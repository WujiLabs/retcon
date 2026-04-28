// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// revisions_v1 projector — maintains the immutable `revisions` DAG view.
//
// One Revision per /v1/messages HTTP call (flat model). Chains via
// parent_revision_id. Forks are sibling Revisions sharing a parent.
//
// parent_revision_id resolution (G2):
//   - fork case: set at request_received time from tobe_applied_from.
//     fork_point_revision_id.
//   - non-fork case: NULL at request_received; resolved at seal time as
//     "last Revision sealed before this one in this session's Task." Per
//     the session-sequencing invariant (one in-flight /v1/messages per
//     session), this lookup is deterministic.
//
// asset_cid arrives on the proxy.response_completed event payload. The
// proxy-handler computes the asset (dag-json of request+response body CIDs)
// because hashing is async and the projector is sync — no async hashing
// inside the single-tx event-emit invariant.

import type { DB } from './db.js'
import type { Event, Projection } from './events.js'
import { classify } from './classifier.js'

interface RequestReceivedPayload {
  method: string
  path: string
  headers_cid: string
  body_cid: string
  tobe_applied_from?: {
    fork_point_revision_id: string
    source_view_id: string
    original_body_cid: string
  }
}

interface ResponseCompletedPayload {
  request_event_id: string
  status: number
  headers_cid: string
  body_cid: string
  stop_reason: string | null
  /** Proxy pre-computes the dag-json asset CID so the projector stays sync. */
  asset_cid?: string
}

interface ResponseAbortedPayload {
  request_event_id: string
  reason?: string
}

interface UpstreamErrorPayload {
  request_event_id: string
  status?: number
  error_message?: string
}

export class RevisionsV1Projector implements Projection {
  readonly id = 'revisions_v1'
  readonly subscribedTopics: ReadonlyArray<string> = [
    'proxy.request_received',
    'proxy.response_completed',
    'proxy.response_aborted',
    'proxy.upstream_error',
  ]

  apply(event: Event, tx: DB): void {
    switch (event.topic) {
      case 'proxy.request_received':
        this.onRequestReceived(event as Event<RequestReceivedPayload>, tx)
        return
      case 'proxy.response_completed':
        this.onCompleted(event as Event<ResponseCompletedPayload>, tx)
        return
      case 'proxy.response_aborted':
        this.onAborted(event as Event<ResponseAbortedPayload>, tx)
        return
      case 'proxy.upstream_error':
        this.onUpstreamError(event as Event<UpstreamErrorPayload>, tx)
    }
  }

  private onRequestReceived(event: Event<RequestReceivedPayload>, tx: DB): void {
    if (!event.sessionId) return
    const taskRow = tx
      .prepare('SELECT task_id FROM sessions WHERE id = ?')
      .get(event.sessionId) as { task_id: string } | undefined
    if (!taskRow) {
      // sessions_v1 should have created the session already (ordered before
      // revisions_v1). If we're here, something reordered the dispatch — skip
      // rather than FK-violate, and let the operator notice via a missing row.
      return
    }

    const parent = event.payload.tobe_applied_from?.fork_point_revision_id ?? null
    tx.prepare(`
      INSERT OR IGNORE INTO revisions
        (id, task_id, asset_cid, parent_revision_id, classification, stop_reason, sealed_at, created_at)
      VALUES (?, ?, NULL, ?, 'in_flight', NULL, NULL, ?)
    `).run(event.id, taskRow.task_id, parent, event.createdAt)
  }

