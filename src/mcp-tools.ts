// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// retcon MCP tool handlers — recall, rewind_to, bookmark.
//
// Wired into the /mcp JSON-RPC dispatcher via the `mcpTools` option on
// startServer(). Each handler receives the session id (from the
// Mcp-Session-Id header that the MCP handler extracts) and the producer,
// and operates on the proxy's own SQLite DB.
//
// rewind_to's F4 guard: walk past `open` (mid-tool-use) and `in_flight`
// (request_received, no response yet) revisions to the nearest settled
// ancestor. Both states are the model mid-thought from Anthropic's POV;
// a fresh user message there would inject where Anthropic expects a
// tool_result. Errors only when no settled revision is reachable.
//
// bookmark's G10 guard: reject when no closed_forkable Revision exists
// yet for this session.
//
// rewind_to also implements the Decision #6 "opaque dual-secret + narrow
// regex" guardrail. First call without a valid `confirm` token returns
// the rules + a freshly-generated {clean, meta} token pair. The AI must
// classify its own message and send back the matching token. Token
// pair is consumed on either path; mismatched values route back to a
// fresh first call.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { AssetId, StorageProvider } from '@playtiss/core'
import { generateTraceId } from '@playtiss/core'

import { blobRefFromBytes, loadHydratedMessagesBody } from './body-blob.js'
import { retconDumpsDir } from './cli/paths.js'
import type { DB } from './db.js'
import {
  buildAnchorToolResultText,
  generateAnchorToken,
  getActiveAnchor,
  insertActiveAnchor,
  TARGET_MESSAGES_MAX_BYTES,
} from './fork-anchors.js'
import { lastForkOutcome } from './fork-awaiter.js'
import type { McpTool } from './mcp-handler.js'
import type { TobeStore } from './tobe.js'

/**
 * Safety cap on rewind_to's user message. Anything larger hints at abuse;
 * legit prompts stay well under this. Also applies to the whole serialized
 * inputs object used for telemetry blobs.
 */
export const MAX_REWIND_MESSAGE_BYTES = 1024 * 1024 // 1 MiB

/**
 * Safety cap on recall's walk-back depth. Prevents unbounded CPU from a
 * cyclic parent chain (corrupted projection) or pathologically deep session.
 */
export const RECALL_MAX_DEPTH = 1000

/**
 * Hard cap on dump_to_file's serialized output size and submit_file's input
 * file size. Mirrors the 8 MiB cap on `branch_context_json` in proxy-handler
 * — if a conversation is too long for an in-memory branch context, it's also
 * too long for a JSONL dump+submit round-trip. Without this, a runaway dump
 * fills the disk and an attacker-crafted submit blows up the daemon's heap.
 */
export const MAX_DUMP_BYTES = 8 * 1024 * 1024 // 8 MiB

/**
 * Filename-safety regex for the session id component of dump filenames.
 * Defense-in-depth against a malformed/malicious Mcp-Session-Id header
 * making `${sessionId}-${turnId}.jsonl` escape the dumps directory via path
 * traversal. The proxy already mints UUIDs, but the binding-table can carry
 * any string; we sanitize at the boundary anyway.
 */
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/

/**
 * Confirm-token TTL. After 5 minutes the token pair is considered stale
 * and the AI's next call returns fresh rules + a new pair.
 */
export const CONFIRM_TOKEN_TTL_MS = 5 * 60 * 1000

/**
 * Cap on bookmark label length. The label is persisted in branch_views.label
 * and surfaced back to the LLM via list_branches and recall — an unbounded
 * label expands every future tools/list response. 256 chars is enough for
 * meaningful human labels ("v1 baseline before refactor") and short of any
 * reasonable abuse vector.
 */
export const MAX_BOOKMARK_LABEL_BYTES = 256

interface McpToolDeps {
  db: DB
  tobeStore: TobeStore
  /** Same DB, but accessed via the @playtiss/core StorageProvider
   *  contract. body-blob's hydrate path goes through here instead of
   *  raw `SELECT bytes FROM blobs WHERE cid = ?`. */
  storageProvider: StorageProvider
  /** When false, rewind_to returns an error + emits fork.back_disabled_rejected. */
  rewindEnabled?: boolean
}

interface SessionRow {
  task_id: string
  harness: string | null
}

interface RevisionRow {
  id: string
  task_id: string
  asset_cid: string | null
  parent_revision_id: string | null
  classification: string
  stop_reason: string | null
  sealed_at: number | null
  created_at: number
}

/**
 * Build the synthetic user-role message that retcon delivers as the rewind/
 * submit landing turn. Wraps the AI's `message` arg in a content array
 * alongside a `<retcon-active>` reminder block. The AI parses the reminder
 * (claude is trained on similar `<system-reminder>` shape) and applies the
 * directives — one user-facing (surfaced in the response so the human sees
 * it in claude code's UI), one AI-internal (a reasoning guideline only,
 * not echoed back).
 *
 * The user-facing one is the only channel retcon has to reach the human
 * in claude code's UI: claude's `/rewind` slash command never reaches the
 * LLM, retcon can't modify claude's UI directly, and pre-splice tool
 * results are discarded. The post-splice AI response IS the channel.
 *
 *   - User-facing warning: claude code's `/rewind` does not release retcon's
 *     fork. The AI tells the user to use `/clear`, `/compact`, or another
 *     `rewind_to`. (Without this notice users silently get Frankenstein
 *     conversations — see CHANGELOG 0.5.3.)
 *   - AI-internal directive: files referenced in earlier turns may have
 *     advanced on disk past the rewound branch's view. Re-Read before
 *     trusting cached memory. The AI applies this when making decisions;
 *     not surfaced to the user (would be UX noise on every fork).
 *
 * Decision #6 in INSIGHTS.md says the user's `message` is delivered VERBATIM
 * with no wrapping. This addition keeps the verbatim contract (the user's
 * text is its own block, byte-equal to what they passed) but adds an
 * adjacent system-reminder-style block at the start of the same user-role
 * message. The verbatim text is unchanged; only the surrounding context
 * grows. retcon's own injection skip logic (isInjectionText) recognizes the
 * pattern and treats the turn as a real user prompt because substantive
 * content remains after stripping the reminder block.
 */
/**
 * Per-fork random token format. Embedded as a `fork-id="..."` attribute
 * on the `<retcon-active>` opening tag inside the synthetic_user_message
 * AND persisted to `sessions.branch_context_fork_id`. The proxy uses
 * exact-equality match (proxy-handler.ts:isSyntheticUserMessageTail)
 * between the column and the tail user message's first text block to
 * detect "branch_context tail is still the synthetic" (fresh fork, no
 * extension yet) — distinguishing retcon's synthetic from any user content
 * that happens to mention `<retcon-active>` (e.g., conversations about
 * retcon's own design — this very codebase has many such references).
 *
 * Token is 12 hex chars (48 bits, ~281 trillion possibilities). Random
 * per rewind. The DB column is the ground truth; the in-text marker is
 * the comparison subject. The AI never needs to echo it back.
 */
const FORK_ID_PREFIX = 'tok_'
const FORK_ID_HEX_LEN = 12

export function generateForkId(): string {
  return `${FORK_ID_PREFIX}${randomBytes(FORK_ID_HEX_LEN / 2).toString('hex')}`
}

/** Build the `<retcon-active fork-id="...">` opening tag retcon embeds in
 *  the synthetic_user_message. Exposed so the proxy-handler can build the
 *  exact substring it needs to search for in branch_context's tail. */
export function buildForkIdMarker(forkId: string): string {
  return `<retcon-active fork-id="${forkId}">`
}

/**
 * Build the `<retcon-active>` reminder text blocks. Returns an array of
 * separate text blocks (one per logical directive) following claude code's
 * `<system-reminder>`-per-block pattern. Mirroring claude's representation
 * keeps the model's reading behavior consistent across the two reminder
 * types it sees most.
 *
 * The FIRST block carries the `fork-id="..."` attribute that
 * proxy-handler.ts:isSyntheticUserMessageTail detects via exact-equality
 * against `sessions.branch_context_fork_id` — keep block[0] stable.
 */
export function buildActiveReminderBlocks(forkId: string): Array<{ type: 'text', text: string }> {
  return [
    {
      type: 'text',
      text: [
        buildForkIdMarker(forkId),
        '[system note from retcon proxy — NOT from the user]',
        'A retcon fork is now active. The user\'s actual message follows in a later block.',
        'The `fork-id` attribute on this tag is a retcon-internal marker — ignore it.',
        '</retcon-active>',
      ].join('\n'),
    },
    {
      type: 'text',
      text: [
        '<retcon-active>',
        'After answering the user\'s question, briefly mention this ONCE to the user:',
        '- They should NOT use claude code\'s `/rewind` slash command — it cannot release this retcon fork. To switch contexts, use `/clear`, `/compact`, or another `rewind_to`.',
        '</retcon-active>',
      ].join('\n'),
    },
    {
      type: 'text',
      text: [
        '<retcon-active>',
        'For your own reasoning ONLY (do NOT mention this to the user — it would be UX noise):',
        '- Files referenced in earlier turns may have changed on disk between the rewound point and now. Re-Read any file you rely on before trusting cached memory of it.',
        '</retcon-active>',
      ].join('\n'),
    },
  ]
}

function synthesizeUserMessageWithReminder(userMessage: string, forkId: string): {
  role: 'user'
  content: Array<{ type: 'text', text: string }>
} {
  return {
    role: 'user',
    content: [
      ...buildActiveReminderBlocks(forkId),
      { type: 'text', text: userMessage },
    ],
  }
}

function loadSession(db: DB, sessionId: string): SessionRow | undefined {
  return db.prepare('SELECT task_id, harness FROM sessions WHERE id = ?').get(sessionId) as
    | SessionRow
    | undefined
}

function loadRevision(db: DB, revisionId: string): RevisionRow | undefined {
  return db.prepare('SELECT * FROM revisions WHERE id = ?').get(revisionId) as RevisionRow | undefined
}

function mostRecentRevision(db: DB, taskId: string): RevisionRow | undefined {
  // id DESC breaks ties when multiple Revisions land in the same millisecond.
  // Event ids are monotonic within a producer (TraceIdGenerator sequence),
  // so id DESC is the correct stable order.
  return db.prepare(
    'SELECT * FROM revisions WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
  ).get(taskId) as RevisionRow | undefined
}

function mostRecentForkableRevision(db: DB, taskId: string): RevisionRow | undefined {
  // Walk DESC by sealed_at and return the first non-injection closed_forkable.
  // "Most recent forkable" is the user-visible "current head" — it should match
  // what `effectiveHead` returns and what `turn_back_n=1` lands on. Without the
  // skip, claude-harness pseudo-prompts (SUGGESTION MODE / system-reminder) sit
  // at the tail and `bookmark` / `dump_to_file` would default to those instead
  // of the real conversational head.
  const rows = db.prepare(`
    SELECT * FROM revisions
     WHERE task_id = ? AND classification = 'closed_forkable' AND sealed_at IS NOT NULL
     ORDER BY sealed_at DESC, id DESC
     LIMIT 64
  `).all(taskId) as RevisionRow[]
  for (const r of rows) {
    if (!isHarnessInjectionRevision(db, r.id)) return r
  }
  return undefined
}

/**
 * Map a Revision's stop_reason to recall's `kind` discriminator. Real turns
 * surface as 'turn'; SR rows (Phase 2's synthetic departure Revisions) carry
 * stop_reason='rewind_synthetic' or 'submit_synthetic' so we can discriminate
 * them cheaply via the column rather than joining the events table.
 */
function turnKindFor(stopReason: string | null): 'turn' | 'rewind_marker' | 'submit_marker' {
  if (stopReason === 'rewind_synthetic') return 'rewind_marker'
  if (stopReason === 'submit_synthetic') return 'submit_marker'
  return 'turn'
}

/**
 * Return all closed_forkable revision ids for a task in DESC order — the same
 * sequence `recall` list-mode walks. Used by `list_branches` to compute
 * `n_back_of_head` (position of a branch_view's head_revision_id in this
 * sequence) without re-querying per row. O(N) in the task's forkable count.
 */
function forkableSequence(db: DB, taskId: string): string[] {
  const rows = db.prepare(`
    SELECT id FROM revisions
     WHERE task_id = ? AND classification = 'closed_forkable' AND sealed_at IS NOT NULL
     ORDER BY sealed_at DESC, id DESC
  `).all(taskId) as Array<{ id: string }>
  return rows.map(r => r.id)
}

/**
 * Look up the request_received event for a given revision id and return its
 * request body CID. Revisions table doesn't carry this directly (the Revision's
 * asset_cid points at the {request_body_cid, response_body_cid} DictAsset);
 * rather than parsing the asset, we query the events table by the revision id.
 */
function requestBodyCidFor(db: DB, revisionId: string): string | null {
  const row = db.prepare(`
    SELECT payload FROM events WHERE event_id = ? AND topic = 'proxy.request_received'
  `).get(revisionId) as { payload: string } | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.payload) as { body_cid?: string }
    return parsed.body_cid ?? null
  }
  catch {
    return null
  }
}

/**
 * Find the EARLIEST non-injection DESCENDANT of a Revision. Fork-point
 * reconstruction needs a descendant's request body to recover the messages[]
 * prefix at the fork point — the algorithm assumes child.body =
 * [...history, target_response, child_user_input], which holds for normal
 * user-prompt children.
 *
 * Two ways harness injections break direct-child lookup:
 *   1. Standalone probe injections (system-reminder, /v1 quota check) often
 *      ship with body=[probe_user_msg] — msgs=1, no conversation history.
 *      Picking that as the child produces an empty `slice(0, -1)`.
 *   2. The target's only direct child can BE an injection, in which case the
 *      "real continuation" turn is a grandchild. (Empirical case: ZEBRA →
 *      system-reminder probe → AARDVARK. ZEBRA's direct child is the probe;
 *      we need AARDVARK two hops down.)
 *
 * Walk via DFS: at each level, return the first non-injection child; for any
 * injection child, recurse into ITS children to skip past the probe. Bounded
 * depth (RECALL_MAX_DEPTH) and visited set guard against cycles.
 */
