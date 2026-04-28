// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Schema + migrations for the proxy's SQLite database.
//
// Two layers:
//   1. Source of truth (append-only, immutable):  blobs, events, projection_offsets
//   2. Projected views (rebuildable from events): sessions, tasks, revisions, branch_views
//
// The schema_version row gates every startup. Source-of-truth tables evolve
// only additively (ALTER ADD COLUMN); projected views can be dropped and
// rebuilt by deleting their projection_offsets rows and restarting.
//
// v1 → v2 migration: rename the `versions` projected view to `revisions` to
// match the Collaboration Protocol vocabulary (RevisionLike in @playtiss/core).
// In-place ALTER TABLE / ALTER COLUMN preserves projected data; only event
// payloads emitted under v1 retain the old field names (`version_id`,
// `parent_version_id`), and that's fine because the cursor stays at the last
// processed event so projectors only see v2-vocabulary payloads going forward.

import Database from 'better-sqlite3'

export type DB = Database.Database

export const CURRENT_SCHEMA_VERSION = 2

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

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  asset_cid TEXT,
  parent_revision_id TEXT,
  classification TEXT NOT NULL,
  stop_reason TEXT,
  sealed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_task ON revisions(task_id);
CREATE INDEX IF NOT EXISTS idx_revisions_parent ON revisions(parent_revision_id);
CREATE INDEX IF NOT EXISTS idx_revisions_forkable
  ON revisions(task_id, classification)
  WHERE classification='closed_forkable';

CREATE TABLE IF NOT EXISTS branch_views (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  head_revision_id TEXT NOT NULL,
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
 * On a fresh DB: create everything at the latest schema and stamp the version.
 * On an existing DB at an older version: apply per-version migrations in order.
 * Reject if the DB version is newer than what this binary knows about.
 */
export function migrate(db: DB): void {
  // Always ensure source-of-truth tables exist (they're additive across versions).
  db.exec(SOURCE_OF_TRUTH_SCHEMA)

  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null }
  const current = row.v ?? 0

  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `DB schema_version=${current} is newer than this binary's ${CURRENT_SCHEMA_VERSION}. `
      + 'Upgrade @playtiss/retcon or point at a different DB.',
    )
  }

  // v1 → v2: rename `versions` projected view to `revisions`.
  if (current === 1) {
    migrateV1toV2(db)
  }

  // Create the latest projected views (no-op for tables that already exist
  // post-migration; creates fresh tables on a new DB).
  db.exec(PROJECTED_VIEWS_SCHEMA)

  if (current < CURRENT_SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(CURRENT_SCHEMA_VERSION, Date.now())
  }
}

/**
 * v1 → v2 migration: rename the `versions` projected view + columns to align
 * with Collaboration Protocol vocabulary. In-place ALTER preserves projected
 * data; the projection cursor stays where it is, so projectors only ever see
 * v2-vocabulary payloads going forward (events emitted under v1 keep their old
 * field names in the events.payload JSON, but those events have already been
 * projected before this migration runs).
 */
function migrateV1toV2(db: DB): void {
  // Drop v1 indexes (they reference the old column / table names).
  db.exec(`
    DROP INDEX IF EXISTS idx_versions_task;
    DROP INDEX IF EXISTS idx_versions_parent;
    DROP INDEX IF EXISTS idx_versions_forkable;
  `)

  // Rename the table itself.
  db.exec(`ALTER TABLE versions RENAME TO revisions`)
  db.exec(`ALTER TABLE revisions RENAME COLUMN parent_version_id TO parent_revision_id`)

  // Rename the branch_views head pointer column.
  db.exec(`ALTER TABLE branch_views RENAME COLUMN head_version_id TO head_revision_id`)

  // Rename the projector_id in projection_offsets so the v2 projector picks
  // up where the v1 projector left off.
  db.prepare(
    `UPDATE projection_offsets SET projection_id = 'revisions_v1' WHERE projection_id = 'versions_v1'`,
  ).run()

  // Indexes for the renamed table get recreated by PROJECTED_VIEWS_SCHEMA below.
}
