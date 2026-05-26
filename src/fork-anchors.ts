// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// fork_anchors — the v0.6 anchor-based context-replacement substrate.
//
// Replaces v0.5.5's `branch_context_json` + asst-text continuity check +
// fresh-fork token mechanism (three load-bearing pieces) with one mechanism:
// rewind_to's tool_result text carries a per-fork anchor token. Every
// /v1/messages scan: if claude's body contains the anchor token in any
// tool_result, splice [target_messages, ...everything_after_anchor].
// Claude's local jsonl is the source of truth for everything post-fork;
// retcon only contributes the prefix through the rewind point.
//
// State machine:
//
//                          rewind_to MCP call
//                                  │
//                                  ▼
//                             ┌─────────┐
//                             │ active  │
//                             └────┬────┘
//                                  │
//              ┌─────────────┬─────┴───────┬─────────────┐
//              │             │             │             │
//   /clear /compact      anchor       new rewind_to   splice-time
//   hook fires        missing from   on same session  guard fires
//                     /v1/msg body                    OR upstream 4xx
//              ▼             ▼             ▼             ▼
//          released      released      released         error
//          reason=       reason=       reason=          reason=
//          clear/compact divergence    superseded       parallel_tools
//                                                       or upstream_4xx
//              │             │             │             │
//              │             │             │             ▼
//              │             │             │     recall() ack
//              │             │             │             │
//              ▼             ▼             ▼             ▼
//                  (state=released — terminal)
//                            │
//                            ▼
//              <retcon-released> reminder fires until acknowledged_at
//              is set by recall() call. Recovery: new rewind_to only.
//
// `error` is a transient label preserved in state_reason; from the splice
// path's perspective, it behaves identically to `released` (no splice this
// turn, reminder until ack). We collapse it into `released` immediately on
// the failing turn — there's no scenario where we want to keep retrying.

import crypto from 'node:crypto'

import type { AssetId } from '@playtiss/core'

import { blobRefFromMessagesBody, loadHydratedMessagesBody } from './body-blob.js'
import type { DB } from './db.js'

/**
 * SR-construction metadata stashed on the active anchor row at rewind_to /
 * submit_file MCP-call time. proxy-handler emits `fork.forked` after
 * response_completed and derives tool_use_id from claude's actual sent body
 * (the pre-splice JSON request). The RewindMarkerV1 projector then INSERTs
 * the SR row with `synthetic_revision_id`. Lifted out of the deleted
 * tobe.ts in the v0.6 cutover.
 */
export interface SyntheticDepartureMeta {
  /** Discriminates which operation produced the anchor. */
  kind: 'rewind' | 'submit'
  /** target_view_id from fork.back_requested (correlation). */
  target_view_id: string
  /** Pre-generated SR id; same value used for both fork.forked emit and INSERT. */
  synthetic_revision_id: string
  /** R2' display content (varies by kind). */
  synthetic_tool_result_text: string
  /** R3' display content (varies by kind). */
  synthetic_assistant_text: string
  /** The user's `message` arg from rewind_to OR submit_file. */
  synthetic_user_message: string
  /** R1.id — the assistant turn that emitted tool_use(rewind_to | submit_file).
   *  SR.parent_revision_id will be set to this. */
  parent_revision_id: string
  /** Timestamp at MCP-call time. SR.sealed_at uses this. */
  back_requested_at: number
}

/**
 * Hard cap on the JSON-encoded size of `target_messages_json` for an active
 * anchor. Matches the v0.5.5 BRANCH_CONTEXT_MAX_BYTES contract: an 8 MiB cap
 * gives Anthropic's 200K token budget plenty of room (8 MiB / 4 bytes-per-
 * token ≈ 2M tokens) while bounding the per-row footprint. Exceeded at
 * rewind_to time → tool returns an error and refuses to create the anchor.
 */
export const TARGET_MESSAGES_MAX_BYTES = 8 * 1024 * 1024

