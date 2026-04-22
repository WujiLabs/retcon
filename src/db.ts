// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Schema + migrations for the proxy's SQLite database.
//
// Two layers:
//   1. Source of truth (append-only, immutable):  blobs, events, projection_offsets
//   2. Projected views (rebuildable from events): sessions, tasks, versions, branch_views
//
// The schema_version row gates every startup. Source-of-truth tables evolve
// only additively (ALTER ADD COLUMN); projected views can be dropped and
// rebuilt by deleting their projection_offsets rows and restarting.

import Database from 'better-sqlite3'

export type DB = Database.Database

export const CURRENT_SCHEMA_VERSION = 1

const SOURCE_OF_TRUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  cid TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic, event_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, event_id);

CREATE TABLE IF NOT EXISTS projection_offsets (
  projection_id TEXT PRIMARY KEY,
  last_processed_event_id TEXT NOT NULL DEFAULT ''
);
`

const PROJECTED_VIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  pid INTEGER,
  harness TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  asset_cid TEXT,
  parent_version_id TEXT,
  classification TEXT NOT NULL,
  stop_reason TEXT,
  sealed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_task ON versions(task_id);
CREATE INDEX IF NOT EXISTS idx_versions_parent ON versions(parent_version_id);
CREATE INDEX IF NOT EXISTS idx_versions_forkable
  ON versions(task_id, classification)
  WHERE classification='closed_forkable';

CREATE TABLE IF NOT EXISTS branch_views (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  head_version_id TEXT NOT NULL,
  label TEXT,
  auto_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_branch_views_task ON branch_views(task_id);
`

export interface OpenDbOptions {
  path: string
  readonly?: boolean
}

export function openDb(options: OpenDbOptions): DB {
  const db = new Database(options.path, { readonly: options.readonly ?? false })
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Keep the WAL file from growing unbounded under sustained writes. SQLite
  // auto-truncates the WAL when it exceeds this many pages (default is 1000).
  // We set it explicitly so the behavior doesn't depend on the sqlite version
  // baked into better-sqlite3.
  db.pragma('wal_autocheckpoint = 1000')
  return db
}

/**
 * Graceful shutdown for a DB opened via openDb(). Runs a final truncating
 * checkpoint so the WAL file doesn't survive the process exit, then closes
 * the connection. Idempotent; safe to call on an already-closed DB.
 */
export function closeDb(db: DB): void {
  if (!db.open) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  }
  catch { /* best-effort on shutdown */ }
  db.close()
}

/**
 * Apply schema migrations to bring the DB up to CURRENT_SCHEMA_VERSION.
 * On a fresh DB: create everything and stamp the version.
 * On an existing DB: reject if version is newer than compiled-in.
 * Additive migrations for older versions go here as we bump CURRENT_SCHEMA_VERSION.
 */
export function migrate(db: DB): void {
  db.exec(SOURCE_OF_TRUTH_SCHEMA)
  db.exec(PROJECTED_VIEWS_SCHEMA)

  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null }

  const current = row.v ?? 0
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `DB schema_version=${current} is newer than this binary's ${CURRENT_SCHEMA_VERSION}. `
      + 'Upgrade @playtiss/proxy or point at a different DB.',
    )
  }

  if (current < CURRENT_SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(CURRENT_SCHEMA_VERSION, Date.now())
  }
}
