// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unit tests for the retcon MCP tool handlers (recall, rewind_to, bookmark).
// The handlers read projected views + emit events; we drive them directly
// rather than going through HTTP. The dual-secret rewind_to flow gets its
// own dedicated describe block — first call returns rules + tokens, second
// call (with the matching token) does the rewind work.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DB } from '../db.js'
import { migrate, openDb } from '../db.js'
import { type Event, type EventProducer } from '../events.js'
import { createEventProducer } from '../events.js'
import {
  CONFIRM_TOKEN_TTL_MS,
  ConfirmTokenStore,
  createMcpTools,
  createMcpToolsWithTokens,
  detectMetaRef,
  META_REFS,
} from '../mcp-tools.js'
import { defaultProjectors } from '../server.js'
import { SqliteStorageProvider } from '../storage.js'
import { createTobeStore, type TobeStore } from '../tobe.js'

interface TestFixture {
  db: DB
  producer: EventProducer
  tobeStore: TobeStore
  storageProvider: SqliteStorageProvider
  tmp: string
  sessionId: string
  taskId: string
  cleanup: () => void
}

function fixture(opts: { orphan?: boolean } = {}): TestFixture {
  const db = openDb({ path: ':memory:' })
  migrate(db)
  const producer = createEventProducer(db, defaultProjectors())
  const tmp = mkdtempSync(path.join(tmpdir(), 'mcp-tools-test-'))
  const tobeStore = createTobeStore(tmp)
  const sessionId = 'sess-tools'
  if (opts.orphan) {
    producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b' },
      sessionId,
    )
  }
  else {
    producer.emit('mcp.session_initialized', { mcp_session_id: 'm', harness: 'claude-code' }, sessionId)
  }
  const taskId = (db.prepare('SELECT task_id FROM sessions WHERE id = ?').get(sessionId) as { task_id: string }).task_id
  const storageProvider = new SqliteStorageProvider(db)
  return {
    db,
    producer,
    tobeStore,
    storageProvider,
    tmp,
    sessionId,
    taskId,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

/** Helper: emit request_received with an inline body blob so rewind_to can reconstruct messages. */
function emitTurn(
  fx: TestFixture,
  stopReason: string,
  messagesArr: unknown[],
): Event {
  const bodyBytes = Buffer.from(JSON.stringify({ messages: messagesArr }), 'utf8')
  const bodyCid = `bafy-body-${Math.random().toString(36).slice(2)}`
  const req = fx.producer.emit(
    'proxy.request_received',
    { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: bodyCid },
    fx.sessionId,
    [{ cid: bodyCid, bytes: bodyBytes }],
  )
  fx.producer.emit(
    'proxy.response_completed',
    {
      request_event_id: req.id,
      status: 200,
      headers_cid: 'h',
      body_cid: 'bafy-resp',
      stop_reason: stopReason,
      asset_cid: 'bafy-asset',
    },
    fx.sessionId,
  )
  return req
}

async function call(fx: TestFixture, name: string, args: unknown, rewindEnabled = true): Promise<unknown> {
  const tools = createMcpTools({
    db: fx.db,
    tobeStore: fx.tobeStore,
    storageProvider: fx.storageProvider,
    rewindEnabled,
  })
  const tool = tools.get(name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  return tool.handler(args, { sessionId: fx.sessionId, producer: fx.producer })
}

/**
 * Two-step rewind_to helper: first call returns rules + tokens; second call
 * (with `confirm` set to the clean token by default) does the actual work.
 * Most tests want the second-call result; this hides the dance.
 *
 * Pass `tokenChoice: 'meta'` to send the meta_token instead.
 * Pass `confirmOverride` to send a custom value (e.g., for static-rejection tests).
 */
async function rewindTwoStep(
  fx: TestFixture,
  args: Record<string, unknown>,
  opts: { tokenChoice?: 'clean' | 'meta', confirmOverride?: string, rewindEnabled?: boolean } = {},
): Promise<unknown> {
  const tokenStore = new ConfirmTokenStore()
  const tools = createMcpToolsWithTokens(
    {
      db: fx.db,
      tobeStore: fx.tobeStore,
      storageProvider: fx.storageProvider,
      rewindEnabled: opts.rewindEnabled ?? true,
    },
    tokenStore,
  )
  const tool = tools.get('rewind_to')!
  // First call — no confirm.
  const first = await tool.handler(args, { sessionId: fx.sessionId, producer: fx.producer }) as {
    status: string
    rules?: string
    confirm_clean?: string
    confirm_meta?: string
  }
  if (first.status !== 'rules_returned') {
    // Already terminal (e.g., message validation failed before reaching the secret check).
    return first
  }
  const choice = opts.tokenChoice ?? 'clean'
  const confirm = opts.confirmOverride
    ?? (choice === 'clean' ? first.confirm_clean! : first.confirm_meta!)
  return tool.handler(
    { ...args, confirm },
    { sessionId: fx.sessionId, producer: fx.producer },
  )
}

// ─── recall ──────────────────────────────────────────────────────────────────

describe('recall (list mode)', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  it('lists closed_forkable turns in recency order with previews', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q2' }]) // open, should NOT appear
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q3' }])
    const res = await call(fx, 'recall', {}) as {
      total: number
      turns: Array<{ turn_id: string, n_back: number, preview: string, stop_reason: string | null }>
    }
    expect(res.total).toBe(2)
    expect(res.turns.every(v => v.stop_reason === 'end_turn')).toBe(true)
    expect(res.turns[0]!.preview).toBe('q3')
    expect(res.turns[1]!.preview).toBe('q1')
    expect(res.turns[0]!.n_back).toBe(1)
    expect(res.turns[1]!.n_back).toBe(2)
  })

  it('returns empty list when no closed_forkable turns exist', async () => {
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q' }]) // open only
    const res = await call(fx, 'recall', {}) as { total: number, turns: unknown[] }
    expect(res.total).toBe(0)
    expect(res.turns).toEqual([])
  })

  it('respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) emitTurn(fx, 'end_turn', [{ role: 'user', content: `q${i}` }])
    const r1 = await call(fx, 'recall', { limit: 2 }) as { turns: unknown[] }
    expect(r1.turns.length).toBe(2)
    const r2 = await call(fx, 'recall', { limit: 10, offset: 3 }) as { turns: unknown[] }
    expect(r2.turns.length).toBe(2)
  })

  it('lean result hides revision_id / classification / asset_cid by default', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const r = await call(fx, 'recall', {}) as { turns: Array<Record<string, unknown>> }
    const t = r.turns[0]!
    expect('classification' in t).toBe(false)
    expect('asset_cid' in t).toBe(false)
    expect('parent_revision_id' in t).toBe(false)
  })
})