/**
 * Regex that extracts an anchor token from a tool_result content string.
 * Format: `<retcon-anchor token="tok_<12hex>" />`. claude code MAY embed our
 * MCP response as a JSON-stringified blob in tool_result.content, which
 * double-escapes the inner quotes (`\"`) — so the regex matches either
 * raw or backslash-escaped quotes around the token. 48 bits entropy makes
 * accidental collisions astronomically unlikely either way.
 */
const ANCHOR_TAG_RE = /<retcon-anchor token=\\?"(tok_[0-9a-f]{12})\\?"\s*\/>/

export type AnchorState = 'active' | 'released'

export type AnchorStateReason
  = | 'clear'
    | 'compact'
    | 'divergence'
    | 'superseded'
    | 'migrated_from_v0_5_5'
    | 'parallel_tools'
    | 'upstream_4xx'

export interface ForkAnchor {
  anchor_token: string
  session_id: string
  /** Unfolded JSON of messages array (active only). NULL once released. */
  target_messages_json: string | null
  /** Top blob CID for content-addressed messages (released only). NULL while active. */
  target_messages_top_cid: string | null
  fork_point_revision_id: string | null
  source_view_id: string | null
  /** SyntheticDepartureMeta-shaped JSON. NULL once SR materializes. */
  synthetic_metadata_json: string | null
  state: AnchorState
  state_reason: AnchorStateReason | null
  acknowledged_at: number | null
  created_at: number
  released_at: number | null
}

/** Build the tool_result content text retcon returns from rewind_to / submit_file.
 *  Carries the anchor token; proxy-handler scans for it on subsequent
 *  /v1/messages bodies. */
export function buildAnchorToolResultText(kind: 'rewind' | 'submit', token: string): string {
  const verb = kind === 'rewind' ? 'Rewind' : 'Submit'
  return [
    `${verb} scheduled. The next message you receive will be in the ${kind === 'rewind' ? 'rewound' : 'submitted'} context.`,
    'Wait for it; do not take further action this turn.',
    `<retcon-anchor token="${token}" />`,
  ].join('\n')
}

/** Generate a fresh anchor token. `tok_<12hex>` = 48 bits entropy. The
 *  fork_anchors PRIMARY KEY catches the extremely-unlikely collision; the
 *  generator retries up to 3 times in that case (in practice never). */
export function generateAnchorToken(): string {
  return `tok_${crypto.randomBytes(6).toString('hex')}`
}

/** Scan `messages` from the END for the latest tool_result block containing
 *  an anchor token. Returns the index of the user-role message holding the
 *  match (so the splice slice point is `messages[turnIndex + 1:]`), or null.
 *
 *  Important: scans ONLY `tool_result` blocks in user-role messages — never
 *  plain user text content. This prevents false-positives from a user
 *  pasting prior tool_result text into their own message. */
export function findLatestAnchorTokenInToolResults(messages: unknown[]): {
  turnIndex: number
  token: string
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string, content?: unknown } | undefined
    if (!m || m.role !== 'user') continue
    if (!Array.isArray(m.content)) continue
    for (const block of m.content as Array<{ type?: string, content?: unknown }>) {
      if (!block || block.type !== 'tool_result') continue
      const text = extractToolResultText(block.content)
      if (!text) continue
      const match = ANCHOR_TAG_RE.exec(text)
      if (match) return { turnIndex: i, token: match[1] }
    }
  }
  return null
}

/** tool_result.content can be a string OR an array of content blocks (text,
 *  image, etc.). Extract textual content for token-matching. */
function extractToolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const c of content as Array<{ type?: string, text?: unknown }>) {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    }
    return parts.length > 0 ? parts.join('\n') : null
  }
  return null
}

/** Insert a fresh active anchor row, marking any prior active rows on this
 *  session as `released` reason='superseded`. Atomic via outer transaction. */
export interface CreateAnchorInput {
  anchor_token: string
  session_id: string
  target_messages_json: string
  fork_point_revision_id: string
  source_view_id: string
  synthetic_metadata?: SyntheticDepartureMeta
}

