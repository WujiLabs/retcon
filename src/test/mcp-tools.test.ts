// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unit tests for the retcon MCP tool handlers (recall, rewind_to, bookmark).
// The handlers read projected views + emit events; we drive them directly
// rather than going through HTTP. The dual-secret rewind_to flow gets its
// own dedicated describe block — first call returns rules + tokens, second
// call (with the matching token) does the rewind work.

import fs, { mkdtempSync, rmSync } from 'node:fs'
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

  it('lists rewindable turns (excludes the head) in recency order with previews', async () => {
    // Three closed_forkable turns: q1, q3, q4. Plus an open in the middle.
    // The head (most-recent closed_forkable, q4) is excluded from the list
    // because rewinding to the current state is a no-op. n_back numbering
    // matches what rewind_to(turn_back_n=N) would land on.
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q2' }]) // open, should NOT appear
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q3' }])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q4' }]) // head — excluded
    const res = await call(fx, 'recall', {}) as {
      total: number
      turns: Array<{ turn_id: string, n_back: number, preview: string, stop_reason: string | null }>
      current_head_turn_id: string | null
    }
    // total = rewindable count (3 closed_forkable - 1 head = 2)
    expect(res.total).toBe(2)
    expect(res.turns.length).toBe(2)
    expect(res.turns.every(v => v.stop_reason === 'end_turn')).toBe(true)
    // n_back=1 is q3 (one before head); n_back=2 is q1.
    expect(res.turns[0]!.preview).toBe('q3')
    expect(res.turns[1]!.preview).toBe('q1')
    expect(res.turns[0]!.n_back).toBe(1)
    expect(res.turns[1]!.n_back).toBe(2)
    expect(res.current_head_turn_id).not.toBeNull()
  })

  it('list mode n_back=N matches rewind_to(turn_back_n=N) target (no off-by-one)', async () => {
    // Regression guard for the inconsistency between list mode and rewind_to:
    // calling rewind_to(turn_back_n=K) MUST land on the same revision that
    // recall list labels n_back=K (turn_id field).
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'first' }])
    const t2 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'second' }])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'third' }]) // head — excluded
    const list = await call(fx, 'recall', {}) as {
      turns: Array<{ turn_id: string, preview: string, n_back: number }>
    }
    // n_back=1 = the turn whose `turn_id` rewind_to(turn_back_n=1) lands on.
    expect(list.turns[0]!.preview).toBe('second')
    expect(list.turns[0]!.n_back).toBe(1)
    expect(list.turns[0]!.turn_id).toBe(t2.id)
    // Now verify rewind_to(turn_back_n=1) targets the n_back=1 entry.
    const res = await rewindTwoStep(fx, { turn_back_n: 1, message: 'X' }) as {
      status: string
      fork_point: string
    }
    expect(res.status).toBe('scheduled')
    expect(res.fork_point).toBe(t2.id) // same as list.turns[0].turn_id
  })

  it('returns empty list when only the head is closed_forkable (single-turn session)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }]) // head, only forkable
    const res = await call(fx, 'recall', {}) as {
      total: number
      turns: unknown[]
      current_head_turn_id: string | null
    }
    expect(res.total).toBe(0) // 1 forkable - 1 head = 0 rewindable
    expect(res.turns).toEqual([])
    expect(res.current_head_turn_id).not.toBeNull() // head exists, just not in list
  })

  it('returns empty list when no closed_forkable turns exist', async () => {
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q' }]) // open only
    const res = await call(fx, 'recall', {}) as {
      total: number
      turns: unknown[]
      current_head_turn_id: string | null
    }
    expect(res.total).toBe(0)
    expect(res.turns).toEqual([])
    expect(res.current_head_turn_id).toBeNull()
  })

  it('respects limit and offset (after head exclusion)', async () => {
    // 5 closed_forkable turns. Head excluded → 4 rewindable.
    for (let i = 0; i < 5; i++) emitTurn(fx, 'end_turn', [{ role: 'user', content: `q${i}` }])
    const r1 = await call(fx, 'recall', { limit: 2 }) as { turns: unknown[], total: number }
    expect(r1.turns.length).toBe(2)
    expect(r1.total).toBe(4) // 5 forkable - 1 head
    // SQL filters head out, so offset/limit count rewindable turns directly.
    // 4 rewindable - 3 offset = 1 row.
    const r2 = await call(fx, 'recall', { limit: 10, offset: 3 }) as { turns: unknown[] }
    expect(r2.turns.length).toBe(1)
  })

  it('lean result hides revision_id / classification / asset_cid by default', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q2' }]) // need 2 so list isn't empty
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
    expect(res.error).toMatch(/exactly one/)
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

// ─── recall (Phase 3 extensions) ────────────────────────────────────────────
//
// Phase 3 of the bookmark management plan (v0.4.4): recall accepts view_id,
// surrounding window, and surfaces rewind_events + branch_views_at_turn.

describe('recall (Phase 3 extensions)', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  it('1: view_id-happy — resolves to bookmark\'s head_turn_id', async () => {
    const turn = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const bm = await call(fx, 'bookmark', { label: 'v1' }) as {
      view_id: string
      head_revision_id: string
    }
    const res = await call(fx, 'recall', { view_id: bm.view_id }) as {
      turn: { turn_id: string }
    }
    expect(res.turn.turn_id).toBe(turn.id)
    expect(res.turn.turn_id).toBe(bm.head_revision_id)
  })

  it('2: view_id-not-found — clear error message', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'recall', { view_id: 'never-existed' }) as { error: string }
    expect(res.error).toMatch(/view not found/)
  })

  it('3: surrounding-window — returns N before + N after', async () => {
    // Seed 5 forkable turns; inspect the middle one with surrounding=2.
    const turns = []
    for (let i = 0; i < 5; i++) {
      const messages: Array<{ role: string, content: string }> = []
      for (let j = 0; j <= i; j++) {
        messages.push({ role: 'user', content: `q${j}` })
        messages.push({ role: 'assistant', content: `a${j}` })
      }
      messages.pop() // end on user
      turns.push(emitTurn(fx, 'end_turn', messages))
    }
    const middle = turns[2]!
    const res = await call(fx, 'recall', { turn_id: middle.id, surrounding: 2 }) as {
      turn: { turn_id: string }
      surrounding_turns: Array<{ turn_id: string, relative_to_target: number }>
    }
    expect(res.turn.turn_id).toBe(middle.id)
    expect(res.surrounding_turns.length).toBe(4)
    // 2 before (negative relative), 2 after (positive). Each group sorted
    // closest-first.
    const before = res.surrounding_turns.filter(t => t.relative_to_target < 0)
    const after = res.surrounding_turns.filter(t => t.relative_to_target > 0)
    expect(before.length).toBe(2)
    expect(after.length).toBe(2)
    expect(before.map(t => t.relative_to_target).sort((a, b) => b - a)).toEqual([-1, -2])
    expect(after.map(t => t.relative_to_target).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('4: surrounding-clipped-at-edges — returns whatever exists when N exceeds available', async () => {
    // 3 turns, inspect the LAST with surrounding=5. Should get 2 before + 0 after.
    const turns = []
    for (let i = 0; i < 3; i++) {
      const messages: Array<{ role: string, content: string }> = []
      for (let j = 0; j <= i; j++) {
        messages.push({ role: 'user', content: `q${j}` })
        messages.push({ role: 'assistant', content: `a${j}` })
      }
      messages.pop()
      turns.push(emitTurn(fx, 'end_turn', messages))
    }
    const last = turns[2]!
    const res = await call(fx, 'recall', { turn_id: last.id, surrounding: 5 }) as {
      surrounding_turns: Array<{ relative_to_target: number }>
    }
    expect(res.surrounding_turns.length).toBe(2) // 2 before, 0 after
    expect(res.surrounding_turns.every(t => t.relative_to_target < 0)).toBe(true)
  })

  it('5 (v0.5): rewind_events* fields are NOT in list output — replaced by SR rows with kind=rewind_marker', async () => {
    // Regression guard: a future change re-introducing rewind_events would
    // duplicate what SR rows already surface and re-introduce the
    // fork.back_requested coupling we removed in v0.5.0.
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q2' }])
    const res = await call(fx, 'recall', {}) as Record<string, unknown>
    expect(res.rewind_events).toBeUndefined()
    expect(res.rewind_events_total).toBeUndefined()
    expect(res.rewind_events_truncated).toBeUndefined()
  })

  it('5b (v0.5): list mode surfaces SR rows with kind=rewind_marker', async () => {
    // Seed a real assistant turn to act as R1, then inject an SR row directly
    // (mimicking what RewindMarkerV1Projector would do on fork.forked).
    // SR.sealed_at = 1 keeps it as the oldest entry so the second emitTurn
    // remains the head (which gets excluded from the list).
    const r1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q2' }]) // head, excluded from list
    fx.db.prepare(`
      INSERT INTO revisions
        (id, task_id, asset_cid, parent_revision_id, classification, stop_reason, sealed_at, created_at)
      VALUES (?, ?, ?, ?, 'closed_forkable', 'rewind_synthetic', ?, ?)
    `).run('rev-sr-1', fx.taskId, 'cid-sr-1', r1.id, 1, 1)

    const res = await call(fx, 'recall', {}) as {
      turns: Array<{ turn_id: string, kind: string }>
    }
    const sr = res.turns.find(t => t.turn_id === 'rev-sr-1')
    expect(sr).toBeDefined()
    expect(sr!.kind).toBe('rewind_marker')
    // Real turns surface with kind='turn'.
    const real = res.turns.find(t => t.turn_id === r1.id)
    expect(real?.kind).toBe('turn')
  })

  it('5c (v0.5): list mode discriminates submit_marker from rewind_marker', async () => {
    const r1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q2' }]) // head
    fx.db.prepare(`
      INSERT INTO revisions
        (id, task_id, asset_cid, parent_revision_id, classification, stop_reason, sealed_at, created_at)
      VALUES (?, ?, ?, ?, 'closed_forkable', 'submit_synthetic', ?, ?)
    `).run('rev-sr-submit', fx.taskId, 'cid-x', r1.id, 1, 1)

    const res = await call(fx, 'recall', {}) as {
      turns: Array<{ turn_id: string, kind: string }>
    }
    const submitMarker = res.turns.find(t => t.turn_id === 'rev-sr-submit')
    expect(submitMarker?.kind).toBe('submit_marker')
  })

  it('5d (v0.5): detail mode on an SR turn includes kind=rewind_marker', async () => {
    const r1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q2' }]) // head
    fx.db.prepare(`
      INSERT INTO revisions
        (id, task_id, asset_cid, parent_revision_id, classification, stop_reason, sealed_at, created_at)
      VALUES (?, ?, ?, ?, 'closed_forkable', 'rewind_synthetic', ?, ?)
    `).run('rev-sr-detail', fx.taskId, 'cid-d', r1.id, Date.now(), Date.now())

    const res = await call(fx, 'recall', { turn_id: 'rev-sr-detail' }) as {
      turn: { turn_id: string, kind: string, stop_reason: string | null }
    }
    expect(res.turn.kind).toBe('rewind_marker')
    expect(res.turn.stop_reason).toBe('rewind_synthetic')
  })

  it('5e (v0.5): surrounding window entries carry kind discriminator', async () => {
    const t1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    const t2 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q2' }])
    const t3 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q3' }])
    // Inject an SR sibling for t2.
    const t2Row = fx.db.prepare('SELECT sealed_at FROM revisions WHERE id = ?').get(t2.id) as { sealed_at: number }
    fx.db.prepare(`
      INSERT INTO revisions
        (id, task_id, asset_cid, parent_revision_id, classification, stop_reason, sealed_at, created_at)
      VALUES (?, ?, ?, ?, 'closed_forkable', 'rewind_synthetic', ?, ?)
    `).run('rev-sr-mid', fx.taskId, 'cid-m', t1.id, t2Row.sealed_at + 1, Date.now())

    const res = await call(fx, 'recall', { turn_id: t3.id, surrounding: 3 }) as {
      surrounding_turns: Array<{ turn_id: string, kind: string }>
    }
    const sr = res.surrounding_turns.find(t => t.turn_id === 'rev-sr-mid')
    expect(sr?.kind).toBe('rewind_marker')
    const real = res.surrounding_turns.find(t => t.turn_id === t1.id)
    expect(real?.kind).toBe('turn')
  })

  it('7: detail-mode-branch_views_at_turn — surfaces every view pointing at this turn', async () => {
    const turn = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const bm1 = await call(fx, 'bookmark', { label: 'a' }) as { view_id: string }
    const bm2 = await call(fx, 'bookmark', { label: 'b' }) as { view_id: string }
    const res = await call(fx, 'recall', { turn_id: turn.id }) as {
      branch_views_at_turn: Array<{ view_id: string, kind: string, label: string | null }>
    }
    expect(res.branch_views_at_turn.length).toBe(2)
    const ids = res.branch_views_at_turn.map(v => v.view_id).sort()
    expect(ids).toEqual([bm1.view_id, bm2.view_id].sort())
    expect(res.branch_views_at_turn.every(v => v.kind === 'bookmark')).toBe(true)
  })

  it('8: view_id-pointing-at-deleted-view — clean "view not found" error', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const bm = await call(fx, 'bookmark', { label: 'v1' }) as { view_id: string }
    await call(fx, 'delete_bookmark', { label: 'v1' })
    const res = await call(fx, 'recall', { view_id: bm.view_id }) as { error: string }
    expect(res.error).toMatch(/view not found/)
  })

  it('9: surrounding=0 — omits surrounding_turns field entirely from response', async () => {
    const turn = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'recall', { turn_id: turn.id, surrounding: 0 }) as Record<string, unknown>
    expect('surrounding_turns' in res).toBe(false)
    // Same when omitted.
    const res2 = await call(fx, 'recall', { turn_id: turn.id }) as Record<string, unknown>
    expect('surrounding_turns' in res2).toBe(false)
  })

  it('10: surrounding>0 with target.sealed_at=null returns empty array + surrounding_skipped warning', async () => {
    // Adversarial-review finding: previously, target.sealed_at IS NULL silently
    // dropped surrounding_turns even when explicitly requested. Now it surfaces
    // an empty list AND a `surrounding_skipped` reason.
    const turn = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    fx.db.prepare(`UPDATE revisions SET sealed_at = NULL, classification = 'open' WHERE id = ?`).run(turn.id)
    const res = await call(fx, 'recall', { turn_id: turn.id, surrounding: 3 }) as {
      surrounding_turns?: unknown[]
      surrounding_skipped?: string
    }
    expect(res.surrounding_turns).toEqual([])
    expect(res.surrounding_skipped).toMatch(/no sealed_at/)
  })

  it('11: recall(view_id) for non-forkable head returns warning', async () => {
    // Adversarial-review finding: previously, recall(view_id) on a view whose
    // head was reclassified would silently succeed and return next_steps text
    // saying "call rewind_to" — but rewind_to rejects non-forkable turns. Add
    // an explicit warning.
    const turn = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const bm = await call(fx, 'bookmark', { label: 'orphan' }) as { view_id: string }
    fx.db.prepare(`UPDATE revisions SET classification = 'dangling_unforkable' WHERE id = ?`).run(turn.id)
    const res = await call(fx, 'recall', { view_id: bm.view_id }) as {
      warning?: string
    }
    expect(res.warning).toMatch(/non-forkable/)
    expect(res.warning).toMatch(/rewind_to will reject/)
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

  it('rejects label exceeding the byte cap (256)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const longLabel = 'x'.repeat(257)
    const res = await call(fx, 'bookmark', { label: longLabel }) as { error: string }
    expect(res.error).toMatch(/exceeds 256-byte cap/)
  })

  it('strips ASCII control chars from label, preserves printable text + emoji', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    // Label has newline, NUL, DEL, plus printable + emoji.
    const dirty = 'v1\nbase\x00line\x7f 🚀'
    const res = await call(fx, 'bookmark', { label: dirty }) as {
      label: string | null
      view_id: string
    }
    expect(res.label).toBe('v1baseline 🚀')
    // Persisted shape matches the response.
    const row = fx.db.prepare('SELECT label FROM branch_views WHERE id = ?').get(res.view_id) as
      | { label: string } | undefined
    expect(row?.label).toBe('v1baseline 🚀')
  })

  it('rejects label that is entirely control characters', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'bookmark', { label: '\n\t\x00' }) as { error: string }
    expect(res.error).toMatch(/control characters/)
  })
})