function firstChild(db: DB, parentRevisionId: string): RevisionRow | undefined {
  const visited = new Set<string>()
  function walk(parentId: string, depth: number): RevisionRow | undefined {
    if (depth > RECALL_MAX_DEPTH) return undefined
    if (visited.has(parentId)) return undefined
    visited.add(parentId)
    const rows = db.prepare(`
      SELECT * FROM revisions WHERE parent_revision_id = ?
       ORDER BY created_at ASC, id ASC LIMIT 32
    `).all(parentId) as RevisionRow[]
    let firstInjection: RevisionRow | undefined
    for (const r of rows) {
      if (isHarnessInjectionRevision(db, r.id)) {
        if (!firstInjection) firstInjection = r
        continue
      }
      return r
    }
    // No non-injection direct child. Recurse into the first injection's
    // descendants to find a non-injection one further down.
    if (firstInjection) {
      const grand = walk(firstInjection.id, depth + 1)
      if (grand) return grand
      return firstInjection // last resort: return the injection itself
    }
    return undefined
  }
  return walk(parentRevisionId, 0)
}

/**
 * Concat all `type='text'` blocks of a leaf message's content (joined by
 * newline). Handles both string content and array content. Naturally skips
 * `thinking`, `tool_use`, and `tool_result` blocks because they're not
 * `type='text'`. Returns empty string if no text content found.
 *
 * claude code can split a single user turn into multiple text blocks
 * (`<system-reminder>` wrappers + the user's actual prompt as separate
 * blocks). Picking only the first block would see the reminder alone;
 * combining lets downstream callers see the whole thing.
 */
function messageText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const m = msg as { content?: unknown }
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  return (m.content as Array<{ type?: string, text?: string }>)
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text!)
    .join('\n')
}

/**
 * Resolve a possibly-link-shaped messages[] entry to its leaf object.
 * Top-blob storage uses `{ '/': cid }` link refs; this fetches the leaf
 * blob and parses. Returns null on any miss / parse failure (defensive).
 */
function resolveLeaf(db: DB, m: unknown): { role?: string, content?: unknown } | null {
  if (!m || typeof m !== 'object') return null
  if ('/' in m && typeof (m as { '/': unknown })['/'] === 'string') {
    const leafBlob = db.prepare('SELECT bytes FROM blobs WHERE cid = ?').get((m as { '/': string })['/']) as { bytes: Buffer } | undefined
    if (!leafBlob) return null
    try {
      return JSON.parse(leafBlob.bytes.toString('utf8'))
    }
    catch { return null }
  }
  if ('role' in m) return m as { role?: string, content?: unknown }
  return null
}

/**
 * Synchronous probe: does this revision's request body's last user message
 * match a known harness pseudo-prompt? Used by effectiveHead / nthForkableBack /
 * countForkableBack / forkableSequence to skip injection turns when computing
 * "N back" — the user's mental model counts conversational turns, not raw
 * revisions, and harness injections (SUGGESTION MODE, system-reminder recap)
 * shouldn't shift the index.
 *
 * Read path: requestBodyCidFor → blobs (top blob with messages link list) →
 * blobs (last user leaf). All sync via better-sqlite3. Returns false on any
 * lookup miss / parse failure (defensive: don't block legitimate navigation
 * because of a corrupt blob).
 */
function isHarnessInjectionRevision(db: DB, revisionId: string): boolean {
  const cid = requestBodyCidFor(db, revisionId)
  if (!cid) return false
  const top = db.prepare('SELECT bytes FROM blobs WHERE cid = ?').get(cid) as { bytes: Buffer } | undefined
  if (!top) return false
  let parsed: { messages?: unknown[] }
  try {
    parsed = JSON.parse(top.bytes.toString('utf8'))
  }
  catch { return false }
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return false
  // Walk last user message in the messages array.
  for (let i = parsed.messages.length - 1; i >= 0; i--) {
    const leaf = resolveLeaf(db, parsed.messages[i])
    if (!leaf || leaf.role !== 'user') continue
    const text = messageText(leaf)
    if (!text) return false
    return isInjectionText(text)
  }
  return false
}

/**
 * Walk past `open` and `in_flight` revisions AND past harness-injection
 * `closed_forkable` revisions (SUGGESTION MODE / recap pseudo-prompts) from
 * the most recent revision to find the nearest "navigable" ancestor — i.e.,
 * a settled, non-injection revision the user thinks of as a real turn.
 * Both `recall` and `rewind_to` use this so `turn_back_n=1` consistently
 * means "one user-prompt back" rather than "one transport-revision back".
 *
 * Returns undefined if no settled non-injection revision is reachable. Cycle-
 * safe: a corrupt parent_revision_id chain terminates via the visited set
 * and depth cap rather than spinning forever.
 */
function effectiveHead(db: DB, taskId: string): RevisionRow | undefined {
  let head: RevisionRow | undefined = mostRecentRevision(db, taskId)
  const visited = new Set<string>()
  for (let i = 0; i < RECALL_MAX_DEPTH; i++) {
    if (!head) return undefined
    if (visited.has(head.id)) return undefined
    visited.add(head.id)
    const isOpen = head.classification === 'open' || head.classification === 'in_flight'
    const isInjection = head.classification === 'closed_forkable' && isHarnessInjectionRevision(db, head.id)
    if (!isOpen && !isInjection) return head
    if (!head.parent_revision_id) return undefined
    head = loadRevision(db, head.parent_revision_id)
  }
  return undefined
}

/**
 * Walk backward from `start` (exclusive) collecting the first N closed_forkable
 * revisions, SKIPPING harness-injection turns. Returns the Nth (1-indexed) or
 * undefined if fewer than N qualifying revisions exist. The returned revision
 * is the FORK POINT for rewind_to.
 *
 * `start` itself is "where we are" — it is NOT counted, even if it's closed_forkable.
 *
 * Cycle-safe: walks at most RECALL_MAX_DEPTH steps, tracking visited ids.
 */
function nthForkableBack(db: DB, start: RevisionRow, n: number): RevisionRow | undefined {
  let walked = 0
  let cursor: string | null = start.parent_revision_id
  let target: RevisionRow | undefined
  const visited = new Set<string>([start.id])
  for (let i = 0; i < RECALL_MAX_DEPTH; i++) {
    if (walked >= n || !cursor) break
    if (visited.has(cursor)) break
    visited.add(cursor)
    const rev = loadRevision(db, cursor)
    if (!rev) break
    if (rev.classification === 'closed_forkable' && !isHarnessInjectionRevision(db, rev.id)) {
      target = rev
      walked++
      if (walked >= n) break
    }
    cursor = rev.parent_revision_id
  }
  if (walked < n) return undefined
  return target
}

/**
 * Count how many non-injection closed_forkable revisions are reachable backward
 * from `start` (exclusive). Used for the "only N rewindable turns available"
 * error message. Counting must match nthForkableBack's filter, otherwise a user
 * sees "X available" but `rewind_to(turn_back_n=X)` returns undefined.
 */
function countForkableBack(db: DB, start: RevisionRow): number {
  let count = 0
  let cursor: string | null = start.parent_revision_id
  const visited = new Set<string>([start.id])
  for (let i = 0; i < RECALL_MAX_DEPTH; i++) {
    if (!cursor) break
    if (visited.has(cursor)) break
    visited.add(cursor)
    const rev = loadRevision(db, cursor)
    if (!rev) break
    if (rev.classification === 'closed_forkable' && !isHarnessInjectionRevision(db, rev.id)) count++
    cursor = rev.parent_revision_id
  }
  return count
}

/**
 * Recognize claude-harness pseudo-prompts that get spliced into messages[]
 * as user-role turns. Three we observe in the wild:
 *   - "The user stepped away and is coming back. Recap in under 40 words…"
 *     fires when the user's terminal idles, asks the AI for a short recap.
 *   - "[SUGGESTION MODE: Suggest what the user might naturally type next…"
 *     fires before claude shows its predictive-suggest UI.
 *   - "<system-reminder>…</system-reminder>" with no body after — pure
 *     reminder turns (file-opened, task-tool nudge, date change). When a
 *     system-reminder is followed by real user content, that's a normal
 *     user prompt and we leave it alone.
 *
 * All three are noise for navigation purposes. `isInjectionText` and
 * downstream callers (effectiveHead, nthForkableBack, countForkableBack,
 * mostRecentForkableRevision) skip them so `turn_back_n=1` consistently
 * means "one user-prompt back."
 *
 * Patterns kept narrow (anchor-at-start, no false-positive risk in real
 * user prose). New harness injections can be added here as observed.
 */
const HARNESS_INJECTION_PATTERNS: readonly RegExp[] = [
  /^The user stepped away and is coming back\b/,
  /^\[SUGGESTION MODE:/,
]

function isInjectionText(text: string): boolean {
  if (HARNESS_INJECTION_PATTERNS.some(re => re.test(text))) return true
  // System-reminder turns are injection ONLY when nothing substantive remains
  // after stripping the <system-reminder> blocks. A user prompt prefixed by a
  // system-reminder (claude harness pattern when the user opens a file in
  // the IDE, hits a date change, etc.) keeps the real user content after
  // the closing tag — that's a real turn.
  if (text.startsWith('<system-reminder>')) {
    const stripped = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim()
    if (stripped === '') return true
  }
  return false
}

/**
 * Extract `user` and `prior_asst` previews from a revision's request body.
 *
 * Conceptually each turn is a (user, assistant_response) pair where the user
 * message is at the body's tail and the assistant_response is the next /v1/
 * messages's response. For preview purposes we show the (user, prior_asst)
 * tuple — the user message of THIS turn, and the assistant message that
 * came BEFORE it (= the prior turn's response). Together these locate the
 * turn in conversation flow without needing to fetch the next turn's body.
 *
 * Walks the body's messages array backward:
 *   1. Find the last user-role message, skipping harness pseudo-prompts
 *      (recap hooks, SUGGESTION MODE) when a real user message exists; fall
 *      back to the injection text if every user is an injection.
 *   2. From that user's index, walk further back to find the most recent
 *      assistant-role message with non-empty text. That's `prior_asst`.
 *
 * Both fields are truncated to `maxLen` chars (default 100) with "…" suffix.
 * `prior_asst` is null when no asst exists before the user (e.g., session
 * start). On body lookup failure, returns placeholder strings so the recall
 * list still has something to show.
 */
async function turnPreview(
  deps: { db: DB, storageProvider: StorageProvider },
  revisionId: string,
  maxLen = 100,
): Promise<{ user: string, prior_asst: string | null }> {
  const cid = requestBodyCidFor(deps.db, revisionId)
  if (!cid) return { user: '(no body)', prior_asst: null }
  const messages = await hydrateMessages(deps, cid as AssetId)
  if (!messages || messages.length === 0) return { user: '(empty body)', prior_asst: null }

  // Walk back through user messages until we find one that isn't a harness
  // injection. Fall back to the most-recent injection text if every user
  // message in scope is one.
  let userIdx = -1
  let firstInjection: { idx: number, text: string } | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string } | undefined
    if (m?.role !== 'user') continue
    const text = messageText(messages[i]).replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (isInjectionText(text)) {
      if (firstInjection === null) firstInjection = { idx: i, text }
      continue
    }
    userIdx = i
    break
  }
  let userText: string
  let userIdxFinal: number
  if (userIdx >= 0) {
    userText = messageText(messages[userIdx]).replace(/\s+/g, ' ').trim()
    userIdxFinal = userIdx
  }
  else if (firstInjection) {
    userText = firstInjection.text
    userIdxFinal = firstInjection.idx
  }
  else {
    return { user: '(no user message)', prior_asst: null }
  }

  // Walk further back from the user's index to find the most recent assistant
  // message with non-empty text. That's the prior_asst (= the response BEFORE
  // this turn's user message arrived).
  let priorAsstText: string | null = null
  for (let i = userIdxFinal - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string } | undefined
    if (m?.role !== 'assistant') continue
    const text = messageText(messages[i]).replace(/\s+/g, ' ').trim()
    if (text) {
      priorAsstText = text
      break
    }
  }

  const truncate = (s: string) => s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s
  return {
    user: truncate(userText),
    prior_asst: priorAsstText ? truncate(priorAsstText) : null,
  }
}

// ─── Confirm token store (Decision #6: opaque dual-secret) ───────────────────

interface ConfirmTokenPair {
  clean: string
  meta: string
  expiresAt: number
}

/**
 * In-memory store mapping session_id → { clean_token, meta_token, expiresAt }.
 *
 * Both tokens are 8-char opaque alphanumeric — no semantic prefix, so the AI
 * can't pick the "ship it" path without actually reading the rules text. The
 * AI looks up which token corresponds to "my message stands alone" vs
 * "my message has a meta-reference" by reading the rules, then sends the
 * matching one as `confirm`.
 *
 * Lifecycle:
 *   - generate(sid): mint a new pair, replace any existing entry, return pair.
 *   - match(sid, val): which token (if any) does `val` match? returns
 *                      'clean' | 'meta' | null.
 *   - consume(sid): drop the entry. Both tokens are single-use; the next call
 *                   gets a fresh pair.
 *
 * TTL is enforced lazily on each access — expired entries are treated as if
 * they never existed (caller will see no match and route to first-call rules).
 * No background sweeper for v0.4; entries are short-lived and per-session.
 */
export class ConfirmTokenStore {
  private map = new Map<string, ConfirmTokenPair>()
  private readonly ttlMs: number

  constructor(ttlMs: number = CONFIRM_TOKEN_TTL_MS) {
    this.ttlMs = ttlMs
  }

  generate(sessionId: string, now: number = Date.now()): ConfirmTokenPair {
    // Loop until clean !== meta. Collision probability is ~5e-15 per attempt
    // with 8-char alphanumeric tokens; this loop almost always exits on the
    // first iteration. The check matters because if the two tokens collide,
    // a meta-flagged confirm would route to the clean path (match() returns
    // 'clean' first), denying the AI's self-flag.
    const clean = opaqueToken()
    let meta = opaqueToken()
    while (clean === meta) {
      meta = opaqueToken()
    }
    const pair: ConfirmTokenPair = { clean, meta, expiresAt: now + this.ttlMs }
    this.map.set(sessionId, pair)
    return pair
  }

  match(sessionId: string, value: string, now: number = Date.now()): 'clean' | 'meta' | null {
    const entry = this.map.get(sessionId)
    if (!entry) return null
    if (entry.expiresAt < now) {
      this.map.delete(sessionId)
      return null
    }
    if (value === entry.clean) return 'clean'
    if (value === entry.meta) return 'meta'
    return null
  }

  consume(sessionId: string): void {
    this.map.delete(sessionId)
  }