export function insertActiveAnchor(db: DB, input: CreateAnchorInput): void {
  const now = Date.now()
  // Mark prior active rows on this session as released (superseded).
  db.prepare(`
    UPDATE fork_anchors
       SET state = 'released',
           state_reason = 'superseded',
           released_at = ?
     WHERE session_id = ? AND state = 'active'
  `).run(now, input.session_id)
  db.prepare(`
    INSERT INTO fork_anchors (
      anchor_token, session_id, target_messages_json, target_messages_top_cid,
      fork_point_revision_id, source_view_id, synthetic_metadata_json,
      state, state_reason, acknowledged_at, created_at, released_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'active', NULL, NULL, ?, NULL)
  `).run(
    input.anchor_token,
    input.session_id,
    input.target_messages_json,
    input.fork_point_revision_id,
    input.source_view_id,
    input.synthetic_metadata ? JSON.stringify(input.synthetic_metadata) : null,
    now,
  )
}

/** Look up the (unique) active anchor for a session. */
export function getActiveAnchor(db: DB, sessionId: string): ForkAnchor | null {
  const row = db.prepare(`
    SELECT * FROM fork_anchors
     WHERE session_id = ? AND state = 'active'
     LIMIT 1
  `).get(sessionId) as ForkAnchor | undefined
  return row ?? null
}

/** Look up the (unique) anchor by token. Used by the splice path to validate
 *  a body-scanned token has a live row. */
export function getAnchorByToken(db: DB, token: string): ForkAnchor | null {
  const row = db.prepare(`
    SELECT * FROM fork_anchors WHERE anchor_token = ?
  `).get(token) as ForkAnchor | undefined
  return row ?? null
}

/** Most-recent released anchor on this session that the AI hasn't ack'd yet.
 *  Drives the persistent `<retcon-released>` reminder injection. */
export function getMostRecentUnacknowledgedRelease(db: DB, sessionId: string): ForkAnchor | null {
  const row = db.prepare(`
    SELECT * FROM fork_anchors
     WHERE session_id = ? AND state = 'released' AND acknowledged_at IS NULL
     ORDER BY released_at DESC, anchor_token DESC
     LIMIT 1
  `).get(sessionId) as ForkAnchor | undefined
  return row ?? null
}

/** Acknowledge a pending release. Called when claude's body contains a
 *  recall() tool_use referencing the row's fork_point_revision_id. */
export function acknowledgeRelease(db: DB, anchorToken: string): void {
  db.prepare(`
    UPDATE fork_anchors
       SET acknowledged_at = ?
     WHERE anchor_token = ? AND state = 'released' AND acknowledged_at IS NULL
  `).run(Date.now(), anchorToken)
}

/** Mark an active anchor as released. If `foldToCids` is true, the splice-
 *  prefix data folds into content-addressed blobs (`target_messages_json`
 *  → NULL, `target_messages_top_cid` ← top CID) so SQLite doesn't carry
 *  redundant data. The blobs table dedups identical messages across forks. */
export async function markReleased(
  db: DB,
  anchorToken: string,
  reason: AnchorStateReason,
  opts: { foldToCids?: boolean } = {},
): Promise<void> {
  const now = Date.now()
  if (opts.foldToCids) {
    const row = db.prepare(
      'SELECT target_messages_json FROM fork_anchors WHERE anchor_token = ?',
    ).get(anchorToken) as { target_messages_json: string | null } | undefined
    if (row?.target_messages_json) {
      const topCid = await foldTargetMessagesToCids(db, row.target_messages_json)
      db.prepare(`
        UPDATE fork_anchors
           SET state = 'released',
               state_reason = ?,
               released_at = ?,
               target_messages_json = NULL,
               target_messages_top_cid = ?
         WHERE anchor_token = ?
      `).run(reason, now, topCid, anchorToken)
      return
    }
  }
  db.prepare(`
    UPDATE fork_anchors
       SET state = 'released',
           state_reason = ?,
           released_at = ?
     WHERE anchor_token = ?
  `).run(reason, now, anchorToken)
}