describe('recall (detail mode)', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  it('returns turn details for a specific turn_id with preceding open chain', async () => {
    const t1 = emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q1' }])
    const t2 = emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q2' }])
    const t3 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q3' }])
    const res = await call(fx, 'recall', { turn_id: t3.id, verbose: true }) as {
      turn: { turn_id: string, classification: string, preview: string }
      preceding_open_turns: string[]
    }
    expect(res.turn.turn_id).toBe(t3.id)
    expect(res.turn.classification).toBe('closed_forkable')
    expect(res.turn.preview).toBe('q3')
    expect(res.preceding_open_turns).toEqual([t2.id, t1.id])
  })

  it('returns turn details for turn_back_n', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'first' }])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'second' }])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'third' }])
    // Most recent settled is "third"; turn_back_n=1 means walk one closed_forkable
    // back from there → "second".
    const res = await call(fx, 'recall', { turn_back_n: 1 }) as { turn: { preview: string } }
    expect(res.turn.preview).toBe('second')
    const res2 = await call(fx, 'recall', { turn_back_n: 2 }) as { turn: { preview: string } }
    expect(res2.turn.preview).toBe('first')
  })

  it('errors on turn_id from a different session', async () => {
    const res = await call(fx, 'recall', { turn_id: 'rev-unknown' }) as { error: string }
    expect(res.error).toMatch(/not found/)
  })

  it('errors when both turn_id and turn_back_n are passed', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'recall', { turn_id: 'x', turn_back_n: 1 }) as { error: string }
    expect(res.error).toMatch(/not both/)
  })

  it('errors when turn_back_n exceeds available turns', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'recall', { turn_back_n: 5 }) as { error: string }
    expect(res.error).toMatch(/fewer than/)
  })

  it('errors when turn_back_n is non-integer or < 1', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'recall', { turn_back_n: 0 }) as { error: string }
    expect(res.error).toMatch(/integer/)
  })

  it('caps walk-back depth to prevent cyclic-chain runaway (A-WR13)', async () => {
    const v = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    fx.db.prepare('UPDATE revisions SET parent_revision_id = id WHERE id = ?').run(v.id)
    const start = Date.now()
    const res = await call(fx, 'recall', { turn_id: v.id }) as {
      preceding_open_turn_count?: number
      preceding_open_turns?: string[]
    }
    expect(Date.now() - start).toBeLessThan(1000)
    expect(typeof res.preceding_open_turn_count === 'number' || Array.isArray(res.preceding_open_turns)).toBe(true)
  })

  it('verbose=true exposes internal fields (CEO Proposal B)', async () => {
    const t = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'recall', { turn_id: t.id, verbose: true }) as {
      turn: Record<string, unknown>
      preceding_open_turns: unknown
    }
    expect('classification' in res.turn).toBe(true)
    expect('parent_revision_id' in res.turn).toBe(true)
    expect('asset_cid' in res.turn).toBe(true)
    expect(Array.isArray(res.preceding_open_turns)).toBe(true)
  })
})

