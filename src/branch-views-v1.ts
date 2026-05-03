// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// branch_views_v1 projector — maintains the `branch_views` presentation
// overlay. Branch views are user-visible, mutable cursors over the Revision
// DAG (see the plan's "branch_views" section). They are NOT protocol types;
// just a proxy-local UX primitive for naming fork destinations.
//
// Runs AFTER revisions_v1 in the dispatch chain, because `proxy.response_completed`
// advances the matching branch_view's head to the new Revision — and to do
// that we need revisions.parent_revision_id to already be set (which
// revisions_v1 does earlier in the same transaction).
//
// v0.5.0-alpha.4 design fix: auto fork-point views are created from
// `fork.forked` (success-only), not `fork.back_requested` (request-time).
// fork.back_requested fires when the MCP handler writes the TOBE pending
// file; if the splice later aborts (parallel-tool guard, upstream 5xx,
// non-end_turn stop_reason, missing synthetic metadata), the rewind never
// took effect but a phantom auto fork-point view used to land in
// branch_views anyway. Switching to fork.forked makes branch_views and SR
// rows materialize together — same success gate.

import type { DB } from './db.js'
import type { Event, Projection } from './events.js'

interface BookmarkCreatedPayload {
  view_id: string
  label: string | null
  auto_label: string
  head_revision_id: string
  task_id: string
}

/** fork.forked payload, mirroring the shape rewind-marker-v1.ts emits.
 *  Defined inline here to keep branch-views-v1 free of cross-projector
 *  imports — the field set we read is intentionally small. */
interface ForkForkedPayload {
  /** target_view_id from the original fork.back_requested correlation. */
  target_view_id: string
  /** The fork target revision (= fork_point_revision_id at MCP-call time). */
  target_revision_id: string
  /** R1.id (the assistant turn that emitted tool_use(rewind_to|submit_file)).
   *  Used to derive task_id via the revisions table. */
  parent_revision_id: string
  /** SR.sealed_at — captured at MCP-call time, used as auto_label timestamp. */
  sealed_at: number
}

interface LabelUpdatedPayload {
  view_id: string
  label: string | null
}

interface BookmarkDeletedPayload {
  view_id: string
  task_id: string
}

interface ResponseCompletedPayload {
  request_event_id: string
}

export class BranchViewsV1Projector implements Projection {
  readonly id = 'branch_views_v1'
  readonly subscribedTopics: ReadonlyArray<string> = [
    'fork.bookmark_created',
    'fork.forked',
    'fork.label_updated',
    'fork.bookmark_deleted',
    'proxy.response_completed',
  ]

  apply(event: Event, tx: DB): void {
    switch (event.topic) {
      case 'fork.bookmark_created':
        this.onBookmarkCreated(event as Event<BookmarkCreatedPayload>, tx)
        return
      case 'fork.forked':
        this.onForkForked(event as Event<ForkForkedPayload>, tx)
        return
      case 'fork.label_updated':
        this.onLabelUpdated(event as Event<LabelUpdatedPayload>, tx)
        return
      case 'fork.bookmark_deleted':
        this.onBookmarkDeleted(event as Event<BookmarkDeletedPayload>, tx)
        return
      case 'proxy.response_completed':
        this.onResponseCompleted(event as Event<ResponseCompletedPayload>, tx)
    }
  }

  private onBookmarkCreated(event: Event<BookmarkCreatedPayload>, tx: DB): void {
    const p = event.payload
    tx.prepare(`
      INSERT OR IGNORE INTO branch_views
        (id, task_id, head_revision_id, label, auto_label, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(p.view_id, p.task_id, p.head_revision_id, p.label, p.auto_label, event.createdAt, event.createdAt)
  }

  private onForkForked(event: Event<ForkForkedPayload>, tx: DB): void {
    const p = event.payload
    // Derive task_id by looking up the parent revision (R1). RewindMarker uses
    // the same lookup pattern. If the parent is missing the auto fork-point
    // view simply doesn't materialize — same conservative posture as
    // RewindMarkerV1Projector.
    const parent = tx.prepare(
      'SELECT task_id FROM revisions WHERE id = ?',
    ).get(p.parent_revision_id) as { task_id: string } | undefined
    if (!parent) return
    const shortFp = p.target_revision_id.slice(0, 8)
    // Use sealed_at (rewind initiation time) for the label so it matches the
    // moment the user thinks about, not when the projector happened to run.
    const autoLabel = `fork@${new Date(p.sealed_at).toISOString()} from ${shortFp}`
    tx.prepare(`
      INSERT OR IGNORE INTO branch_views
        (id, task_id, head_revision_id, label, auto_label, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `).run(p.target_view_id, parent.task_id, p.target_revision_id, autoLabel, event.createdAt, event.createdAt)
  }

  private onLabelUpdated(event: Event<LabelUpdatedPayload>, tx: DB): void {
    tx.prepare(`UPDATE branch_views SET label = ?, updated_at = ? WHERE id = ?`)
      .run(event.payload.label, event.createdAt, event.payload.view_id)
  }

  private onBookmarkDeleted(event: Event<BookmarkDeletedPayload>, tx: DB): void {
    // task_id guards against cross-session deletes. SQLite DELETE is idempotent,
    // so a missing row (already deleted, or task_id mismatch) is a silent no-op.
    // The MCP tool's resolver does the user-visible "not found" rejection; by
    // the time an event lands here it's authoritative.
    tx.prepare(`DELETE FROM branch_views WHERE id = ? AND task_id = ?`)
      .run(event.payload.view_id, event.payload.task_id)
  }

  // Auto-advance: branch_views are git-branch-like, not git-tag-like.
  //
  //   BEFORE turn N+1:        AFTER turn N+1 closes (parent=R_N):
  //
  //     R_N <─ view_X            R_N+1 <─ view_X    (advanced; head was R_N)
  //                                 │
  //     R_M <─ view_Y            R_N <──┘
  //                                 │
  //                              R_M <─ view_Y      (unchanged; head was R_M)
  //
  //   Multiple views at the same revision advance in lockstep. A view only
  //   stops advancing when the user forks elsewhere (rewind_to creates a NEW
  //   branch whose tail has parent=fork_point, not parent=view's-head, so
  //   the original view stays put while the new fork-point view tracks the
  //   new branch).
  //
  // KNOWN LIMITATION (KL-2 in the plan, adversarial finding A-WR4): the
  // UPDATE matches ALL views with head=parent, so two views sitting at the
  // same Revision advance in lock-step forever. In the v1 UX this is actually
  // the desired behavior — `bookmark` creates a view at the current head
  // alongside any existing view, and they track together until the user
  // forks. True branch divergence without fork_back is a v1.1 concern; fixed
  // when per-request branch context is plumbed through (see revisions-v1.ts
  // KL-1 comment).
  private onResponseCompleted(event: Event<ResponseCompletedPayload>, tx: DB): void {
    const rev = tx.prepare(
      `SELECT id, task_id, parent_revision_id FROM revisions WHERE id = ?`,
    ).get(event.payload.request_event_id) as
    | { id: string, task_id: string, parent_revision_id: string | null }
    | undefined
    if (!rev || !rev.parent_revision_id) return
    tx.prepare(`
      UPDATE branch_views
         SET head_revision_id = ?, updated_at = ?
       WHERE task_id = ? AND head_revision_id = ?
    `).run(rev.id, event.createdAt, rev.task_id, rev.parent_revision_id)
  }
}
