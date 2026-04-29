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

import { detectLiveDaemon, formatCleanResult, parseCleanArgs, runClean } from '../cli/clean.js'
import { type DB, migrate, openDb } from '../db.js'

describe('parseCleanArgs', () => {
  it('parses --actor <value>', () => {
    expect(parseCleanArgs(['--actor', 'test'])).toEqual({ actor: 'test', yes: false, force: false })
  })
  it('parses --actor=value', () => {
    expect(parseCleanArgs(['--actor=test'])).toEqual({ actor: 'test', yes: false, force: false })
  })
  it('parses --yes / -y', () => {
    expect(parseCleanArgs(['--actor', 'test', '--yes'])).toEqual({ actor: 'test', yes: true, force: false })
    expect(parseCleanArgs(['-y', '--actor=test'])).toEqual({ actor: 'test', yes: true, force: false })
  })
  it('parses --force', () => {
    expect(parseCleanArgs(['--actor', 'test', '--force', '--yes'])).toEqual({ actor: 'test', yes: true, force: true })
  })
  it('throws when --actor is missing', () => {
    expect(() => parseCleanArgs([])).toThrow(/--actor.*required/)
  })
  it('throws when --actor is the last arg with no value', () => {
    expect(() => parseCleanArgs(['--yes', '--actor'])).toThrow(/missing value for --actor/)
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
    // Pre-create TOBE files using the same `tobe_pending-${safeName(sid)}.json`
    // format the live tobeStore writes; runClean now routes through
    // tobeStore.fileFor() so the formats must match.
    const tobeDir = path.join(tmpRoot, 'tobe')
    mkdirSync(tobeDir, { recursive: true })
    writeFileSync(path.join(tobeDir, 'tobe_pending-sess-test-1.json'), '{}')
    writeFileSync(path.join(tobeDir, 'tobe_pending-sess-test-2.json'), '{}')
    writeFileSync(path.join(tobeDir, 'tobe_pending-sess-keep-1.json'), '{}')
  })

  afterEach(() => {
    delete process.env.RETCON_HOME
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('dry-run reports counts without writing', () => {
    const r = runClean({ actor: 'test', yes: false, force: false })
    expect(r.applied).toBe(false)
    expect(r.sessions).toBe(2)
    expect(r.events).toBe(4)
    expect(r.revisions).toBe(2)
    expect(r.tasks).toBe(2)
    expect(r.branchViews).toBe(2) // one per task under 'test'
    expect(r.pendingActors).toBe(0) // none seeded
    expect(r.tobeFilesRemoved).toBe(0) // dry-run: no fs change

    // Verify rows still exist
    const db = openDb({ path: dbPath })
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE actor=?')
      .get('test') as { n: number }).n
    db.close()
    expect(remaining).toBe(2)
  })

  it('--yes deletes only the matching actor\'s rows', () => {
    const r = runClean({ actor: 'test', yes: true, force: false })
    expect(r.applied).toBe(true)
    expect(r.sessions).toBe(2)
    expect(r.events).toBe(4)
    expect(r.branchViews).toBe(2)
    expect(r.tobeFilesRemoved).toBe(2) // tobe_pending-sess-test-{1,2}.json

    // Verify only the 'keep' actor's rows remain.
    const db = openDb({ path: dbPath })
    const remainingSessions = db.prepare('SELECT id, actor FROM sessions ORDER BY id')
      .all() as Array<{ id: string, actor: string }>
    const remainingEvents = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    const remainingTasks = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
    const remainingRevisions = (db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number }).n
    const remainingBranchViews = (db.prepare('SELECT COUNT(*) AS n FROM branch_views').get() as { n: number }).n
    db.close()
    expect(remainingSessions).toEqual([{ id: 'sess-keep-1', actor: 'keep' }])
    expect(remainingEvents).toBe(2) // 2 events under sess-keep-1
    expect(remainingTasks).toBe(1)
    expect(remainingRevisions).toBe(1)
    expect(remainingBranchViews).toBe(1) // only branch under task-keep-1 survives
  })

  it('returns zeros for a non-matching actor', () => {
    const r = runClean({ actor: 'nonexistent', yes: true, force: false })
    expect(r.sessions).toBe(0)
    expect(r.events).toBe(0)
    expect(r.pendingActors).toBe(0)
    expect(r.applied).toBe(true)

    const db = openDb({ path: dbPath })
    const total = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    db.close()
    expect(total).toBe(3) // nothing deleted
  })

  it('handles a never-seen DB path gracefully', () => {
    rmSync(dbPath)
    const r = runClean({ actor: 'test', yes: true, force: false })
    expect(r.sessions).toBe(0)
  })

  it('--yes deletes orphan pending_actors entries for the actor (no session needed)', () => {
    // Seed an orphan pending entry: actor='test' registered an actor, then
    // the user CTRL-C'd before claude posted. No session row, no session_id
    // in `sessions` matches, but the pending entry should still be cleaned.
    const db = openDb({ path: dbPath })
    db.prepare('INSERT INTO pending_actors (transport_id, actor, registered_at) VALUES (?, ?, ?)')
      .run('orphan-tid-1', 'test', Date.now())
    db.prepare('INSERT INTO pending_actors (transport_id, actor, registered_at) VALUES (?, ?, ?)')
      .run('orphan-tid-keep', 'keep', Date.now())
    db.close()

    const r = runClean({ actor: 'test', yes: true, force: false })
    expect(r.applied).toBe(true)
    expect(r.pendingActors).toBe(1) // only 'test'

    const db2 = openDb({ path: dbPath })
    const remaining = db2.prepare('SELECT transport_id FROM pending_actors').all() as Array<{ transport_id: string }>
    db2.close()
    expect(remaining.map(r => r.transport_id)).toEqual(['orphan-tid-keep'])
  })

  it('--yes runs even when actor has no sessions but has orphan pending entries', () => {
    // Wipe all 'test' sessions first so only the orphan pending matters.
    const db = openDb({ path: dbPath })
    db.prepare(`DELETE FROM sessions WHERE actor='test'`).run()
    db.prepare('INSERT INTO pending_actors (transport_id, actor, registered_at) VALUES (?, ?, ?)')
      .run('lonely-orphan', 'test', Date.now())
    db.close()

    const r = runClean({ actor: 'test', yes: true, force: false })
    expect(r.applied).toBe(true)
    expect(r.sessions).toBe(0)
    expect(r.pendingActors).toBe(1)

    const db2 = openDb({ path: dbPath })
    const remaining = (db2.prepare(`SELECT COUNT(*) AS n FROM pending_actors WHERE actor='test'`).get() as { n: number }).n
    db2.close()
    expect(remaining).toBe(0)
  })
})

