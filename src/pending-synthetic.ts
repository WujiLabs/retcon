// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Deferred fork.forked emission across tool_use chains.
//
// Background: the SR (synthetic departure Revision) pipeline materializes
// a real revisions row only when the post-rewind /v1/messages closes with
// stop_reason='end_turn'. That gate makes sense for the simple case (post-
// rewind AI types one final answer), but when the AI immediately chains
// tool calls (Read, Bash, recall, etc) the response is stop_reason='tool_use'
// and the gate skips. The splice already happened (TOBE was consumed at T1),
// so the rewind itself applied — but the SR row never materializes, which
// means `recall` and `list_branches` show no audit trail of the rewind.
//
// Empirical signal from dogfooding: 7 of 9 fork.back_requested events in
// 3 days produced no fork.forked, and all 7 had stop_reason='tool_use' on
// the first post-rewind turn. The fix: persist the synthetic metadata to
// the session row when stop_reason is 'open' (tool_use, pause_turn), then
// re-check on each subsequent response_completed for the same session and
// fire fork.forked on the first 'closed_forkable' stop_reason that arrives.
//
// Persistence shape mirrors the inline pending.synthetic plus the bits we
// need to rebuild the SR's content at fire time: the post-rewind first
// turn's revision id (= to_revision_id in fork.forked) and the original
// (pre-splice) request body's CID — buildSyntheticAsset re-fetches its
// bytes from the blobs table.

import type { DB } from './db.js'
import type { SyntheticDepartureMeta } from './tobe.js'

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
  // sessions.id has a row by the time T2 runs (sessions_v1 created it on
  // proxy.request_received). UPDATE only — no INSERT. If the row's missing
  // we skip rather than create a half-formed session row.
  db.prepare(
    'UPDATE sessions SET pending_synthetic_json = ? WHERE id = ?',
  ).run(JSON.stringify(pending), sessionId)
}

export function getPendingSynthetic(db: DB, sessionId: string): PendingSynthetic | null {
  const row = db.prepare(
    'SELECT pending_synthetic_json FROM sessions WHERE id = ?',
  ).get(sessionId) as { pending_synthetic_json: string | null } | undefined
  if (!row?.pending_synthetic_json) return null
  try {
    return JSON.parse(row.pending_synthetic_json) as PendingSynthetic
  }
  catch {
    // Corrupt JSON in this column would silently break SR materialization
    // forever for this session. Clear it; audit-log nothing because the
    // value is unrecoverable anyway.
    clearPendingSynthetic(db, sessionId)
    return null
  }
}

export function clearPendingSynthetic(db: DB, sessionId: string): void {
  db.prepare(
    'UPDATE sessions SET pending_synthetic_json = NULL WHERE id = ?',
  ).run(sessionId)
}