  /** For tests only. */
  peek(sessionId: string): ConfirmTokenPair | undefined {
    return this.map.get(sessionId)
  }

  /** For tests only. */
  clear(): void {
    this.map.clear()
  }
}

/**
 * 8-char alphanumeric token. Opaque by design (no semantic prefix). Drawn
 * uniformly from a 62-char alphabet → 62^8 ≈ 2.18×10^14 possible values.
 * Collision is statistically negligible for the per-session use case.
 *
 * Uses rejection sampling on the random bytes to avoid the modulo-bias of
 * the naïve `bytes[i] % 62` approach (256 % 62 = 8, so the first 8 alphabet
 * chars would be ~25% over-represented). We oversample by 2x and discard
 * values >= 248 (the largest multiple of 62 that fits in a byte). The retry
 * path is rare; if 16 bytes still doesn't yield 8 unbiased samples we
 * recurse, but in practice this never recurses more than once.
 */
function opaqueToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const limit = Math.floor(256 / alphabet.length) * alphabet.length // 248
  const out: string[] = []
  while (out.length < 8) {
    const bytes = randomBytes(16)
    for (let i = 0; i < bytes.length && out.length < 8; i++) {
      const b = bytes[i]!
      if (b < limit) out.push(alphabet[b % alphabet.length]!)
    }
  }
  return out.join('')
}

// ─── Narrow META_REFS regex backstop (Decision #6) ───────────────────────────

/**
 * Narrow META_REFS list. Four patterns where the false-positive rate is
 * essentially zero in technical-writing contexts. The earlier 8-pattern list
 * (including "previous answer", "as I said", "my last response", "mentioned
 * earlier", "like before") was dropped — those have legitimate uses. The
 * dual-secret classifier handles the ambiguous cases; this regex catches
 * only the most flagrant misuses where the AI engaged with the rules but
 * still inherited user phrasing verbatim.
 *
 * Tunable. Phase 4 A/B harness data drives any future widening or narrowing.
 */
export const META_REFS: readonly RegExp[] = [
  // (?!\s*\d) negative lookahead skips data-narrative phrasings like "we saw
  // above 90%" while still catching meta-references like "see above for
  // context", "see above.", "read above and revise".
  /\b(see|saw|read) above\b(?!\s*\d)/i,
  /\bcontinue from (here|where we left off)\b/i,
  /\bredo (your|my) (last|previous) (answer|response|message|reply)\b/i,
  /\bthe (last|previous) (question|answer|message|response) I (asked|gave|sent)\b/i,
]

/**
 * Returns the first META_REFS pattern matched by `message`, or null if
 * none match. The matched pattern is included in rejection responses so
 * the AI sees exactly which phrasing tripped the regex.
 */
export function detectMetaRef(message: string): RegExp | null {
  for (const re of META_REFS) {
    if (re.test(message)) return re
  }
  return null
}

// ─── Rewind rules text + scheduled-response ──────────────────────────────────

/**
 * The rules text returned on the first call to rewind_to (no/invalid
 * `confirm`). Includes the freshly-generated token pair inline so the AI
 * can pick the matching one without round-tripping. Verbatim — the
 * receiving AI has no memory of the rewind, so the calling AI must pack
 * everything into `message` itself.
 */
function rewindRulesText(tokens: ConfirmTokenPair): string {
  return [
    'rewind_to: rules + classification tokens (read carefully — these tokens are single-use and you will need them).',
    '',
    'WHAT THIS TOOL DOES:',
    'rewind_to walks back N forkable turns and replaces the conversation tail with your `message` arg. The rewound history replaces the next /v1/messages call. Your `message` arg becomes the next user-role turn delivered to the AI handling that call — and that AI has NO MEMORY of:',
    '  - the user\'s most recent prompt that triggered this rewind',
    '  - your own reasoning that led to calling this tool',
    '  - any cut-off turns (they\'re gone from the receiving AI\'s context)',
    '',
    'PARALLEL TOOLS — DO NOT call rewind_to alongside other tools in the same assistant turn. The rewound history replaces the next /v1/messages, so any sibling tool_use calls (Read, Bash, Edit, etc.) lose their results before the receiving AI ever sees them. Call rewind_to alone, finish your other work first, OR pack the substantive change into the `message` arg instead.',
    '',
    'So `message` must:',
    '  1. Carry the SUBSTANTIVE instruction. Not "rewind to my previous answer" — the rewind already happened, and the receiving AI sees no "previous answer." Send the new value, the corrected plan, the actual instruction.',
    '  2. Be readable in isolation. Don\'t write "let\'s continue from here" — there\'s no shared "here" for the receiving AI. The history above must already make sense; this turn must already make sense.',
    '  3. Include change-context if the user should see the AI acknowledge the change. If the user changed their mind from A to B and you want acknowledgment, write "B (changing my earlier answer of A)". Pure "B" works for clean redos.',
    '  4. Be framed from the user\'s POV. It becomes a user-role turn. For user-initiated rewinds, write what the user would have said if they\'d retyped at the rewound point. For AI-initiated rewinds, write the user-shaped instruction the user WOULD have given if they\'d been steering you.',
    '  5. NOT re-introduce the thing being forgotten. If the user said "forget about the pink elephant" and your `message` says "no pink elephants here", the post-rewind AI sees the elephant again and the rewind was wasted. For sensitive content (passwords, leaked credentials, PII), describe the removal in general terms ("(I removed the leaked credential from the earlier turn)") rather than echoing the actual value. The whole point of forgetting is to NOT name the thing.',
    '  6. Pack stacked instructions. When the user says "rewind to X, then answer Y", the post-rewind AI lands at X with no awareness of Y. Put Y in `message` so it has something to do — otherwise the receiving AI sees only history-up-to-X and a placeholder turn, and may produce a confused "what would you like?" response instead of answering.',
    '  7. Tell the post-rewind AI to RE-READ files before relying on remembered content. Files on disk may have changed between the fork point and now (commits landed, edits happened in this branch but on the rewound branch they didn\'t). The system prompt\'s gitstatus and IDE-open files reflect CURRENT disk state, not the rewound branch state — which can mislead the post-rewind AI into recapping or referencing files it never actually saw in its rewound context. If `message` mentions any files, paths, or code state, append a verify-before-trust note: "Re-Read any files I mention before relying on cached memory of them — disk may have advanced past the rewound point."',
    '',
    'EXAMPLES:',
    '  User: "I want to change my previous answer from A to B."',
    '    → message: "B (changing my earlier answer of A)"',
    '  User: "Restart from the database planning. Use Postgres instead of SQLite."',
    '    → message: "Let\'s use Postgres for the database, not SQLite."',
    '  User: "Go back to before we started talking about auth, then answer: what\'s the right session timeout?"',
    '    → message: "What\'s the right session timeout?"  (the stacked question goes IN the message)',
    '  User: "Forget the API key I just leaked." (single-turn version — for multi-turn, use submit_file)',
    '    → message: "(I removed the leaked credential from the earlier turn — please continue without referencing it.)"',
    '  You (AI, autonomously realized you went off track):',
    '    → message: "Let me try a different approach. Use approach Y instead of approach X — [explain in 1-2 sentences]."',
    '',
    'ANTI-PATTERNS — do not pass these:',
    '  ❌ "continue from here"  ❌ "redo your last response"',
    '  ❌ "the same question I just asked"  ❌ "what I said earlier"',
    '  ❌ "User wants to change A to B." (third-person, reads weird as a user-turn)',
    '  ❌ Echoing the forgotten content ("ignore the password ABC123" — re-leaks it).',
    '',
    'NOW CLASSIFY YOUR MESSAGE AND RE-CALL:',
    '',
    `  - If your \`message\` STANDS ALONE (no meta-references, readable with no cut-off context): re-call with confirm="${tokens.clean}"`,
    `  - If your \`message\` contains a META-REFERENCE you spotted: re-call with confirm="${tokens.meta}" — we will reject and you can revise`,
    '',
    'Both tokens are single-use. They expire in 5 minutes. If you classify dishonestly (send the clean token with a meta-reference in your message), we run a narrow regex check that catches the most flagrant cases.',
    '',
    'Note on the tokens: they classify your CURRENT message, not the one you originally typed. The pair is bound to your session, not to a specific message — if your first attempt had a meta-reference, REVISE the `message` arg and use the token that matches the revised version. The clean path is the goal; the meta path is an honest escape hatch when you can\'t fix the message yourself.',
  ].join('\n')
}

/**
 * Educational response when the AI sends the meta_token (self-flagged its
 * own message). Includes a fresh token pair so retry is one call away.
 */
function rewindMetaFlaggedResponse(newTokens: ConfirmTokenPair): { status: string, message: string } {
  return {
    status: 'rejected',
    message: [
      'Good catch — you flagged a meta-reference in your `message`. Revise to be self-contained.',
      '',
      'Remember: the receiving AI has no memory of cut-off turns. Pack the substantive instruction into `message` itself, framed as a user-role prompt.',
      '',
      `New tokens (the previous pair was consumed): clean="${newTokens.clean}", meta="${newTokens.meta}"`,
    ].join('\n'),
  }
}

/**
 * Rejection response when the narrow regex catches a meta-reference on the
 * clean-token path (AI sent clean_token but the message contains a flagrant
 * meta-reference). Includes the matched pattern for transparency + a fresh
 * token pair for retry.
 */
function rewindRegexRejectedResponse(
  matched: RegExp,
  newTokens: ConfirmTokenPair,
): { status: string, message: string, matched_pattern: string } {
  return {
    status: 'rejected',
    matched_pattern: matched.source,
    message: [
      `Regex caught a meta-reference matching ${matched.source}. The post-rewind AI has no memory of cut-off turns — references like this confuse it.`,
      '',
      'Revise your `message` to be self-contained. Examples:',
      '  ❌ "change my previous answer from A to B"',
      '  ✅ "B"',
      '  ✅ "B (changing my earlier answer of A)"',
      '',
      `If your reference is intentional and points at content visible in the rewound history, set allow_meta_refs=true on the next call.`,
      '',
      `New tokens (the previous pair was consumed): clean="${newTokens.clean}", meta="${newTokens.meta}"`,
    ].join('\n'),
  }
}

/**
 * The "scheduled" response — carries the v0.6 anchor token.
 *
 * The `message` text embeds `<retcon-anchor token="tok_..." />` which the
 * proxy's applyAnchorSplice scans for in claude's next /v1/messages body
 * (specifically in tool_result content). When found, the splice replaces
 * the body with [target_messages, ...messages_after_anchor_turn].
 *
 * Unlike the v0.5.x "RETCON ERROR" loud-failure scaffold, this response
 * is friendly and informational — claude stores it in local jsonl unchanged.
 * The failure signal moves to a `<retcon-released>` reminder injected by
 * the proxy on subsequent /v1/messages whenever the fork's state is
 * `released` and `acknowledged_at` is still NULL.
 */
function rewindScheduledResponse(extra: {
  fork_point: string
  target_view_id: string
  anchor_token: string
  prior_outcome: unknown
}): {
  status: string
  message: string
  fork_point: string
  target_view_id: string
  anchor_token: string
  prior_outcome: unknown
  next_steps: string
} {
  return {
    status: 'scheduled',
    message: buildAnchorToolResultText('rewind', extra.anchor_token),
    fork_point: extra.fork_point,
    target_view_id: extra.target_view_id,
    anchor_token: extra.anchor_token,
    prior_outcome: extra.prior_outcome,
    next_steps: 'WAIT for the next message from the user — that\'s where the rewind lands. Do not call further tools, do not generate any other output for this turn. The proxy will splice the rewound history into your next /v1/messages call automatically.',
  }
}

/**
 * Submit_file's first-call rules. Same dual-secret discipline as rewind_to,
 * but the rules text adds the JSONL constraints (Decision #4): each line is
 * a valid Anthropic message, and the LAST line MUST be assistant-role so the
 * appended user message blends naturally into the existing context.
 */
