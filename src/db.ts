// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Schema + migrations for the proxy's SQLite database.
//
// Two ownership layers (Step 2+ of the channel refactor):
//   1. Channel-owned (via @playtiss/core/channel): blobs, events,
//      task_metadata, channel_schema_version. Created by channel.migrate(db).
//   2. Retcon-owned (here): schema_version, sessions, tasks, revisions,
//      branch_views, pending_actors, projection_offsets (legacy — copied
//      to channel's task_metadata in the v7→v8 migration; kept for
//      forensic value).
//
// retcon's migrate() calls channel.migrate FIRST (channel's tables must
// exist before retcon's v7→v8 step references task_metadata), then runs
// retcon's own per-version migration registry.
//
// Migration policy: NEVER wipe an on-disk DB silently. If we find an older
// schema version, we (1) make a `VACUUM INTO` snapshot of the file at
// `<dbPath>.bak.v<old>.<ts>` so the user can fall back, then (2) iterate
// the MIGRATIONS registry from <old> → CURRENT_SCHEMA_VERSION applying
// each step's SQL. Missing migration step ⇒ throw with the backup path
// in the message, leaving the original DB untouched.

import * as fs from 'node:fs'
import * as path from 'node:path'

import { migrate as channelMigrate } from '@playtiss/core/channel'
import Database from 'better-sqlite3'

export type DB = Database.Database

// v5 = Phase 2 of the asset-store migration: per-message CIDs switched
// from flat-hash (Block.encode of the inline-encoded value) to Merkle-hash
// (computeStorageBlock / computeTopBlock). For Anthropic messages with a
// nested `content` array, the two hashes produce different CIDs for the
// same logical content. A v4→v5 migration would need to re-hash every
// message blob; not written yet, so attempting to upgrade a v4 DB throws
// with the backup path in the error.
//
// v6 = sessions.pending_synthetic_json column. Stores SR-construction
// metadata that survives a tool_use-chained post-rewind turn, so fork.forked
// can fire when an end_turn eventually arrives instead of dropping silently.
// Backfill is just a NULL column add — additive, no data rewrite.
//
// v8 = channel-refactor cutover: @playtiss/core/channel owns blobs / events /
// task_metadata. The v7→v8 step copies projection_offsets rows into
// task_metadata. projection_offsets stays for forensic value; nothing post-v8
// reads it.
export const CURRENT_SCHEMA_VERSION = 8

// Per-version migrations. MIGRATIONS[N] takes a DB at schema_version=N
// and brings it to N+1. Add an entry whenever you bump
// CURRENT_SCHEMA_VERSION.
const MIGRATIONS: Record<number, (db: DB) => void> = {
  5: (db) => {
    db.exec('ALTER TABLE sessions ADD COLUMN pending_synthetic_json TEXT')
  },
  // v7: per-fork random token retcon issues at rewind_to time and persists
  // alongside branch_context_json. Used by proxy-handler.ts's divergence
  // guard to detect "branch_context tail is still the synthetic_user_message"
  // (fresh fork, no extension yet) by exact-equality match against the token
  // embedded in the synthetic's `<retcon-active fork-id="...">` attribute.
  // Pattern-match alone would false-match if user content quotes a token-
  // shaped string; the DB-stored value is the only ground truth.
  // NULL when no fork active or for legacy rows; cleared together with
  // branch_context_json on release/clear/overflow.
  6: (db) => {
    db.exec('ALTER TABLE sessions ADD COLUMN branch_context_fork_id TEXT')
  },
  // v8 (Step 2 of channel refactor): the channel package now owns blobs,
  // events, and task_metadata. projection_offsets stays in retcon's
  // schema as legacy (forensic value) but the channel reads/writes
  // task_metadata for per-Task offsets. Migrate existing data so the
  // channel sees what retcon's pre-Step-2 projectors had committed.
  //
  // task_metadata is created by channel.migrate(db) which runs BEFORE
  // this step (see migrate() below).
  7: (db) => {
    db.exec(`
      INSERT INTO task_metadata (task_id, key, value)
        SELECT projection_id, 'events_offset', last_processed_event_id
          FROM projection_offsets
       WHERE last_processed_event_id IS NOT NULL
         AND last_processed_event_id != ''
      ON CONFLICT (task_id, key) DO NOTHING
    `)
    // projection_offsets table left in place for forensic value; v0.4
    // can drop it after a release cycle confirms nothing reads it.
  },
}

