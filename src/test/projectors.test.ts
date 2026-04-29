// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Projector unit tests. Hand-craft events and dispatch directly via the
// producer's projector chain. Fast, deterministic, no HTTP.

import type { TraceId } from '@playtiss/core'
import { describe, expect, it } from 'vitest'

import type { DB } from '../db.js'
import { migrate, openDb } from '../db.js'
import { createEventProducer, type EventProducer } from '../events.js'
import { RevisionsV1Projector } from '../revisions-v1.js'
import { SessionsV1Projector } from '../sessions-v1.js'

interface RevisionRow {
  id: string
  task_id: string
  asset_cid: string | null
  parent_revision_id: string | null
  classification: string
  stop_reason: string | null
  sealed_at: number | null
  created_at: number
}

interface SessionRow {
  id: string
  task_id: string
  harness: string | null
  ended_at: number | null
}

function fixture(): { db: DB, producer: EventProducer } {
  const db = openDb({ path: ':memory:' })
  migrate(db)
  // Dispatch order: sessions_v1 → revisions_v1 (per server.ts defaultProjectors).
  const producer = createEventProducer(db, [new SessionsV1Projector(), new RevisionsV1Projector()])
  return { db, producer }
}

function latestRevision(db: DB, id: TraceId | string): RevisionRow | undefined {
  return db.prepare('SELECT * FROM revisions WHERE id = ?').get(id) as RevisionRow | undefined
}

describe('sessions_v1', () => {
  it('creates a session + task on mcp.session_initialized', () => {
    const { db, producer } = fixture()
    producer.emit(
      'mcp.session_initialized',
      { mcp_session_id: 'mcp-1', pid: 1234, harness: 'claude-code' },
      'sess-1',
    )
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-1') as SessionRow
    expect(row.harness).toBe('claude-code')
    const task = db.prepare('SELECT * FROM tasks WHERE session_id = ?').get('sess-1') as { id: string }
    expect(task.id).toBe(row.task_id)
  })

  it('marks session ended on mcp.session_closed', () => {
    const { db, producer } = fixture()
    producer.emit('mcp.session_initialized', { mcp_session_id: 'mcp-2' }, 'sess-2')
    producer.emit('mcp.session_closed', {}, 'sess-2')
    const row = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get('sess-2') as { ended_at: number }
    expect(row.ended_at).toBeGreaterThan(0)
  })

  it('bootstraps an orphan session when proxy.request_received arrives first', () => {
    const { db, producer } = fixture()
    producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b' },
      'sess-orphan',
    )
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-orphan') as SessionRow
    expect(row.harness).toBe('orphan')
    expect(row.task_id).toBeTruthy()
  })

  it('upgrades an orphan session when mcp.session_initialized arrives later (A-WR7)', () => {
    const { db, producer } = fixture()
    // /v1/* traffic arrives first → orphan row.
    producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b' },
      'sess-upgrade',
    )
    const before = db.prepare('SELECT harness, pid FROM sessions WHERE id = ?').get('sess-upgrade') as
      | { harness: string, pid: number | null } | undefined
    expect(before?.harness).toBe('orphan')

    // Later, the MCP skill initializes for the same session.
    producer.emit(
      'mcp.session_initialized',
      { mcp_session_id: 'sess-upgrade', pid: 4242, harness: 'claude-code' },
      'sess-upgrade',
    )
    const after = db.prepare('SELECT harness, pid FROM sessions WHERE id = ?').get('sess-upgrade') as
      { harness: string, pid: number | null }
    expect(after.harness).toBe('claude-code')
    expect(after.pid).toBe(4242)
  })

  it('does NOT downgrade a real harness back to orphan on second init (A-WR7 edge)', () => {
    const { db, producer } = fixture()
    producer.emit(
      'mcp.session_initialized',
      { mcp_session_id: 's', pid: 1, harness: 'claude-code' },
      'sess-stay',
    )
    // Another init with no harness arg (e.g. a reconnect with missing clientInfo).
    producer.emit(
      'mcp.session_initialized',
      { mcp_session_id: 's', harness: 'unknown' },
      'sess-stay',
    )
    const row = db.prepare('SELECT harness FROM sessions WHERE id = ?').get('sess-stay') as
      { harness: string }
    // UPSERT only overrides orphan; real harness stays.
    expect(row.harness).toBe('claude-code')
  })

  it('mints deterministic task_id across replays', () => {
    const { db: db1, producer: p1 } = fixture()
    const { db: db2, producer: p2 } = fixture()
    p1.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-det')
    p2.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-det')
    const t1 = (db1.prepare('SELECT task_id FROM sessions WHERE id = ?').get('sess-det') as SessionRow).task_id
    const t2 = (db2.prepare('SELECT task_id FROM sessions WHERE id = ?').get('sess-det') as SessionRow).task_id
    expect(t1).toBe(t2)
  })
})

