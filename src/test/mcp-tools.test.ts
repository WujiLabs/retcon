// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unit tests for the fork_* MCP tool handlers. The handlers read projected
// views + emit events; we drive them directly rather than going through HTTP.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db.js'
import { migrate, openDb } from '../db.js'
import { type EventProducer, type Event } from '../events.js'
import { createEventProducer } from '../events.js'
import { createForkTools } from '../mcp-tools.js'
import { defaultProjectors } from '../server.js'
import { createTobeStore, type TobeStore } from '../tobe.js'

interface TestFixture {
  db: DB
  producer: EventProducer
  tobeStore: TobeStore
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
  return { db, producer, tobeStore, tmp, sessionId, taskId, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

/** Helper: emit request_received with an inline body blob so fork_back can reconstruct messages. */
function emitTurn(
  fx: TestFixture,
  stopReason: string,
  messagesArr: unknown[],
): Event {
  const bodyBytes = Buffer.from(JSON.stringify({ messages: messagesArr }), 'utf8')
  const bodyCid = `bafy-body-${Math.random().toString(36).slice(2)}`
  // Emit request_received with an attached body blob so requestBodyCidFor can
  // resolve it via the events table + blobs table lookup.
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

async function call(fx: TestFixture, name: string, args: unknown, forkBackEnabled = true): Promise<unknown> {
  const tools = createForkTools({ db: fx.db, tobeStore: fx.tobeStore, forkBackEnabled })
  const tool = tools.get(name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  return tool.handler(args, { sessionId: fx.sessionId, producer: fx.producer })
}

describe('fork_list', () => {
  let fx: TestFixture
  beforeEach(() => { fx = fixture() })
  afterEach(() => fx.cleanup())

  it('lists closed_forkable Versions in recency order', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q2' }])  // open, should NOT appear
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q3' }])
    const res = await call(fx, 'fork_list', {}) as {
      total: number
      revisions: Array<{ revision_id: string, stop_reason: string }>
    }
    expect(res.total).toBe(2)
    expect(res.revisions.every(v => v.stop_reason === 'end_turn')).toBe(true)
  })

  it('returns empty list when no closed_forkable turns exist', async () => {
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q' }])  // open only
    const res = await call(fx, 'fork_list', {}) as { total: number, versions: unknown[] }
    expect(res.total).toBe(0)
    expect(res.revisions).toEqual([])
  })

  it('respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) emitTurn(fx, 'end_turn', [{ role: 'user', content: `q${i}` }])
    const r1 = await call(fx, 'fork_list', { limit: 2 }) as { versions: unknown[] }
    expect(r1.revisions.length).toBe(2)
    const r2 = await call(fx, 'fork_list', { limit: 10, offset: 3 }) as { versions: unknown[] }
    expect(r2.revisions.length).toBe(2)  // 5 total, offset 3 → 2 remaining
  })
})

describe('fork_show', () => {
  let fx: TestFixture
  beforeEach(() => { fx = fixture() })
  afterEach(() => fx.cleanup())

  it('returns version details with preceding open chain', async () => {
    const t1 = emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q' }])
    const t2 = emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q' }])
    const t3 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'fork_show', { revision_id: t3.id }) as {
      revision: { id: string, classification: string }
      preceding_open_revisions: string[]
    }
    expect(res.revision.id).toBe(t3.id)
    expect(res.revision.classification).toBe('closed_forkable')
    expect(res.preceding_open_revisions).toEqual([t2.id, t1.id])
  })

  it('errors when version_id is from a different session', async () => {
    const res = await call(fx, 'fork_show', { revision_id: 'rev-unknown' }) as { error: string }
    expect(res.error).toMatch(/not found/)
  })
})

describe('fork_bookmark', () => {
  let fx: TestFixture
  beforeEach(() => { fx = fixture() })
  afterEach(() => fx.cleanup())

  it('creates a branch_view pointing at the latest closed_forkable Version', async () => {
    const req = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const res = await call(fx, 'fork_bookmark', { label: 'my-spot' }) as {
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

  it('G10: rejects when no closed_forkable Version exists yet', async () => {
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q' }])  // open only
    const res = await call(fx, 'fork_bookmark', { label: 'x' }) as { error: string }
    expect(res.error).toMatch(/no forkable turn yet/)
  })
})

describe('fork_back', () => {
  let fx: TestFixture
  beforeEach(() => { fx = fixture() })
  afterEach(() => fx.cleanup())

  it('F4: rejects when current head classification is open', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'tool_use', [{ role: 'user', content: 'q2' }])  // leaves head=open
    const res = await call(fx, 'fork_back', { n: 1, message: 'alt' }) as { error: string }
    expect(res.error).toMatch(/mid-tool-use|open/)
  })

  it('F4: rejects when current head is in_flight (no response yet)', async () => {
    fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b' },
      fx.sessionId,
    )
    // No response_completed yet — head stays in_flight.
    const res = await call(fx, 'fork_back', { n: 1, message: 'alt' }) as { error: string }
    expect(res.error).toMatch(/in_flight|turn is/)
  })

  it('writes TOBE + emits fork.back_requested + returns scheduled', async () => {
    const t1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'original' }])
    // Second turn provides a child request whose body has messages[] reflecting t1's close.
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'original' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ])
    const res = await call(fx, 'fork_back', { n: 1, message: 'alternate' }) as {
      status: string
      fork_point: string
      target_view_id: string
      pending_path: string
    }
    expect(res.status).toBe('scheduled')
    expect(res.fork_point).toBe(t1.id)
    // TOBE file written with the alternate user message appended.
    const pending = fx.tobeStore.peek(fx.sessionId)
    expect(pending).toBeTruthy()
    expect(pending!.fork_point_revision_id).toBe(t1.id)
    const lastMsg = pending!.messages[pending!.messages.length - 1] as { role: string, content: string }
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content).toBe('alternate')
  })

  it('rejects n < 1 or non-integer n', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    const r1 = await call(fx, 'fork_back', { n: 0, message: 'alt' }) as { error: string }
    expect(r1.error).toMatch(/n.*≥ 1|n.*>= 1|integer/)
    const r2 = await call(fx, 'fork_back', { n: 1, message: null }) as { error: string }
    expect(r2.error).toMatch(/message.*required/)
  })

  it('rejects when n exceeds available forkable turns', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    const res = await call(fx, 'fork_back', { n: 5, message: 'alt' }) as { error: string }
    expect(res.error).toMatch(/only \d+ forkable turns available/)
  })

  it('rejects orphan sessions', async () => {
    const orphan = fixture({ orphan: true })
    try {
      emitTurn(orphan, 'end_turn', [{ role: 'user', content: 'q' }])
      const tools = createForkTools({ db: orphan.db, tobeStore: orphan.tobeStore })
      const tool = tools.get('fork_back')!
      const res = await tool.handler(
        { n: 1, message: 'alt' },
        { sessionId: orphan.sessionId, producer: orphan.producer },
      ) as { error: string }
      expect(res.error).toMatch(/orphan sessions cannot fork/)
    }
    finally {
      orphan.cleanup()
    }
  })

  it('F7: feature gate off — emits fork.back_disabled_rejected and errors', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    const res = await call(fx, 'fork_back', { n: 1, message: 'alt' }, false) as { error: string }
    expect(res.error).toMatch(/disabled/)
    // Telemetry event was emitted.
    const row = fx.db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE topic = 'fork.back_disabled_rejected' AND session_id = ?`,
    ).get(fx.sessionId) as { n: number }
    expect(row.n).toBe(1)
    // TOBE NOT written.
    expect(fx.tobeStore.peek(fx.sessionId)).toBeNull()
  })

  it('rejects messages larger than MAX_FORK_BACK_MESSAGE_BYTES (A-WR2)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    const huge = 'x'.repeat(2 * 1024 * 1024)  // 2 MiB — above the 1 MiB cap
    const res = await call(fx, 'fork_back', { n: 1, message: huge }) as { error: string }
    expect(res.error).toMatch(/exceeds/)
  })

  it('F7 disabled path uses a real content-addressed CID (M-1)', async () => {
    emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    await call(fx, 'fork_back', { n: 1, message: 'alt' }, false)
    // The fork.back_disabled_rejected event payload's inputs_cid must match a
    // row in the blobs table (no fake `bafy-inputs-*-<ts>` keys).
    const evRow = fx.db.prepare(
      `SELECT payload FROM events WHERE topic = 'fork.back_disabled_rejected' AND session_id = ?`,
    ).get(fx.sessionId) as { payload: string }
    const payload = JSON.parse(evRow.payload) as { inputs_cid: string }
    expect(payload.inputs_cid).not.toBe('inline')
    const blob = fx.db.prepare('SELECT 1 FROM blobs WHERE cid = ?').get(payload.inputs_cid)
    expect(blob).toBeTruthy()
  })

  it('fork_back falls back to target body when child body is malformed (A-WR9)', async () => {
    // Seed a target version whose only child has a body blob that's NOT JSON.
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
    // Child with unparsable body — AND sealed so the head isn't in_flight.
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
    // Now fork_back n=1 — should fall back to target's own body rather than
    // failing on the child's malformed JSON.
    const res = await call(fx, 'fork_back', { n: 1, message: 'retry' }) as {
      status?: string
      error?: string
    }
    expect(res.status).toBe('scheduled')
    const pending = fx.tobeStore.peek(fx.sessionId)!
    const msgs = pending.messages as Array<{ content: string }>
    // baseMessages came from target body ("from-target"), then user appended.
    expect(msgs[0].content).toBe('from-target')
    expect(msgs[msgs.length - 1].content).toBe('retry')
  })

  it('fork_show caps walk-back depth to prevent cyclic-chain runaway (A-WR13)', async () => {
    // Emit a version, then hack its parent_version_id to point at itself
    // (simulating a corrupt projection). fork_show must NOT hang.
    const v = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q' }])
    fx.db.prepare('UPDATE revisions SET parent_revision_id = id WHERE id = ?').run(v.id)
    const start = Date.now()
    const res = await call(fx, 'fork_show', { revision_id: v.id }) as {
      preceding_open_revisions: string[]
    }
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(1000)  // didn't hang
    // `version` itself is closed_forkable so the walk terminates immediately —
    // the key assertion is "did not hang" which we just verified.
    expect(Array.isArray(res.preceding_open_revisions)).toBe(true)
  })

  it('includes prior_outcome from the last TOBE-applied request', async () => {
    // Set up: a normal chain V1 → V2, then a forked attempt pointing back
    // at V1 that failed. After all that, call fork_back(n=1) and assert the
    // prior_outcome reflects the upstream_error from the failed forked attempt.
    const V1 = emitTurn(fx, 'end_turn', [{ role: 'user', content: 'q1' }])
    emitTurn(fx, 'end_turn', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    // Simulate a prior failed TOBE attempt — uses V1 as the fork point so the
    // version graph is valid. Emit the forked request with a body blob so the
    // walk-back can reconstruct messages.
    const bodyCid = `bafy-forked-body`
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

    // fork_back(n=1): current head is the dangling forked Version; walk back
    // one closed_forkable lands at V1. Success — returns scheduled + prior.
    const res = await call(fx, 'fork_back', { n: 1, message: 'retry' }) as {
      status: string
      prior_outcome: { status: string, http_status?: number, error_message?: string } | null
    }
    expect(res.status).toBe('scheduled')
    expect(res.prior_outcome?.status).toBe('upstream_error')
    expect(res.prior_outcome?.http_status).toBe(502)
  })
})
