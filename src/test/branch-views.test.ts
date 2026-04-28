// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from 'vitest'
import { BranchViewsV1Projector } from '../branch-views-v1.js'
import type { DB } from '../db.js'
import { migrate, openDb } from '../db.js'
import { createEventProducer, type EventProducer } from '../events.js'
import { SessionsV1Projector } from '../sessions-v1.js'
import { RevisionsV1Projector } from '../revisions-v1.js'

interface BranchViewRow {
  id: string
  task_id: string
  head_revision_id: string
  label: string | null
  auto_label: string
  updated_at: number
}

function fixture(): { db: DB, producer: EventProducer, taskId: string, sessionId: string } {
  const db = openDb({ path: ':memory:' })
  migrate(db)
  const producer = createEventProducer(db, [
    new SessionsV1Projector(),
    new RevisionsV1Projector(),
    new BranchViewsV1Projector(),
  ])
  const sessionId = 'sess-bv'
  producer.emit('mcp.session_initialized', { mcp_session_id: 'm' }, sessionId)
  const task = db.prepare('SELECT task_id FROM sessions WHERE id = ?').get(sessionId) as { task_id: string }
  return { db, producer, taskId: task.task_id, sessionId }
}

function loadView(db: DB, id: string): BranchViewRow | undefined {
  return db.prepare('SELECT * FROM branch_views WHERE id = ?').get(id) as BranchViewRow | undefined
}

describe('branch_views_v1', () => {
  let fx: ReturnType<typeof fixture>

  beforeEach(() => { fx = fixture() })

  it('creates a bookmark view with explicit label', () => {
    fx.producer.emit(
      'fork.bookmark_created',
      {
        view_id: 'view-1',
        task_id: fx.taskId,
        head_revision_id: 'rev-head',
        label: 'my-bookmark',
        auto_label: 'main',
      },
      fx.sessionId,
    )
    const row = loadView(fx.db, 'view-1')!
    expect(row.label).toBe('my-bookmark')
    expect(row.auto_label).toBe('main')
    expect(row.head_revision_id).toBe('rev-head')
  })

  it('creates a fork view with auto-label on fork.back_requested', () => {
    fx.producer.emit(
      'fork.back_requested',
      {
        source_view_id: 'view-src',
        fork_point_revision_id: 'rev-fp-abcdef1234567890',
        new_message_cid: 'bafy-msg',
        target_view_id: 'view-fork',
        task_id: fx.taskId,
      },
      fx.sessionId,
    )
    const row = loadView(fx.db, 'view-fork')!
    expect(row.head_revision_id).toBe('rev-fp-abcdef1234567890')
    expect(row.label).toBeNull()
    expect(row.auto_label).toMatch(/^fork@/)
    expect(row.auto_label).toContain('rev-fp-a')  // first 8 chars of fork point
  })

  it('updates label on fork.label_updated', () => {
    fx.producer.emit(
      'fork.bookmark_created',
      { view_id: 'view-2', task_id: fx.taskId, head_revision_id: 'v', label: null, auto_label: 'a' },
      fx.sessionId,
    )
    fx.producer.emit(
      'fork.label_updated',
      { view_id: 'view-2', label: 'renamed' },
      fx.sessionId,
    )
    const row = loadView(fx.db, 'view-2')!
    expect(row.label).toBe('renamed')
  })

  it('advances head_revision_id when a response_completed seals a Revision whose parent was the view head', () => {
    // Set up: turn 1 seals → bookmark points at v1 → turn 2 arrives with v1 as parent → view advances to v2.
    const v1 = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b1' },
      fx.sessionId,
    )
    fx.producer.emit(
      'proxy.response_completed',
      { request_event_id: v1.id, status: 200, headers_cid: 'h', body_cid: 'r1', stop_reason: 'end_turn', asset_cid: 'a1' },
      fx.sessionId,
    )
    fx.producer.emit(
      'fork.bookmark_created',
      { view_id: 'view-advance', task_id: fx.taskId, head_revision_id: v1.id, label: null, auto_label: 'main' },
      fx.sessionId,
    )
    // Next HTTP call — non-fork, chains from v1.
    const v2 = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b2' },
      fx.sessionId,
    )
    fx.producer.emit(
      'proxy.response_completed',
      { request_event_id: v2.id, status: 200, headers_cid: 'h', body_cid: 'r2', stop_reason: 'end_turn', asset_cid: 'a2' },
      fx.sessionId,
    )
    const row = loadView(fx.db, 'view-advance')!
    expect(row.head_revision_id).toBe(v2.id)
  })

  it('does NOT advance views that point elsewhere', () => {
    const v1 = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b1' },
      fx.sessionId,
    )
    fx.producer.emit(
      'proxy.response_completed',
      { request_event_id: v1.id, status: 200, headers_cid: 'h', body_cid: 'r1', stop_reason: 'end_turn', asset_cid: 'a1' },
      fx.sessionId,
    )
    // View points at some UNRELATED revision id.
    fx.producer.emit(
      'fork.bookmark_created',
      { view_id: 'view-stable', task_id: fx.taskId, head_revision_id: 'other-revision', label: null, auto_label: 'other' },
      fx.sessionId,
    )
    const v2 = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b2' },
      fx.sessionId,
    )
    fx.producer.emit(
      'proxy.response_completed',
      { request_event_id: v2.id, status: 200, headers_cid: 'h', body_cid: 'r2', stop_reason: 'end_turn', asset_cid: 'a2' },
      fx.sessionId,
    )
    const row = loadView(fx.db, 'view-stable')!
    expect(row.head_revision_id).toBe('other-revision')  // not advanced
  })
})
