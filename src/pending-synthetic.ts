// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Deferred fork.forked emission across tool_use chains — v0.6 facade.
//
// Background: the SR (synthetic departure Revision) pipeline materializes a
// real revisions row only when the post-rewind /v1/messages closes with
// stop_reason='end_turn'. When the AI chains tool calls (Read, Bash, recall)
// the response is stop_reason='tool_use' and the gate skips. The splice
// already happened, so the rewind itself applied — but the SR row never
// materializes unless we persist enough metadata to fire fork.forked when
// the eventual end_turn arrives.
//
// v0.5.1 stored the in-flight metadata on `sessions.pending_synthetic_json`.
// v0.6 folds that into `fork_anchors.synthetic_metadata_json` (on the active
// anchor row), so retcon has ONE state machine instead of two. This file
// keeps the legacy setPendingSynthetic / getPendingSynthetic /
// clearPendingSynthetic surface and just delegates to fork-anchors.ts —
// callers in proxy-handler.ts don't need to know about the indirection.
//
// `sessions.pending_synthetic_json` is dropped in the v8→v9 migration and
// any existing in-flight metadata is folded into the migrated ghost row's
// synthetic_metadata_json (see db.ts MIGRATIONS[8]).

import type { DB } from './db.js'
import {
  clearSyntheticMetadata,
  getActiveAnchorSyntheticMetadata,
  setActiveAnchorSyntheticMetadata,
  type SyntheticDepartureMeta,
} from './fork-anchors.js'

/** Persisted form of an in-flight rewind awaiting an end_turn. */
export interface PendingSynthetic {
  /** The synthetic metadata that came in via TOBE.synthetic. */
  synthetic: SyntheticDepartureMeta
  /** First post-rewind turn's revision id (= proxy.request_received event id
   *  for the /v1/messages that consumed TOBE). Becomes fork.forked.to_revision_id. */
  to_revision_id: string
  /** Fork-point revision id (TOBE's fork_point_revision_id). Becomes
   *  fork.forked.target_revision_id. */
  fork_point_revision_id: string
  /** Pre-splice request body's CID. buildSyntheticAsset re-fetches the bytes
   *  from blobs to extract R1's parsed content (claude's tool_use block). */
  original_body_cid: string
  /** Wall-clock ms when this pending was first persisted. Diagnostic only. */
  first_seen_at: number
}

export function setPendingSynthetic(
  db: DB,
  sessionId: string,
  pending: PendingSynthetic,
): void {
  setActiveAnchorSyntheticMetadata(db, sessionId, pending)
}

export function getPendingSynthetic(db: DB, sessionId: string): PendingSynthetic | null {
  const row = getActiveAnchorSyntheticMetadata(db, sessionId)
  if (!row) return null
  return {
    synthetic: row.synthetic,
    to_revision_id: row.to_revision_id,
    fork_point_revision_id: row.fork_point_revision_id,
    original_body_cid: row.original_body_cid,
    first_seen_at: row.first_seen_at,
  }
}

export function clearPendingSynthetic(db: DB, sessionId: string): void {
  const row = getActiveAnchorSyntheticMetadata(db, sessionId)
  if (row) clearSyntheticMetadata(db, row.anchor_token)
}