// Single source of truth for the schema_version table DDL. Used in two
// places (initial create in migrate() and the SOURCE_OF_TRUTH_SCHEMA
// bundle) so a column-shape change here propagates to both.
const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`

// Step 2+: blobs / events / event indexes / task_metadata are channel-owned
// (created by channel.migrate). projection_offsets stays in retcon's schema
// as a legacy table — pre-Step-2 DBs have data here that the v7→v8 migration
// copies into channel's task_metadata. Kept for forensic value; v0.4 can
// drop after a release cycle.
const SOURCE_OF_TRUTH_SCHEMA = `
${SCHEMA_VERSION_DDL}

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
  actor TEXT NOT NULL DEFAULT 'default',
  -- Persistent fork branch context. NULL when the session is on its
  -- main branch; otherwise a JSON array of messages representing the
  -- full conversation in the active forked branch (history up to the
  -- fork point + every user/assistant pair since). proxy-handler reads
  -- this on every /v1/messages and rewrites the upstream body to use
  -- it as the messages array (plus claude's new user input when the
  -- branch's tail is an assistant turn). Updated after every 2xx
  -- response. Survives daemon restarts and --resume so cross-resume
  -- forks stay coherent.
  branch_context_json TEXT,
  -- Deferred SR-construction metadata. NULL when no rewind/submit is
  -- waiting for an end_turn. Set when a TOBE-consuming /v1/messages
  -- closes with stop_reason=tool_use (the splice landed but the post-
  -- rewind first turn chained more tool calls instead of finishing).
  -- Cleared on the next end_turn (fork.forked fires then) or on a
  -- dangling stop_reason (max_tokens/refusal — fork.synthesis_failed
  -- fires) or when overwritten by a new rewind/submit. Carries the
  -- synthetic metadata, the post-rewind first turn's revision id (=
  -- to_revision_id in fork.forked), the fork-point revision id, and
  -- the original (pre-splice) request body's CID so buildSyntheticAsset
  -- can reconstruct the SR's content from blobs at fire-time.
  pending_synthetic_json TEXT,
  -- Per-fork random token (tok_ + 12 hex chars) retcon issues at
  -- rewind_to/submit_file time and embeds in the synthetic_user_message
  -- as a fork-id attribute on the retcon-active tag. proxy-handler.ts
  -- uses exact-equality against this column to detect "branch_context
  -- tail is still the synthetic" (fresh fork, no extension yet) and
  -- skip the asst-text continuity check on the first post-rewind turn
  -- (otherwise the rewound target's response, which may be compacted
  -- out of claude local view, anchors the check and false-positive-
  -- releases healthy forks). NULL when no fork active.
  branch_context_fork_id TEXT
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
  const readonly = options.readonly ?? false
  const db = new Database(options.path, { readonly })
  // Read-only opens can't set WAL or wal_autocheckpoint (both write the
  // header / checkpoint state), so skip pragmas that need write access.
  // foreign_keys is per-connection regardless.
  if (!readonly) {
    db.pragma('journal_mode = WAL')
    // Keep the WAL file from growing unbounded under sustained writes.
    // SQLite auto-truncates the WAL when it exceeds this many pages
    // (default is 1000). We set it explicitly so the behavior doesn't
    // depend on the sqlite version baked into better-sqlite3.
    db.pragma('wal_autocheckpoint = 1000')
  }
  db.pragma('foreign_keys = ON')
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
 * Fresh DB (no schema_version row): create everything at the latest schema
 * and stamp the version.
 *
 * Older DB (schema_version < CURRENT): snapshot the file via VACUUM INTO
 * to `<dbPath>.bak.v<old>.<ISO-ts>` first, then walk the MIGRATIONS
 * registry stepping from <old>+1 up to CURRENT, applying each entry. If
 * any step is missing from the registry, throw with the backup path in
 * the message and leave the live DB untouched. The user decides whether
 * to downgrade retcon, restore the backup, or wipe manually.
 *
 * Newer DB: throw. We don't downgrade.
 *
 * `dbPath` is required when the DB is on disk (so we can VACUUM INTO a
 * sibling file). Tests that open `:memory:` can omit it; in that case we
 * skip the backup since there's no file to copy.
 */
