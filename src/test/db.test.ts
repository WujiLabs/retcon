// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, CURRENT_SCHEMA_VERSION, type DB, migrate, openDb } from '../db.js'

describe('db migrations', () => {
  let db: DB

  beforeEach(() => {
    db = openDb({ path: ':memory:' })
  })

  it('creates source-of-truth and projected-view tables on a fresh DB', () => {
    migrate(db)
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string }>
    const names = new Set(tables.map(t => t.name))
    for (const expected of [
      'schema_version',
      'blobs',
      'events',
      'projection_offsets',
      'sessions',
      'tasks',
      'revisions',
      'branch_views',
    ]) {
      expect(names.has(expected)).toBe(true)
    }
  })

  it('stamps CURRENT_SCHEMA_VERSION on fresh DB', () => {
    migrate(db)
    const row = db
      .prepare('SELECT MAX(version) AS v FROM schema_version')
      .get() as { v: number }
    expect(row.v).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('is idempotent — a second migrate does not stamp twice', () => {
    migrate(db)
    migrate(db)
    const count = (
      db
        .prepare('SELECT COUNT(*) AS n FROM schema_version')
        .get() as { n: number }
    ).n
    expect(count).toBe(1)
  })

  it('refuses to run against a newer DB schema version', () => {
    migrate(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      CURRENT_SCHEMA_VERSION + 100,
      Date.now(),
    )
    expect(() => migrate(db)).toThrow(/newer than this binary/)
  })

  it('sets wal_autocheckpoint pragma on openDb', () => {
    migrate(db)
    const val = db.pragma('wal_autocheckpoint', { simple: true }) as number
    expect(val).toBe(1000)
  })

  it('closeDb runs a truncating checkpoint then closes', () => {
    migrate(db)
    db.prepare('INSERT INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)').run(
      'bafy-wal-test', Buffer.from('x'), 1, Date.now(),
    )
    closeDb(db)
    expect(db.open).toBe(false)
    // Idempotent.
    expect(() => closeDb(db)).not.toThrow()
  })
})

// ─── v8 → v9 cutover migration ─────────────────────────────────────────────
//
// v0.6 replaces the sessions.branch_context_json + branch_context_fork_id +
// pending_synthetic_json columns with the new fork_anchors table. The
// migration must:
//   1. Synthesize a `released` ghost row in fork_anchors for each v0.5.5
//      session that had a non-NULL branch_context_json.
//   2. Drop the three legacy columns.
//   3. Stay idempotent on transitional v0.6 DBs where v8 was stamped with
//      the new DDL (no legacy columns) — the data-migration step skips.
//   4. Run inside a transaction so a mid-migration crash rolls back
//      cleanly (a partial ghost-row insert loop must not strand
//      schema_version at 8 with a half-populated fork_anchors).
describe('v8 → v9 migration (cutover from branch_context_json)', () => {
  let db: DB
  beforeEach(() => {
    db = openDb({ path: ':memory:' })
  })
  afterEach(() => closeDb(db))

  // Build a pre-v8 schema shape that includes the legacy columns. Mimics
  // a real v0.5.5 production DB just before the v8 → v9 step runs.
  function stampPreV9WithLegacyColumns(): void {
    // Channel tables (created by channelMigrate) + retcon schema_version
    // are bootstrapped via a normal migrate() to v8 — but we then drop
    // the v0.6 fork_anchors / new-shape and recreate sessions with the
    // legacy columns so the v8 → v9 step sees data to migrate. This is
    // the only way to test the synthesis path now that the v0.5.5
    // source-of-truth schema is no longer in the binary.
    db.exec(`
      DROP TABLE IF EXISTS branch_views;
      DROP TABLE IF EXISTS revisions;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS schema_version;

      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        harness TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        branch_context_json TEXT,
        branch_context_fork_id TEXT,
        pending_synthetic_json TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE revisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        parent_revision_id TEXT,
        classification TEXT,
        stop_reason TEXT,
        asset_cid TEXT,
        sealed_at INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at) VALUES (8, ${Date.now()});
    `)
  }

  it('synthesizes a released ghost row for each session with branch_context_json', () => {
    stampPreV9WithLegacyColumns()
    // Two sessions, both with non-NULL branch_context_json. One also has a
    // sealed closed_forkable revision so fork_point_revision_id gets populated.
    db.prepare(
      `INSERT INTO sessions (id, task_id, actor, harness, created_at,
        branch_context_json, branch_context_fork_id, pending_synthetic_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('sess-a', 'task-a', 'alice', 'claude-code', Date.now(),
      '{"messages":[]}', 'tok_oldforkid111', '{"meta":"x"}')
    db.prepare('INSERT INTO tasks (id, session_id, created_at) VALUES (?, ?, ?)')
      .run('task-a', 'sess-a', Date.now())
    db.prepare(
      `INSERT INTO revisions (id, task_id, classification, sealed_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('rev-fork-a', 'task-a', 'closed_forkable', Date.now(), Date.now())

    db.prepare(
      `INSERT INTO sessions (id, task_id, actor, harness, created_at,
        branch_context_json, branch_context_fork_id, pending_synthetic_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('sess-b', 'task-b', 'bob', 'claude-code', Date.now(),
      '{"messages":[]}', null, null)
    db.prepare('INSERT INTO tasks (id, session_id, created_at) VALUES (?, ?, ?)')
      .run('task-b', 'sess-b', Date.now())

    migrate(db)

    const ghosts = db.prepare(
      `SELECT anchor_token, session_id, state, state_reason,
              fork_point_revision_id, synthetic_metadata_json
         FROM fork_anchors ORDER BY session_id`,
    ).all() as Array<{
      anchor_token: string
      session_id: string
      state: string
      state_reason: string
      fork_point_revision_id: string | null
      synthetic_metadata_json: string | null
    }>
    expect(ghosts.length).toBe(2)
    expect(ghosts.every(g => g.state === 'released')).toBe(true)
    expect(ghosts.every(g => g.state_reason === 'migrated_from_v0_5_5')).toBe(true)
    expect(ghosts.every(g => g.anchor_token.startsWith('mig_'))).toBe(true)
    const ghostA = ghosts.find(g => g.session_id === 'sess-a')!
    expect(ghostA.fork_point_revision_id).toBe('rev-fork-a')
    expect(ghostA.synthetic_metadata_json).toBe('{"meta":"x"}')
    const ghostB = ghosts.find(g => g.session_id === 'sess-b')!
    expect(ghostB.fork_point_revision_id).toBeNull()
  })

  it('drops the three legacy sessions columns', () => {
    stampPreV9WithLegacyColumns()
    migrate(db)
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    const colNames = new Set(cols.map(c => c.name))
    expect(colNames.has('branch_context_json')).toBe(false)
    expect(colNames.has('branch_context_fork_id')).toBe(false)
    expect(colNames.has('pending_synthetic_json')).toBe(false)
  })

  it('runs cleanly on a transitional v8 DB that lacks the legacy columns', () => {
    // Some dev builds stamped v8 with the new sessions DDL (no legacy
    // columns) before MIGRATIONS[8] existed. The PRAGMA table_info guard
    // must let this case through without throwing.
    db.exec(`
      DROP TABLE IF EXISTS branch_views;
      DROP TABLE IF EXISTS revisions;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS schema_version;

      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        harness TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE revisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        parent_revision_id TEXT,
        classification TEXT,
        stop_reason TEXT,
        asset_cid TEXT,
        sealed_at INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at) VALUES (8, ${Date.now()});
    `)
    expect(() => migrate(db)).not.toThrow()
    const ghostCount = (
      db.prepare('SELECT COUNT(*) AS n FROM fork_anchors').get() as { n: number }
    ).n
    expect(ghostCount).toBe(0)
  })
})

// ─── backup + migration policy ──────────────────────────────────────────────
//
// User said "do not wipe out database on migration from now on. backup the
// database before each migration call." These tests pin that behavior.
//
// UNREGISTERED_FROM points at a schema_version step that genuinely has NO
// MIGRATIONS[N] entry. The "no migration registered" tests need this to
// trigger the registry-miss path. Currently 4 (i.e., 4→5 has no migration —
// v5 was the only-release-in-the-wild bump and was never written). Update
// this if a 4→5 migration ever lands.
const UNREGISTERED_FROM = 4

describe('migrate(): backup + per-version registry', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retcon-db-test-'))
    dbPath = path.join(tmpDir, 'proxy.db')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Open + force a specific schema_version to simulate an older binary's DB. */
  function seedDbAtVersion(v: number, withRow: boolean): void {
    const seedDb = openDb({ path: dbPath })
    migrate(seedDb, dbPath)
    if (withRow) {
      // Plant a fingerprint row so we can prove later that the DB wasn't wiped.
      seedDb.prepare('INSERT INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)')
        .run('bafy-fingerprint', Buffer.from('fp'), 2, 1234567890)
    }
    // Overwrite schema_version to make the next migrate() see an older DB.
    seedDb.prepare('DELETE FROM schema_version').run()
    seedDb.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(v, Date.now())
    closeDb(seedDb)
  }

  it('does NOT create a backup file on a fresh DB (nothing to back up)', () => {
    const freshDb = openDb({ path: dbPath })
    migrate(freshDb, dbPath)
    closeDb(freshDb)

    const siblings = fs.readdirSync(tmpDir).filter(f => f.includes('.bak.'))
    expect(siblings).toEqual([])
  })

  it('refuses to upgrade when no migration is registered AND leaves live DB untouched', () => {
    // Seed v5 (current) then force schema to v4 to simulate an older install.
    seedDbAtVersion(UNREGISTERED_FROM, true)

    const upgradedDb = openDb({ path: dbPath })
    expect(() => migrate(upgradedDb, dbPath)).toThrow(
      new RegExp(`No migration registered for schema_version ${UNREGISTERED_FROM} → ${UNREGISTERED_FROM + 1}`),
    )
    closeDb(upgradedDb)

    // Live DB is unchanged: schema_version still says the old version, and
    // the fingerprint row we planted is still there.
    const verifyDb = openDb({ path: dbPath, readonly: true })
    const v = (verifyDb.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v
    expect(v).toBe(UNREGISTERED_FROM)
    const fp = verifyDb.prepare('SELECT cid FROM blobs WHERE cid=?').get('bafy-fingerprint') as { cid: string } | undefined
    expect(fp?.cid).toBe('bafy-fingerprint')
    closeDb(verifyDb)
  })

  it('writes a backup file BEFORE attempting migration', () => {
    seedDbAtVersion(UNREGISTERED_FROM, true)

    const upgradedDb = openDb({ path: dbPath })
    expect(() => migrate(upgradedDb, dbPath)).toThrow()
    closeDb(upgradedDb)

    const backups = fs.readdirSync(tmpDir).filter(f => f.startsWith('proxy.db.bak.v'))
    expect(backups.length).toBe(1)
    // Filename should include the OLD version number.
    expect(backups[0]).toContain(`.v${UNREGISTERED_FROM}.`)

    // Backup is a real, openable SQLite file with the original fingerprint.
    const backupPath = path.join(tmpDir, backups[0])
    const backupDb = openDb({ path: backupPath, readonly: true })
    const fp = backupDb.prepare('SELECT cid FROM blobs WHERE cid=?').get('bafy-fingerprint') as { cid: string } | undefined
    expect(fp?.cid).toBe('bafy-fingerprint')
    closeDb(backupDb)
  })

  it('error message tells the user where the backup is', () => {
    seedDbAtVersion(UNREGISTERED_FROM, false)

    const upgradedDb = openDb({ path: dbPath })
    let err: Error | null = null
    try {
      migrate(upgradedDb, dbPath)
    }
    catch (e) {
      err = e as Error
    }
    closeDb(upgradedDb)

    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/backed up to .+\.bak\.v\d+\./)
    expect(err!.message).toMatch(/downgrade @playtiss\/retcon/)
  })

  it('skips backup when dbPath is omitted (in-memory or test path)', () => {
    // Even if a dbPath would be wrong, the in-memory case should keep working
    // without trying to write a backup file. Simulate by passing no path; in
    // the production code path daemon.ts always passes one.
    const memDb = openDb({ path: ':memory:' })
    // Fresh DB → migrates cleanly, no error.
    expect(() => migrate(memDb)).not.toThrow()

    // No backup files anywhere in our tmp dir.
    const siblings = fs.readdirSync(tmpDir).filter(f => f.includes('.bak.'))
    expect(siblings).toEqual([])
    closeDb(memDb)
  })
})
