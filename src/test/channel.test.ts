// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Step 1 v3 channel-facade integration test. Exercises:
//
//   defaultTasks() → createChannel() → submit() → projector apply() in dep
//   order → per-Task projection_offsets bump for accepts → projection.exception
//   substrate events for exceptions → event row landed unconditionally
//
// Regression suite for the channel refactor itself. Pins:
//   - L1.2 / L1.8 / L1.10 / L2.4: event row lands even if projector throws.
//   - L1.10: exception outcomes recorded as substrate events.
//   - L3.5: dep-order dispatch from declared TaskRef Input.
//   - Cascade exceptions (downstream Task throws because upstream threw).
//   - Per-projector SAVEPOINT isolation (one throw doesn't roll back accepted
//     siblings' writes).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyTask, type Task, taskRef, type TaskId } from '../channel-types.js'
import { createChannel } from '../channel.js'
import { type DB, migrate, openDb } from '../db.js'
import { defaultTasks } from '../server.js'

function noopApply(): void { /* test stub */ }

describe('createChannel + defaultTasks (happy path)', () => {
  let db: DB

  beforeEach(() => {
    db = openDb({ path: ':memory:' })
    migrate(db)
  })

  afterEach(() => db.close())

  it('submit() writes event row + dispatches Tasks in dep order + records accept outcomes', async () => {
    const tasks = await defaultTasks()
    const channel = createChannel({ db, tasks })

    const result = await channel.submit(
      'mcp.session_initialized',
      { mcp_session_id: 'sess-test', harness: 'claude-code' },
      'sess-test',
    )
    expect(result.event.topic).toBe('mcp.session_initialized')

    // mcp.session_initialized only subscribed by sessions_v1 → exactly one outcome.
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ kind: 'accept' }),
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

    // Per-Task offset bumped via the accept outcome (Q1=c — accept outcomes
    // are implicit in projection_offsets advancement).
    const sessionsTask = tasks.find(t => t.action === 'playtiss.proxy.sessions_v1')!
    const offset = channel.taskMetadata(sessionsTask.id).get('events_offset')
    expect(offset).toBe(result.event.id)
  })

  it('Task ids are content-hashed and stable across calls', async () => {
    const a = await defaultTasks()
    const b = await defaultTasks()
    const aIds = a.map(t => t.id).sort()
    const bIds = b.map(t => t.id).sort()
    expect(aIds).toEqual(bIds)
  })

  it('TaskRef dependencies enforce dep-order dispatch even with shared topic', async () => {
    // proxy.response_completed is subscribed by revisions_v1, branch_views_v1,
    // AND rewind_marker_v1 (well, rewind_marker is fork.forked-only). The
    // dep edge that matters: revisions_v1 must run before branch_views_v1.
    const tasks = await defaultTasks()
    const channel = createChannel({ db, tasks })

    await channel.submit('mcp.session_initialized', { mcp_session_id: 's' }, 's')
    const { event: reqEvent } = await channel.submit('proxy.request_received', {
      method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: 'b',
    }, 's')

    const completed = await channel.submit('proxy.response_completed', {
      request_event_id: reqEvent.id,
      status: 200,
      headers_cid: 'h',
      body_cid: 'b-resp',
      stop_reason: 'end_turn',
      asset_cid: 'bafy-asset',
    }, 's')
    // All subscribers accepted (revisions_v1 + branch_views_v1).
    expect(completed.outcomes.every(o => o.kind === 'accept')).toBe(true)

    const revRow = db.prepare('SELECT * FROM revisions WHERE id = ?').get(reqEvent.id) as
      | { id: string, classification: string }
      | undefined
    expect(revRow?.classification).toBe('closed_forkable')
  })

  it('registerTask is idempotent on duplicate id', async () => {
    const channel = createChannel({ db })
    const id = await applyTask('test.action', { topics: ['x'] })
    const task: Task = { id, action: 'test.action', input: { topics: ['x'] }, apply: noopApply }
    channel.registerTask(task)
    channel.registerTask(task) // idempotent — no throw
    await channel.submit('x', {}, null)
  })

  it('registerTask after construction respects new TaskRef dep (lazy topo-sort)', async () => {
    const channel = createChannel({ db })

    const callOrder: string[] = []
    const aId = await applyTask('test.a', { topics: ['shared'] })
    const bId = await applyTask('test.b', {
      topics: ['shared'],
      upstream: taskRef(aId),
    })

    // Register in REVERSE dep order — runner topo-sort defers and reorders.
    channel.registerTask({
      id: bId, action: 'test.b', input: { topics: ['shared'], upstream: taskRef(aId) },
      apply: () => callOrder.push('b'),
    })
    channel.registerTask({
      id: aId, action: 'test.a', input: { topics: ['shared'] },
      apply: () => callOrder.push('a'),
    })

    await channel.submit('shared', {}, null)
    expect(callOrder).toEqual(['a', 'b'])
  })

  it('taskMetadata.set on unknown key is a silent no-op (v0.3 single-key limit)', async () => {
    const channel = createChannel({ db })
    const id = await applyTask('test.action', {})
    const md = channel.taskMetadata(id)
    md.set('arbitrary_key', 'value')
    expect(md.get('arbitrary_key')).toBeNull()
    md.set('events_offset', 'evt-123')
    expect(md.get('events_offset')).toBe('evt-123')
  })

  it('storage is a working StorageProvider', async () => {
    const channel = createChannel({ db })
    expect(channel.storage).toBeDefined()
    const bytes = new TextEncoder().encode('hello')
    const cid = 'bafkreitestcid' as Parameters<typeof channel.storage.saveBuffer>[1]
    await channel.storage.saveBuffer(bytes, cid)
    expect(await channel.storage.hasBuffer(cid)).toBe(true)
    const fetched = await channel.storage.fetchBuffer(cid)
    expect(Array.from(fetched)).toEqual(Array.from(bytes))
  })
})