// ─── delete_bookmark ────────────────────────────────────────────────────────
//
// Phase 1 of the bookmark management plan (v0.4.4), redesigned post-/review
// to LABEL-ONLY. Deleting by view_id was an implementation leak — the user's
// mental model is "the bookmark I named X". So this tool accepts only `label`.
// Implications: unlabeled bookmarks and auto fork-points are not deletable
// via this tool (system-managed; reaped on `retcon clean --actor X`).

describe('delete_bookmark', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  /** Seed an explicit user bookmark on the latest forkable turn. */
  async function seedBookmark(label: string | null): Promise<{ view_id: string, head_id: string }> {
    const args = label === null ? {} : { label }
    const res = await call(fx, 'bookmark', args) as {
      view_id: string
      head_revision_id: string
    }
    return { view_id: res.view_id, head_id: res.head_revision_id }
  }

  /** Seed an auto fork-point view by emitting a fork.back_requested event. */
  function seedForkPoint(forkPointRevId: string): string {
    const viewId = `vp_${Math.random().toString(36).slice(2, 10)}`
    fx.producer.emit(
      'fork.back_requested',
      {
        target_view_id: viewId,
        source_view_id: 'src',
        fork_point_revision_id: forkPointRevId,
        new_message_cid: 'cid',
        task_id: fx.taskId,
      },
      fx.sessionId,
    )
    return viewId
  }

  it('1: deletes by unique label (happy path)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const { view_id, head_id } = await seedBookmark('v1')
    const res = await call(fx, 'delete_bookmark', { label: 'v1' }) as {
      deleted: { view_id: string, kind: string, label: string, head_turn_id_at_delete: string }
    }
    expect(res.deleted.view_id).toBe(view_id)
    expect(res.deleted.kind).toBe('bookmark')
    expect(res.deleted.label).toBe('v1')
    expect(res.deleted.head_turn_id_at_delete).toBe(head_id)
    const row = fx.db.prepare('SELECT id FROM branch_views WHERE id = ?').get(view_id)
    expect(row).toBeUndefined()
  })

  it('2: rejects when label is missing or empty', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const r1 = await call(fx, 'delete_bookmark', {}) as { error: string }
    expect(r1.error).toMatch(/label is required/)
    const r2 = await call(fx, 'delete_bookmark', { label: '' }) as { error: string }
    expect(r2.error).toMatch(/label is required/)
  })

  it('3: rejects ambiguous label with ambiguous_views list', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const { view_id: a } = await seedBookmark('dup')
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' }])
    const { view_id: b } = await seedBookmark('dup')
    const res = await call(fx, 'delete_bookmark', { label: 'dup' }) as {
      error: string
      ambiguous_views: Array<{ view_id: string, kind: string, label: string | null, head_turn_id: string }>
    }
    expect(res.error).toMatch(/matches 2 bookmarks/)
    const ids = res.ambiguous_views.map(v => v.view_id).sort()
    expect(ids).toEqual([a, b].sort())
    for (const v of res.ambiguous_views) {
      expect(v.kind).toBe('bookmark')
      expect(v.label).toBe('dup')
      expect(typeof v.head_turn_id).toBe('string')
    }
    // Both still exist.
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM branch_views').get()).toEqual({ n: 2 })
  })

  it('4: rejects when no bookmark has that label', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    await seedBookmark('v1')
    const res = await call(fx, 'delete_bookmark', { label: 'nonexistent' }) as { error: string }
    expect(res.error).toMatch(/no bookmark with label 'nonexistent'/)
  })

  it('5: rejects cross-session delete (label from another session\'s task does not match)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    await seedBookmark('cross-session-v1')

    // Spin up a second session with its own task.
    const otherSession = 'sess-other'
    fx.producer.emit('mcp.session_initialized', { mcp_session_id: 'm2', harness: 'claude-code' }, otherSession)

    // Try to delete the FIRST session's bookmark from inside the SECOND session's context.
    const tools = createMcpTools({
      db: fx.db,
      tobeStore: fx.tobeStore,
      storageProvider: fx.storageProvider,
      rewindEnabled: true,
    })
    const res = await tools.get('delete_bookmark')!.handler(
      { label: 'cross-session-v1' },
      { sessionId: otherSession, producer: fx.producer },
    ) as { error: string }
    expect(res.error).toMatch(/no bookmark/)
    // First session's bookmark is still there.
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM branch_views WHERE label = ?`).get('cross-session-v1'))
      .toEqual({ n: 1 })
  })

  it('6: cannot delete fork_points (label=NULL never matches any string label)', async () => {
    const turn = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    seedForkPoint(turn.id)
    // Even if you guess the auto_label string, label-only resolver compares
    // against the `label` field which is NULL — the SQL `label = ?` excludes
    // NULL rows.
    const res = await call(fx, 'delete_bookmark', { label: 'anything' }) as { error: string }
    expect(res.error).toMatch(/no bookmark with label/)
    // fork_point survives.
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM branch_views WHERE label IS NULL`).get())
      .toEqual({ n: 1 })
  })

  it('7: cannot delete unlabeled bookmarks (bookmark() with no args)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    await seedBookmark(null) // label=NULL
    // No string label can resolve a NULL-label row.
    const res = await call(fx, 'delete_bookmark', { label: '' }) as { error: string }
    expect(res.error).toMatch(/label is required/)
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM branch_views WHERE label IS NULL`).get())
      .toEqual({ n: 1 })
  })

  it('8: idempotent — second call against an already-deleted bookmark returns "not found"', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    await seedBookmark('v1')
    await call(fx, 'delete_bookmark', { label: 'v1' })
    const second = await call(fx, 'delete_bookmark', { label: 'v1' }) as { error: string }
    expect(second.error).toMatch(/no bookmark with label/)
  })

  it('9: projector silently skips on task_id mismatch (no throw)', async () => {
    const turn = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const { view_id } = await seedBookmark('v1')
    // Emit a delete event with a wrong task_id directly to bypass the
    // resolver. The projector handler should run DELETE WHERE id=? AND
    // task_id=? — no match, no throw, row remains.
    expect(() => {
      fx.producer.emit(
        'fork.bookmark_deleted',
        { view_id, task_id: 'wrong-task' },
        fx.sessionId,
      )
    }).not.toThrow()
    expect(fx.db.prepare('SELECT id FROM branch_views WHERE id = ?').get(view_id)).toBeTruthy()
    // Sanity: the right task_id deletes correctly.
    fx.producer.emit(
      'fork.bookmark_deleted',
      { view_id, task_id: turn ? fx.taskId : '' },
      fx.sessionId,
    )
    expect(fx.db.prepare('SELECT id FROM branch_views WHERE id = ?').get(view_id)).toBeUndefined()
  })
})

// ─── list_branches ───────────────────────────────────────────────────────────
//
// Phase 2 of the bookmark management plan (v0.4.4): list_branches surfaces
// every branch_view row for the session's task — explicit bookmarks AND auto
// fork-point views — with a `kind` discriminator derived from auto_label.

describe('list_branches', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  function seedForkPoint(forkPointRevId: string, label: string | null = null): string {
    const viewId = `vp_${Math.random().toString(36).slice(2, 10)}`
    fx.producer.emit(
      'fork.back_requested',
      {
        target_view_id: viewId,
        source_view_id: 'src',
        fork_point_revision_id: forkPointRevId,
        new_message_cid: 'cid',
        task_id: fx.taskId,
      },
      fx.sessionId,
    )
    if (label !== null) {
      fx.producer.emit('fork.label_updated', { view_id: viewId, label }, fx.sessionId)
    }
    return viewId
  }

  it('1: returns empty list on a fresh session', async () => {
    const res = await call(fx, 'list_branches', {}) as { total: number, branches: unknown[] }
    expect(res.total).toBe(0)
    expect(res.branches).toEqual([])
  })

  it('2: lists a mix of bookmark and fork_point with correct kind from auto_label', async () => {
    const turn = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    // Explicit bookmark (no label).
    const bm = await call(fx, 'bookmark', {}) as { view_id: string }
    // Auto fork-point view (label=NULL).
    const fp = seedForkPoint(turn.id)
    const res = await call(fx, 'list_branches', {}) as {
      total: number
      branches: Array<{ view_id: string, kind: string, label: string | null }>
    }
    expect(res.total).toBe(2)
    const byId = new Map(res.branches.map(b => [b.view_id, b]))
    expect(byId.get(bm.view_id)?.kind).toBe('bookmark')
    expect(byId.get(bm.view_id)?.label).toBeNull()
    expect(byId.get(fp)?.kind).toBe('fork_point')
    expect(byId.get(fp)?.label).toBeNull()
  })

  it('3: n_back_of_head=0 when bookmark is tracking the current head', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    await call(fx, 'bookmark', { label: 'tracking' })
    const res = await call(fx, 'list_branches', {}) as {
      branches: Array<{ label: string | null, n_back_of_head: number | null }>
    }
    const tracking = res.branches.find(b => b.label === 'tracking')
    expect(tracking?.n_back_of_head).toBe(0)
  })

  it('4: n_back_of_head=N when bookmark is frozen N turns back', async () => {
    // Turn 1, bookmark, then 2 more turns. The auto-advance updates only
    // views whose head was the parent of the new revision. With multiple
    // independent turns landing without parent_revision_id chaining (no
    // fork yet), the first bookmark stays put. Verify it's reported as
    // n_back_of_head = position in DESC sequence.
    const turn1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    await call(fx, 'bookmark', { label: 'frozen' })
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }, { role: 'user', content: 'q3' }])
    const res = await call(fx, 'list_branches', {}) as {
      branches: Array<{ label: string | null, head_turn_id: string, n_back_of_head: number | null }>
    }
    const frozen = res.branches.find(b => b.label === 'frozen')
    // The frozen bookmark's head_turn_id is whatever the auto-advance
    // landed on — which depends on the parent chain in the test seeds.
    // Either it stayed at turn1 (n_back_of_head=2 in a 3-element seq) or
    // advanced. The contract is: if head IS in the forkable sequence,
    // n_back_of_head is its DESC index; if not, null. Assert the index
    // matches the actual position.
    expect(frozen).toBeDefined()
    const seq = fx.db.prepare(`
      SELECT id FROM revisions
       WHERE task_id = ? AND classification = 'closed_forkable' AND sealed_at IS NOT NULL
       ORDER BY sealed_at DESC, id DESC
    `).all(fx.taskId) as Array<{ id: string }>
    const expectedIdx = seq.findIndex(r => r.id === frozen!.head_turn_id)
    expect(frozen!.n_back_of_head).toBe(expectedIdx === -1 ? null : expectedIdx)
    // Also verify turn1 still exists in revisions (sanity).
    expect(fx.db.prepare('SELECT id FROM revisions WHERE id = ?').get(turn1.id)).toBeTruthy()
  })

  it('5: n_back_of_head=null when head_revision_id is not in the closed_forkable sequence', async () => {
    // Bookmark a forkable turn, then surgically reclassify that revision
    // to dangling_unforkable. n_back_of_head should fall back to null.
    const turn = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const { view_id } = await call(fx, 'bookmark', { label: 'orphan' }) as {
      view_id: string
    }
    fx.db.prepare(`UPDATE revisions SET classification = 'dangling_unforkable' WHERE id = ?`)
      .run(turn.id)
    const res = await call(fx, 'list_branches', {}) as {
      branches: Array<{ view_id: string, n_back_of_head: number | null }>
    }
    const orphan = res.branches.find(b => b.view_id === view_id)
    expect(orphan?.n_back_of_head).toBeNull()
  })

  it('6: pagination via limit + offset', async () => {
    // Seed 5 forkable turns + one bookmark each.
    for (let i = 0; i < 5; i++) {
      const messages = []
      for (let j = 0; j <= i; j++) {
        messages.push({ role: 'user', content: `q${j}` }, { role: 'assistant', content: `a${j}` })
      }
      messages.pop() // end on user
      emitTurn(fx, 'end_turn', messages)
      await call(fx, 'bookmark', { label: `b${i}` })
    }
    const page1 = await call(fx, 'list_branches', { limit: 2, offset: 0 }) as {
      total: number
      branches: Array<{ label: string | null }>
    }
    const page2 = await call(fx, 'list_branches', { limit: 2, offset: 2 }) as {
      total: number
      branches: Array<{ label: string | null }>
    }
    expect(page1.total).toBe(5)
    expect(page2.total).toBe(5)
    expect(page1.branches.length).toBe(2)
    expect(page2.branches.length).toBe(2)
    // Disjoint pages.
    const p1Labels = page1.branches.map(b => b.label)
    const p2Labels = page2.branches.map(b => b.label)
    for (const lbl of p1Labels) expect(p2Labels).not.toContain(lbl)
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

  it('clean and meta tokens are always distinct (collision guard)', () => {
    // Stress: 10k generations should never produce a clean=meta pair.
    const store = new ConfirmTokenStore()
    for (let i = 0; i < 10_000; i++) {
      const pair = store.generate(`session-${i}`)
      expect(pair.clean).not.toBe(pair.meta)
    }
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

  it('rejects whitespace-only message BEFORE consuming token', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    // Pre-token-check rejection — same as size-cap rejection.
    const r1 = await call(fx, 'rewind_to', { turn_back_n: 1, message: '   ' }) as { error: string }
    expect(r1.error).toMatch(/non-whitespace/)
    const r2 = await call(fx, 'rewind_to', { turn_back_n: 1, message: '\n\n\t' }) as { error: string }
    expect(r2.error).toMatch(/non-whitespace/)
  })

  it('cycle-safe: corrupt parent_revision_id self-loop does not hang', async () => {
    // Seed two closed_forkable revisions, then create a self-loop on the head's
    // parent. effectiveHead and nthForkableBack used to spin forever on this;
    // they now bail via the visited-set + RECALL_MAX_DEPTH cap.
    const t1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    fx.db.prepare('UPDATE revisions SET parent_revision_id = id WHERE id = ?').run(t1.id)
    const start = Date.now()
    // Calling with a high turn_back_n forces the walker to traverse beyond the
    // cycle. Should fail fast, not hang.
    const res = await rewindTwoStep(fx, { turn_back_n: 99, message: 'X' }) as {
      error?: string
      status?: string
    }
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000)
    expect(res.status).toBeUndefined()
    expect(res.error).toMatch(/forkable turns available/)
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

  it('does NOT false-positive on "saw above N%" data narratives (regression guard)', () => {
    // The (?!\s*\d) lookahead in pattern 1 skips numeric-comparison phrasings
    // common in data discussion. Without it, "saw above 90%" falsely matched
    // the meta-reference pattern.
    expect(detectMetaRef('we saw above 90% accuracy')).toBeNull()
    expect(detectMetaRef('the rate read above 7000 RPM')).toBeNull()
    expect(detectMetaRef('see above 1000 ms latency')).toBeNull()
    // But still catches genuine meta-references with non-digit follow-ups.
    expect(detectMetaRef('see above for context')).toBeTruthy()
    expect(detectMetaRef('see above.')).toBeTruthy()
    expect(detectMetaRef('please read above and revise')).toBeTruthy()
  })

  it('META_REFS list has exactly 4 patterns', () => {
    expect(META_REFS.length).toBe(4)
  })
})

// ─── dump_to_file ────────────────────────────────────────────────────────────

describe('dump_to_file', () => {
  let fx: TestFixture
  let retconHome: string
  beforeEach(() => {
    fx = fixture()
    // Each test gets its own RETCON_HOME so dumps from one test don't leak
    // into another. retconDumpsDir() reads process.env.RETCON_HOME at call
    // time, so we just need to set it before invoking the handler.
    retconHome = mkdtempSync(path.join(tmpdir(), 'retcon-dumps-home-'))
    process.env.RETCON_HOME = retconHome
  })
  afterEach(() => {
    delete process.env.RETCON_HOME
    try {
      rmSync(retconHome, { recursive: true, force: true })
    }
    catch { /* ignore */ }
    fx.cleanup()
  })

  it('writes a JSONL dump of the current head and returns the path', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    const res = await call(fx, 'dump_to_file', {}) as {
      path?: string
      error?: string
      turn_id: string
      message_count: number
      next_steps: string
    }
    if (res.error) throw new Error(`dump_to_file failed: ${res.error}`)
    expect(res.path!).toContain('dumps')
    expect(res.message_count).toBeGreaterThan(0)
    expect(res.next_steps).toMatch(/Read tool/)
    // File exists and ends with a newline.
    const content = fs.readFileSync(res.path, { encoding: 'utf8' })
    expect(content.endsWith('\n')).toBe(true)
    const lines = content.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBe(res.message_count)
    // Each line is valid JSON with role + content.
    for (const line of lines) {
      const parsed = JSON.parse(line) as { role: string, content: unknown }
      expect(typeof parsed.role).toBe('string')
      expect(parsed.content).toBeDefined()
    }
    // Last line is assistant role (load-bearing rule).
    const lastLine = JSON.parse(lines[lines.length - 1]!) as { role: string }
    expect(lastLine.role).toBe('assistant')
  })

  it('dumps a specific turn via turn_id', async () => {
    const t1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    const res = await call(fx, 'dump_to_file', { turn_id: t1.id }) as {
      path: string
      turn_id: string
    }
    expect(res.turn_id).toBe(t1.id)
    expect(fs.existsSync(res.path)).toBe(true)
  })

  it('dumps via turn_back_n (matches recall list numbering)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'first' }])
    const t2 = emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'second' },
    ])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'third' },
    ])
    const res = await call(fx, 'dump_to_file', { turn_back_n: 1 }) as {
      path?: string
      turn_id?: string
      error?: string
    }
    if (res.error) throw new Error(`dump_to_file failed: ${res.error}`)
    expect(res.turn_id).toBe(t2.id)
  })

  it('errors with helpful message when no-args called on a fresh session (only 1 turn)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'dump_to_file', {}) as { error: string }
    expect(res.error).toMatch(/at least 2 forkable turns|active forked branch/)
  })

  it('rejects orphan sessions', async () => {
    const orphan = fixture({ orphan: true })
    try {
      const res = await call(orphan, 'dump_to_file', {}) as { error: string }
      expect(res.error).toMatch(/orphan sessions cannot dump/)
    }
    finally {
      orphan.cleanup()
    }
  })

  it('errors when no forkable turn exists (open-only session)', async () => {
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q' }]) // open only
    const res = await call(fx, 'dump_to_file', {}) as { error: string }
    // effectiveHead returns undefined when only in_flight/open revs exist.
    expect(res.error).toMatch(/no settled turns yet|nothing to dump/)
  })

  it('errors on turn_id from a different session', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'dump_to_file', { turn_id: 'rev-unknown' }) as { error: string }
    expect(res.error).toMatch(/not found/)
  })

  it('rejects both turn_id and turn_back_n together', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'dump_to_file', { turn_id: 'x', turn_back_n: 1 }) as { error: string }
    expect(res.error).toMatch(/not both/)
  })

  it('uses branch_context_json when on a forked branch — slices trailing user (post-rewind reality)', async () => {
    // Branch_context_json's tail is ALWAYS user-role in production (rewind_to
    // sets it ending in the new user message; subsequent applyBranchContextRewrite
    // extends it ending in the user just typed by claude — Anthropic requires
    // request bodies end in user). dump_to_file must slice off the trailing
    // user line(s) so the file ends at the most recent assistant response.
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const branchMessages = [
      { role: 'user', content: 'forked q' },
      { role: 'assistant', content: 'forked a' },
      { role: 'user', content: 'pending user (would-be next prompt)' },
    ]
    fx.db.prepare('UPDATE sessions SET branch_context_json = ? WHERE id = ?')
      .run(JSON.stringify(branchMessages), fx.sessionId)
    const res = await call(fx, 'dump_to_file', {}) as {
      path?: string
      message_count?: number
      is_branch_view?: boolean
      error?: string
    }
    if (res.error) throw new Error(`dump_to_file failed: ${res.error}`)
    expect(res.is_branch_view).toBe(true)
    expect(res.message_count).toBe(2) // trailing user sliced
    const content = fs.readFileSync(res.path!, { encoding: 'utf8' })
    const lines = content.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]!).content).toBe('forked q')
    expect(JSON.parse(lines[1]!).role).toBe('assistant')
    expect(JSON.parse(lines[1]!).content).toBe('forked a')
  })

  it('handles deeply-nested trailing-user branch_context (multi-user-tail)', async () => {
    // Edge case: if for some reason branch_context has multiple consecutive
    // trailing users, slice them all so we land on the most recent assistant.
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    fx.db.prepare('UPDATE sessions SET branch_context_json = ? WHERE id = ?')
      .run(JSON.stringify([
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'user', content: 'u3' },
      ]), fx.sessionId)
    const res = await call(fx, 'dump_to_file', {}) as { message_count: number, error?: string }
    if (res.error) throw new Error(res.error)
    expect(res.message_count).toBe(2) // [u1, a1]
  })

  it('falls through to reconstructForkMessages if branch_context is all-user (corrupt state)', async () => {
    // Pathological: branch_context is just users with no assistant. Slicing
    // empties it; we fall through to reconstructForkMessages. With turn_back_n=1
    // the target is one-before-head, which has a child (head) whose body
    // contains the assistant response — reconstruct succeeds.
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    fx.db.prepare('UPDATE sessions SET branch_context_json = ? WHERE id = ?')
      .run(JSON.stringify([
        { role: 'user', content: 'all-user-1' },
        { role: 'user', content: 'all-user-2' },
      ]), fx.sessionId)
    // turn_back_n=1 targets the FIRST turn (q1's revision); branch_context
    // is only consulted on the head case, so this dump uses reconstruct
    // directly without touching the corrupt state.
    const res = await call(fx, 'dump_to_file', { turn_back_n: 1 }) as {
      is_branch_view?: boolean
      message_count?: number
      error?: string
    }
    if (res.error) throw new Error(res.error)
    expect(res.is_branch_view).toBe(false) // not the head, so branch_context not used
    expect(res.message_count).toBeGreaterThanOrEqual(1)
  })

  it('rejects sessionId with path-traversal characters (defense-in-depth)', async () => {
    // The valid-paths regex in dump_to_file is the boundary check. Easiest
    // way to exercise it: emit an mcp.session_initialized for a malicious
    // session id and let the projector populate the session row normally,
    // then call dump_to_file with that session id in the ctx.
    const evil = fixture()
    try {
      const evilId = '../../../tmp/evil'
      evil.producer.emit('mcp.session_initialized', { mcp_session_id: 'm', harness: 'claude-code' }, evilId)
      // Add a closed_forkable so the no-args default has a target.
      const bodyBytes = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }), 'utf8')
      const bodyCid = `bafy-evil-${Math.random().toString(36).slice(2)}`
      const req = evil.producer.emit(
        'proxy.request_received',
        { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: bodyCid },
        evilId,
        [{ cid: bodyCid, bytes: bodyBytes }],
      )
      evil.producer.emit('proxy.response_completed', {
        request_event_id: req.id,
        status: 200,
        headers_cid: 'h',
        body_cid: 'r',
        stop_reason: 'end_turn',
        asset_cid: 'a',
      }, evilId)
      // Need a second turn so the no-args default (one-before-head) has data
      // to reconstruct from — that's the path that exercises filename safety.
      const bodyCid2 = `bafy-evil-${Math.random().toString(36).slice(2)}`
      const req2 = evil.producer.emit(
        'proxy.request_received',
        { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: bodyCid2 },
        evilId,
        [{ cid: bodyCid2, bytes: Buffer.from(JSON.stringify({ messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'q2' },
        ] }), 'utf8') }],
      )
      evil.producer.emit('proxy.response_completed', {
        request_event_id: req2.id,
        status: 200,
        headers_cid: 'h',
        body_cid: 'r',
        stop_reason: 'end_turn',
        asset_cid: 'a',
      }, evilId)

      const tools = createMcpTools({
        db: evil.db,
        tobeStore: evil.tobeStore,
        storageProvider: evil.storageProvider,
        rewindEnabled: true,
      })
      const res = await tools.get('dump_to_file')!.handler(
        {},
        { sessionId: evilId, producer: evil.producer },
      ) as { error?: string }
      expect(res.error).toMatch(/unsafe for filesystem use/)
    }
    finally {
      evil.cleanup()
    }
  })
})

// ─── submit_file ─────────────────────────────────────────────────────────────

describe('submit_file (dual-secret + path safety)', () => {
  let fx: TestFixture
  let dumpsRoot: string
  beforeEach(() => {
    fx = fixture()
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'retcon-submit-test-'))
    process.env.RETCON_HOME = tmpRoot
    dumpsRoot = path.join(tmpRoot, 'dumps')
    fs.mkdirSync(dumpsRoot, { recursive: true })
  })
  afterEach(() => {
    const home = process.env.RETCON_HOME
    delete process.env.RETCON_HOME
    if (home) {
      try {
        rmSync(home, { recursive: true, force: true })
      }
      catch { /* ignore */ }
    }
    fx.cleanup()
  })

  /** Helper: write a JSONL file inside dumpsRoot with the given messages. */
  function writeDump(filename: string, messages: Array<{ role: string, content: unknown }>): string {
    const content = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    const full = path.join(dumpsRoot, filename)
    fs.writeFileSync(full, content, { encoding: 'utf8' })
    return full
  }

  /** Two-step submit_file helper, parallel to rewindTwoStep. */
  async function submitTwoStep(
    args: Record<string, unknown>,
    opts: { tokenChoice?: 'clean' | 'meta', confirmOverride?: string } = {},
  ): Promise<unknown> {
    const tokenStore = new ConfirmTokenStore()
    const tools = createMcpToolsWithTokens(
      {
        db: fx.db,
        tobeStore: fx.tobeStore,
        storageProvider: fx.storageProvider,
        rewindEnabled: true,
      },
      { rewind: new ConfirmTokenStore(), submit: tokenStore },
    )
    const tool = tools.get('submit_file')!
    const first = await tool.handler(args, { sessionId: fx.sessionId, producer: fx.producer }) as {
      status: string
      confirm_clean?: string
      confirm_meta?: string
    }
    if (first.status !== 'rules_returned') return first
    const choice = opts.tokenChoice ?? 'clean'
    const confirm = opts.confirmOverride
      ?? (choice === 'clean' ? first.confirm_clean! : first.confirm_meta!)
    return tool.handler({ ...args, confirm }, { sessionId: fx.sessionId, producer: fx.producer })
  }

  it('first call returns rules + token pair (rules mention assistant-must-end)', async () => {
    const dump = writeDump('test.jsonl', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    const res = await call(fx, 'submit_file', { path: dump, message: 'X' }) as {
      status: string
      rules: string
      confirm_clean: string
      confirm_meta: string
    }
    expect(res.status).toBe('rules_returned')
    expect(res.rules).toMatch(/LAST line.*assistant/i)
    expect(res.confirm_clean).toMatch(/^[A-Za-z0-9]{8}$/)
  })

  it('clean-token + valid dump → writes TOBE + scheduled response', async () => {
    // Need at least one forkable revision in the session — submit_file uses
    // it as the fork-point anchor for the emitted event.
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'session-q' }])
    const dump = writeDump('valid.jsonl', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ])
    const res = await submitTwoStep({ path: dump, message: 'continue with X' }) as {
      status: string
      message: string
      message_count: number
    }
    expect(res.status).toBe('scheduled')
    expect(res.message).toMatch(/RETCON ERROR/)
    expect(res.message_count).toBe(3) // 2 dump + 1 appended user
    const pending = fx.tobeStore.peek(fx.sessionId)!
    expect(pending.messages.length).toBe(3)
    const last = pending.messages[2] as { role: string, content: string }
    expect(last.role).toBe('user')
    expect(last.content).toBe('continue with X')
  })

  it('errors when session has no forkable revision yet', async () => {
    const dump = writeDump('valid.jsonl', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    // No emitTurn — session has no closed_forkable revisions.
    const res = await submitTwoStep({ path: dump, message: 'X' }) as { error: string }
    expect(res.error).toMatch(/at least one settled turn/)
  })

  it('rejects path traversal outside dumps dir', async () => {
    // Write a file OUTSIDE the dumps dir.
    const outside = path.join(tmpdir(), `retcon-outside-${Date.now()}.jsonl`)
    fs.writeFileSync(outside, '{"role":"assistant","content":"a"}\n')
    try {
      const res = await call(fx, 'submit_file', { path: outside, message: 'X' }) as { error: string }
      expect(res.error).toMatch(/must resolve inside/)
    }
    finally {
      try {
        fs.unlinkSync(outside)
      }
      catch { /* ignore */ }
    }
  })

  it('rejects nonexistent path', async () => {
    const ghost = path.join(dumpsRoot, 'no-such-file.jsonl')
    const res = await call(fx, 'submit_file', { path: ghost, message: 'X' }) as { error: string }
    expect(res.error).toMatch(/does not exist/)
  })

  it('rejects malformed JSONL line', async () => {
    const dump = path.join(dumpsRoot, 'broken.jsonl')
    fs.writeFileSync(dump, '{"role":"user","content":"q"}\n{not json\n{"role":"assistant","content":"a"}\n')
    const res = await submitTwoStep({ path: dump, message: 'X' }) as { error: string }
    expect(res.error).toMatch(/line 2 is not valid JSON/)
  })

  it('rejects line missing role or content', async () => {
    const dump = path.join(dumpsRoot, 'missing-role.jsonl')
    fs.writeFileSync(dump, '{"role":"user","content":"q"}\n{"content":"orphan"}\n')
    const res = await submitTwoStep({ path: dump, message: 'X' }) as { error: string }
    expect(res.error).toMatch(/line 2 missing string `role`/)
  })

  it('rejects line with role outside the user|assistant|system allowlist', async () => {
    const dump = path.join(dumpsRoot, 'bad-role.jsonl')
    fs.writeFileSync(dump,
      '{"role":"user","content":"q"}\n'
      + '{"role":"junk","content":"unsupported"}\n'
      + '{"role":"assistant","content":"a"}\n',
    )
    const res = await submitTwoStep({ path: dump, message: 'X' }) as { error: string }
    expect(res.error).toMatch(/invalid role "junk"/)
  })

  it('handles CRLF line endings (Windows-style dumps)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'session' }])
    const dump = path.join(dumpsRoot, 'crlf.jsonl')
    // Same content as a valid dump but with \r\n separators.
    fs.writeFileSync(dump,
      '{"role":"user","content":"q"}\r\n'
      + '{"role":"assistant","content":"a"}\r\n',
    )
    const res = await submitTwoStep({ path: dump, message: 'continue' }) as { status: string }
    expect(res.status).toBe('scheduled')
  })

  it('rejects dump file larger than MAX_DUMP_BYTES', async () => {
    const dump = path.join(dumpsRoot, 'huge.jsonl')
    // Write a single huge user line, then a small assistant tail. Total > 8 MiB.
    const bigContent = 'x'.repeat(10 * 1024 * 1024) // 10 MiB
    fs.writeFileSync(dump,
      `${JSON.stringify({ role: 'user', content: bigContent })}\n`
      + `${JSON.stringify({ role: 'assistant', content: 'a' })}\n`,
    )
    const res = await submitTwoStep({ path: dump, message: 'X' }) as { error: string }
    expect(res.error).toMatch(/exceeds.*cap/)
  })

  it('rejects last-line-not-assistant (Decision #4 load-bearing rule)', async () => {
    const dump = writeDump('user-tail.jsonl', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'extra user' }, // BAD: trailing user
    ])
    const res = await submitTwoStep({ path: dump, message: 'X' }) as { error: string }
    expect(res.error).toMatch(/last line has role="user"/)
  })

  it('rejects empty dump file', async () => {
    const dump = path.join(dumpsRoot, 'empty.jsonl')
    fs.writeFileSync(dump, '')
    const res = await submitTwoStep({ path: dump, message: 'X' }) as { error: string }
    expect(res.error).toMatch(/empty/)
  })

  it('rejects whitespace-only message before consuming token', async () => {
    const dump = writeDump('valid.jsonl', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    const res = await call(fx, 'submit_file', { path: dump, message: '   ' }) as { error: string }
    expect(res.error).toMatch(/non-whitespace/)
  })

  it('meta_token → educational rejection + new token pair', async () => {
    const dump = writeDump('valid.jsonl', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    const res = await submitTwoStep(
      { path: dump, message: 'see above for context' },
      { tokenChoice: 'meta' },
    ) as { status: string, message: string }
    expect(res.status).toBe('rejected')
    expect(res.message).toMatch(/Good catch/)
    expect(fx.tobeStore.peek(fx.sessionId)).toBeNull()
  })

  it('clean-token + regex-flagged message → rejection (no TOBE)', async () => {
    const dump = writeDump('valid.jsonl', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    const res = await submitTwoStep({
      path: dump,
      message: 'see above for context',
    }) as { status: string }
    expect(res.status).toBe('rejected')
    expect(fx.tobeStore.peek(fx.sessionId)).toBeNull()
  })

  it('clean-token + allow_meta_refs=true bypasses regex', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'session-q' }])
    const dump = writeDump('valid.jsonl', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    const res = await submitTwoStep({
      path: dump,
      message: 'see above for the corrected number, then continue',
      allow_meta_refs: true,
    }) as { status: string }
    expect(res.status).toBe('scheduled')
  })

  it('emits fork.back_requested with via=submit_file', async () => {
    const dump = writeDump('valid.jsonl', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'session-q' }])
    await submitTwoStep({ path: dump, message: 'continue' })
    const ev = fx.db.prepare(
      `SELECT payload FROM events WHERE topic = 'fork.back_requested' AND session_id = ? ORDER BY event_id DESC LIMIT 1`,
    ).get(fx.sessionId) as { payload: string }
    const parsed = JSON.parse(ev.payload) as { via?: string, dump_path?: string }
    expect(parsed.via).toBe('submit_file')
    expect(parsed.dump_path).toContain('dumps')
  })

  it('writes branch_context_json so submit persists across turns', async () => {
    const dump = writeDump('valid.jsonl', [
      { role: 'user', content: 'historical q' },
      { role: 'assistant', content: 'historical a' },
    ])
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'session-q' }])
    await submitTwoStep({ path: dump, message: 'continue' })
    const row = fx.db.prepare('SELECT branch_context_json FROM sessions WHERE id = ?').get(fx.sessionId) as
      | { branch_context_json: string | null } | undefined
    expect(row?.branch_context_json).not.toBeNull()
    const msgs = JSON.parse(row!.branch_context_json!) as Array<{ role: string }>
    expect(msgs.length).toBe(3) // 2 dump + 1 appended user
    expect(msgs[2]!.role).toBe('user')
  })
})

// ─── gcDumps (daemon GC sweep) ───────────────────────────────────────────────

describe('createMcpToolsWithTokens (defensive construction)', () => {
  function deps() {
    const fx = fixture()
    return {
      fx,
      asDeps: {
        db: fx.db,
        tobeStore: fx.tobeStore,
        storageProvider: fx.storageProvider,
        rewindEnabled: true,
      },
    }
  }

  it('throws if rewind store is missing in the object form', () => {
    const { fx, asDeps } = deps()
    try {
      expect(() => createMcpToolsWithTokens(
        asDeps,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { rewind: undefined as any, submit: new ConfirmTokenStore() },
      )).toThrow(/both rewind and submit/)
    }
    finally { fx.cleanup() }
  })

  it('throws if submit store is missing in the object form', () => {
    const { fx, asDeps } = deps()
    try {
      expect(() => createMcpToolsWithTokens(
        asDeps,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { rewind: new ConfirmTokenStore(), submit: undefined as any },
      )).toThrow(/both rewind and submit/)
    }
    finally { fx.cleanup() }
  })

  it('accepts a single ConfirmTokenStore (back-compat with rewind-only tests)', () => {
    const { fx, asDeps } = deps()
    try {
      expect(() => createMcpToolsWithTokens(asDeps, new ConfirmTokenStore())).not.toThrow()
    }
    finally { fx.cleanup() }
  })
})

// ─── Phase 1 (v0.5.0): SR-construction TOBE + parallel-tool guard ────────────

/**
 * Emit a request_received + response_completed pair where the response body
 * is real JSON content stored as a content-addressed blob. Used by parallel-
 * tool-guard tests so loadResponseToolUses can actually inspect the body.
 */
async function emitTurnWithRealResponse(
  fx: TestFixture,
  stopReason: string,
  reqMessages: unknown[],
  respContent: Array<{ type: string, id?: string, name?: string, text?: string, input?: unknown }>,
): Promise<Event> {
  const { blobRefFromBytes } = await import('../body-blob.js')

  const reqBytes = Buffer.from(JSON.stringify({ messages: reqMessages }), 'utf8')
  const reqCid = `bafy-req-${Math.random().toString(36).slice(2)}`
  const req = fx.producer.emit(
    'proxy.request_received',
    { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: reqCid },
    fx.sessionId,
    [{ cid: reqCid, bytes: reqBytes }],
  )

  const respBytes = Buffer.from(
    JSON.stringify({ role: 'assistant', stop_reason: stopReason, content: respContent }),
    'utf8',
  )
  const respBlob = await blobRefFromBytes(respBytes)
  fx.producer.emit(
    'proxy.response_completed',
    {
      request_event_id: req.id,
      status: 200,
      headers_cid: 'h',
      body_cid: respBlob.cid,
      stop_reason: stopReason,
      asset_cid: 'bafy-asset',
    },
    fx.sessionId,
    [respBlob.ref],
  )
  return req
}

describe('rewind_to: parallel-tool guard (Phase 1)', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  it('first-call rules text contains the parallel-tool warning', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'rewind_to', { turn_back_n: 1, message: 'X' }) as {
      status: string
      rules: string
    }
    expect(res.status).toBe('rules_returned')
    expect(res.rules).toMatch(/PARALLEL TOOLS/i)
    expect(res.rules).toMatch(/lose their results/i)
  })

  it('rejects when R1 has parallel tool_uses (rewind_to + read_file)', async () => {
    // Seed two settled turns so turn_back_n=1 has a target.
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'first' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    // R1 (mostRecentRevision) emits BOTH rewind_to and read_file.
    await emitTurnWithRealResponse(fx, 'tool_use', [{ role: 'user', content: 'q3' }], [
      { type: 'tool_use', id: 'toolu_rewind', name: 'rewind_to', input: { turn_back_n: 1, message: 'X' } },
      { type: 'tool_use', id: 'toolu_read', name: 'read_file', input: { path: '/etc/foo' } },
    ])
    const res = await rewindTwoStep(fx, { turn_back_n: 1, message: 'switch to plan B' }) as {
      error?: string
      status?: string
    }
    expect(res.error).toMatch(/parallel/i)
    expect(res.error).toMatch(/read_file/)
    // No TOBE write on rejection.
    expect(fx.tobeStore.peek(fx.sessionId)).toBeNull()
  })

  it('accepts when R1 has only the rewind_to tool_use', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'first' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    await emitTurnWithRealResponse(fx, 'tool_use', [{ role: 'user', content: 'q3' }], [
      { type: 'tool_use', id: 'toolu_rewind', name: 'rewind_to', input: { turn_back_n: 1, message: 'X' } },
    ])
    const res = await rewindTwoStep(fx, { turn_back_n: 1, message: 'switch to plan B' }) as {
      status: string
    }
    expect(res.status).toBe('scheduled')
    expect(fx.tobeStore.peek(fx.sessionId)).toBeTruthy()
  })
})

describe('rewind_to: extended TOBE shape (Phase 1)', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  it('writes synthetic SR-construction metadata to TOBE pending file', async () => {
    const t1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'first' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    const r1 = await emitTurnWithRealResponse(fx, 'tool_use', [{ role: 'user', content: 'q3' }], [
      { type: 'tool_use', id: 'toolu_rewind_42', name: 'rewind_to', input: { turn_back_n: 1, message: 'X' } },
    ])
    await rewindTwoStep(fx, { turn_back_n: 1, message: 'plan B' })
    const pending = fx.tobeStore.peek(fx.sessionId)
    expect(pending).toBeTruthy()
    expect(pending!.synthetic).toBeTruthy()
    const s = pending!.synthetic!
    expect(s.kind).toBe('rewind')
    expect(s.tool_use_id).toBe('toolu_rewind_42')
    expect(s.parent_revision_id).toBe(r1.id)
    expect(s.synthetic_user_message).toBe('plan B')
    expect(s.synthetic_revision_id).toMatch(/^[a-z0-9]/i)
    expect(s.synthetic_revision_id).not.toBe(r1.id)
    expect(s.synthetic_revision_id).not.toBe(t1.id)
    // R2'/R3' content includes the fork target in shorthand form.
    expect(s.synthetic_tool_result_text).toContain(t1.id.slice(0, 8))
    expect(s.synthetic_tool_result_text).toContain('plan B')
    expect(s.synthetic_assistant_text).toContain(t1.id.slice(0, 8))
    expect(s.target_view_id).toMatch(/.+/)
    expect(s.back_requested_at).toBeGreaterThan(0)
  })

  it('omits synthetic field when R1 has no resolvable response body', async () => {
    // Existing emitTurn with bafy-resp fake CID → loadResponseToolUses fails →
    // synthetic field stays undefined. Pre-1.0 alpha graceful path.
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'first' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    await rewindTwoStep(fx, { turn_back_n: 1, message: 'plan B' })
    const pending = fx.tobeStore.peek(fx.sessionId)
    expect(pending).toBeTruthy()
    expect(pending!.synthetic).toBeUndefined()
  })

  it('TOBE roundtrip: write + peek preserves all synthetic fields', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'first' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    await emitTurnWithRealResponse(fx, 'tool_use', [{ role: 'user', content: 'q3' }], [
      { type: 'tool_use', id: 'toolu_x', name: 'rewind_to', input: { turn_back_n: 1, message: 'X' } },
    ])
    await rewindTwoStep(fx, { turn_back_n: 1, message: 'roundtrip me' })
    // Read directly via fs to ensure JSON serialization round-trips correctly.
    const pendingPath = fx.tobeStore.fileFor(fx.sessionId)
    const raw = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as { synthetic?: Record<string, unknown> }
    expect(raw.synthetic).toBeTruthy()
    expect(raw.synthetic!.kind).toBe('rewind')
    expect(raw.synthetic!.synthetic_user_message).toBe('roundtrip me')
    expect(raw.synthetic!.tool_use_id).toBe('toolu_x')
    expect(typeof raw.synthetic!.back_requested_at).toBe('number')
  })
})

describe('submit_file: parallel-tool guard + extended TOBE (Phase 1)', () => {
  let fx: TestFixture
  let dumpsDir: string

  beforeEach(() => {
    fx = fixture()
    dumpsDir = mkdtempSync(path.join(tmpdir(), 'retcon-test-dumps-'))
    process.env.RETCON_HOME = path.dirname(dumpsDir)
    // Move dumps to <RETCON_HOME>/dumps to satisfy retconDumpsDir().
    const target = path.join(path.dirname(dumpsDir), 'dumps')
    if (fs.existsSync(target)) rmSync(target, { recursive: true, force: true })
    fs.renameSync(dumpsDir, target)
    dumpsDir = target
  })
  afterEach(() => {
    fx.cleanup()
    rmSync(dumpsDir, { recursive: true, force: true })
    delete process.env.RETCON_HOME
  })

  function writeDump(filename: string, lines: Array<{ role: string, content: unknown }>): string {
    const filePath = path.join(dumpsDir, filename)
    fs.writeFileSync(filePath, lines.map(m => JSON.stringify(m)).join('\n'))
    return filePath
  }

  async function submitTwoStep(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const tokenStore = new ConfirmTokenStore()
    const tools = createMcpToolsWithTokens(
      {
        db: fx.db,
        tobeStore: fx.tobeStore,
        storageProvider: fx.storageProvider,
        rewindEnabled: true,
      },
      { rewind: tokenStore, submit: new ConfirmTokenStore() },
    )
    const tool = tools.get('submit_file')!
    const first = await tool.handler(args, { sessionId: fx.sessionId, producer: fx.producer }) as {
      status: string
      confirm_clean?: string
    }
    if (first.status !== 'rules_returned') return first
    return tool.handler(
      { ...args, confirm: first.confirm_clean! },
      { sessionId: fx.sessionId, producer: fx.producer },
    )
  }

  it('first-call rules text contains the parallel-tool warning', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const dumpPath = writeDump('seed.jsonl', [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old reply' },
    ])
    const tools = createMcpTools({
      db: fx.db,
      tobeStore: fx.tobeStore,
      storageProvider: fx.storageProvider,
    })
    const res = await tools.get('submit_file')!.handler(
      { path: dumpPath, message: 'X' },
      { sessionId: fx.sessionId, producer: fx.producer },
    ) as { status: string, rules: string }
    expect(res.status).toBe('rules_returned')
    expect(res.rules).toMatch(/PARALLEL TOOLS/i)
    expect(res.rules).toMatch(/lose their results/i)
  })

  it('rejects when R1 has parallel tool_uses (submit_file + read_file)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'first' }])
    await emitTurnWithRealResponse(fx, 'tool_use', [{ role: 'user', content: 'q2' }], [
      { type: 'tool_use', id: 'toolu_submit', name: 'submit_file', input: { path: 'x', message: 'y' } },
      { type: 'tool_use', id: 'toolu_read', name: 'read_file', input: { path: '/etc/foo' } },
    ])
    const dumpPath = writeDump('parallel.jsonl', [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old reply' },
    ])
    const res = await submitTwoStep({ path: dumpPath, message: 'submit me' }) as {
      error?: string
    }
    expect(res.error).toMatch(/parallel/i)
    expect(res.error).toMatch(/read_file/)
    expect(fx.tobeStore.peek(fx.sessionId)).toBeNull()
  })

  it('writes synthetic SR-construction metadata to TOBE pending file', async () => {
    const t1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'first' }])
    const r1 = await emitTurnWithRealResponse(fx, 'tool_use', [{ role: 'user', content: 'q2' }], [
      { type: 'tool_use', id: 'toolu_submit_99', name: 'submit_file', input: { path: 'x', message: 'y' } },
    ])
    const dumpPath = writeDump('happy.jsonl', [
      { role: 'user', content: 'edited 1' },
      { role: 'assistant', content: 'edited reply' },
    ])
    const res = await submitTwoStep({ path: dumpPath, message: 'apply edits' }) as {
      status: string
    }
    expect(res.status).toBe('scheduled')
    const pending = fx.tobeStore.peek(fx.sessionId)
    expect(pending).toBeTruthy()
    expect(pending!.synthetic).toBeTruthy()
    const s = pending!.synthetic!
    expect(s.kind).toBe('submit')
    expect(s.tool_use_id).toBe('toolu_submit_99')
    expect(s.parent_revision_id).toBe(r1.id)
    expect(s.synthetic_user_message).toBe('apply edits')
    expect(s.synthetic_tool_result_text).toContain(t1.id.slice(0, 8))
    expect(s.synthetic_tool_result_text).toContain('happy.jsonl')
    expect(s.synthetic_tool_result_text).toContain('2 messages')
    expect(s.synthetic_assistant_text).toMatch(/Submission applied/)
  })
})

describe('gcDumps', () => {
  it('imports as a named export from cli/daemon', async () => {
    // Indirect import via dynamic require to avoid coupling all the other
    // tests to daemon module loading order.
    const { gcDumps } = await import('../cli/daemon.js')
    expect(typeof gcDumps).toBe('function')
  })

  it('removes files older than ttlMs, keeps fresh ones', async () => {
    const { gcDumps } = await import('../cli/daemon.js')
    const dir = mkdtempSync(path.join(tmpdir(), 'retcon-gc-test-'))
    try {
      const oldFile = path.join(dir, 'old.jsonl')
      const freshFile = path.join(dir, 'fresh.jsonl')
      fs.writeFileSync(oldFile, '{}')
      fs.writeFileSync(freshFile, '{}')
      // Backdate oldFile by 48 hours.
      const old = Date.now() - 48 * 60 * 60 * 1000
      fs.utimesSync(oldFile, old / 1000, old / 1000)
      gcDumps(dir, 24 * 60 * 60 * 1000)
      expect(fs.existsSync(oldFile)).toBe(false)
      expect(fs.existsSync(freshFile)).toBe(true)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives missing directory (returns silently)', async () => {
    const { gcDumps } = await import('../cli/daemon.js')
    expect(() => gcDumps('/tmp/this-dir-does-not-exist-xyzzy', 1000)).not.toThrow()
  })
})
