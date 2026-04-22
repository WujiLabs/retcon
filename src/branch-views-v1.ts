// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// branch_views_v1 projector — maintains the `branch_views` presentation
// overlay. Branch views are user-visible, mutable cursors over the Version
// DAG (see the plan's "branch_views" section). They are NOT protocol types;
// just a proxy-local UX primitive for naming fork destinations.
//
// Runs AFTER versions_v1 in the dispatch chain, because `proxy.response_completed`
// advances the matching branch_view's head to the new Version — and to do
// that we need versions.parent_version_id to already be set (which
// versions_v1 does earlier in the same transaction).

import type { DB } from './db.js'
import type { Event, Projection } from './events.js'

interface BookmarkCreatedPayload {
  view_id: string
  label: string | null
  auto_label: string
  head_version_id: string
  task_id: string
}

interface BackRequestedPayload {
  source_view_id: string
  fork_point_version_id: string
  new_message_cid: string
  target_view_id: string
  task_id: string
}

interface LabelUpdatedPayload {
  view_id: string
  label: string | null
}

interface ResponseCompletedPayload {
  request_event_id: string
}

export class BranchViewsV1Projector implements Projection {
  readonly id = 'branch_views_v1'
  readonly subscribedTopics: ReadonlyArray<string> = [
    'fork.bookmark_created',
    'fork.back_requested',
    'fork.label_updated',
    'proxy.response_completed',
  ]

  apply(event: Event, tx: DB): void {
    switch (event.topic) {
      case 'fork.bookmark_created':
        this.onBookmarkCreated(event as Event<BookmarkCreatedPayload>, tx)
        return
      case 'fork.back_requested':
        this.onBackRequested(event as Event<BackRequestedPayload>, tx)
        return
      case 'fork.label_updated':
        this.onLabelUpdated(event as Event<LabelUpdatedPayload>, tx)
        return
      case 'proxy.response_completed':
        this.onResponseCompleted(event as Event<ResponseCompletedPayload>, tx)
    }
  }

  private onBookmarkCreated(event: Event<BookmarkCreatedPayload>, tx: DB): void {
    const p = event.payload
    tx.prepare(`
      INSERT OR IGNORE INTO branch_views
        (id, task_id, head_version_id, label, auto_label, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(p.view_id, p.task_id, p.head_version_id, p.label, p.auto_label, event.createdAt, event.createdAt)
  }

  private onBackRequested(event: Event<BackRequestedPayload>, tx: DB): void {
    const p = event.payload
    const shortFp = p.fork_point_version_id.slice(0, 8)
    const autoLabel = `fork@${new Date(event.createdAt).toISOString()} from ${shortFp}`
    tx.prepare(`
      INSERT OR IGNORE INTO branch_views
        (id, task_id, head_version_id, label, auto_label, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `).run(p.target_view_id, p.task_id, p.fork_point_version_id, autoLabel, event.createdAt, event.createdAt)
  }

  private onLabelUpdated(event: Event<LabelUpdatedPayload>, tx: DB): void {
    tx.prepare(`UPDATE branch_views SET label = ?, updated_at = ? WHERE id = ?`)
      .run(event.payload.label, event.createdAt, event.payload.view_id)
  }

  private onResponseCompleted(event: Event<ResponseCompletedPayload>, tx: DB): void {
    // Advance any branch_view whose head was the parent of this newly-sealed
    // Version. versions_v1 has already set parent_version_id in this same tx.
    const ver = tx.prepare(
      `SELECT id, task_id, parent_version_id FROM versions WHERE id = ?`,
    ).get(event.payload.request_event_id) as
      | { id: string, task_id: string, parent_version_id: string | null }
      | undefined
    if (!ver || !ver.parent_version_id) return
    tx.prepare(`
      UPDATE branch_views
         SET head_version_id = ?, updated_at = ?
       WHERE task_id = ? AND head_version_id = ?
    `).run(ver.id, event.createdAt, ver.task_id, ver.parent_version_id)
  }
}
