// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// `retcon clean --actor <name>` — wipe every row associated with sessions
// tagged under <name>: events, branch_views, revisions, tasks, sessions,
// pending_actors, and the per-session TOBE pending files on disk. Atomic
// SQLite transaction; filesystem cleanup is best-effort after commit.
//
// Destructive of the event log. Events are normally append-only source-of-
// truth; this command removes them so an actor's traffic vanishes from
// history (intended use: cleaning up integration-test runs). Projection
// cursors (`projection_offsets.last_processed_event_id`) are not reset —
// the cursor's `event_id > last_processed` predicate naturally jumps the
// gap to the next remaining event when the projector resumes.
//
// Pre-1.0 alpha policy: this skips the daemon entirely and operates on
// `~/.retcon/proxy.db` directly. If the daemon is running, the CLI
// refuses without `--force` so a mid-stream session can't be split-written.
//
// Defaults to dry-run. `--yes` confirms the delete.

import fs from 'node:fs'

import { closeDb, openDb } from '../db.js'
import { createTobeStore } from '../tobe.js'
import { ACTOR_RE } from '../util/actor-name.js'
import { retconDbPath, retconPidFile, retconTobeDir } from './paths.js'

export interface CleanOptions {
  actor: string
  /** True means "actually delete"; false (the default) is dry-run. */
  yes: boolean
  /** Bypass the running-daemon refusal. Default false. */
  force: boolean
}

export interface CleanResult {
  /** Number of session rows that matched / would match. */
  sessions: number
  tasks: number
  revisions: number
  branchViews: number
  events: number
  tobeFilesRemoved: number
  /** True if writes were applied; false if dry-run. */
  applied: boolean
}

/**
 * Parse a `retcon clean` argv list into options. Accepts `--actor <name>`,
 * `--actor=<name>`, `--yes`/`-y`, and `--force`. Throws on missing or
 * malformed actor.
 */
export function parseCleanArgs(args: readonly string[]): CleanOptions {
  let actor: string | undefined
  let yes = false
  let force = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--actor') {
      if (i + 1 >= args.length) {
        throw new Error('missing value for --actor')
      }
      actor = args[i + 1]
      i++
    }
    else if (a.startsWith('--actor=')) {
      actor = a.slice('--actor='.length)
    }
    else if (a === '--yes' || a === '-y') {
      yes = true
    }
    else if (a === '--force') {
      force = true
    }
    else {
      throw new Error(`unknown argument: ${a}`)
    }
  }
  if (!actor) {
    throw new Error('--actor <name> is required (refusing to clean without an explicit scope)')
  }
  if (!ACTOR_RE.test(actor)) {
    throw new Error(
      `--actor "${actor}" is not a valid name. `
      + `Allowed: 1–64 characters from [A-Za-z0-9_-].`,
    )
  }
  return { actor, yes, force }
}

/**
 * Probe the retcon PID file to see if a daemon currently owns it. Returns
 * the PID if alive, null otherwise. We use a 0-signal kill to test for the
 * process; ESRCH (no process) and stale-file are both treated as "no live
 * daemon".
 */
export function detectLiveDaemon(): number | null {
  let raw: string
  try {
    raw = fs.readFileSync(retconPidFile(), 'utf8')
  }
  catch {
    return null
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  }
  catch {
    return null
  }
}

/**
 * Execute the cleanup against `~/.retcon/proxy.db` and `~/.retcon/tobe/`.
 * Returns row counts so callers can print a summary.
 *
 * Implementation note: we collect target session ids and task ids OUTSIDE
 * the transaction so the TOBE filesystem cleanup can iterate them after the
 * SQL commits. Inside the transaction we delete in dependency order.
 */
