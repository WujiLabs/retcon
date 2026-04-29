// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unit tests for `retcon clean --actor X`. These exercise the parse + run
// paths via fixture DB. The runClean() helper in cli/clean.ts opens
// retconDbPath() directly, so we use RETCON_HOME to point at a tmpdir.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { formatCleanResult, parseCleanArgs, runClean } from '../cli/clean.js'
import { type DB, migrate, openDb } from '../db.js'

describe('parseCleanArgs', () => {
  it('parses --actor <value>', () => {
    expect(parseCleanArgs(['--actor', 'test'])).toEqual({ actor: 'test', yes: false })
  })
  it('parses --actor=value', () => {
    expect(parseCleanArgs(['--actor=test'])).toEqual({ actor: 'test', yes: false })
  })
  it('parses --yes / -y', () => {
    expect(parseCleanArgs(['--actor', 'test', '--yes'])).toEqual({ actor: 'test', yes: true })
    expect(parseCleanArgs(['-y', '--actor=test'])).toEqual({ actor: 'test', yes: true })
  })
  it('throws when --actor is missing', () => {
    expect(() => parseCleanArgs([])).toThrow(/--actor.*required/)
  })
  it('throws on malformed actor', () => {
    expect(() => parseCleanArgs(['--actor', 'bad name'])).toThrow(/not a valid name/)
  })
  it('throws on unknown args (no silent acceptance)', () => {
    expect(() => parseCleanArgs(['--actor', 'test', '--bogus']))
      .toThrow(/unknown argument: --bogus/)
  })
})

describe('runClean', () => {
  let tmpRoot: string
  let dbPath: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'retcon-clean-test-'))
    process.env.RETCON_HOME = tmpRoot
    dbPath = path.join(tmpRoot, 'proxy.db')
    // Bootstrap a DB with mock rows for two actors.
    const db = openDb({ path: dbPath })
    migrate(db)
    seedFixture(db)
    db.close()
    // Pre-create some TOBE files so we can verify filesystem cleanup.
    const tobeDir = path.join(tmpRoot, 'tobe')
    mkdirSync(tobeDir, { recursive: true })
    writeFileSync(path.join(tobeDir, 'sess-test-1.json'), '{}')
    writeFileSync(path.join(tobeDir, 'sess-test-2.json'), '{}')
    writeFileSync(path.join(tobeDir, 'sess-keep-1.json'), '{}')
  })

  afterEach(() => {
    delete process.env.RETCON_HOME
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('dry-run reports counts without writing', () => {
    const r = runClean({ actor: 'test', yes: false })
    expect(r.applied).toBe(false)
    expect(r.sessions).toBe(2)
    expect(r.events).toBe(4)
    expect(r.revisions).toBe(2)
    expect(r.tasks).toBe(2)
    expect(r.tobeFilesRemoved).toBe(0) // dry-run: no fs change

    // Verify rows still exist
    const db = openDb({ path: dbPath })
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE actor=?')
      .get('test') as { n: number }).n
    db.close()
    expect(remaining).toBe(2)
  })

  it('--yes deletes only the matching actor\'s rows', () => {
    const r = runClean({ actor: 'test', yes: true })
    expect(r.applied).toBe(true)
    expect(r.sessions).toBe(2)
    expect(r.events).toBe(4)
    expect(r.tobeFilesRemoved).toBe(2) // sess-test-1.json + sess-test-2.json

    // Verify only the 'keep' actor's rows remain.
    const db = openDb({ path: dbPath })
    const remainingSessions = db.prepare('SELECT id, actor FROM sessions ORDER BY id')
      .all() as Array<{ id: string, actor: string }>
    const remainingEvents = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    const remainingTasks = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
    const remainingRevisions = (db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number }).n
    db.close()
    expect(remainingSessions).toEqual([{ id: 'sess-keep-1', actor: 'keep' }])
    expect(remainingEvents).toBe(2) // 2 events under sess-keep-1
    expect(remainingTasks).toBe(1)
    expect(remainingRevisions).toBe(1)
  })

  it('returns zeros for a non-matching actor', () => {
    const r = runClean({ actor: 'nonexistent', yes: true })
    expect(r.sessions).toBe(0)
    expect(r.events).toBe(0)
    expect(r.applied).toBe(true)

    const db = openDb({ path: dbPath })
    const total = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    db.close()
    expect(total).toBe(3) // nothing deleted
  })

  it('handles a never-seen DB path gracefully', () => {
    rmSync(dbPath)
    const r = runClean({ actor: 'test', yes: true })
    expect(r.sessions).toBe(0)
  })
})

describe('formatCleanResult', () => {
  it('labels output as dry-run when not applied', () => {
    const out = formatCleanResult(
      { actor: 'test', yes: false },
      { sessions: 1, tasks: 1, revisions: 2, branchViews: 0, events: 5, tobeFilesRemoved: 0, applied: false },
    )
    expect(out).toContain('would delete')
    expect(out).toContain('dry-run')
  })
  it('labels output as deleted when applied', () => {
    const out = formatCleanResult(
      { actor: 'test', yes: true },
      { sessions: 1, tasks: 1, revisions: 2, branchViews: 0, events: 5, tobeFilesRemoved: 1, applied: true },
    )
    expect(out).toContain('deleted')
    expect(out).not.toContain('dry-run')
  })
})

function seedFixture(db: DB): void {
  const now = Date.now()
  // Two test sessions and one keep session.
  db.prepare(`INSERT INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)`)
    .run('sess-test-1', 'task-test-1', 'test', now, 'claude-code')
  db.prepare(`INSERT INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)`)
    .run('sess-test-2', 'task-test-2', 'test', now + 1, 'claude-code')
  db.prepare(`INSERT INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)`)
    .run('sess-keep-1', 'task-keep-1', 'keep', now + 2, 'claude-code')

  db.prepare(`INSERT INTO tasks (id, session_id, created_at) VALUES (?, ?, ?)`)
    .run('task-test-1', 'sess-test-1', now)
  db.prepare(`INSERT INTO tasks (id, session_id, created_at) VALUES (?, ?, ?)`)
    .run('task-test-2', 'sess-test-2', now)
  db.prepare(`INSERT INTO tasks (id, session_id, created_at) VALUES (?, ?, ?)`)
    .run('task-keep-1', 'sess-keep-1', now)

  // 2 events per session (6 total: 4 under test, 2 under keep)
  for (const sid of ['sess-test-1', 'sess-test-2', 'sess-keep-1']) {
    for (let i = 0; i < 2; i++) {
      db.prepare(`INSERT INTO events (event_id, topic, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(`evt-${sid}-${i}`, 'proxy.request_received', '{}', sid, now + i)
    }
  }

  // 1 revision per task
  for (const [tid] of [['task-test-1'], ['task-test-2'], ['task-keep-1']]) {
    db.prepare(`INSERT INTO revisions (id, task_id, classification, created_at) VALUES (?, ?, ?, ?)`)
      .run(`rev-${tid}`, tid, 'closed_forkable', now)
  }
}