describe('revisions_v1', () => {
  it('inserts an in_flight Revision on proxy.request_received', () => {
    const { db, producer } = fixture()
    producer.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-v1')
    const evt = producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b-req' },
      'sess-v1',
    )
    const rev = latestRevision(db, evt.id)!
    expect(rev.classification).toBe('in_flight')
    expect(rev.asset_cid).toBeNull()
    expect(rev.sealed_at).toBeNull()
    expect(rev.parent_revision_id).toBeNull()
  })

  it('sets parent_revision_id from tobe_applied_from at request time', () => {
    const { db, producer } = fixture()
    producer.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-fork')
    const evt = producer.emit(
      'proxy.request_received',
      {
        method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b',
        tobe_applied_from: {
          fork_point_revision_id: 'rev-fp-123',
          source_view_id: 'view-a',
          original_body_cid: 'b-orig',
        },
      },
      'sess-fork',
    )
    const rev = latestRevision(db, evt.id)!
    expect(rev.parent_revision_id).toBe('rev-fp-123')
  })

  it('seals a Revision on proxy.response_completed with classification + asset_cid', () => {
    const { db, producer } = fixture()
    producer.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-seal')
    const req = producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b-req' },
      'sess-seal',
    )
    producer.emit(
      'proxy.response_completed',
      {
        request_event_id: req.id,
        status: 200,
        headers_cid: 'h-resp',
        body_cid: 'b-resp',
        stop_reason: 'end_turn',
        asset_cid: 'bafy-asset-xyz',
      },
      'sess-seal',
    )
    const rev = latestRevision(db, req.id)!
    expect(rev.classification).toBe('closed_forkable')
    expect(rev.stop_reason).toBe('end_turn')
    expect(rev.asset_cid).toBe('bafy-asset-xyz')
    expect(rev.sealed_at).toBeGreaterThan(0)
  })

  it('resolves parent at seal time for non-fork Revisions (most recent sealed)', () => {
    const { db, producer } = fixture()
    producer.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-chain')
    const v1 = producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b1' },
      'sess-chain',
    )
    producer.emit(
      'proxy.response_completed',
      {
        request_event_id: v1.id, status: 200, headers_cid: 'h', body_cid: 'r1',
        stop_reason: 'end_turn', asset_cid: 'a1',
      },
      'sess-chain',
    )
    const v2 = producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b2' },
      'sess-chain',
    )
    producer.emit(
      'proxy.response_completed',
      {
        request_event_id: v2.id, status: 200, headers_cid: 'h', body_cid: 'r2',
        stop_reason: 'tool_use', asset_cid: 'a2',
      },
      'sess-chain',
    )
    const rev2 = latestRevision(db, v2.id)!
    expect(rev2.parent_revision_id).toBe(v1.id)
    expect(rev2.classification).toBe('open')
  })

  it('marks Revision dangling_unforkable on response_aborted', () => {
    const { db, producer } = fixture()
    producer.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-abort')
    const req = producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b' },
      'sess-abort',
    )
    producer.emit(
      'proxy.response_aborted',
      { request_event_id: req.id, reason: 'client_disconnect' },
      'sess-abort',
    )
    const rev = latestRevision(db, req.id)!
    expect(rev.classification).toBe('dangling_unforkable')
    expect(rev.sealed_at).toBeGreaterThan(0)
  })

  it('marks Revision dangling_unforkable on upstream_error', () => {
    const { db, producer } = fixture()
    producer.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-up')
    const req = producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b' },
      'sess-up',
    )
    producer.emit(
      'proxy.upstream_error',
      { request_event_id: req.id, status: 502, error_message: 'ECONNREFUSED' },
      'sess-up',
    )
    const rev = latestRevision(db, req.id)!
    expect(rev.classification).toBe('dangling_unforkable')
  })

  it('fork siblings share a parent_revision_id', () => {
    const { db, producer } = fixture()
    producer.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-sib')
    // First turn closes cleanly — becomes the fork anchor.
    const anchor = producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b1' },
      'sess-sib',
    )
    producer.emit(
      'proxy.response_completed',
      {
        request_event_id: anchor.id, status: 200, headers_cid: 'h', body_cid: 'r1',
        stop_reason: 'end_turn', asset_cid: 'a1',
      },
      'sess-sib',
    )
    // Two fork-siblings — both cite anchor.id in tobe_applied_from.
    const siblingA = producer.emit(
      'proxy.request_received',
      {
        method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'bA',
        tobe_applied_from: { fork_point_revision_id: anchor.id, source_view_id: 'v', original_body_cid: 'o' },
      },
      'sess-sib',
    )
    const siblingB = producer.emit(
      'proxy.request_received',
      {
        method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'bB',
        tobe_applied_from: { fork_point_revision_id: anchor.id, source_view_id: 'v', original_body_cid: 'o' },
      },
      'sess-sib',
    )
    expect(latestRevision(db, siblingA.id)!.parent_revision_id).toBe(anchor.id)
    expect(latestRevision(db, siblingB.id)!.parent_revision_id).toBe(anchor.id)
  })

  it('idempotent on replay — same event emitted twice does not duplicate rows', () => {
    const { db, producer } = fixture()
    // Simulate what a projection rebuild does: emit the same logical events.
    // Here we just INSERT the same row twice via the emit path.
    producer.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-dup')
    const sessionsCount1 = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get('sess-dup') as { n: number }).n
    expect(sessionsCount1).toBe(1)
    // Re-running a session_initialized event for the same session_id is a
    // no-op thanks to INSERT OR IGNORE.
    producer.emit('mcp.session_initialized', { mcp_session_id: 'x' }, 'sess-dup')
    const sessionsCount2 = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get('sess-dup') as { n: number }).n
    expect(sessionsCount2).toBe(1)
  })
})
