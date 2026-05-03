// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from 'vitest'

import { BranchViewsV1Projector } from '../branch-views-v1.js'
import type { DB } from '../db.js'
import { migrate, openDb } from '../db.js'
import { createEventProducer, type EventProducer } from '../events.js'
import { RevisionsV1Projector } from '../revisions-v1.js'
import { SessionsV1Projector } from '../sessions-v1.js'

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

  beforeEach(() => {
    fx = fixture()
  })

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

  it('creates a fork view with auto-label on fork.forked (success-only)', () => {
    // Seed R1 so the parent_revision_id lookup in onForkForked resolves.
    // RewindMarkerV1Projector does the same lookup; branch-views-v1 reuses
    // the pattern so that auto fork-point views don't materialize for
    // failed rewinds (the no-SR case is now also the no-branch_view case).
    fx.db.prepare(`
      INSERT INTO revisions (id, task_id, asset_cid, parent_revision_id, classification, stop_reason, sealed_at, created_at)
      VALUES (?, ?, NULL, NULL, 'open', 'tool_use', ?, ?)
    `).run('rev-r1', fx.taskId, Date.now(), Date.now())

    fx.producer.emit(
      'fork.forked',
      {
        kind: 'rewind',
        synthetic_revision_id: 'rev-sr-1',
        parent_revision_id: 'rev-r1',
        target_revision_id: 'rev-fp-abcdef1234567890',
        to_revision_id: 'rev-new',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        target_view_id: 'view-fork',
        sealed_at: Date.UTC(2026, 4, 3, 12, 0, 0),
        synthetic_asset_cid: 'cid-fake',
      },
      fx.sessionId,
    )
    const row = loadView(fx.db, 'view-fork')!
    expect(row.head_revision_id).toBe('rev-fp-abcdef1234567890')
    expect(row.label).toBeNull()
    expect(row.auto_label).toMatch(/^fork@2026-05-03T12:00:00\.000Z from rev-fp-a/)
  })

  it('does NOT create a fork view if R1 is missing (failed rewind, R1 lookup fails)', () => {
    // R1 missing → no SR, no branch_view. Symmetric with RewindMarker's
    // skip-on-missing-parent posture.
    fx.producer.emit(
      'fork.forked',
      {
        kind: 'rewind',
        synthetic_revision_id: 'rev-sr-orphan',
        parent_revision_id: 'rev-r1-missing',
        target_revision_id: 'rev-fp',
        to_revision_id: 'rev-new',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        target_view_id: 'view-orphan',
        sealed_at: Date.now(),
        synthetic_asset_cid: 'cid',
      },
      fx.sessionId,
    )
    expect(loadView(fx.db, 'view-orphan')).toBeUndefined()
  })

  it('fork.back_requested no longer creates a branch_view (regression guard)', () => {
    // Pre-v0.5.0-alpha.4: this event populated branch_views directly.
    // Post-fix: it's audit-only. fork.forked is the success-gated signal.
    fx.producer.emit(
      'fork.back_requested',
      {
        source_view_id: 'view-src',
        fork_point_revision_id: 'rev-fp',
        new_message_cid: 'bafy-msg',
        target_view_id: 'view-back-only',
        task_id: fx.taskId,
      },
      fx.sessionId,
    )
    expect(loadView(fx.db, 'view-back-only')).toBeUndefined()
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
    expect(row.head_revision_id).toBe('other-revision') // not advanced
  })
})
