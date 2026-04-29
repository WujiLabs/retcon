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
import { DEFAULT_ACTOR } from './util/actor-name.js'

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

  /**
   * Drop the alias for a transport id. Used to roll back a speculative
   * `set()` when the SQL rebind transaction fails (e.g. ActorConflictError),
   * so the in-memory routing table doesn't disagree with the persisted
   * state.
   */
  unset(transportId: string): void {
    this.map.delete(transportId)
  }

  /** Test-only: inspect current bindings. */
  size(): number {
    return this.map.size
  }
}

/**
 * Thrown when a resumed session's existing actor disagrees with the actor
 * the resuming `retcon` invocation registered. The hook handler catches
 * this, emits a `session.actor_conflict` event for audit, and returns 4xx
 * to claude. Resume binding fails; the new traffic stays orphaned under
 * the binding token until the user reconciles.
 */
export class ActorConflictError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly existingActor: string,
    public readonly requestedActor: string,
  ) {
    super(
      `session ${sessionId} has actor "${existingActor}" but resume specified `
      + `"${requestedActor}". Drop --actor (to inherit) or use the original.`,
    )
    this.name = 'ActorConflictError'
  }
}

/**
 * Atomically re-key any rows that landed under `oldId` to `newId`. Two cases:
 *
 *   PROMOTE (no row exists under newId):
 *     - sessions.id, tasks.session_id, events.session_id rename old → new
 *
 *   MERGE (row already exists under newId, e.g. resumed pre-existing session):
 *     - Conflict-check actors: throw ActorConflictError if both are set and
 *       differ. Otherwise upgrade NULL → known actor.
 *     - Find the tail of the existing session's DAG (last closed_forkable
 *       revision); link the first newly-arrived revision under oldId's task
 *       to it as parent, so fork_back can walk across the resume boundary.
 *     - Re-task all revisions / branch_views from oldTaskId → newTaskId.
 *     - Delete the duplicate task + session row.
 *     - Re-key events.session_id old → new.
 *
 * Pending actor entries (from /actor/register) are migrated alongside:
 * if one exists under oldId, it transfers to newId (or gets consumed
 * inline when the merged session is updated).
 *
 * No-op if oldId == newId or oldId has no rows yet AND no pending actor
 * was registered (hook-fires-first path).
 */
export function rebindSession(db: DB, oldId: string, newId: string): void {
  if (oldId === newId) return
  const tx = db.transaction(() => {
    const oldSession = db
      .prepare('SELECT id, task_id, actor FROM sessions WHERE id=?')
      .get(oldId) as { id: string, task_id: string, actor: string } | undefined

    // Pending actor registered under oldId (transport id). May exist even when
    // no session row yet — that's the hook-fires-before-first-event case.
    const pending = db
      .prepare('SELECT actor FROM pending_actors WHERE transport_id=?')
      .get(oldId) as { actor: string } | undefined

    if (!oldSession) {
      // No traffic under oldId yet. If a pending actor was registered, move
      // it over to newId so the projector picks it up when the first event
      // for the merged session arrives. Conflict-check against existingNew
      // if that session row already exists.
      if (pending) {
        const existingNew = db
          .prepare('SELECT actor FROM sessions WHERE id=?')
          .get(newId) as { actor: string } | undefined
        if (existingNew) {
          if (existingNew.actor !== DEFAULT_ACTOR && existingNew.actor !== pending.actor) {
            throw new ActorConflictError(newId, existingNew.actor, pending.actor)
          }
          if (existingNew.actor === DEFAULT_ACTOR && pending.actor !== DEFAULT_ACTOR) {
            db.prepare('UPDATE sessions SET actor=? WHERE id=?').run(pending.actor, newId)
          }
          db.prepare('DELETE FROM pending_actors WHERE transport_id=?').run(oldId)
        }
        else {
          // No session row yet; re-key the pending entry so future projector
          // picks the right actor when newId's first event lands.
          db.prepare('DELETE FROM pending_actors WHERE transport_id=?').run(oldId)
          db.prepare(`
            INSERT INTO pending_actors (transport_id, actor, registered_at)
            VALUES (?, ?, ?)
            ON CONFLICT(transport_id) DO UPDATE SET
              actor = excluded.actor,
              registered_at = excluded.registered_at
          `).run(newId, pending.actor, Date.now())
        }
      }
      return
    }

    const existingNew = db
      .prepare('SELECT id, task_id, actor FROM sessions WHERE id=?')
      .get(newId) as { id: string, task_id: string, actor: string } | undefined

    if (existingNew) {
      // Conflict-check actor before re-tasking. If both sides have a
      // non-default explicit actor and they differ, refuse the merge.
      const requestedActor = pending?.actor ?? oldSession.actor
      if (
        existingNew.actor !== DEFAULT_ACTOR
        && requestedActor !== DEFAULT_ACTOR
        && existingNew.actor !== requestedActor
      ) {
        throw new ActorConflictError(newId, existingNew.actor, requestedActor)
      }
      // Upgrade existingNew.actor from default → requested if applicable.
      if (existingNew.actor === DEFAULT_ACTOR && requestedActor !== DEFAULT_ACTOR) {
        db.prepare('UPDATE sessions SET actor=? WHERE id=?').run(requestedActor, newId)
      }

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
    // pending_actors entry for oldId (if any) becomes meaningless after the
    // merge — the actor was already accounted for above.
    db.prepare('DELETE FROM pending_actors WHERE transport_id=?').run(oldId)
  })
  tx()
}