/** Mark all active anchors for this session as released (used by /clear,
 *  /compact, divergence detection). Does NOT fold to CIDs by default —
 *  caller can fold after if they want. */
export function markSessionActiveAnchorsReleased(
  db: DB,
  sessionId: string,
  reason: AnchorStateReason,
): string[] {
  const tokens = db.prepare(`
    SELECT anchor_token FROM fork_anchors
     WHERE session_id = ? AND state = 'active'
  `).all(sessionId) as Array<{ anchor_token: string }>
  if (tokens.length === 0) return []
  const now = Date.now()
  db.prepare(`
    UPDATE fork_anchors
       SET state = 'released', state_reason = ?, released_at = ?
     WHERE session_id = ? AND state = 'active'
  `).run(reason, now, sessionId)
  return tokens.map(t => t.anchor_token)
}

/** Re-encode target_messages as content-addressed blobs and return the top
 *  CID. Idempotent (INSERT OR IGNORE in blobs). */
async function foldTargetMessagesToCids(db: DB, targetMessagesJson: string): Promise<string> {
  let messages: unknown[]
  try {
    messages = JSON.parse(targetMessagesJson) as unknown[]
  }
  catch {
    // Corrupt JSON — store the raw blob and call it a day. The CID is then
    // the hash of the corrupt bytes; load path returns null.
    const bytes = new TextEncoder().encode(targetMessagesJson)
    return await storeRawBytesAsBlob(db, bytes)
  }
  const bodyBytes = new TextEncoder().encode(JSON.stringify({ messages }))
  const split = await blobRefFromMessagesBody(bodyBytes)
  // Store every leaf + the top blob into the blobs table.
  const insertBlob = db.prepare(
    'INSERT OR IGNORE INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)',
  )
  const now = Date.now()
  for (const ref of split.refs) {
    insertBlob.run(ref.cid, ref.bytes, ref.bytes.byteLength, now)
  }
  return split.topCid
}

async function storeRawBytesAsBlob(db: DB, bytes: Uint8Array): Promise<string> {
  const split = await blobRefFromMessagesBody(bytes)
  const insertBlob = db.prepare(
    'INSERT OR IGNORE INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)',
  )
  const now = Date.now()
  for (const ref of split.refs) {
    insertBlob.run(ref.cid, ref.bytes, ref.bytes.byteLength, now)
  }
  return split.topCid
}

/** Load a released anchor's target_messages from blobs. Used for navigation
 *  reads (dump_to_file on a released anchor, content rehydration). Returns
 *  null if the top CID can't be loaded. */
export async function loadReleasedTargetMessages(
  db: DB,
  topCid: AssetId,
): Promise<unknown[] | null> {
  const provider = makeBlobStorageReader(db)
  const hydrated = await loadHydratedMessagesBody(provider, topCid)
  if (!hydrated || !Array.isArray(hydrated.messages)) return null
  return hydrated.messages as unknown[]
}

/** Minimal StorageProvider that reads blobs directly from the DB. Read-only.
 *  Used by loadReleasedTargetMessages. */
function makeBlobStorageReader(db: DB): {
  hasBuffer: (id: AssetId) => Promise<boolean>
  fetchBuffer: (id: AssetId) => Promise<Uint8Array>
  saveBuffer: (buffer: Uint8Array, id: AssetId) => Promise<void>
} {
  const existsStmt = db.prepare('SELECT 1 FROM blobs WHERE cid = ?')
  const fetchStmt = db.prepare('SELECT bytes FROM blobs WHERE cid = ?')
  return {
    hasBuffer: async (id: AssetId) => existsStmt.get(id) !== undefined,
    fetchBuffer: async (id: AssetId) => {
      const row = fetchStmt.get(id) as { bytes: Uint8Array } | undefined
      if (!row) throw new Error(`Blob not found: ${id}`)
      return row.bytes
    },
    saveBuffer: async () => { /* not used in read path */ },
  }
}