function submitRulesText(tokens: ConfirmTokenPair): string {
  return [
    'submit_file: rules + classification tokens (read carefully — these tokens are single-use and you will need them).',
    '',
    'WHAT THIS TOOL DOES:',
    'submit_file reads a JSONL conversation dump (one Anthropic message per line) that you produced via dump_to_file (and possibly edited with Read/Edit), validates it, appends your `message` arg as a new user-role turn, and queues that as the next /v1/messages from claude. The receiving AI sees the (possibly-edited) history + your `message` as the next user turn — and that AI has NO MEMORY of:',
    '  - the user\'s most recent prompt that triggered this submit',
    '  - your own reasoning that led to calling this tool',
    '  - any cut-off turns (they\'re gone from the receiving AI\'s context)',
    '',
    'JSONL CONSTRAINTS (validation will reject otherwise):',
    '  - The path must resolve inside ~/.retcon/dumps/ (no traversal).',
    '  - Each line must be a valid JSON object with `role` and `content`.',
    '  - The LAST line\'s role MUST be "assistant". Your `message` arg gets appended as a `{role: "user", content: <message>}` line; if the dump\'s tail is already a user line, the appended user would create back-to-back user turns and the receiving AI would see a malformed conversation.',
    '',
    'COMMON WORKFLOWS:',
    '  1. CLEAN REDO of recent turns: skip submit_file. Use rewind_to alone — single-point rewinds are simpler and cheaper.',
    '  2. FORGET THE PINK ELEPHANT (multi-turn contamination): when something sensitive, biasing, or off-topic was spread across several turns and a single rewind point can\'t reach it. dump_to_file → grep/Edit the JSONL to remove the lines or rewrite them → BEFORE submit_file, also scrub external memory: CLAUDE.md, ~/.claude/projects/*/memory/, project notes, TODOS.md, IDE-open files, scratch dumps. submit_file only sanitizes the /v1/messages context the receiving AI sees; if the value persists in any long-lived file the next session will re-leak it. Verify the content is gone from external memory FIRST, then submit. The receiving AI sees a sanitized history with no awareness of the removed content.',
    '  3. FACTUAL CORRECTION in earlier content: dump → Edit the specific message line(s) to fix the error → submit_file with a `message` that signals the correction (e.g. "I corrected the budget from $500 to $5,000 in the earlier turn — please redo the cost analysis.").',
    '',
    'PARALLEL TOOLS — DO NOT call submit_file alongside other tools in the same assistant turn. The submitted history replaces the next /v1/messages, so any sibling tool_use calls (Read, Bash, Edit, etc.) lose their results before the receiving AI ever sees them. Call submit_file alone, finish your other work first, OR queue the substantive change in the `message` arg instead.',
    '',
    'So `message` must:',
    '  1. Carry the SUBSTANTIVE instruction. Not "submit my edits" — the edits already happened, and the receiving AI sees them as if they always existed. Send the new value, the corrected plan, the actual instruction.',
    '  2. Be readable in isolation. Don\'t write "let\'s continue from here" — there\'s no shared "here" for the receiving AI. The history above must already make sense; this turn must already make sense.',
    '  3. Include change-context if the user should see the AI acknowledge the edit. If you fixed a factual error in the history, write something like "(I corrected an error in the earlier discussion — please verify and continue.)" Pure substantive instruction works for clean replays.',
    '  4. Be framed from the user\'s POV. It becomes a user-role turn.',
    '  5. NOT re-introduce the thing you just removed from the dump. If the workflow is "forget about the pink elephant" and your `message` says "no pink elephants, please", the post-submit AI sees the elephant again — your edits to the JSONL were wasted. For sensitive content (passwords, leaked credentials, PII), describe the removal in general terms ("(I removed the leaked credential from earlier turns)") rather than echoing the actual value. The whole point of forgetting is to NOT name the thing.',
    '  6. Pack stacked instructions. When the user says "submit the cleaned dump, then answer Y", put Y in `message` so the post-submit AI has something to do — otherwise it sees a fresh user turn with no instruction and may produce a confused "what next?" response.',
    '  7. Tell the post-submit AI to RE-READ files before relying on remembered content. The dumped JSONL is a frozen snapshot, but the receiving AI\'s system prompt still reflects CURRENT disk state — gitstatus, IDE-open files, recent commits — which may have advanced past what the JSONL captured. If `message` mentions any files, paths, or code state, append a verify-before-trust note: "Re-Read any files I mention before relying on cached memory of them — disk may have advanced past the dumped state."',
    '',
    'EXAMPLES:',
    '  After editing a dump to fix a wrong calculation:',
    '    → message: "(I corrected the budget number in the earlier turn from $500 to $5,000.) Continue with the cost analysis using the corrected number."',
    '  After stripping a leaked credential from multiple turns:',
    '    → message: "(I removed the leaked credential from earlier turns.) Please continue with the security review without referencing the removed value."',
    '  After dumping current state with no edits, just to redirect:',
    '    → message: "Switch the focus to security review now."',
    '  After cleaning the dump, with a stacked question from the user:',
    '    → message: "What\'s the right session timeout for our use case?"',
    '',
    'ANTI-PATTERNS — do not pass these:',
    '  ❌ "submit my changes"  ❌ "see the edits I made"',
    '  ❌ "as I just edited"  ❌ "now apply this"',
    '  ❌ Echoing the removed content ("ignore the password ABC123" — re-leaks what you just stripped).',
    '',
    'NOW CLASSIFY YOUR MESSAGE AND RE-CALL:',
    '',
    `  - If your \`message\` STANDS ALONE (no meta-references, readable with no cut-off context): re-call with confirm="${tokens.clean}"`,
    `  - If your \`message\` contains a META-REFERENCE you spotted: re-call with confirm="${tokens.meta}" — we will reject and you can revise`,
    '',
    'Both tokens are single-use. They expire in 5 minutes. If you classify dishonestly (send the clean token with a meta-reference in your message), we run a narrow regex check that catches the most flagrant cases.',
    '',
    'Note on the tokens: they classify your CURRENT message, not the one you originally typed. The pair is bound to your session, not to a specific message — if your first attempt had a meta-reference, REVISE the `message` arg and use the token that matches the revised version. The clean path is the goal; the meta path is an honest escape hatch when you can\'t fix the message yourself.',
  ].join('\n')
}

function submitMetaFlaggedResponse(newTokens: ConfirmTokenPair): { status: string, message: string } {
  return {
    status: 'rejected',
    message: [
      'Good catch — you flagged a meta-reference in your `message`. Revise to be self-contained.',
      '',
      'Remember: the receiving AI has no memory of your edits-in-progress. Pack the substantive instruction into `message` itself, framed as a user-role prompt. If the user should see the AI acknowledge what changed in the dump, include that context in the message.',
      '',
      `New tokens (the previous pair was consumed): clean="${newTokens.clean}", meta="${newTokens.meta}"`,
    ].join('\n'),
  }
}

function submitRegexRejectedResponse(
  matched: RegExp,
  newTokens: ConfirmTokenPair,
): { status: string, message: string, matched_pattern: string } {
  return {
    status: 'rejected',
    matched_pattern: matched.source,
    message: [
      `Regex caught a meta-reference matching ${matched.source}. The receiving AI has no memory of cut-off turns or your edits — references like this confuse it.`,
      '',
      'Revise your `message` to be self-contained.',
      '',
      `If your reference is intentional and points at content visible in the dump, set allow_meta_refs=true on the next call.`,
      '',
      `New tokens (the previous pair was consumed): clean="${newTokens.clean}", meta="${newTokens.meta}"`,
    ].join('\n'),
  }
}

function submitScheduledResponse(extra: {
  path: string
  fork_point: string | null
  target_view_id: string
  anchor_token: string
  message_count: number
}): {
  status: string
  message: string
  path: string
  fork_point: string | null
  target_view_id: string
  anchor_token: string
  message_count: number
  next_steps: string
} {
  return {
    status: 'scheduled',
    message: buildAnchorToolResultText('submit', extra.anchor_token),
    path: extra.path,
    fork_point: extra.fork_point,
    target_view_id: extra.target_view_id,
    anchor_token: extra.anchor_token,
    message_count: extra.message_count,
    next_steps: 'WAIT for the next message from the user — that\'s where the submitted dump lands. Do not call further tools, do not generate any other output for this turn.',
  }
}

// ─── Tool factory ────────────────────────────────────────────────────────────

/**
 * Token stores keyed by tool name. rewind_to and submit_file each maintain
 * their own dual-secret store so a token issued for one tool doesn't validate
 * a call to the other (rules text differs between the two — Decision #4 adds
 * the assistant-must-end constraint to submit_file's rules).
 */
export interface ConfirmTokenStores {
  rewind: ConfirmTokenStore
  submit: ConfirmTokenStore
}

export function createMcpTools(deps: McpToolDeps): Map<string, McpTool> {
  return createMcpToolsWithTokens(deps, {
    rewind: new ConfirmTokenStore(),
    submit: new ConfirmTokenStore(),
  })
}

/**
 * Internal entry for tests that need to inspect the token stores. External
 * callers should use createMcpTools() which manages its own stores.
 *
 * Accepts either a {rewind, submit} object or a single ConfirmTokenStore for
 * backward compatibility with rewind-only test code (the single store is
 * shared across both tools in that case).
 */