// ─── bookmark ────────────────────────────────────────────────────────────────

describe('bookmark', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  it('creates a branch_view pointing at the latest closed_forkable turn', async () => {
    const req = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'bookmark', { label: 'my-spot' }) as {
      view_id: string
      head_revision_id: string
      label: string
    }
    expect(res.head_revision_id).toBe(req.id)
    expect(res.label).toBe('my-spot')
    const row = fx.db.prepare('SELECT * FROM branch_views WHERE id = ?').get(res.view_id) as
      | { label: string, head_revision_id: string } | undefined
    expect(row?.label).toBe('my-spot')
  })

  it('G10: rejects when no closed_forkable turn exists yet', async () => {
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'bookmark', { label: 'x' }) as { error: string }
    expect(res.error).toMatch(/no forkable turn yet/)
  })
})

// ─── rewind_to ───────────────────────────────────────────────────────────────

describe('rewind_to (dual-secret flow)', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  it('first call (no confirm) returns rules + a fresh token pair', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    const res = await call(fx, 'rewind_to', { turn_back_n: 1, message: 'X' }) as {
      status: string
      rules: string
      confirm_clean: string
      confirm_meta: string
    }
    expect(res.status).toBe('rules_returned')
    expect(res.rules).toMatch(/STANDS ALONE/)
    expect(res.rules).toMatch(/META-REFERENCE/)
    expect(res.rules).toContain(res.confirm_clean)
    expect(res.rules).toContain(res.confirm_meta)
    expect(res.confirm_clean).not.toBe(res.confirm_meta)
    expect(res.confirm_clean).toMatch(/^[A-Za-z0-9]{8}$/)
    expect(res.confirm_meta).toMatch(/^[A-Za-z0-9]{8}$/)
    // No TOBE side effects.
    expect(fx.tobeStore.peek(fx.sessionId)).toBeNull()
  })

  it('static-value rejection: confirm="acknowledged" routes back to fresh first call', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    const res = await call(fx, 'rewind_to', {
      turn_back_n: 1,
      message: 'X',
      confirm: 'acknowledged',
    }) as { status: string, confirm_clean?: string, confirm_meta?: string }
    expect(res.status).toBe('rules_returned')
    expect(res.confirm_clean).toMatch(/^[A-Za-z0-9]{8}$/)
    expect(res.confirm_meta).toMatch(/^[A-Za-z0-9]{8}$/)
  })

  it('opaque tokens have no semantic prefix (regression guard)', async () => {
    // Guards against a future regression where someone adds deliberate semantic
    // prefixes like PROCEED-/REVISE-. We only check for prefixes long enough
    // that random collision against an 8-char alphanumeric token is
    // statistically negligible (≥6 chars from a 62-char alphabet ≈ 1 in 5×10^10).
    // Shorter prefixes ("OK", "NO") would false-positive from randomness.
    const banned = ['PROCEED', 'REVISE', 'CONFIRM', 'ACCEPT', 'REJECT', 'APPROVE']
    for (let i = 0; i < 50; i++) {
      const fxn = fixture()
      try {
        emitTurn(fxn, 'end_turn', [{ role: 'user', content: 'q' }])
        const res = await call(fxn, 'rewind_to', { turn_back_n: 1, message: 'X' }) as {
          confirm_clean: string
          confirm_meta: string
        }
        for (const tok of [res.confirm_clean, res.confirm_meta]) {
          expect(tok).toMatch(/^[A-Za-z0-9]{8}$/)
          for (const b of banned) {
            expect(tok.toUpperCase().startsWith(b)).toBe(false)
          }
        }
        // The two tokens must be different from each other.
        expect(res.confirm_clean).not.toBe(res.confirm_meta)
      }
      finally {
        fxn.cleanup()
      }
    }
  })

  it('clean_token + clean message → writes TOBE + scheduled response', async () => {
    const t1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    const res = await rewindTwoStep(fx, { turn_back_n: 1, message: 'alternate' }) as {
      status: string
      message: string
      fork_point: string
      target_view_id: string
      pending_path: string
    }
    expect(res.status).toBe('scheduled')
    // Loud-failure response text — Decision #7.
    expect(res.message).toMatch(/RETCON ERROR/)
    expect(res.fork_point).toBe(t1.id)
    const pending = fx.tobeStore.peek(fx.sessionId)
    expect(pending).toBeTruthy()
    const lastMsg = pending!.messages[pending!.messages.length - 1] as { role: string, content: string }
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content).toBe('alternate')
  })

  it('synthetic-message verbatim test: message arg lands in TOBE without any wrapping', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'orig' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'orig' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    const verbatim = 'EXACT VERBATIM 12345 (changing my earlier answer of A)'
    await rewindTwoStep(fx, { turn_back_n: 1, message: verbatim })
    const pending = fx.tobeStore.peek(fx.sessionId)!
    const last = pending.messages[pending.messages.length - 1] as { role: string, content: string }
    expect(last.role).toBe('user')
    expect(last.content).toBe(verbatim) // no prefix, no wrapping
  })

  it('meta_token → educational rejection + fresh token pair', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await rewindTwoStep(
      fx,
      { turn_back_n: 1, message: 'change my previous answer to B' },
      { tokenChoice: 'meta' },
    ) as { status: string, message: string }
    expect(res.status).toBe('rejected')
    expect(res.message).toMatch(/Good catch/)
    expect(res.message).toMatch(/clean=/)
    expect(res.message).toMatch(/meta=/)
    expect(fx.tobeStore.peek(fx.sessionId)).toBeNull()
  })

  it('narrow regex catches "see above" on clean-token path', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await rewindTwoStep(fx, {
      turn_back_n: 1,
      message: 'see above for context',
    }) as { status: string, matched_pattern?: string }
    expect(res.status).toBe('rejected')
    // matched_pattern is the regex .source field — verify it identifies the
    // "see/saw/read above" branch of META_REFS without over-escaping.
    expect(res.matched_pattern).toContain('see|saw|read')
    expect(res.matched_pattern).toContain('above')
    expect(fx.tobeStore.peek(fx.sessionId)).toBeNull()
  })

  it('narrow regex no-false-positive: "the previous algorithm" succeeds (regression guard)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    const res = await rewindTwoStep(fx, {
      turn_back_n: 1,
      message: 'the previous algorithm was O(n²)',
    }) as { status: string }
    expect(res.status).toBe('scheduled')
    expect(fx.tobeStore.peek(fx.sessionId)).toBeTruthy()
  })

  it('allow_meta_refs=true bypasses the regex backstop', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    const res = await rewindTwoStep(fx, {
      turn_back_n: 1,
      message: 'see above for context (the visible-history reference is intentional)',
      allow_meta_refs: true,
    }) as { status: string }
    expect(res.status).toBe('scheduled')
  })

  it('token single-use: re-calling with same clean_token after consume returns fresh first-call', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    const tokenStore = new ConfirmTokenStore()
    const tools = createMcpToolsWithTokens(
      { db: fx.db, tobeStore: fx.tobeStore, storageProvider: fx.storageProvider, rewindEnabled: true },
      tokenStore,
    )
    const tool = tools.get('rewind_to')!

    const first = await tool.handler(
      { turn_back_n: 1, message: 'X' },
      { sessionId: fx.sessionId, producer: fx.producer },
    ) as { confirm_clean: string }
    const stale = first.confirm_clean

    await tool.handler(
      { turn_back_n: 1, message: 'X', confirm: stale },
      { sessionId: fx.sessionId, producer: fx.producer },
    )

    const replay = await tool.handler(
      { turn_back_n: 1, message: 'X', confirm: stale },
      { sessionId: fx.sessionId, producer: fx.producer },
    ) as { status: string, confirm_clean?: string }
    expect(replay.status).toBe('rules_returned')
    expect(replay.confirm_clean).not.toBe(stale)
  })

  it('token single-use: re-calling with same meta_token after consume returns fresh first-call', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const tokenStore = new ConfirmTokenStore()
    const tools = createMcpToolsWithTokens(
      { db: fx.db, tobeStore: fx.tobeStore, storageProvider: fx.storageProvider, rewindEnabled: true },
      tokenStore,
    )
    const tool = tools.get('rewind_to')!
    const first = await tool.handler(
      { turn_back_n: 1, message: 'X' },
      { sessionId: fx.sessionId, producer: fx.producer },
    ) as { confirm_meta: string }
    const stale = first.confirm_meta
    // First send with meta → consumes pair.
    await tool.handler(
      { turn_back_n: 1, message: 'X', confirm: stale },
      { sessionId: fx.sessionId, producer: fx.producer },
    )
    // Resend → no longer matches; routes to fresh rules.
    const replay = await tool.handler(
      { turn_back_n: 1, message: 'X', confirm: stale },
      { sessionId: fx.sessionId, producer: fx.producer },
    ) as { status: string }
    expect(replay.status).toBe('rules_returned')
  })

  it('token TTL: expired tokens are treated as unknown values', async () => {
    // Use a tokenStore with a very short TTL (1ms) so we can exercise expiry
    // deterministically without sleeping in the test.
    const tokenStore = new ConfirmTokenStore(1)
    const tools = createMcpToolsWithTokens(
      { db: fx.db, tobeStore: fx.tobeStore, storageProvider: fx.storageProvider, rewindEnabled: true },
      tokenStore,
    )
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const tool = tools.get('rewind_to')!
    const first = await tool.handler(
      { turn_back_n: 1, message: 'X' },
      { sessionId: fx.sessionId, producer: fx.producer },
    ) as { confirm_clean: string }
    // Wait past TTL (1ms is enough; setTimeout 5ms covers timer slop).
    await new Promise(resolve => setTimeout(resolve, 5))
    const replay = await tool.handler(
      { turn_back_n: 1, message: 'X', confirm: first.confirm_clean },
      { sessionId: fx.sessionId, producer: fx.producer },
    ) as { status: string }
    expect(replay.status).toBe('rules_returned')
  })

  it('CONFIRM_TOKEN_TTL_MS default is 5 minutes', () => {
    expect(CONFIRM_TOKEN_TTL_MS).toBe(5 * 60 * 1000)
  })
})