/** Splice result. `body` is the rewritten bytes ready for upstream forwarding.
 *  `releasedReason`, when set, signals the proxy to emit a release audit
 *  event and inject the `<retcon-released>` reminder beside the body. */
export interface AnchorSpliceResult {
  body: Buffer
  releasedReason?: AnchorStateReason
  /** The token that was matched (active row) or detected-but-released. */
  matchedToken?: string
}

/** The core splice. Returns null when no rewrite is needed (no anchor + no
 *  active row; or anchor + no row; or anchor + state=released with already-
 *  acknowledged release).
 *
 *  Mutates `fork_anchors` only on the divergence path (anchor expected but
 *  missing from body): marks the active row released with reason='divergence'. */
export function applyAnchorSplice(rawBody: Buffer, sessionId: string, db: DB): AnchorSpliceResult | null {
  let parsedBody: { messages?: unknown[] }
  try {
    parsedBody = JSON.parse(rawBody.toString('utf8')) as { messages?: unknown[] }
  }
  catch {
    return null
  }
  if (!Array.isArray(parsedBody.messages) || parsedBody.messages.length === 0) {
    return null
  }

  const match = findLatestAnchorTokenInToolResults(parsedBody.messages)

  if (!match) {
    // No anchor in body. Check if we expected one.
    const active = getActiveAnchor(db, sessionId)
    if (!active) return null // no fork ever, no fork now — pass through
    // Divergence — user truncated past the anchor via /rewind (or a
    // subagent body doesn't carry the parent's tool_result). Mark released.
    db.prepare(`
      UPDATE fork_anchors
         SET state = 'released',
             state_reason = 'divergence',
             released_at = ?
       WHERE anchor_token = ?
    `).run(Date.now(), active.anchor_token)
    return {
      body: rawBody,
      releasedReason: 'divergence',
      matchedToken: active.anchor_token,
    }
  }

  const row = getAnchorByToken(db, match.token)
  if (!row || row.session_id !== sessionId) {
    // Anchor in body but no DB record (or row belongs to a different session).
    // Likely stale token from a wiped daemon DB, or a subagent inheriting
    // tool_result text. Silent pass-through.
    return null
  }

  if (row.state !== 'active') {
    // Anchor present, row marked released. Splice does NOT apply.
    // The /v1/messages dispatch layer will inject `<retcon-released>` if
    // acknowledged_at is still NULL (handled outside this function).
    return null
  }

  // ACTIVE row + anchor match → splice.
  if (!row.target_messages_json) {
    // Active row should always have target_messages_json. Defensive
    // pass-through if missing (don't blow up on a half-formed row).
    return null
  }
  let targetMessages: unknown[]
  try {
    targetMessages = JSON.parse(row.target_messages_json) as unknown[]
  }
  catch {
    return null
  }
  const postAnchor = parsedBody.messages.slice(match.turnIndex + 1)
  const splicedBody = { ...parsedBody, messages: [...targetMessages, ...postAnchor] }
  return {
    body: Buffer.from(JSON.stringify(splicedBody), 'utf8'),
    matchedToken: match.token,
  }
}

/** Parse fork_anchors.synthetic_metadata_json. Two shapes can live here:
 *  (1) the BARE SyntheticDepartureMeta written at insertActiveAnchor time
 *      (initial state after rewind_to / submit_file), and (2) the WRAPPED
 *      PendingSynthetic shape written by setActiveAnchorSyntheticMetadata
 *      after the first post-rewind turn closes on tool_use (deferred SR
 *      awaiting end_turn). Both can be read on subsequent splice turns; the
 *      consumer needs the bare meta either way (for parallel-tool detection
 *      and fork.forked field extraction). This helper returns the bare meta
 *      regardless of which shape is stored, and reports whether the row is
 *      in deferred state so the caller can skip re-firing setPendingSynthetic. */