export function createMcpToolsWithTokens(
  deps: McpToolDeps,
  stores: ConfirmTokenStores | ConfirmTokenStore,
): Map<string, McpTool> {
  const rewindStore = stores instanceof ConfirmTokenStore ? stores : stores.rewind
  const submitStore = stores instanceof ConfirmTokenStore ? stores : stores.submit
  // Defensive: caller could pass {rewind: store, submit: undefined} which
  // type-checks but explodes later when submit_file calls submitStore.match().
  // Fail loudly at construction time instead.
  if (!(rewindStore instanceof ConfirmTokenStore) || !(submitStore instanceof ConfirmTokenStore)) {
    throw new Error(
      'createMcpToolsWithTokens: both rewind and submit ConfirmTokenStores are required',
    )
  }
  const tools = new Map<string, McpTool>()

  // ── recall ────────────────────────────────────────────────────────────────
  // Combines fork_list + fork_show. No args = list recent forkable turns.
  // turn_back_n = inspect Nth turn back. turn_id = inspect specific turn.
  tools.set('recall', {
    description:
      'USE WHEN: the user wants to revisit, rewind, recall, or pull up a past moment, OR you recognize you have gone off track and want to back up. '
      + 'Returns recent forkable turns with content previews and turn ids you can pass to `rewind_to`. Each entry has a `kind`: "turn" (real assistant turn), "rewind_marker"/"submit_marker" (synthetic markers from prior rewinds/submits — navigable like real turns). '
      + 'Args: no args = list. `turn_back_n` / `turn_id` / `view_id` = inspect one. `surrounding: N` (0-10) widens the window when inspecting. '
      + 'NEXT STEPS: `rewind_to` to jump back, `bookmark` to save a spot, `list_branches` to see saved ones.',
    inputSchema: {
      type: 'object',
      properties: {
        turn_back_n: { type: 'number', description: 'Inspect the Nth forkable turn back (1=most recent). Mutually exclusive with turn_id and view_id.' },
        turn_id: { type: 'string', description: 'Inspect a specific turn by id. Mutually exclusive with turn_back_n and view_id.' },
        view_id: { type: 'string', description: 'Inspect the turn this branch_view points at (resolves to head_revision_id at call time). Mutually exclusive with turn_id and turn_back_n.' },
        surrounding: { type: 'number', description: 'When inspecting a turn, also return N forkable turns on each side (0-10). Default 0 = no window.' },
        limit: { type: 'number', description: 'When listing (no turn_back_n/turn_id/view_id), max turns to return (1-200, default 20).' },
        offset: { type: 'number', description: 'When listing, pagination offset (default 0).' },
        verbose: { type: 'boolean', description: 'Include internal fields (revision ids, asset CIDs, classifications) for debugging.' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = (args ?? {}) as {
        turn_back_n?: number
        turn_id?: string
        view_id?: string
        surrounding?: number
        limit?: number
        offset?: number
        verbose?: boolean
      }
      const verbose = parsed.verbose === true

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found', session_id: ctx.sessionId }

      // Detail mode triggered by any of: turn_id, turn_back_n, view_id.
      const detailMode = typeof parsed.turn_id === 'string'
        || typeof parsed.turn_back_n === 'number'
        || typeof parsed.view_id === 'string'

      if (detailMode) {
        // Mutual exclusion: only one entry path allowed.
        const entryCount = [
          typeof parsed.turn_id === 'string',
          typeof parsed.turn_back_n === 'number',
          typeof parsed.view_id === 'string',
        ].filter(Boolean).length
        if (entryCount > 1) {
          return { error: 'pass exactly one of turn_id, turn_back_n, view_id' }
        }

        let target: RevisionRow | undefined
        // When the user reaches detail-mode via view_id, surface a warning if
        // the view's head was reclassified out of closed_forkable. The AI can
        // still inspect the turn, but rewind_to will reject it — without this
        // hint the next_steps text contradicts the actual behavior.
        let viewIdNonForkableWarning: string | undefined
        if (typeof parsed.view_id === 'string') {
          // Resolve view → its current head_revision_id, then load that revision.
          const view = deps.db
            .prepare('SELECT head_revision_id, task_id FROM branch_views WHERE id = ? AND task_id = ?')
            .get(parsed.view_id, sess.task_id) as { head_revision_id: string, task_id: string } | undefined
          if (!view) return { error: 'view not found in this session' }
          target = loadRevision(deps.db, view.head_revision_id)
          if (!target || target.task_id !== sess.task_id) {
            return { error: 'view points at a turn that is not in this session' }
          }
          if (target.classification !== 'closed_forkable') {
            viewIdNonForkableWarning = `this view points at a non-forkable turn (classification=${target.classification}); rewind_to will reject. The view's head was reclassified after the bookmark was created.`
          }
        }
        else if (typeof parsed.turn_id === 'string') {
          target = loadRevision(deps.db, parsed.turn_id)
          if (!target || target.task_id !== sess.task_id) {
            return { error: 'turn not found in this session' }
          }
        }
        else {
          const n = Math.floor(parsed.turn_back_n!)
          if (!Number.isInteger(n) || n < 1) {
            return { error: 'turn_back_n must be an integer ≥ 1' }
          }
          const head = effectiveHead(deps.db, sess.task_id)
          if (!head) return { error: 'no settled turns yet' }
          target = nthForkableBack(deps.db, head, n)
          if (!target) return { error: `only fewer than ${n} forkable turns available` }
        }

        // Walk back to find the chain of open Revisions preceding this one,
        // capped in depth and by visited-set to survive corrupt or cyclic chains.
        const preceding: string[] = []
        const visited = new Set<string>([target.id])
        let cursor: string | null = target.parent_revision_id
        for (let i = 0; cursor && i < RECALL_MAX_DEPTH; i++) {
          if (visited.has(cursor)) break
          visited.add(cursor)
          const parent = loadRevision(deps.db, cursor)
          if (!parent || parent.classification === 'closed_forkable') break
          preceding.push(parent.id)
          cursor = parent.parent_revision_id
        }

        const preview = await turnPreview(deps, target.id)
        const lean = {
          turn_id: target.id,
          kind: turnKindFor(target.stop_reason),
          user: preview.user,
          prior_asst: preview.prior_asst,
          stop_reason: target.stop_reason,
          sealed_at: target.sealed_at,
        }

        // branch_views_at_turn: every branch_view whose head_revision_id
        // matches THIS turn. Useful for "what bookmarks point here?".
        const branchViewsAtTurn = deps.db.prepare(`
          SELECT id, label, auto_label FROM branch_views
           WHERE task_id = ? AND head_revision_id = ?
           ORDER BY updated_at DESC, id DESC
        `).all(sess.task_id, target.id) as Array<{
          id: string
          label: string | null
          auto_label: string
        }>
        const branchViewsAtTurnLean = branchViewsAtTurn.map(v => ({
          view_id: v.id,
          kind: v.auto_label.startsWith('fork@') ? 'fork_point' : 'bookmark',
          label: v.label,
        }))

        // surrounding window: N forkable turns before AND after the target,
        // by sealed_at. Cap at 10 each side. surrounding=0 (or unset) returns
        // no surrounding_turns field at all (not present-but-empty) to keep
        // the response shape minimal.
        const surrounding = typeof parsed.surrounding === 'number'
          ? Math.min(Math.max(Math.floor(parsed.surrounding), 0), 10)
          : 0
        let surroundingTurns: Array<{
          turn_id: string
          kind: 'turn' | 'rewind_marker' | 'submit_marker'
          stop_reason: string | null
          sealed_at: number | null
          relative_to_target: number // negative = older, positive = newer
        }> | undefined
        let surroundingSkipped: string | undefined
        if (surrounding > 0 && target.sealed_at === null) {
          // Target lacks sealed_at (e.g., reached via view_id whose head was
          // reclassified from closed_forkable to open/dangling). Surfacing
          // an empty array would imply "no nearby turns"; surfacing nothing
          // would silently drop the explicit `surrounding=N` request. Instead
          // return an empty list AND a warning so the AI knows why.
          surroundingTurns = []
          surroundingSkipped = 'target turn has no sealed_at — likely reclassified after view was created; surrounding window not applicable'
        }
        if (surrounding > 0 && target.sealed_at !== null) {
          const before = deps.db.prepare(`
            SELECT id, stop_reason, sealed_at FROM revisions
             WHERE task_id = ? AND classification = 'closed_forkable'
                   AND sealed_at IS NOT NULL
                   AND (sealed_at < ? OR (sealed_at = ? AND id < ?))
             ORDER BY sealed_at DESC, id DESC LIMIT ?
          `).all(sess.task_id, target.sealed_at, target.sealed_at, target.id, surrounding) as Array<{
            id: string
            stop_reason: string | null
            sealed_at: number | null
          }>
          const after = deps.db.prepare(`
            SELECT id, stop_reason, sealed_at FROM revisions
             WHERE task_id = ? AND classification = 'closed_forkable'
                   AND sealed_at IS NOT NULL
                   AND (sealed_at > ? OR (sealed_at = ? AND id > ?))
             ORDER BY sealed_at ASC, id ASC LIMIT ?
          `).all(sess.task_id, target.sealed_at, target.sealed_at, target.id, surrounding) as Array<{
            id: string
            stop_reason: string | null
            sealed_at: number | null
          }>
          surroundingTurns = [
            ...before.map((r, i) => ({
              turn_id: r.id,
              kind: turnKindFor(r.stop_reason),
              stop_reason: r.stop_reason,
              sealed_at: r.sealed_at,
              relative_to_target: -(i + 1),
            })),
            ...after.map((r, i) => ({
              turn_id: r.id,
              kind: turnKindFor(r.stop_reason),
              stop_reason: r.stop_reason,
              sealed_at: r.sealed_at,
              relative_to_target: i + 1,
            })),
          ]
        }

        if (!verbose) {
          return {
            turn: lean,
            preceding_open_turn_count: preceding.length,
            branch_views_at_turn: branchViewsAtTurnLean,
            ...(surroundingTurns ? { surrounding_turns: surroundingTurns } : {}),
            ...(surroundingSkipped ? { surrounding_skipped: surroundingSkipped } : {}),
            ...(viewIdNonForkableWarning ? { warning: viewIdNonForkableWarning } : {}),
            next_steps: 'To rewind to this turn, call `rewind_to` with `turn_id` set to this turn\'s id (or `turn_back_n` matching its position in the list). To save it as a bookmark, call `bookmark`.',
          }
        }
        return {
          turn: {
            ...lean,
            classification: target.classification,
            parent_revision_id: target.parent_revision_id,
            asset_cid: target.asset_cid,
            created_at: target.created_at,
          },
          preceding_open_turns: preceding,
          branch_views_at_turn: branchViewsAtTurnLean,
          ...(surroundingTurns ? { surrounding_turns: surroundingTurns } : {}),
          next_steps: 'To rewind to this turn, call `rewind_to` with `turn_id` set to this turn\'s id. To save it as a bookmark, call `bookmark`.',
        }
      }

      // List mode.
      //
      // Numbering aligns with rewind_to: n_back=1 is the turn that
      // rewind_to(turn_back_n=1) would land on. That means the most recent
      // closed_forkable (the "current head" — what you're already at) is
      // EXCLUDED from the list. Rewinding to it would be a no-op, and
      // including it caused a numbering inconsistency where the AI saw
      // n_back=1 in the list but landed one turn earlier when calling
      // rewind_to(turn_back_n=1).
      //
      // Implementation: filter the head out at the SQL level so offset/limit
      // count rewindable turns directly (no fetch+slice gymnastics). The
      // head id is exposed separately as `current_head_turn_id` so the AI
      // knows where it is.
      const limit = Math.min(Math.max(parsed.limit ?? 20, 1), 200)
      const offset = Math.max(parsed.offset ?? 0, 0)

      const headRow = mostRecentForkableRevision(deps.db, sess.task_id)
      const headId = headRow?.id ?? null

      const rows = headId
        ? deps.db.prepare(`
            SELECT id, stop_reason, sealed_at, created_at
              FROM revisions
             WHERE task_id = ? AND classification = 'closed_forkable' AND id != ?
             ORDER BY sealed_at DESC, id DESC
             LIMIT ? OFFSET ?
          `).all(sess.task_id, headId, limit, offset) as Array<{
          id: string
          stop_reason: string | null
          sealed_at: number | null
          created_at: number
        }>
        : ([] as Array<{
            id: string
            stop_reason: string | null
            sealed_at: number | null
            created_at: number
          }>)

      const total = headId
        ? (deps.db.prepare(`
            SELECT COUNT(*) AS n FROM revisions
             WHERE task_id = ? AND classification = 'closed_forkable' AND id != ?
          `).get(sess.task_id, headId) as { n: number }).n
        : 0

      // Pre-fetch landing-turn metadata and SR R3' content from fork.forked
      // events. Done in one query each so we don't N+1 against events.
      //
      // landingKinds: revision_id (a "landing turn", i.e., id ∈ fork.forked.
      //   to_revision_id set) → kind from fork.forked.payload.kind.
      // srToR3: SR revision_id → synthetic_assistant_text (R3').
      // landingToSR: landing turn id → its paired SR id (1:1 from fork.forked).
      const forkForkedEvents = deps.db.prepare(`
        SELECT payload FROM events WHERE topic='fork.forked' AND session_id=?
      `).all(ctx.sessionId) as Array<{ payload: string }>
      const landingKinds = new Map<string, 'rewind' | 'submit' | 'unknown'>()
      const srToR3 = new Map<string, string>()
      const landingToSR = new Map<string, string>()
      const srToLanding = new Map<string, string>()
      for (const ev of forkForkedEvents) {
        try {
          const p = JSON.parse(ev.payload) as {
            kind?: 'rewind' | 'submit'
            to_revision_id?: string
            synthetic_revision_id?: string
            synthetic_assistant_text?: string
          }
          const kind = p.kind ?? 'unknown'
          if (p.to_revision_id) {
            landingKinds.set(p.to_revision_id, kind)
            if (p.synthetic_revision_id) {
              landingToSR.set(p.to_revision_id, p.synthetic_revision_id)
              srToLanding.set(p.synthetic_revision_id, p.to_revision_id)
            }
          }
          if (p.synthetic_revision_id && p.synthetic_assistant_text) {
            srToR3.set(p.synthetic_revision_id, p.synthetic_assistant_text)
          }
        }
        catch { /* skip malformed */ }
      }

      // Orphan landings: turns with tobe_applied_from in their request_received
      // event but no matching fork.forked (rewind succeeded mid-stream but the
      // tool_use chain never closed with end_turn, or pending_synthetic_json
      // never resolved). Mark as 'unknown' kind. Same query as fork.forked but
      // for proxy.request_received with tobe_applied_from.
      const orphanLandingRows = deps.db.prepare(`
        SELECT event_id FROM events
         WHERE session_id=? AND topic='proxy.request_received'
           AND json_extract(payload, '$.tobe_applied_from') IS NOT NULL
      `).all(ctx.sessionId) as Array<{ event_id: string }>
      for (const r of orphanLandingRows) {
        if (!landingKinds.has(r.event_id)) landingKinds.set(r.event_id, 'unknown')
      }

      type TurnEntry = {
        turn_id: string
        kind: 'turn' | 'rewind_marker' | 'submit_marker' | 'release_marker'
        n_back: number | null
        user: string | undefined
        prior_asst: string | null | undefined
        stop_reason: string | null
        sealed_at: number | null
        release_reason?: string
        is_landing?: boolean
        landing_kind?: 'rewind' | 'submit' | 'unknown'
        paired_sr_id?: string
        synthetic_assistant_text?: string
        paired_landing_id?: string
        created_at?: number
      }

      const turnEntries: TurnEntry[] = await Promise.all(rows.map(async (r, idx) => {
        const kind = turnKindFor(r.stop_reason) as 'turn' | 'rewind_marker' | 'submit_marker'
        const isSR = kind === 'rewind_marker' || kind === 'submit_marker'
        const r3 = isSR ? srToR3.get(r.id) : undefined
        const isLanding = landingKinds.has(r.id)
        const landingKind = isLanding ? landingKinds.get(r.id)! : undefined
        const pairedSrId = isLanding ? landingToSR.get(r.id) : undefined

        // SR rows with R3' available: skip body extraction (R2' is mechanic-
        // only; R3' is the navigation-friendly assist content). Display
        // surfaces synthetic_assistant_text instead of user/prior_asst.
        // Legacy orphan SRs (no R3') fall through to body extraction.
        let user: string | undefined
        let prior_asst: string | null | undefined
        if (isSR && r3) {
          user = undefined
          prior_asst = undefined
        }
        else {
          const preview = await turnPreview(deps, r.id)
          user = preview.user
          prior_asst = preview.prior_asst
        }

        const lean: TurnEntry = {
          turn_id: r.id,
          kind,
          n_back: offset + idx + 1,
          user,
          prior_asst,
          stop_reason: r.stop_reason,
          sealed_at: r.sealed_at,
        }
        if (isLanding) {
          lean.is_landing = true
          lean.landing_kind = landingKind
          if (pairedSrId) lean.paired_sr_id = pairedSrId
        }
        if (isSR && r3) {
          lean.synthetic_assistant_text = r3
          const landingId = srToLanding.get(r.id)
          if (landingId) lean.paired_landing_id = landingId
        }
        if (verbose) lean.created_at = r.created_at
        return lean
      }))

      // Pull branch_context release/clear events for this session and inject
      // them as release_marker entries interleaved with rewindable turns by
      // timestamp. Releases are NOT rewindable (they're audit events on the
      // session, not revisions), so n_back=null. Their position helps the AI
      // reconstruct what happened: "between turn N and turn N-1 the fork got
      // released by /compact" or "by state divergence (likely /rewind or a
      // subagent that didn't carry the fork tail)".
      //
      // Source filter: events where session_id maps to this task's sessions.
      // Time-bounded by the oldest visible turn so a long-history task with
      // many releases doesn't dump them all here.
      const oldestSealedAt = rows.length > 0
        ? rows[rows.length - 1].sealed_at ?? 0
        : 0
      const releaseRows = deps.db.prepare(`
        SELECT e.event_id, e.topic, e.created_at, e.payload, e.session_id
          FROM events e
          JOIN sessions s ON s.id = e.session_id
         WHERE s.task_id = ?
           AND e.topic IN ('session.branch_context_released', 'session.branch_context_cleared', 'session.branch_context_overflow')
           AND e.created_at >= ?
         ORDER BY e.created_at DESC
      `).all(sess.task_id, oldestSealedAt) as Array<{
        event_id: string
        topic: string
        created_at: number
        payload: string
        session_id: string
      }>

      const releaseEntries = releaseRows.map((r) => {
        let reason = ''
        try {
          const p = JSON.parse(r.payload) as { reason?: string, source?: string }
          reason = p.reason ?? p.source ?? ''
        }
        catch { /* keep '' */ }
        const label = r.topic === 'session.branch_context_overflow'
          ? `branch_context overflowed (8 MiB cap)`
          : r.topic === 'session.branch_context_cleared'
            ? `branch_context cleared by ${reason || 'unknown'}`
            : `branch_context released: ${reason || 'unknown'}`
        return {
          turn_id: r.event_id,
          kind: 'release_marker' as const,
          n_back: null,
          preview: label,
          stop_reason: null,
          sealed_at: r.created_at,
          release_reason: reason || r.topic.replace('session.branch_context_', ''),
          ...(verbose ? { created_at: r.created_at } : {}),
        }
      })

      // Merge & sort: same DESC-by-sealed_at ordering as the turns query so
      // releases land between the surrounding turns chronologically. Tie-
      // break by turn_id DESC: turn_ids are event_ids, monotonic per
      // producer (TraceIdGenerator sequence), so even when emits land in the
      // same millisecond the lex order matches the emit order.
      const turns = [...turnEntries, ...releaseEntries]
        .sort((a, b) => {
          const ta = a.sealed_at ?? 0
          const tb = b.sealed_at ?? 0
          if (ta !== tb) return tb - ta
          return b.turn_id.localeCompare(a.turn_id)
        })

      const nextSteps = turns.length === 0
        ? 'No rewindable turns yet. The current state is `current_head_turn_id`. After more turns close, call `recall` again.'
        : 'Each turn entry has a `user` field (the human prompt) and a `prior_asst` field (the assistant\'s preceding reply that this user prompt was responding to). Read them as a (assistant → user) pair to recover the conversational beat. Entries with `is_landing: true` are the first turn that landed inside a forked branch — they typically appear right above their paired SR (kind: "rewind_marker" or "submit_marker") which exposes `synthetic_assistant_text` (the assist text the rewinding AI was told it had said when the fork was created). Reading the SR\'s `synthetic_assistant_text` together with the landing turn\'s `user` shows the synthetic bridge. Orphan landings (no paired SR) carry `landing_kind: "unknown"`. Entries with `kind: "release_marker"` mark moments when an active branch_context was released (state divergence, /compact, /clear, or 8 MiB overflow); they\'re not rewindable themselves but tell you when forks ended. To inspect one turn, call `recall` with `turn_id` or `turn_back_n`. To rewind, call `rewind_to(turn_back_n=N, message="...")` where N matches `n_back` (or pass `turn_id` directly). To save the current spot, call `bookmark`; to list saved spots, call `list_branches`.'

      // rewind_events fields (rewind_events / rewind_events_total /
      // rewind_events_truncated) were dropped in v0.5.0. They've been replaced
      // by SR (synthetic departure Revision) rows visible inline in the
      // turns array with `kind: 'rewind_marker'` or 'submit_marker'.

      return {
        total,
        turns,
        current_head_turn_id: headId,
        next_steps: nextSteps,
      }
    },
  })

  // ── rewind_to ─────────────────────────────────────────────────────────────
  // Replaces fork_back. Adds opaque dual-secret + narrow regex guardrail.
  tools.set('rewind_to', {
    description:
      'USE WHEN: the user asks to rewind/restart/revise an earlier turn, OR you recognize the conversation went off track. For "forget X spread across multiple turns" use `dump_to_file` + edit + `submit_file` instead — rewind_to is single-point only. '
      + 'Walks back N forkable turns and replaces the conversation tail with your `message` arg. The AI handling the next /v1/messages has NO memory of cut-off turns. '
      + 'TWO-STEP: first call without `confirm` returns rules + tokens; second call confirms. '
      + 'NEXT STEPS: WAIT for the next /v1/messages — the rewind lands there. Do not call further tools.',
    inputSchema: {
      type: 'object',
      properties: {
        turn_back_n: { type: 'number', description: 'How many forkable turns back to go (≥1). Mutually exclusive with turn_id.' },
        turn_id: { type: 'string', description: 'Exact turn id (from `recall`) to rewind to. Mutually exclusive with turn_back_n.' },
        message: { type: 'string', description: 'New user message to deliver at the rewound point. Must stand alone (no meta-references to cut-off content).' },
        confirm: { type: 'string', description: 'Single-use token issued by this tool\'s first call. The rules-return response names the two choices.' },
        allow_meta_refs: { type: 'boolean', description: 'Override the narrow regex backstop. Use only when your message intentionally references content that is visible in the rewound history.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = (args ?? {}) as {
        turn_back_n?: number
        turn_id?: string
        message?: unknown
        confirm?: unknown
        allow_meta_refs?: boolean
      }
      const message = typeof parsed.message === 'string' ? parsed.message : null
      if (!message) return { error: '`message` is required' }
      if (message.trim().length === 0) {
        return { error: '`message` must contain non-whitespace content (a whitespace-only message has nothing for the receiving AI to act on)' }
      }
      if (Buffer.byteLength(message, 'utf8') > MAX_REWIND_MESSAGE_BYTES) {
        return { error: `message exceeds ${MAX_REWIND_MESSAGE_BYTES} bytes; trim your prompt` }
      }

      // ── Phase 1 of dual-secret flow: classify the confirm token ───────────
      const confirmValue = typeof parsed.confirm === 'string' ? parsed.confirm : ''
      const matchKind = confirmValue.length > 0
        ? rewindStore.match(ctx.sessionId, confirmValue)
        : null

      if (matchKind === null) {
        // First call (no confirm) OR mismatched/expired/unknown value.
        // Either way: return rules + a fresh token pair. No side effects.
        const tokens = rewindStore.generate(ctx.sessionId)
        return {
          status: 'rules_returned',
          rules: rewindRulesText(tokens),
          confirm_clean: tokens.clean,
          confirm_meta: tokens.meta,
        }
      }

      // Whichever path we take, the original pair is consumed.
      rewindStore.consume(ctx.sessionId)

      if (matchKind === 'meta') {
        // AI self-flagged its own message. Educational response + new pair.
        const newTokens = rewindStore.generate(ctx.sessionId)
        return rewindMetaFlaggedResponse(newTokens)
      }

      // matchKind === 'clean'. Run narrow regex backstop unless allow_meta_refs.
      if (parsed.allow_meta_refs !== true) {
        const matched = detectMetaRef(message)
        if (matched) {
          const newTokens = rewindStore.generate(ctx.sessionId)
          return rewindRegexRejectedResponse(matched, newTokens)
        }
      }

      // ── Phase 2: do the rewind work ───────────────────────────────────────
      // Feature gate.
      if (deps.rewindEnabled === false) {
        const bodyBytes = Buffer.from(JSON.stringify({ message, ...parsed }), 'utf8')
        const inputsBlob = await blobRefFromBytes(bodyBytes)
        await ctx.channel.submit(
          'fork.back_disabled_rejected',
          { inputs_cid: inputsBlob.cid },
          ctx.sessionId,
          [inputsBlob.ref],
        )
        return {
          error: 'rewind_to is disabled; proxy running in recording-only mode.',
        }
      }

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }
      if (sess.harness === 'orphan') {
        return { error: 'rewind_to requires an MCP-initialized session (orphan sessions cannot rewind)' }
      }

      // R1 = the assistant turn that emitted tool_use(rewind_to). We capture
      // its id here so SR.parent_revision_id can be set later. The rules-text
      // warning advises against parallel tool_uses on R1; the actual detection
      // happens in proxy-handler at TOBE-consumption time, where claude's
      // pre-splice JSON body exposes R1's parsed content directly (no SSE
      // parsing needed).
      const r1 = mostRecentRevision(deps.db, sess.task_id)

      // Resolve the target revision: turn_id wins; else turn_back_n; else default 1.
      // Also capture `headBeforeFork` — the closed_forkable head at this moment.
      // It's the "from" turn surfaced by recall's rewind_events ("where did
      // I rewind FROM?"). Always computed regardless of which entry path was
      // taken so the audit event payload is consistent. Falls back to target
      // when no settled head is reachable (rare; corrupt revision chain), so
      // the field is never blank in production v0.4.4+.
      let target: RevisionRow | undefined
      if (typeof parsed.turn_id === 'string' && typeof parsed.turn_back_n === 'number') {
        return { error: 'pass either turn_id or turn_back_n, not both' }
      }

      const headBeforeFork = effectiveHead(deps.db, sess.task_id)
      if (typeof parsed.turn_id === 'string') {
        target = loadRevision(deps.db, parsed.turn_id)
        if (!target || target.task_id !== sess.task_id) {
          return { error: 'turn_id not found in this session' }
        }
        if (target.classification !== 'closed_forkable') {
          return { error: 'turn_id is not a forkable turn (must be closed_forkable)' }
        }
      }
      else {
        const n = typeof parsed.turn_back_n === 'number' ? Math.floor(parsed.turn_back_n) : 1
        if (!Number.isInteger(n) || n < 1) {
          return { error: 'turn_back_n must be an integer ≥ 1' }
        }
        if (!headBeforeFork) {
          return { error: 'cannot rewind: no settled (non-in-flight) revision available' }
        }
        target = nthForkableBack(deps.db, headBeforeFork, n)
        if (!target) {
          // Use the cycle-safe helper so a corrupt parent chain doesn't hang
          // the error path on top of failing the happy path.
          const available = countForkableBack(deps.db, headBeforeFork)
          return { error: `only ${available} forkable turns available; cannot go back ${n}` }
        }
      }

      // Reconstruct messages[] at the fork point.
      const baseMessages = await reconstructForkMessages(deps, target)
      if (!baseMessages) {
        return { error: 'unable to reconstruct messages[] for fork_point (no usable source blob)' }
      }
      const forkId = generateForkId()
      const newMessage = synthesizeUserMessageWithReminder(message, forkId)
      baseMessages.push(newMessage)

      const newMessageBlob = await blobRefFromBytes(
        Buffer.from(JSON.stringify(newMessage), 'utf8'),
      )

      // Prior fork's outcome (A-R8): if the previous TOBE-applied request
      // ended in failure, the LLM sees that here along with the new fork.
      const prior = lastForkOutcome(deps.db, ctx.sessionId)

      const targetViewId = generateTraceId()

      // SR-construction metadata (v0.5.0). Populated whenever we can resolve
      // R1 (= mostRecentRevision in this task). proxy-handler derives
      // tool_use_id at TOBE-consumption time from claude's pre-splice JSON
      // body. If R1 is missing (rare; corrupted projector state), no SR
      // materializes — the rewind still applies.
      const syntheticRevisionId = generateTraceId()
      const forkShort = target.id.slice(0, 8)
      const syntheticToolResultText
        = `Rewind initiated. Target: rev_${forkShort}. Synthetic message: ${message}`
      const syntheticAssistantText
        = `Rewind initiated. Jumping to rev_${forkShort}.`
      const backRequestedAt = Date.now()

      // v0.6 anchor mechanism: write the active fork_anchors row. The proxy's
      // applyAnchorSplice scans claude's next /v1/messages body for the
      // anchor_token embedded in our tool_result reply (see
      // rewindScheduledResponse below) and splices target_messages_json
      // in place of everything before-and-including that tool_result turn.
      // Replaces the v0.5.5 branch_context_json + branch_context_fork_id
      // mechanism (asst-text continuity check, fresh-fork token skip) with
      // one cleanly-anchored handle.
      const anchorToken = generateAnchorToken()
      const targetMessagesJson = JSON.stringify(baseMessages)
      if (targetMessagesJson.length > TARGET_MESSAGES_MAX_BYTES) {
        return {
          status: 'error',
          message: `rewind_to: target_messages would exceed the ${TARGET_MESSAGES_MAX_BYTES} byte cap. Rewind to a more recent turn (less history to splice) and try again.`,
        }
      }
      insertActiveAnchor(deps.db, {
        anchor_token: anchorToken,
        session_id: ctx.sessionId,
        target_messages_json: targetMessagesJson,
        fork_point_revision_id: target.id,
        source_view_id: ctx.sessionId,
        synthetic_metadata: r1
          ? {
              kind: 'rewind',
              target_view_id: targetViewId,
              synthetic_revision_id: syntheticRevisionId,
              synthetic_tool_result_text: syntheticToolResultText,
              synthetic_assistant_text: syntheticAssistantText,
              synthetic_user_message: message,
              parent_revision_id: r1.id,
              back_requested_at: backRequestedAt,
            }
          : undefined,
      })

      await ctx.channel.submit(
        'fork.back_requested',
        {
          source_view_id: ctx.sessionId,
          fork_point_revision_id: target.id,
          new_message_cid: newMessageBlob.cid,
          target_view_id: targetViewId,
          task_id: sess.task_id,
          // The closed_forkable head at the moment of rewind — used by
          // recall's rewind_events to surface "where did I rewind FROM?".
          // Falls back to target.id when no settled head is reachable.
          head_revision_id: (headBeforeFork ?? target).id,
        },
        ctx.sessionId,
        [newMessageBlob.ref],
      )

      return rewindScheduledResponse({
        fork_point: target.id,
        target_view_id: targetViewId,
        anchor_token: anchorToken,
        prior_outcome: prior,
      })
    },
  })

  // ── bookmark ──────────────────────────────────────────────────────────────
  // Renamed from fork_bookmark. Same semantics, intent-aligned name.
  tools.set('bookmark', {
    description:
      'USE WHEN: the user wants to save the current spot to return to later. '
      + 'Bookmarks the most recent forkable turn with an optional label. Behaves like a git branch (not a tag): the head auto-advances as new turns close, until you fork via `rewind_to`. Survives /clear, /compact, and resume. '
      + 'NEXT STEPS: `list_branches` to see saved spots; `recall({view_id})` then `rewind_to({turn_id})` to revisit; `delete_bookmark` to remove.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable label for this bookmark (e.g., "before refactor" or "v1 baseline").' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = (args ?? {}) as { label?: string }

      // Validate label: cap at MAX_BOOKMARK_LABEL_BYTES and strip control
      // chars. Without this, an unbounded label expands every future
      // list_branches/recall response that surfaces it to the LLM.
      let label: string | null = null
      if (typeof parsed.label === 'string' && parsed.label.length > 0) {
        if (Buffer.byteLength(parsed.label, 'utf8') > MAX_BOOKMARK_LABEL_BYTES) {
          return { error: `label exceeds ${MAX_BOOKMARK_LABEL_BYTES}-byte cap` }
        }
        // Strip ASCII control chars (newline, NUL, etc.) but keep printable
        // chars + emoji + non-ASCII text. Labels are display-only.
        // eslint-disable-next-line no-control-regex
        label = parsed.label.replace(/[\u0000-\u001f\u007f]/g, '')
        if (label.length === 0) {
          return { error: 'label contained only control characters after sanitization' }
        }
      }

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }

      const head = mostRecentForkableRevision(deps.db, sess.task_id)
      if (!head) {
        return {
          error: 'no forkable turn yet — wait for the current turn to close before bookmarking',
        }
      }

      const viewId = generateTraceId()
      await ctx.channel.submit(
        'fork.bookmark_created',
        {
          view_id: viewId,
          task_id: sess.task_id,
          head_revision_id: head.id,
          label,
          auto_label: `bookmark@${new Date().toISOString()}`,
        },
        ctx.sessionId,
      )
      return {
        view_id: viewId,
        head_revision_id: head.id,
        label,
        next_steps: 'Bookmark saved. The next time you want to return here, call `recall` to list turns (this bookmark is the current head, so you\'ll see its `head_revision_id` as `current_head_turn_id`) and then `rewind_to` with `turn_id` matching it.',
      }
    },
  })

  // ── delete_bookmark ───────────────────────────────────────────────────────
  // Resolves an id-or-label to a single branch_view row in the current session,
  // emits fork.bookmark_deleted, projector deletes. LABEL-ONLY by design: the
  // user's mental model for navigation is "the bookmark named X" — view_id
  // is implementation detail. Deleting by id leaks that detail and makes the
  // surface inconsistent with how the AI/user thinks. So this tool accepts
  // only `label`.
  //
  // Implications:
  //   - Unlabeled bookmarks (`bookmark()` no args) cannot be deleted via
  //     this tool. They auto-advance with head until session cleanup.
  //   - Auto fork-point views (label=NULL, created by rewind_to) cannot
  //     be deleted via this tool. System-managed; reaped on `retcon clean
  //     --actor X`.
  // Both are by design — if you want a deletable bookmark, give it a label.
  tools.set('delete_bookmark', {
    description:
      'USE WHEN: the user wants to remove a labeled bookmark. '
      + 'Deletes the single bookmark with the given label in this session. Errors on no-match or label collision. Unlabeled bookmarks and auto fork-point views can\'t be deleted here — they\'re reaped on session cleanup. '
      + 'NEXT STEPS: `list_branches` to see what remains.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Exact label of the bookmark to delete. Must be unique within this session.' },
      },
      required: ['label'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = (args ?? {}) as { label?: unknown }

      if (typeof parsed.label !== 'string' || parsed.label.length === 0) {
        return { error: 'label is required and must be a non-empty string' }
      }
      const label = parsed.label

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }

      // Match label exactly within this session's task. NULL-label rows
      // (fork_points, unlabeled bookmarks) are excluded automatically —
      // SQL's `label = ?` never matches NULL.
      const matches = deps.db
        .prepare(`SELECT id, task_id, label, head_revision_id, auto_label FROM branch_views WHERE task_id = ? AND label = ?`)
        .all(sess.task_id, label) as Array<{
        id: string
        task_id: string
        label: string | null
        head_revision_id: string
        auto_label: string
      }>

      if (matches.length === 0) {
        return { error: `no bookmark with label '${label}' in this session` }
      }
      if (matches.length > 1) {
        return {
          error: `label '${label}' matches ${matches.length} bookmarks — labels must be unique to delete by label. Use list_branches to inspect them.`,
          ambiguous_views: matches.map(r => ({
            view_id: r.id,
            kind: r.auto_label.startsWith('fork@') ? 'fork_point' : 'bookmark',
            label: r.label,
            head_turn_id: r.head_revision_id,
          })),
        }
      }
      const target = matches[0]!

      await ctx.channel.submit(
        'fork.bookmark_deleted',
        { view_id: target.id, task_id: target.task_id },
        ctx.sessionId,
      )
      // Kind from auto_label prefix (always 'bookmark' here since label != NULL,
      // and fork.back_requested writes label=NULL while fork.bookmark_created
      // writes the user-supplied label).
      const kind = target.auto_label.startsWith('fork@') ? 'fork_point' : 'bookmark'
      return {
        deleted: {
          view_id: target.id,
          kind,
          label: target.label,
          head_turn_id_at_delete: target.head_revision_id,
        },
        next_steps: 'Bookmark removed. Call `list_branches` to see what remains.',
      }
    },
  })

  // ── list_branches ─────────────────────────────────────────────────────────
  // Returns every branch_view for the current session's task, ordered by
  // updated_at DESC so the most recently active branch is on top. The `kind`
  // field distinguishes user bookmarks from auto fork-points (created when
  // you rewind_to elsewhere). Discrimination is by auto_label prefix:
  //   - "bookmark@..." → kind='bookmark'   (created via bookmark())
  //   - "fork@..."     → kind='fork_point' (created via rewind_to())
  // The `label` field is independent and may be NULL for either kind.
  //
  // n_back_of_head is computed against forkableSequence(task_id) — 0 means
  // the branch is currently tracking head (auto-advance still active), N>0
  // means it points at the Nth forkable turn back, null means its head is
  // not in the closed_forkable sequence (rare: head was reclassified).
  tools.set('list_branches', {
    description:
      'USE WHEN: the user asks what bookmarks/branches exist, or you need to navigate to one. '
      + 'Lists every branch_view in this session — explicit bookmarks plus auto fork-point views from `rewind_to`. Each has a `kind` field. Heads auto-advance as new turns close, until you fork. '
      + 'NEXT STEPS: `recall({view_id})` to inspect, then `rewind_to({turn_id})` to return. `delete_bookmark` to remove.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (1-200, default 50).' },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
        verbose: { type: 'boolean', description: 'Include internal fields (auto_label, created_at).' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = (args ?? {}) as { limit?: number, offset?: number, verbose?: boolean }
      const limit = Math.min(Math.max(parsed.limit ?? 50, 1), 200)
      const offset = Math.max(parsed.offset ?? 0, 0)
      const verbose = parsed.verbose === true

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }

      const total = (deps.db
        .prepare('SELECT COUNT(*) AS n FROM branch_views WHERE task_id = ?')
        .get(sess.task_id) as { n: number }).n

      const rows = deps.db.prepare(`
        SELECT id, label, auto_label, head_revision_id, created_at, updated_at
          FROM branch_views
         WHERE task_id = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT ? OFFSET ?
      `).all(sess.task_id, limit, offset) as Array<{
        id: string
        label: string | null
        auto_label: string
        head_revision_id: string
        created_at: number
        updated_at: number
      }>

      const seq = forkableSequence(deps.db, sess.task_id)
      const nBackOfHead = (revId: string): number | null => {
        const idx = seq.indexOf(revId)
        return idx === -1 ? null : idx
      }

      const branches = rows.map((r) => {
        const kind = r.auto_label.startsWith('fork@') ? 'fork_point' : 'bookmark'
        const lean = {
          view_id: r.id,
          kind,
          label: r.label,
          head_turn_id: r.head_revision_id,
          n_back_of_head: nBackOfHead(r.head_revision_id),
        }
        if (!verbose) return lean
        return {
          ...lean,
          auto_label: r.auto_label,
          created_at: r.created_at,
          updated_at: r.updated_at,
        }
      })

      const nextSteps = branches.length === 0
        ? 'No branches yet. Call `bookmark` to save the current spot.'
        : 'To inspect a branch\'s turn, call `recall({view_id})`. To rewind there: `recall({view_id})` then `rewind_to({turn_id})` (two-call inspect-then-act). To remove a branch, call `delete_bookmark({id_or_label})`.'

      return { total, branches, next_steps: nextSteps }
    },
  })

  // ── dump_to_file ──────────────────────────────────────────────────────────
  // Phase 3 (v0.4): writes the conversation history through and including a
  // target turn's assistant response to ~/.retcon/dumps/<sid>-<rev>.jsonl.
  // The AI reads the file (Read tool, pre-allowed by the dumps-path
  // permissions injection in cli/run.ts), optionally edits it, and submits
  // via submit_file. Messages-only — system prompt and tools[] come from
  // claude's outgoing body at replay time and aren't frozen here.
  tools.set('dump_to_file', {
    description:
      'USE WHEN: you want to inspect or edit the conversation history before continuing. Three common cases: (1) just look at past messages, (2) fix a factual error in an earlier turn, (3) strip content spread across multiple turns — the "pink elephant" pattern that single-point rewind_to can\'t reach. '
      + 'Writes the conversation through a target turn to ~/.retcon/dumps/<id>.jsonl (one Anthropic message per line). retcon pre-allowed Read/Edit/Write/Glob/Grep on that path, so no permission prompts. '
      + 'Args: no args = dump current state; `turn_id`/`turn_back_n` = dump through that turn. '
      + 'NEXT STEPS: `Read` to view, `Edit` to modify lines, then `submit_file` with the path + a new user instruction.',
    inputSchema: {
      type: 'object',
      properties: {
        turn_id: { type: 'string', description: 'Dump through this specific turn (must be closed_forkable).' },
        turn_back_n: { type: 'number', description: 'Dump through the Nth forkable turn back (1=first rewindable, matching `recall` numbering).' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = (args ?? {}) as { turn_id?: string, turn_back_n?: number }

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }
      if (sess.harness === 'orphan') {
        return { error: 'dump_to_file requires an MCP-initialized session (orphan sessions cannot dump)' }
      }
      if (typeof parsed.turn_id === 'string' && typeof parsed.turn_back_n === 'number') {
        return { error: 'pass either turn_id or turn_back_n, not both' }
      }

      // Resolve the target turn.
      let target: RevisionRow | undefined
      if (typeof parsed.turn_id === 'string') {
        target = loadRevision(deps.db, parsed.turn_id)
        if (!target || target.task_id !== sess.task_id) {
          return { error: 'turn_id not found in this session' }
        }
        if (target.classification !== 'closed_forkable') {
          return { error: 'turn_id is not a forkable turn (must be closed_forkable)' }
        }
      }
      else if (typeof parsed.turn_back_n === 'number') {
        const n = Math.floor(parsed.turn_back_n)
        if (!Number.isInteger(n) || n < 1) {
          return { error: 'turn_back_n must be an integer ≥ 1' }
        }
        const head = effectiveHead(deps.db, sess.task_id)
        if (!head) return { error: 'cannot dump: no settled (non-in-flight) revision available' }
        target = nthForkableBack(deps.db, head, n)
        if (!target) {
          const available = countForkableBack(deps.db, head)
          return { error: `only ${available} rewindable turns available; cannot go back ${n}` }
        }
      }
      else {
        // No args: default to "current dumpable state". If a forked branch
        // is active (fork_anchors row with state='active'), that's the source
        // — and the target is the current branch head. Otherwise the head's
        // response body isn't reliably available from the request-body chain
        // (the head's child doesn't exist yet), so we step back one forkable
        // turn — `reconstructForkMessages(target=N-1)` uses head as the
        // child and slices off head's user input, ending the dump at the
        // one-before-head's assistant response.
        const activeAnchorEarly = getActiveAnchor(deps.db, ctx.sessionId)
        if (activeAnchorEarly) {
          target = mostRecentForkableRevision(deps.db, sess.task_id)
          if (!target) return { error: 'forked branch active but no forkable turn anchors it' }
        }
        else {
          const head = effectiveHead(deps.db, sess.task_id)
          if (!head) return { error: 'no settled turns yet — nothing to dump' }
          target = nthForkableBack(deps.db, head, 1)
          if (!target) {
            return {
              error: 'cannot dump current state: not enough turn history yet (need either at least 2 forkable turns, or an active forked branch). Pass `turn_back_n` or `turn_id` to dump a specific older turn.',
            }
          }
        }
      }

      // Resolve messages. If we're on a forked branch (active fork_anchors
      // row present) AND the target IS the current branch head, dump the
      // anchor's target_messages_json directly — that's the splice prefix
      // we use on every /v1/messages; the most-recent assistant + new user
      // input arrive on claude's side post-splice and aren't in our store.
      // Otherwise reconstruct from the request body via reconstructForkMessages.
      //
      // CRITICAL: target_messages_json's tail is ALWAYS user-role
      // (synthetic_user_message). Slice off trailing user line(s) so the dump
      // ends at the most recent assistant response. The post-splice tail
      // (asst + new_user) lives in claude's local jsonl, not in our DB.
      let messages: unknown[] | null = null
      const activeAnchor = getActiveAnchor(deps.db, ctx.sessionId)
      const headRev = mostRecentForkableRevision(deps.db, sess.task_id)
      const isHead = headRev?.id === target.id
      const usedBranchView = isHead && !!activeAnchor?.target_messages_json
      if (usedBranchView) {
        try {
          const parsedJson = JSON.parse(activeAnchor!.target_messages_json!) as unknown
          if (Array.isArray(parsedJson)) {
            const trimmed = [...parsedJson]
            while (
              trimmed.length > 0
              && (trimmed[trimmed.length - 1] as { role?: unknown } | null | undefined)?.role === 'user'
            ) {
              trimmed.pop()
            }
            if (trimmed.length > 0) messages = trimmed
          }
        }
        catch { /* fall through to reconstruction */ }
      }
      if (!messages) {
        messages = await reconstructForkMessages(deps, target)
      }
      if (!messages) {
        return { error: 'unable to reconstruct messages for the target turn (no usable source blob)' }
      }

      // The load-bearing rule: dumps must end with assistant role so
      // submit_file's appended user message blends naturally.
      const lastMsg = messages[messages.length - 1] as { role?: unknown } | undefined
      if (!lastMsg || lastMsg.role !== 'assistant') {
        return {
          error: `dump's last message has role=${typeof lastMsg?.role === 'string' ? lastMsg.role : 'unknown'}, expected 'assistant'. This shouldn't happen — please report a bug.`,
        }
      }

      // Defense-in-depth: sanitize the session id component of the filename
      // so a malformed Mcp-Session-Id can't escape dumpsDir via path traversal.
      // The proxy mints UUIDs that pass this regex; orphan/binding-table
      // sessions in theory could carry odd strings.
      if (!SAFE_SESSION_ID_RE.test(ctx.sessionId)) {
        return {
          error: `session id contains characters unsafe for filesystem use; cannot dump (id=${ctx.sessionId.slice(0, 32)}...)`,
        }
      }

      // Write JSONL atomically: tmpfile + rename. Filename includes session
      // and target ids so different sessions / different rewind anchors
      // don't collide. Tmp file gets a PID + random suffix to survive
      // concurrent dump_to_file calls for the same target without races.
      const dumpsDir = retconDumpsDir()
      try {
        fs.mkdirSync(dumpsDir, { recursive: true })
      }
      catch (err) {
        return { error: `failed to create dumps directory: ${(err as Error).message}` }
      }
      const filename = `${ctx.sessionId}-${target.id}.jsonl`
      const fullPath = path.join(dumpsDir, filename)
      const content = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
      // Size cap: refuse to write a dump larger than MAX_DUMP_BYTES so a
      // long conversation doesn't fill the disk and submit_file's matching
      // cap doesn't OOM.
      if (Buffer.byteLength(content, 'utf8') > MAX_DUMP_BYTES) {
        return {
          error: `dump would exceed ${MAX_DUMP_BYTES} bytes (conversation too long). Bookmark or rewind to an earlier turn instead.`,
        }
      }
      const tmpSuffix = `${process.pid}.${randomBytes(4).toString('hex')}`
      const tmpPath = `${fullPath}.${tmpSuffix}.tmp`
      try {
        fs.writeFileSync(tmpPath, content, { encoding: 'utf8' })
        fs.renameSync(tmpPath, fullPath)
      }
      catch (err) {
        try {
          fs.unlinkSync(tmpPath)
        }
        catch { /* tmp may not exist */ }
        return { error: `failed to write dump: ${(err as Error).message}` }
      }

      return {
        path: fullPath,
        turn_id: target.id,
        message_count: messages.length,
        is_branch_view: usedBranchView,
        next_steps: [
          'Use the Read tool to inspect this dump (one Anthropic message per line). Use Edit to modify any line — keep the {role, content} shape intact. The LAST line MUST remain an assistant-role message; submit_file will reject otherwise.',
          '',
          'TIME-WINDOW WARNING: any tool calls you run between this dump and your `submit_file` are SCRATCH WORK from the post-submit AI\'s perspective — that AI sees the (possibly-edited) JSONL + your `message` arg as a single user turn and has NO memory of any Read/Edit/Bash/recall calls you made in between. Their *file-system side effects* persist (commits land, files get written); the *AI awareness* of running them does not.',
          'Two safe patterns: (1) finish edits quickly and submit (the post-submit AI inherits the dump as-is, no awareness of the edit ritual); (2) for complex edits, write a script BEFORE the final dump, run the script, then dump → Read to verify the dump captures the post-script state → submit. Pattern 2 keeps the AI awareness aligned with disk reality.',
          'When ready, call `submit_file` with `path` set to this file and `message` set to your new user instruction.',
        ].join('\n'),
      }
    },
  })

  // ── submit_file ───────────────────────────────────────────────────────────
  // Phase 3 (v0.4): reads a JSONL dump (produced by dump_to_file, optionally
  // AI-edited), validates it, appends `message` as a user-role turn, and
  // writes to TOBE so the next /v1/messages from claude carries the result.
  // Same opaque dual-secret + narrow regex as rewind_to. Plus path-traversal
  // realpath check, JSONL parse-per-line, last-line-must-be-assistant.
  tools.set('submit_file', {
    description:
      'USE WHEN: you need to apply an edited (or as-is) dump as the conversation history going forward. Pairs with `dump_to_file` for "forget the pink elephant" — strip or rewrite multi-turn content that no single rewind_to point can reach. '
      + 'Reads a JSONL dump from ~/.retcon/dumps/, validates each line, appends your `message` as a new user turn, queues as the next /v1/messages. '
      + 'TWO-STEP: first call without `confirm` returns rules + tokens; second call confirms. '
      + 'NEXT STEPS: WAIT for the next /v1/messages — the result lands there. Do not call further tools.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the JSONL dump (must resolve inside ~/.retcon/dumps/).' },
        message: { type: 'string', description: 'New user message to deliver after the dumped history. Must stand alone (no meta-references).' },
        confirm: { type: 'string', description: 'Single-use token issued by this tool\'s first call. The rules-return response names the two choices.' },
        allow_meta_refs: { type: 'boolean', description: 'Override the narrow regex backstop. Use only when your message intentionally references content visible in the dumped history.' },
      },
      required: ['path', 'message'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = (args ?? {}) as {
        path?: unknown
        message?: unknown
        confirm?: unknown
        allow_meta_refs?: boolean
      }

      // Validate inputs BEFORE consuming a token (same shape as rewind_to).
      const filePath = typeof parsed.path === 'string' ? parsed.path : null
      if (!filePath) return { error: '`path` is required (string)' }
      const message = typeof parsed.message === 'string' ? parsed.message : null
      if (!message) return { error: '`message` is required (string)' }
      if (message.trim().length === 0) {
        return { error: '`message` must contain non-whitespace content' }
      }
      if (Buffer.byteLength(message, 'utf8') > MAX_REWIND_MESSAGE_BYTES) {
        return { error: `message exceeds ${MAX_REWIND_MESSAGE_BYTES} bytes; trim your prompt` }
      }

      // Path traversal guard: resolve realpath and require it to be inside
      // the dumps directory. realpathSync follows symlinks and resolves
      // .. so a `../../etc/passwd`-style path can't escape.
      const dumpsDir = retconDumpsDir()
      let resolvedPath: string
      let resolvedDumpsDir: string
      try {
        resolvedPath = fs.realpathSync(filePath)
      }
      catch {
        return { error: `path does not exist or is unreadable: ${filePath}` }
      }
      try {
        resolvedDumpsDir = fs.realpathSync(dumpsDir)
      }
      catch {
        return { error: `dumps directory not initialized at ${dumpsDir}` }
      }
      // Ensure resolvedPath is under resolvedDumpsDir (with separator to
      // avoid prefix-match attacks: /tmp/dumps2/x.jsonl shouldn't pass
      // when /tmp/dumps is the allowed root).
      const dumpsWithSep = resolvedDumpsDir.endsWith(path.sep) ? resolvedDumpsDir : resolvedDumpsDir + path.sep
      if (!resolvedPath.startsWith(dumpsWithSep)) {
        return { error: `path must resolve inside ${dumpsDir} (got ${resolvedPath})` }
      }

      // ── Phase 1 of dual-secret flow ───────────────────────────────────────
      const confirmValue = typeof parsed.confirm === 'string' ? parsed.confirm : ''
      const matchKind = confirmValue.length > 0
        ? submitStore.match(ctx.sessionId, confirmValue)
        : null

      if (matchKind === null) {
        const tokens = submitStore.generate(ctx.sessionId)
        return {
          status: 'rules_returned',
          rules: submitRulesText(tokens),
          confirm_clean: tokens.clean,
          confirm_meta: tokens.meta,
        }
      }

      submitStore.consume(ctx.sessionId)

      if (matchKind === 'meta') {
        const newTokens = submitStore.generate(ctx.sessionId)
        return submitMetaFlaggedResponse(newTokens)
      }

      // matchKind === 'clean'. Run regex backstop unless allow_meta_refs.
      if (parsed.allow_meta_refs !== true) {
        const matched = detectMetaRef(message)
        if (matched) {
          const newTokens = submitStore.generate(ctx.sessionId)
          return submitRegexRejectedResponse(matched, newTokens)
        }
      }

      // ── Phase 2: parse + validate the JSONL ───────────────────────────────
      // Size cap before we read the file into memory. statSync is cheap and
      // catches dumps that grew past MAX_DUMP_BYTES (e.g., AI hand-crafted
      // a giant JSONL outside dump_to_file's path).
      try {
        const fileStat = fs.statSync(resolvedPath)
        if (fileStat.size > MAX_DUMP_BYTES) {
          return {
            error: `dump file is ${fileStat.size} bytes (exceeds ${MAX_DUMP_BYTES} cap). Edit it down before submitting.`,
          }
        }
      }
      catch (err) {
        return { error: `failed to stat dump: ${(err as Error).message}` }
      }

      let raw: string
      try {
        raw = fs.readFileSync(resolvedPath, { encoding: 'utf8' })
      }
      catch (err) {
        return { error: `failed to read dump: ${(err as Error).message}` }
      }

      // Split on \n (Unix) or \r\n (CRLF). The trim catches both stray \r
      // from CRLF tools AND whitespace-only lines that JSON.parse would
      // reject anyway. Keeps the parse loop simple.
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
      if (lines.length === 0) {
        return { error: 'dump file is empty (no JSONL lines)' }
      }
      const messages: Array<{ role: string, content: unknown }> = []
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        let msg: unknown
        try {
          msg = JSON.parse(line)
        }
        catch (err) {
          return { error: `dump line ${i + 1} is not valid JSON: ${(err as Error).message}` }
        }
        if (typeof msg !== 'object' || msg === null) {
          return { error: `dump line ${i + 1} is not a JSON object` }
        }
        const m = msg as { role?: unknown, content?: unknown }
        if (typeof m.role !== 'string') {
          return { error: `dump line ${i + 1} missing string \`role\` field` }
        }
        // Allowlist roles. Anthropic's /v1/messages accepts user/assistant/
        // system; anything else (e.g. role:"junk", role:"tool_result")
        // makes upstream 400 the next request, breaking the conversation
        // silently from the AI's POV (it just sees "scheduled" and waits
        // forever). Catch malformed values here.
        if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') {
          return {
            error: `dump line ${i + 1} has invalid role "${m.role}" (expected user|assistant|system)`,
          }
        }
        if (m.content === undefined) {
          return { error: `dump line ${i + 1} missing \`content\` field` }
        }
        // Anthropic accepts string content OR an array of content blocks; we
        // don't validate the array's structure (passes through to Anthropic).
        messages.push({ role: m.role, content: m.content })
      }

      // The load-bearing rule (Decision #4): last line MUST be assistant.
      const lastMsg = messages[messages.length - 1]!
      if (lastMsg.role !== 'assistant') {
        return {
          error: `dump's last line has role="${lastMsg.role}", expected "assistant". The appended user message would create back-to-back user turns. Either drop the trailing user line from the dump, or call rewind_to directly if you don't need the file edits.`,
        }
      }

      // Feature gate (mirror rewind_to). Reuse the same env-driven flag —
      // if rewind is off, submit is off too (both produce a TOBE that the
      // proxy splices into the next /v1/messages).
      if (deps.rewindEnabled === false) {
        return { error: 'submit_file is disabled; proxy running in recording-only mode.' }
      }

      // ── Phase 3: append message + write TOBE ──────────────────────────────
      const forkId = generateForkId()
      const newMessage = synthesizeUserMessageWithReminder(message, forkId)
      const finalMessages: unknown[] = [...messages, newMessage]
      const newMessageBlob = await blobRefFromBytes(
        Buffer.from(JSON.stringify(newMessage), 'utf8'),
      )

      // Load the session here (we deferred it past the validation/secret
      // checks since those don't need DB state). Reject orphans the same
      // way rewind_to does — submit_file produces a TOBE that the proxy
      // splice consumes, and that splice path requires a properly-bound
      // session.
      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }
      if (sess.harness === 'orphan') {
        return { error: 'submit_file requires an MCP-initialized session (orphan sessions cannot submit)' }
      }

      // R1 = the assistant turn that emitted tool_use(submit_file). Captured
      // here for SR.parent_revision_id. Parallel-tool detection runs at
      // TOBE-consumption time in proxy-handler against claude's parsed JSON
      // body — see the rewind_to handler comment above for rationale.
      const r1 = mostRecentRevision(deps.db, sess.task_id)

      // submit_file needs at least one closed_forkable revision to use as
      // the fork-point anchor in the emitted fork.back_requested event.
      // The projector requires a non-null fork_point_revision_id and the
      // proxy splice attaches the submitted history at the first /v1/
      // messages call after this — so a session with no history yet can't
      // meaningfully submit.
      const headForkable = mostRecentForkableRevision(deps.db, sess.task_id)
      if (!headForkable) {
        return {
          error: 'submit_file requires at least one settled turn in this session — wait for the current turn to close (or send a normal user message first).',
        }
      }
      const targetViewId = generateTraceId()

      // SR-construction metadata (v0.5.0). Same handoff as rewind_to: the
      // proxy-handler derives tool_use_id at TOBE-consumed time, then emits
      // fork.forked. Skipped (no SR materialized) when R1 can't be resolved
      // — the submit still applies.
      const syntheticRevisionId = generateTraceId()
      const headShort = headForkable.id.slice(0, 8)
      const dumpBasename = path.basename(resolvedPath)
      const syntheticToolResultText
        = `Submission applied. Edited dump from ${dumpBasename} (${messages.length} messages) merged at rev_${headShort}.`
      const syntheticAssistantText
        = `Submission applied. Continuing from edited conversation.`
      const backRequestedAt = Date.now()

      // v0.6 anchor mechanism: write the active fork_anchors row. Symmetric
      // with rewind_to — the anchor token in the returned tool_result drives
      // applyAnchorSplice on the next /v1/messages.
      const anchorToken = generateAnchorToken()
      const finalMessagesJson = JSON.stringify(finalMessages)
      if (finalMessagesJson.length > TARGET_MESSAGES_MAX_BYTES) {
        return {
          status: 'error',
          message: `submit_file: target messages would exceed the ${TARGET_MESSAGES_MAX_BYTES} byte cap. Trim the dump and try again.`,
        }
      }
      insertActiveAnchor(deps.db, {
        anchor_token: anchorToken,
        session_id: ctx.sessionId,
        target_messages_json: finalMessagesJson,
        fork_point_revision_id: headForkable.id,
        source_view_id: ctx.sessionId,
        synthetic_metadata: r1
          ? {
              kind: 'submit',
              target_view_id: targetViewId,
              synthetic_revision_id: syntheticRevisionId,
              synthetic_tool_result_text: syntheticToolResultText,
              synthetic_assistant_text: syntheticAssistantText,
              synthetic_user_message: message,
              parent_revision_id: r1.id,
              back_requested_at: backRequestedAt,
            }
          : undefined,
      })

      await ctx.channel.submit(
        'fork.back_requested',
        {
          source_view_id: ctx.sessionId,
          fork_point_revision_id: headForkable.id,
          new_message_cid: newMessageBlob.cid,
          target_view_id: targetViewId,
          task_id: sess.task_id,
          // For submit_file, head==fork_point: the AI edits content at the
          // current head. recall's rewind_events surfaces from==to which
          // signals "edit, not rewind" (no actual jump in the revision DAG).
          head_revision_id: headForkable.id,
          via: 'submit_file',
          dump_path: resolvedPath,
        },
        ctx.sessionId,
        [newMessageBlob.ref],
      )

      return submitScheduledResponse({
        path: resolvedPath,
        fork_point: headForkable.id,
        target_view_id: targetViewId,
        anchor_token: anchorToken,
        message_count: finalMessages.length,
      })
    },
  })

  return tools
}