describe('rewind_to (existing F4 / orphan / size-cap / feature-gate behavior)', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  it('F4: walks past an open head to the nearest closed_forkable ancestor', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q2' }]) // head=open
    const res = await rewindTwoStep(fx, { turn_back_n: 1, message: 'alt' }) as { error: string }
    expect(res.error).toMatch(/forkable turns available/)
  })

  it('F4: errors when no settled revision exists (everything in_flight)', async () => {
    fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b' },
      fx.sessionId,
    )
    const res = await rewindTwoStep(fx, { turn_back_n: 1, message: 'alt' }) as { error: string }
    expect(res.error).toMatch(/no settled/)
  })

  it('rejects message > MAX_REWIND_MESSAGE_BYTES BEFORE consuming token', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const huge = 'x'.repeat(2 * 1024 * 1024)
    // Note: size check runs before the secret check, so we don't need two-step.
    const res = await call(fx, 'rewind_to', { turn_back_n: 1, message: huge }) as { error: string }
    expect(res.error).toMatch(/exceeds/)
  })

  it('rejects orphan sessions', async () => {
    const orphan = fixture({ orphan: true })
    try {
      emitTurn(orphan, 'end_turn', [{ role: 'user', content: 'q' }])
      const res = await rewindTwoStep(orphan, { turn_back_n: 1, message: 'alt' }) as { error: string }
      expect(res.error).toMatch(/orphan sessions cannot rewind/)
    }
    finally {
      orphan.cleanup()
    }
  })

  it('rewindEnabled=false emits fork.back_disabled_rejected and errors', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await rewindTwoStep(fx, { turn_back_n: 1, message: 'alt' }, { rewindEnabled: false }) as {
      error: string
    }
    expect(res.error).toMatch(/disabled/)
    const row = fx.db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE topic = 'fork.back_disabled_rejected' AND session_id = ?`,
    ).get(fx.sessionId) as { n: number }
    expect(row.n).toBe(1)
    expect(fx.tobeStore.peek(fx.sessionId)).toBeNull()
  })

  it('rejects turn_back_n < 1', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await rewindTwoStep(fx, { turn_back_n: 0, message: 'alt' }) as { error: string }
    expect(res.error).toMatch(/turn_back_n must be an integer/)
  })

  it('rejects when turn_back_n exceeds available forkable turns', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    const res = await rewindTwoStep(fx, { turn_back_n: 5, message: 'alt' }) as { error: string }
    expect(res.error).toMatch(/only \d+ forkable turns available/)
  })

  it('falls back to target body when child body is malformed (A-WR9)', async () => {
    const target = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'bafy-target-body' },
      fx.sessionId,
      [{ cid: 'bafy-target-body', bytes: Buffer.from(JSON.stringify({
        messages: [{ role: 'user', content: 'from-target' }],
      })) }],
    )
    fx.producer.emit(
      'proxy.response_completed',
      { request_event_id: target.id, status: 200, headers_cid: 'h', body_cid: 'r', stop_reason: 'end_turn', asset_cid: 'a' },
      fx.sessionId,
    )
    const child = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'bafy-child-garbage' },
      fx.sessionId,
      [{ cid: 'bafy-child-garbage', bytes: Buffer.from('{not json') }],
    )
    fx.producer.emit(
      'proxy.response_completed',
      { request_event_id: child.id, status: 200, headers_cid: 'h', body_cid: 'r', stop_reason: 'end_turn', asset_cid: 'a' },
      fx.sessionId,
    )
    const res = await rewindTwoStep(fx, { turn_back_n: 1, message: 'retry' }) as {
      status?: string
      error?: string
    }
    expect(res.status).toBe('scheduled')
    const pending = fx.tobeStore.peek(fx.sessionId)!
    const msgs = pending.messages as Array<{ content: string }>
    expect(msgs[0]!.content).toBe('from-target')
    expect(msgs[msgs.length - 1]!.content).toBe('retry')
  })

  it('errors when neither child nor target body resolves', async () => {
    const target = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'bafy-target-ghost' },
      fx.sessionId,
    )
    fx.producer.emit(
      'proxy.response_completed',
      { request_event_id: target.id, status: 200, headers_cid: 'h', body_cid: 'r', stop_reason: 'end_turn', asset_cid: 'a' },
      fx.sessionId,
    )
    const child = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'bafy-child-ghost' },
      fx.sessionId,
    )
    fx.producer.emit(
      'proxy.response_completed',
      { request_event_id: child.id, status: 200, headers_cid: 'h', body_cid: 'r', stop_reason: 'end_turn', asset_cid: 'a' },
      fx.sessionId,
    )
    const res = await rewindTwoStep(fx, { turn_back_n: 1, message: 'retry' }) as {
      status?: string
      error?: string
    }
    expect(res.status).toBeUndefined()
    expect(res.error).toMatch(/no usable source blob/)
    expect(fx.tobeStore.peek(fx.sessionId)).toBeNull()
  })

  it('includes prior_outcome from the last TOBE-applied request', async () => {
    const V1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    const bodyCid = 'bafy-forked-body'
    const bodyBytes = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'q1' }],
    }), 'utf8')
    const forked = fx.producer.emit(
      'proxy.request_received',
      {
        method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: bodyCid,
        tobe_applied_from: {
          fork_point_revision_id: V1.id,
          source_view_id: 'view-old',
          original_body_cid: 'b-orig',
        },
      },
      fx.sessionId,
      [{ cid: bodyCid, bytes: bodyBytes }],
    )
    fx.producer.emit(
      'proxy.upstream_error',
      { request_event_id: forked.id, status: 502, error_message: 'upstream down' },
      fx.sessionId,
    )

    const res = await rewindTwoStep(fx, { turn_back_n: 1, message: 'retry' }) as {
      status: string
      prior_outcome: { status: string, http_status?: number, error_message?: string } | null
    }
    expect(res.status).toBe('scheduled')
    expect(res.prior_outcome?.status).toBe('upstream_error')
    expect(res.prior_outcome?.http_status).toBe(502)
  })

  it('turn_id mode: rewinds to a specific forkable turn', async () => {
    const t1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    const res = await rewindTwoStep(fx, { turn_id: t1.id, message: 'redirect' }) as {
      status: string
      fork_point: string
    }
    expect(res.status).toBe('scheduled')
    expect(res.fork_point).toBe(t1.id)
  })

  it('turn_id mode rejects non-forkable turns', async () => {
    const open = emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q' }])
    const res = await rewindTwoStep(fx, { turn_id: open.id, message: 'X' }) as { error: string }
    expect(res.error).toMatch(/not a forkable turn/)
  })
})

// ─── META_REFS regex ─────────────────────────────────────────────────────────

describe('detectMetaRef + META_REFS', () => {
  it('catches "see above" / "read above" / "saw above"', () => {
    expect(detectMetaRef('please see above')).toBeTruthy()
    expect(detectMetaRef('SEE ABOVE for the answer')).toBeTruthy()
    expect(detectMetaRef('I read above and disagree')).toBeTruthy()
  })

  it('catches "continue from here / where we left off"', () => {
    expect(detectMetaRef('continue from here')).toBeTruthy()
    expect(detectMetaRef('Continue from where we left off')).toBeTruthy()
  })

  it('catches "redo your last answer" / "redo my previous response"', () => {
    expect(detectMetaRef('redo your last answer')).toBeTruthy()
    expect(detectMetaRef('Redo my previous response with more detail')).toBeTruthy()
  })

  it('catches "the last/previous question I asked/gave/sent"', () => {
    expect(detectMetaRef('the last question I asked')).toBeTruthy()
    expect(detectMetaRef('the previous answer I gave')).toBeTruthy()
  })

  it('does NOT false-positive on "the previous algorithm" (regression guard)', () => {
    expect(detectMetaRef('the previous algorithm was O(n²)')).toBeNull()
    expect(detectMetaRef('previous response from the API was 200')).toBeNull()
    expect(detectMetaRef('as I mentioned earlier in the doc')).toBeNull()
    expect(detectMetaRef('my last response time was 200ms')).toBeNull()
    expect(detectMetaRef('format the same as before in the schema')).toBeNull()
  })

  it('META_REFS list has exactly 4 patterns', () => {
    expect(META_REFS.length).toBe(4)
  })
})