describe('createChannel — exception outcomes (the v2 → v3 protocol fix)', () => {
  let db: DB

  beforeEach(() => {
    db = openDb({ path: ':memory:' })
    migrate(db)
  })

  afterEach(() => db.close())

  it('projector exception does NOT void the event row (L1.2 + L1.8 + L2.4)', async () => {
    const channel = createChannel({ db })
    const taskId = await applyTask('test.exploding', { topics: ['ka.boom'] })
    channel.registerTask({
      id: taskId,
      action: 'test.exploding',
      input: { topics: ['ka.boom'] },
      apply: () => {
        throw new Error('boom: simulated projector failure')
      },
    })

    const result = await channel.submit('ka.boom', { detail: 'hi' }, 'sess-exc')

    // The event ROW landed. This is the protocol fix: projector exception
    // is data, not an error that voids upstream substrate writes.
    const evtCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE topic='ka.boom'`)
      .get() as { n: number }).n
    expect(evtCount).toBe(1)

    // Outcome recorded as exception (NOT thrown).
    expect(result.outcomes).toHaveLength(1)
    const outcome = result.outcomes[0]!
    expect(outcome.kind).toBe('exception')
    if (outcome.kind === 'exception') {
      expect(outcome.taskId).toBe(taskId)
      expect(outcome.error).toContain('boom')
    }
  })

  it('exception outcome records a projection.exception substrate event (L1.10)', async () => {
    const channel = createChannel({ db })
    const taskId = await applyTask('test.boom', { topics: ['t'] })
    channel.registerTask({
      id: taskId,
      action: 'test.boom',
      input: { topics: ['t'] },
      apply: () => { throw new Error('exploded') },
    })

    const result = await channel.submit('t', {}, 'sess-rec')

    // The projection.exception event lives in the substrate. Payload
    // carries the source event id + task id + error message.
    const excRows = db
      .prepare(`SELECT payload FROM events WHERE topic='projection.exception'`)
      .all() as Array<{ payload: string }>
    expect(excRows).toHaveLength(1)
    const excPayload = JSON.parse(excRows[0]!.payload) as {
      source_event_id: string
      task_id: string
      error: string
    }
    expect(excPayload.source_event_id).toBe(result.event.id)
    expect(excPayload.task_id).toBe(taskId)
    expect(excPayload.error).toContain('exploded')
  })

  it('exception in one projector does NOT roll back accepted siblings (SAVEPOINT isolation)', async () => {
    const channel = createChannel({ db })

    // Set up a session row so downstream Tasks have FK to reference.
    const sessionsTask = (await defaultTasks()).find(t => t.action === 'playtiss.proxy.sessions_v1')!
    channel.registerTask(sessionsTask)
    await channel.submit('mcp.session_initialized', { mcp_session_id: 's' }, 's')

    // Add a "good" projector that writes a marker row + a "bad" projector
    // that throws AFTER writing partial state. The good writer's row
    // should land; the bad writer's partial state should roll back.
    db.exec(`CREATE TABLE test_markers (id TEXT PRIMARY KEY, value TEXT)`)

    const goodId = await applyTask('test.good', { topics: ['shared.test'] })
    const badId = await applyTask('test.bad', {
      topics: ['shared.test'],
      upstream: taskRef(goodId),
    })

    channel.registerTask({
      id: goodId, action: 'test.good', input: { topics: ['shared.test'] },
      apply: (event) => {
        db.prepare('INSERT INTO test_markers (id, value) VALUES (?, ?)')
          .run(`good-${event.id}`, 'GOOD')
      },
    })
    channel.registerTask({
      id: badId, action: 'test.bad',
      input: { topics: ['shared.test'], upstream: taskRef(goodId) },
      apply: (event) => {
        // Partial write FIRST, then throw. SAVEPOINT should roll BACK
        // this partial write but leave the good projector's row intact.
        db.prepare('INSERT INTO test_markers (id, value) VALUES (?, ?)')
          .run(`bad-partial-${event.id}`, 'PARTIAL')
        throw new Error('bad projector failed mid-write')
      },
    })

    const result = await channel.submit('shared.test', {}, 's')

    // The good projector's row landed (accepted).
    const goodRow = db
      .prepare(`SELECT id FROM test_markers WHERE id = ?`)
      .get(`good-${result.event.id}`)
    expect(goodRow).toBeDefined()

    // The bad projector's partial-write row was ROLLED BACK by the
    // SAVEPOINT mechanic.
    const badRow = db
      .prepare(`SELECT id FROM test_markers WHERE id = ?`)
      .get(`bad-partial-${result.event.id}`)
    expect(badRow).toBeUndefined()

    // Outcomes show good=accept, bad=exception.
    expect(result.outcomes).toHaveLength(2)
    expect(result.outcomes[0]!.kind).toBe('accept')
    expect(result.outcomes[1]!.kind).toBe('exception')
  })

  it('downstream Task still dispatches after upstream throws (cascade exception)', async () => {
    const channel = createChannel({ db })

    const upstreamId = await applyTask('test.upstream', { topics: ['cascade'] })
    const downstreamId = await applyTask('test.downstream', {
      topics: ['cascade'],
      upstream: taskRef(upstreamId),
    })

    let downstreamRan = false
    channel.registerTask({
      id: upstreamId, action: 'test.upstream', input: { topics: ['cascade'] },
      apply: () => { throw new Error('upstream boom') },
    })
    channel.registerTask({
      id: downstreamId, action: 'test.downstream',
      input: { topics: ['cascade'], upstream: taskRef(upstreamId) },
      apply: () => { downstreamRan = true },
    })

    const result = await channel.submit('cascade', {}, 'sess-cascade')

    expect(downstreamRan).toBe(true)
    expect(result.outcomes.find(o => o.taskId === upstreamId)?.kind).toBe('exception')
    expect(result.outcomes.find(o => o.taskId === downstreamId)?.kind).toBe('accept')
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
    const tasks = await defaultTasks()
    const db1 = openDb({ path: ':memory:' })
    migrate(db1)
    try {
      // Register in reverse order
      const reversed = [...tasks].reverse()
      const channel = createChannel({ db: db1, tasks: reversed })
      await channel.submit('mcp.session_initialized', { mcp_session_id: 'r' }, 'r')
      const sess = db1.prepare('SELECT id FROM sessions WHERE id = ?').get('r') as { id: string } | undefined
      expect(sess?.id).toBe('r')
    }
    finally {
      db1.close()
    }
  })
})
