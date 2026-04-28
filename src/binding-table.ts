// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// In-memory binding-token → session_id table for late-binding resumed sessions.
//
// Background: when a user runs `claude --resume` or `claude --continue`, the
// retcon CLI cannot pre-mint claude's session_id (the picker UI lets the user
// choose, and `--session-id` conflicts with `--resume`). Instead retcon mints
// a binding_token T and injects it via x-playtiss-session / Mcp-Session-Id.
// claude's SessionStart hook fires post-picker with the actual session_id S,
// at which point retcon's daemon learns T → S and "rebinds" any traffic that
// landed under T to S in the DB.
//
// For new sessions (no --resume), the binding_token equals claude's session_id
// (we pass --session-id T), so the SessionStart hook's rebind is a no-op.

import type { DB } from './db.js'

export class BindingTable {
  private readonly map = new Map<string, string>()

  /**
   * Resolve a transport-level identifier to a DB session_id. If no binding
   * exists, return the transport id unchanged (new-session path or hook-fires-
   * first path where T is the canonical session_id).
   */
  resolve(transportId: string): string {
    return this.map.get(transportId) ?? transportId
  }

  /** Record an alias. Idempotent. */
  set(transportId: string, sessionId: string): void {
    if (transportId === sessionId) return
    this.map.set(transportId, sessionId)
  }

  /** Test-only: inspect current bindings. */
  size(): number {
    return this.map.size
  }
}

/**
 * Atomically re-key any rows that landed under `oldId` to `newId`. Two cases:
 *
 *   PROMOTE (no row exists under newId):
 *     - sessions.id, tasks.session_id, events.session_id rename old → new
 *
 *   MERGE (row already exists under newId, e.g. resumed pre-existing session):
 *     - Find the tail of the existing session's DAG (last closed_forkable
 *       revision); link the first newly-arrived revision under oldId's task
 *       to it as parent, so fork_back can walk across the resume boundary.
 *     - Re-task all revisions / branch_views from oldTaskId → newTaskId.
 *     - Delete the duplicate task + session row.
 *     - Re-key events.session_id old → new.
 *
 * No-op if oldId == newId or oldId has no rows yet (hook-fires-first path).
 */
export function rebindSession(db: DB, oldId: string, newId: string): void {
  if (oldId === newId) return
  const tx = db.transaction(() => {
    const oldSession = db
      .prepare('SELECT id, task_id FROM sessions WHERE id=?')
      .get(oldId) as { id: string, task_id: string } | undefined
    if (!oldSession) {
      // Hook fired before any traffic landed. In-memory binding alone is enough.
      return
    }

    const existingNew = db
      .prepare('SELECT id, task_id FROM sessions WHERE id=?')
      .get(newId) as { id: string, task_id: string } | undefined

    if (existingNew) {
      const oldTaskId = oldSession.task_id
      const newTaskId = existingNew.task_id
      if (oldTaskId !== newTaskId) {
        // Reconnect the DAG: link first new-task revision to last new-task tail
        // so fork_back can walk back across the resume boundary.
        const tail = db
          .prepare(
            `SELECT id FROM revisions
             WHERE task_id=? AND classification='closed_forkable'
             ORDER BY sealed_at DESC, created_at DESC LIMIT 1`,
          )
          .get(newTaskId) as { id: string } | undefined
        const firstUnderOld = db
          .prepare(
            `SELECT id FROM revisions
             WHERE task_id=? AND parent_revision_id IS NULL
             ORDER BY created_at ASC LIMIT 1`,
          )
          .get(oldTaskId) as { id: string } | undefined
        if (tail && firstUnderOld) {
          db.prepare('UPDATE revisions SET parent_revision_id=? WHERE id=?')
            .run(tail.id, firstUnderOld.id)
        }
        db.prepare('UPDATE revisions SET task_id=? WHERE task_id=?').run(newTaskId, oldTaskId)
        db.prepare('UPDATE branch_views SET task_id=? WHERE task_id=?').run(newTaskId, oldTaskId)
        db.prepare('DELETE FROM tasks WHERE id=?').run(oldTaskId)
      }
      db.prepare('DELETE FROM sessions WHERE id=?').run(oldId)
    }
    else {
      db.prepare('UPDATE sessions SET id=? WHERE id=?').run(newId, oldId)
      db.prepare('UPDATE tasks SET session_id=? WHERE session_id=?').run(newId, oldId)
    }

    db.prepare('UPDATE events SET session_id=? WHERE session_id=?').run(newId, oldId)
  })
  tx()
}