export function runClean(opts: CleanOptions): CleanResult {
  const dbPath = retconDbPath()
  if (!fs.existsSync(dbPath)) {
    return {
      sessions: 0,
      tasks: 0,
      revisions: 0,
      branchViews: 0,
      events: 0,
      tobeFilesRemoved: 0,
      applied: opts.yes,
    }
  }

  const db = openDb({ path: dbPath })
  try {
    const sessionRows = db
      .prepare('SELECT id, task_id FROM sessions WHERE actor = ?')
      .all(opts.actor) as Array<{ id: string, task_id: string }>
    const sessionIds = sessionRows.map(r => r.id)
    const taskIds = sessionRows.map(r => r.task_id)

    if (sessionIds.length === 0) {
      return {
        sessions: 0,
        tasks: 0,
        revisions: 0,
        branchViews: 0,
        events: 0,
        tobeFilesRemoved: 0,
        applied: opts.yes,
      }
    }

    const placeholders = (n: number): string => Array(n).fill('?').join(',')
    const sessionPlaceholders = placeholders(sessionIds.length)
    const taskPlaceholders = placeholders(taskIds.length)

    // Count what would be deleted — same query whether we apply or not.
    const eventsCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id IN (${sessionPlaceholders})`)
      .get(...sessionIds) as { n: number }).n
    const branchViewsCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM branch_views WHERE task_id IN (${taskPlaceholders})`)
      .get(...taskIds) as { n: number }).n
    const revisionsCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM revisions WHERE task_id IN (${taskPlaceholders})`)
      .get(...taskIds) as { n: number }).n
    const tasksCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE id IN (${taskPlaceholders})`)
      .get(...taskIds) as { n: number }).n

    let tobeFilesRemoved = 0

    if (opts.yes) {
      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM events WHERE session_id IN (${sessionPlaceholders})`)
          .run(...sessionIds)
        db.prepare(`DELETE FROM branch_views WHERE task_id IN (${taskPlaceholders})`)
          .run(...taskIds)
        db.prepare(`DELETE FROM revisions WHERE task_id IN (${taskPlaceholders})`)
          .run(...taskIds)
        db.prepare(`DELETE FROM tasks WHERE id IN (${taskPlaceholders})`)
          .run(...taskIds)
        db.prepare(`DELETE FROM sessions WHERE id IN (${sessionPlaceholders})`)
          .run(...sessionIds)
        db.prepare(`DELETE FROM pending_actors WHERE transport_id IN (${sessionPlaceholders})`)
          .run(...sessionIds)
      })
      tx()

      // Filesystem cleanup of TOBE pending files. Routed through the live
      // tobeStore so we use the same `tobe_pending-${safeName(sid)}.json`
      // path format the writer used; a hand-built `${sid}.json` is wrong
      // and silently no-ops every cleanup.
      const tobeStore = createTobeStore(retconTobeDir())
      for (const sessionId of sessionIds) {
        const tobePath = tobeStore.fileFor(sessionId)
        try {
          fs.unlinkSync(tobePath)
          tobeFilesRemoved++
        }
        catch { /* not present, fine */ }
      }
    }

    return {
      sessions: sessionIds.length,
      tasks: tasksCount,
      revisions: revisionsCount,
      branchViews: branchViewsCount,
      events: eventsCount,
      tobeFilesRemoved,
      applied: opts.yes,
    }
  }
  finally {
    closeDb(db)
  }
}

/**
 * Pretty-print a CleanResult for the CLI. Lives here so the formatting is
 * test-friendly without needing to mock stdout.
 */
export function formatCleanResult(opts: CleanOptions, result: CleanResult): string {
  const verb = result.applied ? 'deleted' : 'would delete'
  const lines = [
    `retcon clean --actor ${opts.actor}${result.applied ? ' --yes' : ''}`,
    `  ${verb}:`,
    `    sessions:      ${result.sessions}`,
    `    tasks:         ${result.tasks}`,
    `    revisions:     ${result.revisions}`,
    `    branch_views:  ${result.branchViews}`,
    `    events:        ${result.events}`,
    `    TOBE files:    ${result.tobeFilesRemoved}`,
  ]
  if (!result.applied) {
    lines.push(``, `  (dry-run; pass --yes to actually delete)`)
  }
  return lines.join('\n') + '\n'
}
