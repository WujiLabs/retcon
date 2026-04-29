// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Schema + migrations for the proxy's SQLite database.
//
// Two layers:
//   1. Source of truth (append-only, immutable):  blobs, events, projection_offsets
//   2. Projected views (rebuildable from events): sessions, tasks, revisions, branch_views
//
// Pre-1.0 alpha policy: schema bumps are destructive. If we find an older
// schema version on disk, we drop everything and recreate at the latest
// version. retcon's data at this stage is dev / test data — preserving it
// across schema changes isn't worth the migration cost. Once we cut a 1.0
// release, this comment becomes a lie and we add real migrations.

import Database from 'better-sqlite3'

export type DB = Database.Database

export const CURRENT_SCHEMA_VERSION = 3

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
  harness TEXT,
  actor TEXT NOT NULL DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS idx_sessions_actor ON sessions(actor);

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

-- Pending-actor table: retcon CLI stamps an actor here at launch (keyed by
-- the transport id it minted). The sessions_v1 projector reads this when
-- creating a session row and deletes the entry. Persistent across daemon
-- restarts (vs an in-memory map) so a CLI launch survives a daemon crash
-- between register-time and the first event landing.
CREATE TABLE IF NOT EXISTS pending_actors (
  transport_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_actors_registered_at ON pending_actors(registered_at);
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
 * Bring the DB to CURRENT_SCHEMA_VERSION.
 *
 * On a fresh DB: create everything at the latest schema and stamp the version.
 * On a DB at an older schema: drop all retcon-owned tables and recreate at
 * current. Pre-1.0 alpha policy — retcon's data is dev / test data and not
 * worth migrating yet. Reject if the DB version is newer than what this
 * binary knows about.
 */
export function migrate(db: DB): void {
  // schema_version belongs to source-of-truth, but we read from it before
  // the rest of the schema exists. Create just that table first, idempotently.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)

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

  if (current > 0 && current < CURRENT_SCHEMA_VERSION) {
    process.stderr.write(
      `[retcon] DB schema_version=${current} predates this binary's ${CURRENT_SCHEMA_VERSION}; `
      + `dropping all tables and recreating. (Pre-1.0 alpha policy: no migrations yet.)\n`,
    )
    nukeAllTables(db)
  }

  // Create everything at the latest schema. CREATE ... IF NOT EXISTS makes
  // this idempotent for both the fresh-DB case and the post-nuke case.
  db.exec(SOURCE_OF_TRUTH_SCHEMA)
  db.exec(PROJECTED_VIEWS_SCHEMA)

  if (current < CURRENT_SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(CURRENT_SCHEMA_VERSION, Date.now())
  }
}

/**
 * Drop every retcon-owned table. Pre-1.0 schema-bump shortcut so we don't
 * have to write per-version migrations for data that's all dev / test
 * traffic at this stage.
 */
function nukeAllTables(db: DB): void {
  db.exec(`
    DROP TABLE IF EXISTS pending_actors;
    DROP TABLE IF EXISTS branch_views;
    DROP TABLE IF EXISTS revisions;
    DROP TABLE IF EXISTS versions;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS projection_offsets;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS blobs;
    DROP TABLE IF EXISTS schema_version;
  `)
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)
}
