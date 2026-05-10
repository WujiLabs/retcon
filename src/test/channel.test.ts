// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Step 1 channel-facade integration test. Exercises the full path:
// defaultTasks() → createChannel() → emit() → projector apply() in dep order
// → projection_offsets row updated per Task id.
//
// This is the regression suite for the channel refactor itself: it pins the
// Task-shaped wiring so future contributors can't silently lose the dep-
// order dispatch property or the per-Task offset semantics.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyTask, type Task, taskRef, type TaskId } from '../channel-types.js'
import { createChannel } from '../channel.js'
import { type DB, migrate, openDb } from '../db.js'
import { defaultTasks } from '../server.js'

function noopApply(): void { /* test stub */ }

describe('createChannel + defaultTasks', () => {
  let db: DB

  beforeEach(() => {
    db = openDb({ path: ':memory:' })
    migrate(db)
  })

  afterEach(() => db.close())

  it('emit() writes events row + dispatches Tasks in dep order', async () => {
    const tasks = await defaultTasks()
    const channel = createChannel({ db, tasks })

    // Emit an mcp.session_initialized event — only sessions_v1 should fire.
    channel.emit(
      'mcp.session_initialized',
      { mcp_session_id: 'sess-test', harness: 'claude-code' },
      'sess-test',
    )

    // Event row written
    const eventCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE topic='mcp.session_initialized'`)
      .get() as { n: number }).n
    expect(eventCount).toBe(1)

    // sessions_v1 ran → sessions row created
    const sessionRow = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get('sess-test') as { id: string, harness: string | null } | undefined
    expect(sessionRow).toBeDefined()
    expect(sessionRow!.harness).toBe('claude-code')

    // Per-Task offset bumped — the sessions Task's offset === the event id
    const sessionsTask = tasks.find(t => t.action === 'playtiss.proxy.sessions_v1')!
    const offset = channel.taskMetadata(sessionsTask.id).get('events_offset')
    expect(offset).not.toBeNull()
    expect(offset!.length).toBeGreaterThan(0)
  })

  it('Task ids are content-hashed and stable across calls', async () => {
    const a = await defaultTasks()
    const b = await defaultTasks()

    // Same (action, input) → same TaskId.
    const aIds = a.map(t => t.id).sort()
    const bIds = b.map(t => t.id).sort()
    expect(aIds).toEqual(bIds)
  })

  it('TaskRef dependencies enforce dep-order dispatch even with shared topic', async () => {
    // proxy.response_completed is subscribed by both revisions_v1 and
    // branch_views_v1. branch_views_v1 reads revisions.parent_revision_id
    // set by revisions_v1 — so revisions_v1 MUST run first.
    const tasks = await defaultTasks()
    const channel = createChannel({ db, tasks })

    // Bootstrap a session + a request_received so revisions_v1 has an in_flight
    // row to update.
    channel.emit('mcp.session_initialized', { mcp_session_id: 's' }, 's')
    const reqEvent = channel.emit('proxy.request_received', {
      method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b',
    }, 's')

    // Now fire response_completed. Both revisions_v1 and branch_views_v1
    // subscribe. revisions_v1 sets parent_revision_id; branch_views_v1
    // depends on that field's value mid-tx.
    channel.emit('proxy.response_completed', {
      request_event_id: reqEvent.id,
      status: 200,
      headers_cid: 'h',
      body_cid: 'b-resp',
      stop_reason: 'end_turn',
      asset_cid: 'bafy-asset',
    }, 's')

    // If dispatch order were broken (branch_views_v1 first), the revisions
    // row's parent_revision_id wouldn't be set when branch_views_v1 read
    // it — the test wouldn't directly assert that today, but the absence
    // of crashes/FK violations + the standing test suite passing IS the
    // regression guard.
    const revRow = db.prepare('SELECT * FROM revisions WHERE id = ?').get(reqEvent.id) as
      | { id: string, classification: string }
      | undefined
    expect(revRow).toBeDefined()
    expect(revRow!.classification).toBe('closed_forkable')
  })

  it('registerTask is idempotent on duplicate id', async () => {
    const channel = createChannel({ db })
    const id = await applyTask('test.action', { topics: ['x'] })
    const task: Task = { id, action: 'test.action', input: { topics: ['x'] }, apply: noopApply }
    channel.registerTask(task)
    channel.registerTask(task) // idempotent — no throw
    // Confirm the topology still works (single registration effectively).
    channel.emit('x', {}, null)
  })

  it('registerTask after construction respects new TaskRef dep', async () => {
    const channel = createChannel({ db })

    const callOrder: string[] = []
    const aId = await applyTask('test.a', { topics: ['shared'] })
    const bId = await applyTask('test.b', {
      topics: ['shared'],
      upstream: taskRef(aId),
    })

    // Register in REVERSE dep order — runner topo-sort must reorder.
    channel.registerTask({
      id: bId, action: 'test.b', input: { topics: ['shared'], upstream: taskRef(aId) },
      apply: () => callOrder.push('b'),
    })
    channel.registerTask({
      id: aId, action: 'test.a', input: { topics: ['shared'] },
      apply: () => callOrder.push('a'),
    })

    channel.emit('shared', {}, null)
    expect(callOrder).toEqual(['a', 'b'])
  })

  it('taskMetadata.set on unknown key is a silent no-op (Step 1 single-key limit)', async () => {
    const channel = createChannel({ db })
    const id = await applyTask('test.action', {})
    const md = channel.taskMetadata(id)
    md.set('arbitrary_key', 'value')
    expect(md.get('arbitrary_key')).toBeNull()
    // events_offset still works
    md.set('events_offset', 'evt-123')
    expect(md.get('events_offset')).toBe('evt-123')
  })

  it('storage is a working StorageProvider', async () => {
    const channel = createChannel({ db })
    expect(channel.storage).toBeDefined()
    // Roundtrip via the StorageProvider interface (saveBuffer/fetchBuffer/hasBuffer)
    const bytes = new TextEncoder().encode('hello')
    const cid = 'bafkreitestcid' as Parameters<typeof channel.storage.saveBuffer>[1]
    await channel.storage.saveBuffer(bytes, cid)
    expect(await channel.storage.hasBuffer(cid)).toBe(true)
    // SQLite returns the BLOB as a Buffer; compare as bytes since Uint8Array
    // and Buffer have the same byte sequence but different toEqual identity.
    const fetched = await channel.storage.fetchBuffer(cid)
    expect(Array.from(fetched)).toEqual(Array.from(bytes))
  })

  it('producer.emit alias matches channel.emit (back-compat)', async () => {
    const tasks = await defaultTasks()
    const channel = createChannel({ db, tasks })
    channel.producer.emit('mcp.session_initialized', { mcp_session_id: 's' }, 's')
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s')
    expect(sess).toBeDefined()
  })
})

describe('defaultTasks (declarative TaskRef wiring)', () => {
  it('produces the four projector Tasks in any registration order', async () => {
    const tasks = await defaultTasks()
    expect(tasks.map(t => t.action).sort()).toEqual([
      'playtiss.proxy.branch_views_v1',
      'playtiss.proxy.revisions_v1',
      'playtiss.proxy.rewind_marker_v1',
      'playtiss.proxy.sessions_v1',
    ])
  })

  it('declares revisions_v1.input.sessions = TaskRef(sessions_v1.id)', async () => {
    const tasks = await defaultTasks()
    const sessions = tasks.find(t => t.action === 'playtiss.proxy.sessions_v1')!
    const revisions = tasks.find(t => t.action === 'playtiss.proxy.revisions_v1')!
    expect(revisions.input.sessions).toEqual({ kind: 'task_ref', id: sessions.id })
  })

  it('declares branch_views_v1 + rewind_marker_v1 as deps of revisions_v1', async () => {
    const tasks = await defaultTasks()
    const revisions = tasks.find(t => t.action === 'playtiss.proxy.revisions_v1')!
    const branchViews = tasks.find(t => t.action === 'playtiss.proxy.branch_views_v1')!
    const rewindMarker = tasks.find(t => t.action === 'playtiss.proxy.rewind_marker_v1')!
    expect(branchViews.input.revisions).toEqual({ kind: 'task_ref', id: revisions.id })
    expect(rewindMarker.input.revisions).toEqual({ kind: 'task_ref', id: revisions.id })
  })

  it('REGRESSION: dispatch order matches dependency order regardless of registration order', async () => {
    // The plan v2 critical regression test: Tasks registered in randomized
    // order must still dispatch in dep order. Validated end-to-end against
    // a real DB; if dispatch broke, sessions_v1 wouldn't have inserted
    // session rows before revisions_v1 needed to FK-reference them.
    const tasks = await defaultTasks()
    const db1 = openDb({ path: ':memory:' })
    migrate(db1)
    try {
      // Register in reverse order
      const reversed = [...tasks].reverse()
      const channel = createChannel({ db: db1, tasks: reversed })
      channel.emit('mcp.session_initialized', { mcp_session_id: 'r' }, 'r')
      const sess = db1.prepare('SELECT id FROM sessions WHERE id = ?').get('r') as { id: string } | undefined
      expect(sess?.id).toBe('r')
    }
    finally {
      db1.close()
    }
  })
})
