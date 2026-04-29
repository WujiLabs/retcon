// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Coverage for ActorConflictError — the multi-actor isolation enforcement
// boundary in rebindSession. A regression here would let two actors'
// sessions silently merge.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ActorConflictError, rebindSession } from '../binding-table.js'
import { type DB, migrate, openDb } from '../db.js'

function insertSession(db: DB, id: string, taskId: string, actor: string): void {
  db.prepare(
    'INSERT INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)',
  ).run(id, taskId, actor, Date.now(), 'claude-code')
  db.prepare(
    'INSERT INTO tasks (id, session_id, created_at) VALUES (?, ?, ?)',
  ).run(taskId, id, Date.now())
}

function insertPending(db: DB, transportId: string, actor: string): void {
  db.prepare(
    'INSERT INTO pending_actors (transport_id, actor, registered_at) VALUES (?, ?, ?)',
  ).run(transportId, actor, Date.now())
}

describe('rebindSession actor isolation', () => {
  let db: DB
  beforeEach(() => {
    db = openDb({ path: ':memory:' })
    migrate(db)
  })
  afterEach(() => db.close())

  it('throws ActorConflictError when both sessions have differing non-default actors', () => {
    insertSession(db, 'old-id', 'task-old', 'alice')
    insertSession(db, 'new-id', 'task-new', 'bob')
    expect(() => rebindSession(db, 'old-id', 'new-id')).toThrow(ActorConflictError)
    // Verify no half-merge: both sessions still exist.
    const count = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    expect(count).toBe(2)
  })

  it('upgrades existingNew "default" actor to the requested non-default', () => {
    insertSession(db, 'old-id', 'task-old', 'alice')
    insertSession(db, 'new-id', 'task-new', 'default')
    rebindSession(db, 'old-id', 'new-id')
    const row = db.prepare('SELECT actor FROM sessions WHERE id=?').get('new-id') as { actor: string }
    expect(row.actor).toBe('alice')
  })

  it('throws on hook-fires-first conflict (pending=bob vs existingNew=alice)', () => {
    insertPending(db, 'old-id', 'bob')
    insertSession(db, 'new-id', 'task-new', 'alice')
    expect(() => rebindSession(db, 'old-id', 'new-id')).toThrow(ActorConflictError)
    // The pending row stays put — no half-commit.
    const pending = db
      .prepare('SELECT actor FROM pending_actors WHERE transport_id=?')
      .get('old-id') as { actor: string } | undefined
    expect(pending?.actor).toBe('bob')
  })

  it('hook-fires-first: pending=bob upgrades existingNew=default to bob', () => {
    insertPending(db, 'old-id', 'bob')
    insertSession(db, 'new-id', 'task-new', 'default')
    rebindSession(db, 'old-id', 'new-id')
    const row = db.prepare('SELECT actor FROM sessions WHERE id=?').get('new-id') as { actor: string }
    expect(row.actor).toBe('bob')
    // Pending row consumed.
    const pending = db
      .prepare('SELECT actor FROM pending_actors WHERE transport_id=?')
      .get('old-id') as { actor: string } | undefined
    expect(pending).toBeUndefined()
  })

  it('promote path (no existing newId) succeeds when actors agree', () => {
    insertSession(db, 'old-id', 'task-old', 'alice')
    rebindSession(db, 'old-id', 'new-id')
    const row = db.prepare('SELECT actor FROM sessions WHERE id=?').get('new-id') as { actor: string }
    expect(row.actor).toBe('alice')
    const oldGone = db.prepare('SELECT 1 FROM sessions WHERE id=?').get('old-id')
    expect(oldGone).toBeUndefined()
  })

  it('throws on requested-actor conflict during merge (pending=alice vs existingNew=charlie)', () => {
    insertSession(db, 'old-id', 'task-old', 'default')
    insertPending(db, 'old-id', 'alice')
    insertSession(db, 'new-id', 'task-new', 'charlie')
    expect(() => rebindSession(db, 'old-id', 'new-id')).toThrow(ActorConflictError)
  })

  it('bare-pending with no existing newId session: re-keys pending entry oldId → newId', () => {
    // Hook-fires-first for a brand-new session: /actor/register registered
    // an actor under the transport id, but no /v1/* event has landed yet
    // for either oldId OR newId. The rebind moves the pending row to the
    // new transport id so the projector picks the right actor when the
    // session's first event arrives.
    insertPending(db, 'old-id', 'bob')
    rebindSession(db, 'old-id', 'new-id')
    const oldRow = db.prepare('SELECT 1 FROM pending_actors WHERE transport_id=?').get('old-id')
    expect(oldRow).toBeUndefined()
    const newRow = db
      .prepare('SELECT actor FROM pending_actors WHERE transport_id=?')
      .get('new-id') as { actor: string } | undefined
    expect(newRow?.actor).toBe('bob')
  })
})
