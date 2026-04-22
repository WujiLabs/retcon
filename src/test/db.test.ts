// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, migrate, openDb, type DB } from '../db.js'

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
      'versions',
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
})
