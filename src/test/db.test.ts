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

// ─── backup + migration policy ──────────────────────────────────────────────
//
// User said "do not wipe out database on migration from now on. backup the
// database before each migration call." These tests pin that behavior.
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
    seedDbAtVersion(CURRENT_SCHEMA_VERSION - 1, true)

    const upgradedDb = openDb({ path: dbPath })
    expect(() => migrate(upgradedDb, dbPath)).toThrow(
      new RegExp(`No migration registered for schema_version ${CURRENT_SCHEMA_VERSION - 1} → ${CURRENT_SCHEMA_VERSION}`),
    )
    closeDb(upgradedDb)

    // Live DB is unchanged: schema_version still says the old version, and
    // the fingerprint row we planted is still there.
    const verifyDb = openDb({ path: dbPath, readonly: true })
    const v = (verifyDb.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v
    expect(v).toBe(CURRENT_SCHEMA_VERSION - 1)
    const fp = verifyDb.prepare('SELECT cid FROM blobs WHERE cid=?').get('bafy-fingerprint') as { cid: string } | undefined
    expect(fp?.cid).toBe('bafy-fingerprint')
    closeDb(verifyDb)
  })

  it('writes a backup file BEFORE attempting migration', () => {
    seedDbAtVersion(CURRENT_SCHEMA_VERSION - 1, true)

    const upgradedDb = openDb({ path: dbPath })
    expect(() => migrate(upgradedDb, dbPath)).toThrow()
    closeDb(upgradedDb)

    const backups = fs.readdirSync(tmpDir).filter(f => f.startsWith('proxy.db.bak.v'))
    expect(backups.length).toBe(1)
    // Filename should include the OLD version number.
    expect(backups[0]).toContain(`.v${CURRENT_SCHEMA_VERSION - 1}.`)

    // Backup is a real, openable SQLite file with the original fingerprint.
    const backupPath = path.join(tmpDir, backups[0])
    const backupDb = openDb({ path: backupPath, readonly: true })
    const fp = backupDb.prepare('SELECT cid FROM blobs WHERE cid=?').get('bafy-fingerprint') as { cid: string } | undefined
    expect(fp?.cid).toBe('bafy-fingerprint')
    closeDb(backupDb)
  })

  it('error message tells the user where the backup is', () => {
    seedDbAtVersion(CURRENT_SCHEMA_VERSION - 1, false)

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