  private onCompleted(event: Event<ResponseCompletedPayload>, tx: DB): void {
    const reqId = event.payload.request_event_id
    const rev = tx.prepare('SELECT task_id, parent_revision_id, created_at FROM revisions WHERE id = ?').get(reqId) as
      | { task_id: string, parent_revision_id: string | null, created_at: number }
      | undefined
    if (!rev) return

    const parentId = rev.parent_revision_id ?? this.resolveParentAtSealTime(tx, rev.task_id, rev.created_at)
    const classification = classify(event.payload.stop_reason)

    tx.prepare(`
      UPDATE revisions
         SET asset_cid = ?,
             parent_revision_id = ?,
             classification = ?,
             stop_reason = ?,
             sealed_at = ?
       WHERE id = ?
    `).run(
      event.payload.asset_cid ?? null,
      parentId,
      classification,
      event.payload.stop_reason,
      event.createdAt,
      reqId,
    )
  }

  private onAborted(event: Event<ResponseAbortedPayload>, tx: DB): void {
    this.markDangling(tx, event.payload.request_event_id, event.createdAt)
  }

  private onUpstreamError(event: Event<UpstreamErrorPayload>, tx: DB): void {
    this.markDangling(tx, event.payload.request_event_id, event.createdAt)
  }

  private markDangling(tx: DB, requestEventId: string, sealedAt: number): void {
    const rev = tx
      .prepare('SELECT task_id, parent_revision_id, created_at FROM revisions WHERE id = ?')
      .get(requestEventId) as
        | { task_id: string, parent_revision_id: string | null, created_at: number }
        | undefined
    if (!rev) return
    const parentId = rev.parent_revision_id ?? this.resolveParentAtSealTime(tx, rev.task_id, rev.created_at)
    tx.prepare(`
      UPDATE revisions
         SET parent_revision_id = ?,
             classification = 'dangling_unforkable',
             sealed_at = ?
       WHERE id = ?
    `).run(parentId, sealedAt, requestEventId)
  }

  private resolveParentAtSealTime(tx: DB, taskId: string, createdAt: number): string | null {
    // Use `created_at <= ?` combined with sealed_at ordering for correctness
    // even when emits land in the same millisecond — they sort deterministically
    // by sealed_at (the instant the prior Revision sealed, strictly before this
    // one becomes seal-ready). Per the session sequencing invariant, there's
    // never more than one in-flight Revision per task at a time, so the prior
    // sealed Revision is unambiguous.
    //
    // KNOWN LIMITATION (KL-1 in the plan, adversarial finding A-WR3): this
    // query picks the most-recently-sealed Revision for the Task with no
    // awareness of which branch the user is currently on. If a user on a
    // fork branch issues a non-fork request (no `tobe_applied_from`), the
    // new Revision will be parented to the fork's leaf rather than the main
    // branch's leaf. Not reachable through Claude Code's normal turn-serial
    // flow; switching branches always goes through fork_back which sets
    // tobe_applied_from and bypasses this fallback. v1.1 adds a per-request
    // branch context that will replace this heuristic.
    const prior = tx.prepare(`
      SELECT id FROM revisions
       WHERE task_id = ?
         AND sealed_at IS NOT NULL
         AND sealed_at <= ?
       ORDER BY sealed_at DESC, id DESC
       LIMIT 1
    `).get(taskId, createdAt) as { id: string } | undefined
    return prior?.id ?? null
  }
}

/**
 * Helper used by the proxy-handler to pre-compute the Revision asset
 * (dag-json of {request_body_cid, response_body_cid}) BEFORE emitting
 * proxy.response_completed. Returns the CID (as AssetId string) + the
 * bytes to save as a blob via the StorageProvider.
 *
 * Runs async (multiformats is async). Called outside the emit transaction;
 * the bytes flow into emit's referencedBlobs[] so the save is atomic with
 * the event insert.
 */
export async function computeRevisionAsset(
  requestBodyCid: string,
  responseBodyCid: string,
): Promise<{ cid: string, bytes: Uint8Array }> {
  const { cidToAssetId, computeTopBlock } = await import('@playtiss/core')
  const { cid, bytes } = await computeTopBlock({
    request_body_cid: requestBodyCid,
    response_body_cid: responseBodyCid,
  })
  return { cid: cidToAssetId(cid), bytes }
}