export function parseAnchorSyntheticMetadata(
  json: string | null,
): { synthetic: SyntheticDepartureMeta, deferred: boolean } | null {
  if (!json) return null
  try {
    const obj = JSON.parse(json) as
      | SyntheticDepartureMeta
      | { synthetic?: SyntheticDepartureMeta }
    if (obj && typeof (obj as SyntheticDepartureMeta).kind === 'string') {
      return { synthetic: obj as SyntheticDepartureMeta, deferred: false }
    }
    const wrapped = obj as { synthetic?: SyntheticDepartureMeta }
    if (wrapped?.synthetic && typeof wrapped.synthetic.kind === 'string') {
      return { synthetic: wrapped.synthetic, deferred: true }
    }
    return null
  }
  catch {
    return null
  }
}

/** Read fork_anchors.synthetic_metadata_json. Replaces sessions.pending_synthetic_json
 *  in the v0.6 cutover. Returns the bare meta regardless of wrapped/deferred state. */
export function getSyntheticMetadataForAnchor(
  db: DB,
  anchorToken: string,
): SyntheticDepartureMeta | null {
  const row = db.prepare(
    'SELECT synthetic_metadata_json FROM fork_anchors WHERE anchor_token = ?',
  ).get(anchorToken) as { synthetic_metadata_json: string | null } | undefined
  const parsed = parseAnchorSyntheticMetadata(row?.synthetic_metadata_json ?? null)
  return parsed?.synthetic ?? null
}

/** Clear synthetic_metadata_json once the SR row has materialized. */
export function clearSyntheticMetadata(db: DB, anchorToken: string): void {
  db.prepare(
    'UPDATE fork_anchors SET synthetic_metadata_json = NULL WHERE anchor_token = ?',
  ).run(anchorToken)
}

/** Per-session lookup of the active anchor's synthetic metadata. Helper for
 *  the deferred-fork.forked emission path which works in session-id space
 *  (it doesn't have an anchor_token at fire time — only a session_id from
 *  the proxy.response_completed event). */
export function getActiveAnchorSyntheticMetadata(
  db: DB,
  sessionId: string,
): { anchor_token: string, synthetic: SyntheticDepartureMeta, to_revision_id: string, fork_point_revision_id: string, original_body_cid: string, first_seen_at: number } | null {
  const row = db.prepare(`
    SELECT anchor_token, synthetic_metadata_json
      FROM fork_anchors
     WHERE session_id = ? AND state = 'active' AND synthetic_metadata_json IS NOT NULL
     LIMIT 1
  `).get(sessionId) as { anchor_token: string, synthetic_metadata_json: string } | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.synthetic_metadata_json) as {
      synthetic: SyntheticDepartureMeta
      to_revision_id: string
      fork_point_revision_id: string
      original_body_cid: string
      first_seen_at: number
    }
    return {
      anchor_token: row.anchor_token,
      synthetic: parsed.synthetic,
      to_revision_id: parsed.to_revision_id,
      fork_point_revision_id: parsed.fork_point_revision_id,
      original_body_cid: parsed.original_body_cid,
      first_seen_at: parsed.first_seen_at,
    }
  }
  catch {
    return null
  }
}

/** Set the in-flight SR-construction metadata on the active anchor row.
 *  Mirror of the v0.5.1 setPendingSynthetic, repointed at fork_anchors. */
export function setActiveAnchorSyntheticMetadata(
  db: DB,
  sessionId: string,
  meta: {
    synthetic: SyntheticDepartureMeta
    to_revision_id: string
    fork_point_revision_id: string
    original_body_cid: string
    first_seen_at: number
  },
): void {
  db.prepare(`
    UPDATE fork_anchors
       SET synthetic_metadata_json = ?
     WHERE session_id = ? AND state = 'active'
  `).run(JSON.stringify(meta), sessionId)
}