export function migrate(db: DB, dbPath?: string): void {
  // Step 2+: the channel package owns blobs/events/task_metadata/
  // channel_schema_version. Run channel.migrate FIRST so those tables
  // exist before retcon's own migrations reference them — in particular,
  // the v7→v8 step writes to task_metadata. channel.migrate is idempotent;
  // safe to call on every openDb. The channel tracks its version
  // separately in `channel_schema_version`.
  channelMigrate(db)

  // schema_version belongs to source-of-truth, but we read from it before
  // the rest of the schema exists. Create just that table first, idempotently.
  db.exec(SCHEMA_VERSION_DDL)

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
    // Take a consistent snapshot BEFORE we run a single migration step.
    // VACUUM INTO is sync, atomic, and produces a valid SQLite file at
    // dest. If anything goes wrong below, the user has this file.
    const backupPath = dbPath ? backupOnDisk(db, dbPath, current) : null
    if (backupPath) {
      process.stderr.write(`[retcon] DB schema_version=${current} predates this binary's ${CURRENT_SCHEMA_VERSION}; backed up to ${backupPath} before migrating.\n`)
    }

    for (let v = current; v < CURRENT_SCHEMA_VERSION; v++) {
      const step = MIGRATIONS[v]
      if (!step) {
        throw new Error(
          `[retcon] No migration registered for schema_version ${v} → ${v + 1}. `
          + (backupPath
            ? `Your DB has been backed up to ${backupPath} and the live file is unchanged. `
            : 'The live DB is unchanged. ')
          + `To proceed, either downgrade @playtiss/retcon to a build that wrote schema_version=${current}, `
          + 'or remove the DB to start fresh (the backup remains).',
        )
      }
      step(db)
      // Idempotent: we stamp the new version after each step so a partial
      // migration leaves a recoverable state.
      db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(v + 1, Date.now())
    }
  }

  // Always idempotently ensure the latest-schema DDL is present. On a fresh
  // DB this is the create path; on a migrated DB this is a no-op because
  // every CREATE uses IF NOT EXISTS.
  db.exec(SOURCE_OF_TRUTH_SCHEMA)
  db.exec(PROJECTED_VIEWS_SCHEMA)

  if (current === 0) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(CURRENT_SCHEMA_VERSION, Date.now())
  }
}

/**
 * Snapshot the live DB file to a sibling backup file via VACUUM INTO.
 * Returns the backup path (or throws on copy failure — we'd rather refuse
 * to migrate than risk losing the user's data without a fallback).
 *
 * VACUUM INTO is the SQLite-native way to get a consistent snapshot of an
 * open DB into a new file. It briefly takes a write lock, walks the b-tree,
 * and emits a defragmented copy. Available since SQLite 3.27 (2019); ships
 * with every better-sqlite3.
 *
 * The destination filename embeds the OLD schema version + ISO timestamp
 * so multiple backups don't collide and the user can tell which version
 * each one came from.
 */
function backupOnDisk(db: DB, dbPath: string, fromVersion: number): string {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(dir, `${base}.bak.v${fromVersion}.${ts}`)
  // VACUUM INTO refuses to overwrite. The timestamp makes collisions
  // effectively impossible, but unlink defensively just in case.
  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath)
  // Path goes into a SQL string literal; SQLite single-quote-doubling
  // escapes any quotes in dbPath. Belt-and-suspenders since dbPath comes
  // from retconHome() which we control, but cheap to be safe.
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, '\'\'')}'`)
  return backupPath
}