describe('detectLiveDaemon', () => {
  let tmpRoot: string
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'retcon-pid-test-'))
    process.env.RETCON_HOME = tmpRoot
  })
  afterEach(() => {
    delete process.env.RETCON_HOME
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('returns null when no PID file exists', () => {
    expect(detectLiveDaemon()).toBeNull()
  })

  it('returns null when the PID file is empty / malformed', () => {
    const pidPath = path.join(tmpRoot, 'proxy.pid')
    writeFileSync(pidPath, '')
    expect(detectLiveDaemon()).toBeNull()
    writeFileSync(pidPath, 'not-a-number')
    expect(detectLiveDaemon()).toBeNull()
    writeFileSync(pidPath, '-1')
    expect(detectLiveDaemon()).toBeNull()
    writeFileSync(pidPath, '0')
    expect(detectLiveDaemon()).toBeNull()
  })

  it('returns null when the PID points at a dead process', () => {
    // 999999 is well past anything we'd realistically have running. If it
    // happens to match a real process this test will spuriously pass via
    // the alive-pid path, which is harmless.
    writeFileSync(path.join(tmpRoot, 'proxy.pid'), '999999')
    expect(detectLiveDaemon()).toBeNull()
  })

  it('returns the pid when process.kill(pid, 0) succeeds', () => {
    // Our own PID is guaranteed to satisfy kill(pid, 0).
    writeFileSync(path.join(tmpRoot, 'proxy.pid'), `${process.pid}\n`)
    expect(detectLiveDaemon()).toBe(process.pid)
  })
})

describe('formatCleanResult', () => {
  it('labels output as dry-run when not applied', () => {
    const out = formatCleanResult(
      { actor: 'test', yes: false, force: false },
      { sessions: 1, tasks: 1, revisions: 2, branchViews: 0, events: 5, pendingActors: 0, tobeFilesRemoved: 0, applied: false },
    )
    expect(out).toContain('would delete')
    expect(out).toContain('dry-run')
  })
  it('labels output as deleted when applied', () => {
    const out = formatCleanResult(
      { actor: 'test', yes: true, force: false },
      { sessions: 1, tasks: 1, revisions: 2, branchViews: 0, events: 5, pendingActors: 1, tobeFilesRemoved: 1, applied: true },
    )
    expect(out).toContain('deleted')
    expect(out).toContain('pending_actors:')
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

  // 1 branch_view per task — without this the DELETE FROM branch_views path
  // executes against an empty result set and a typo in the SQL would not
  // be caught.
  for (const tid of ['task-test-1', 'task-test-2', 'task-keep-1']) {
    db.prepare(`INSERT INTO branch_views (id, task_id, head_revision_id, auto_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`bv-${tid}`, tid, `rev-${tid}`, 'main', now, now)
  }
}