/**
 * Reconstruct the messages[] array AT (i.e. up to and including) a fork
 * point's assistant response. Two source preferences:
 *
 * 1. Earliest child's request body, with the LAST entry sliced off. The
 *    child's body has the form `[...history, target_assistant_response,
 *    child_user_input]`; we want the prefix up through the assistant
 *    response, so dropping the last entry (the to-be-rolled-back user
 *    message) gives exactly that.
 *
 * 2. Fallback: target's OWN request body. Doesn't contain target's
 *    assistant response but is a valid conversation prefix. Used only
 *    when no child exists or its body is unavailable.
 *
 * Returns null only if neither source yields a valid messages array.
 *
 * Without the slice in case 1, the rolled-back user input would land
 * back in the upstream request — defeating the rewind.
 *
 * Bodies are stored as content-addressed splits (one blob per message
 * + tool, top blob holds CID links) — see body-blob.ts. We hydrate
 * via loadHydratedMessagesBody so the messages[] array we return is
 * fully expanded inline, not link refs.
 */
export async function reconstructForkMessages(
  deps: { db: DB, storageProvider: StorageProvider },
  target: RevisionRow,
): Promise<unknown[] | null> {
  const child = firstChild(deps.db, target.id)
  if (child) {
    const childCid = requestBodyCidFor(deps.db, child.id)
    if (childCid) {
      const messages = await hydrateMessages(deps, childCid as AssetId)
      if (messages && messages.length > 0) {
        return messages.slice(0, -1)
      }
    }
  }
  const targetCid = requestBodyCidFor(deps.db, target.id)
  if (targetCid) {
    const messages = await hydrateMessages(deps, targetCid as AssetId)
    if (messages) return [...messages]
  }
  return null
}

async function hydrateMessages(
  deps: { storageProvider: StorageProvider },
  cid: AssetId,
): Promise<unknown[] | null> {
  // Try the content-addressed (link-ified) layout first.
  const hydrated = await loadHydratedMessagesBody(deps.storageProvider, cid)
  if (hydrated && Array.isArray(hydrated.messages)) {
    return hydrated.messages
  }
  // Legacy fallback: the top blob predates the messages-body split, OR
  // its decoded value isn't a recognizable link-walk shape (raw codec,
  // top-level array, primitive, etc.). Try parsing the bytes as
  // straight JSON to extract messages[]. fetchBuffer throws on missing;
  // treat that as null.
  let bytes: Uint8Array
  try {
    bytes = await deps.storageProvider.fetchBuffer(cid)
  }
  catch {
    return null
  }
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as { messages?: unknown[] }
    if (Array.isArray(parsed.messages)) return parsed.messages
  }
  catch { /* not JSON */ }
  return null
}
