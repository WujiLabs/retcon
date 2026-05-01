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
  return db.prepare(`
    SELECT * FROM revisions
     WHERE task_id = ? AND classification = 'closed_forkable' AND sealed_at IS NOT NULL
     ORDER BY sealed_at DESC, id DESC LIMIT 1
  `).get(taskId) as RevisionRow | undefined
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
 * Find the EARLIEST child of a Revision. Fork-point reconstruction needs the
 * child's request body to recover the messages[] prefix at the fork point.
 * Ordering by created_at/id gives deterministic behavior across SQLite builds
 * and across projection rebuilds — same events → same reconstructed messages.
 */
function firstChild(db: DB, parentRevisionId: string): RevisionRow | undefined {
  return db.prepare(`
    SELECT * FROM revisions WHERE parent_revision_id = ?
     ORDER BY created_at ASC, id ASC LIMIT 1
  `).get(parentRevisionId) as RevisionRow | undefined
}

/**
 * Walk past `open` and `in_flight` revisions from the most recent revision
 * to find the nearest settled (non-in-flight) ancestor. This is the F4 guard
 * extracted into a helper so both `recall` and `rewind_to` can reuse it.
 *
 * Returns undefined if no settled revision is reachable. Cycle-safe: a
 * corrupt parent_revision_id chain (e.g., self-loop or A→B→A) terminates
 * via the visited set and depth cap rather than spinning forever.
 */
function effectiveHead(db: DB, taskId: string): RevisionRow | undefined {
  let head: RevisionRow | undefined = mostRecentRevision(db, taskId)
  const visited = new Set<string>()
  for (let i = 0; i < RECALL_MAX_DEPTH; i++) {
    if (!head || (head.classification !== 'open' && head.classification !== 'in_flight')) return head
    if (visited.has(head.id)) return undefined
    visited.add(head.id)
    if (!head.parent_revision_id) return undefined
    head = loadRevision(db, head.parent_revision_id)
  }
  return undefined
}

/**
 * Walk backward from `start` (inclusive) collecting the first N closed_forkable
 * revisions. Returns the Nth (1-indexed) or undefined if fewer than N exist.
 * The returned revision is the FORK POINT for rewind_to.
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
    if (rev.classification === 'closed_forkable') {
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
 * Count how many closed_forkable revisions are reachable backward from
 * `start` (exclusive). Used to produce a helpful error message when
 * `nthForkableBack` returns undefined. Cycle-safe like its siblings.
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
    if (rev.classification === 'closed_forkable') count++
    cursor = rev.parent_revision_id
  }
  return count
}

/**
 * Extract a ≤80-char content preview from a revision's request body. Used by
 * `recall` to show the AI what each forkable turn was about without dumping
 * the full conversation. Resolves the body via the events table and grabs
 * the LAST user message's text content.
 *
 * Returns a short placeholder string if the body is unavailable, empty, or
 * carries only non-text content blocks (images, tool_use, etc.). Failures
 * are non-fatal — the preview is informational, not load-bearing.
 */
async function turnPreview(
  deps: { db: DB, storageProvider: StorageProvider },
  revisionId: string,
  maxLen = 80,
): Promise<string> {
  const cid = requestBodyCidFor(deps.db, revisionId)
  if (!cid) return '(no body)'
  const messages = await hydrateMessages(deps, cid as AssetId)
  if (!messages || messages.length === 0) return '(empty body)'
  // Last user message — that's the prompt that produced this turn's response.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string, content?: unknown } | undefined
    if (m?.role !== 'user') continue
    let text = ''
    if (typeof m.content === 'string') {
      text = m.content
    }
    else if (Array.isArray(m.content)) {
      const block = m.content.find(
        (b: unknown): b is { type: string, text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text',
      )
      text = block?.text ?? '(non-text content)'
    }
    text = text.replace(/\s+/g, ' ').trim()
    if (text.length === 0) return '(empty user message)'
    return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text
  }
  return '(no user message)'
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
    'So `message` must:',
    '  1. Carry the SUBSTANTIVE instruction. Not "rewind to my previous answer" — the rewind already happened, and the receiving AI sees no "previous answer." Send the new value, the corrected plan, the actual instruction.',
    '  2. Be readable in isolation. Don\'t write "let\'s continue from here" — there\'s no shared "here" for the receiving AI. The history above must already make sense; this turn must already make sense.',
    '  3. Include change-context if the user should see the AI acknowledge the change. If the user changed their mind from A to B and you want acknowledgment, write "B (changing my earlier answer of A)". Pure "B" works for clean redos.',
    '  4. Be framed from the user\'s POV. It becomes a user-role turn. For user-initiated rewinds, write what the user would have said if they\'d retyped at the rewound point. For AI-initiated rewinds, write the user-shaped instruction the user WOULD have given if they\'d been steering you.',
    '',
    'EXAMPLES:',
    '  User: "I want to change my previous answer from A to B."',
    '    → message: "B (changing my earlier answer of A)"',
    '  User: "Restart from the database planning. Use Postgres instead of SQLite."',
    '    → message: "Let\'s use Postgres for the database, not SQLite."',
    '  You (AI, autonomously realized you went off track):',
    '    → message: "Let me try a different approach. Use approach Y instead of approach X — [explain in 1-2 sentences]."',
    '',
    'ANTI-PATTERNS — do not pass these:',
    '  ❌ "continue from here"  ❌ "redo your last response"',
    '  ❌ "the same question I just asked"  ❌ "what I said earlier"',
    '  ❌ "User wants to change A to B." (third-person, reads weird as a user-turn)',
    '',
    'NOW CLASSIFY YOUR MESSAGE AND RE-CALL:',
    '',
    `  - If your \`message\` STANDS ALONE (no meta-references, readable with no cut-off context): re-call with confirm="${tokens.clean}"`,
    `  - If your \`message\` contains a META-REFERENCE you spotted: re-call with confirm="${tokens.meta}" — we will reject and you can revise`,
    '',
    'Both tokens are single-use. They expire in 5 minutes. If you classify dishonestly (send the clean token with a meta-reference in your message), we run a narrow regex check that catches the most flagrant cases.',
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
 * The "scheduled" response. Decision #7: invisible-success, loud-failure.
 * If the AI sees this text, the splice didn't run and the user needs to
 * hear about it. On the success path, the proxy's body-splice replaces the
 * entire turn carrying this response, so the AI never reads it.
 */
function rewindScheduledResponse(extra: {
  fork_point: string
  target_view_id: string
  pending_path: string
  prior_outcome: unknown
}): {
  status: string
  message: string
  fork_point: string
  target_view_id: string
  pending_path: string
  prior_outcome: unknown
  next_steps: string
} {
  return {
    status: 'scheduled',
    message: [
      'RETCON ERROR: If you are reading this, the rewind did NOT take effect.',
      'Tell the user: "retcon failed to apply the rewind. The next message will not be in the rewound state."',
      'They may need to retry, or run `retcon stop && retcon` to restart the daemon.',
      '',
      '(On the success path, the proxy splices the rewound history into the next /v1/messages and this entire turn is discarded — meaning you never see this text. Reading it means the splice failed.)',
    ].join('\n'),
    fork_point: extra.fork_point,
    target_view_id: extra.target_view_id,
    pending_path: extra.pending_path,
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
    'So `message` must:',
    '  1. Carry the SUBSTANTIVE instruction. Not "submit my edits" — the edits already happened, and the receiving AI sees them as if they always existed. Send the new value, the corrected plan, the actual instruction.',
    '  2. Be readable in isolation. Don\'t write "let\'s continue from here" — there\'s no shared "here" for the receiving AI. The history above must already make sense; this turn must already make sense.',
    '  3. Include change-context if the user should see the AI acknowledge the edit. If you fixed a factual error in the history, write something like "(I corrected an error in the earlier discussion — please verify and continue.)" Pure substantive instruction works for clean replays.',
    '  4. Be framed from the user\'s POV. It becomes a user-role turn.',
    '',
    'EXAMPLES:',
    '  After editing a dump to fix a wrong calculation:',
    '    → message: "(I corrected the budget number in the earlier turn from $500 to $5,000.) Continue with the cost analysis using the corrected number."',
    '  After dumping current state with no edits, just to redirect:',
    '    → message: "Switch the focus to security review now."',
    '',
    'ANTI-PATTERNS — do not pass these:',
    '  ❌ "submit my changes"  ❌ "see the edits I made"',
    '  ❌ "as I just edited"  ❌ "now apply this"',
    '',
    'NOW CLASSIFY YOUR MESSAGE AND RE-CALL:',
    '',
    `  - If your \`message\` STANDS ALONE (no meta-references, readable with no cut-off context): re-call with confirm="${tokens.clean}"`,
    `  - If your \`message\` contains a META-REFERENCE you spotted: re-call with confirm="${tokens.meta}" — we will reject and you can revise`,
    '',
    'Both tokens are single-use. They expire in 5 minutes. If you classify dishonestly (send the clean token with a meta-reference in your message), we run a narrow regex check that catches the most flagrant cases.',
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
  pending_path: string
  message_count: number
}): {
  status: string
  message: string
  path: string
  fork_point: string | null
  target_view_id: string
  pending_path: string
  message_count: number
  next_steps: string
} {
  return {
    status: 'scheduled',
    message: [
      'RETCON ERROR: If you are reading this, the submit did NOT take effect.',
      'Tell the user: "retcon failed to apply the submitted dump. The next message will not include the edits."',
      'They may need to retry, or run `retcon stop && retcon` to restart the daemon.',
      '',
      '(On the success path, the proxy splices the submitted history into the next /v1/messages and this entire turn is discarded — meaning you never see this text. Reading it means the splice failed.)',
    ].join('\n'),
    path: extra.path,
    fork_point: extra.fork_point,
    target_view_id: extra.target_view_id,
    pending_path: extra.pending_path,
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
      'USE WHEN: the user wants to revisit, rewind, recall, or pull up a past moment in this conversation. ALSO use when YOU recognize you have gone off track and want to back up. '
      + 'Returns recent forkable turns (closed_forkable Revisions) with content previews and turn ids you can pass to `rewind_to`. '
      + 'No args: list recent turns plus a rewind_events array showing where you have rewound. `turn_back_n`: inspect the Nth turn back. `turn_id`: inspect a specific turn. `view_id`: inspect the turn a branch_view (from `list_branches`) points at. `surrounding: N` (0-10): include N forkable turns on each side of the inspected turn. '
      + 'NEXT STEPS: to rewind to a turn, call `rewind_to`. To save a spot, call `bookmark`. To list saved spots, call `list_branches`.',
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
          preview,
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
          stop_reason: string | null
          sealed_at: number | null
          relative_to_target: number // negative = older, positive = newer
        }> | undefined
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
              stop_reason: r.stop_reason,
              sealed_at: r.sealed_at,
              relative_to_target: -(i + 1),
            })),
            ...after.map((r, i) => ({
              turn_id: r.id,
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

      const turns = await Promise.all(rows.map(async (r, idx) => {
        const preview = await turnPreview(deps, r.id)
        const lean = {
          turn_id: r.id,
          n_back: offset + idx + 1, // matches rewind_to(turn_back_n=N)
          preview,
          stop_reason: r.stop_reason,
          sealed_at: r.sealed_at,
        }
        if (!verbose) return lean
        return { ...lean, created_at: r.created_at }
      }))

      const nextSteps = turns.length === 0
        ? 'No rewindable turns yet. The current state is `current_head_turn_id`. After more turns close, call `recall` again.'
        : 'To inspect a turn, call `recall` with `turn_id` or `turn_back_n`. To rewind, call `rewind_to(turn_back_n=N, message="...")` where N matches the `n_back` of the target turn (or pass `turn_id` directly). To save the current spot, call `bookmark`. To list saved spots, call `list_branches`.'

      // rewind_events: prior fork.back_requested events for THIS session,
      // surfaced inline so the AI can see "a rewind happened here" between
      // turns. Bounded LIMIT 50 to keep the response small on long sessions
      // — long-tail rewind history is reachable via list_branches.
      const rewindEventRows = deps.db.prepare(`
        SELECT event_id, payload, created_at FROM events
         WHERE session_id = ? AND topic = 'fork.back_requested'
         ORDER BY event_id DESC
         LIMIT 50
      `).all(ctx.sessionId) as Array<{
        event_id: string
        payload: string
        created_at: number
      }>
      const rewindEvents: Array<{
        at: number
        from_turn_id: string
        to_turn_id: string
        view_id: string
      }> = []
      for (const row of rewindEventRows) {
        try {
          const p = JSON.parse(row.payload) as {
            fork_point_revision_id?: string
            target_view_id?: string
            // The "from" turn: the head_revision_id at the moment of fork
            // is recorded as `head_revision_id` by some emitters. If absent,
            // skip — we don't fabricate.
            head_revision_id?: string
          }
          if (!p.fork_point_revision_id || !p.target_view_id) continue
          rewindEvents.push({
            at: row.created_at,
            from_turn_id: p.head_revision_id ?? '',
            to_turn_id: p.fork_point_revision_id,
            view_id: p.target_view_id,
          })
        }
        catch { /* malformed event payload — skip */ }
      }

      return {
        total,
        turns,
        current_head_turn_id: headId,
        rewind_events: rewindEvents,
        next_steps: nextSteps,
      }
    },
  })

  // ── rewind_to ─────────────────────────────────────────────────────────────
  // Replaces fork_back. Adds opaque dual-secret + narrow regex guardrail.
  tools.set('rewind_to', {
    description:
      'USE WHEN: the user explicitly asks to rewind, restart, or revise an earlier turn. ALSO use when YOU recognize the conversation went off track and you want to back up. '
      + 'Walks back N forkable turns and replaces the conversation tail with your `message` arg. The next /v1/messages call will arrive with the rewound history + your `message` as the next user-role turn — and the AI handling that call has NO memory of cut-off turns. '
      + 'TWO-STEP CALL: First call WITHOUT a `confirm` token returns the rules + a single-use token pair. Pick the token matching your message and re-call. '
      + 'NEXT STEPS: after a successful rewind_to, WAIT for the next /v1/messages — that is where the rewind lands. Do not call further tools.',
    inputSchema: {
      type: 'object',
      properties: {
        turn_back_n: { type: 'number', description: 'How many forkable turns back to go (≥1). Mutually exclusive with turn_id.' },
        turn_id: { type: 'string', description: 'Exact turn id (from `recall`) to rewind to. Mutually exclusive with turn_back_n.' },
        message: { type: 'string', description: 'New user message to deliver at the rewound point. Must stand alone (no meta-references to cut-off content).' },
        confirm: { type: 'string', description: 'Token from this tool\'s prior rules-return call. Pick the clean_token if your message stands alone; pick the meta_token if you spotted a meta-reference (we will reject and let you revise).' },
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
        ctx.producer.emit(
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

      // Resolve the target revision: turn_id wins; else turn_back_n; else default 1.
      let target: RevisionRow | undefined
      if (typeof parsed.turn_id === 'string' && typeof parsed.turn_back_n === 'number') {
        return { error: 'pass either turn_id or turn_back_n, not both' }
      }

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
        const head = effectiveHead(deps.db, sess.task_id)
        if (!head) {
          return { error: 'cannot rewind: no settled (non-in-flight) revision available' }
        }
        target = nthForkableBack(deps.db, head, n)
        if (!target) {
          // Use the cycle-safe helper so a corrupt parent chain doesn't hang
          // the error path on top of failing the happy path.
          const available = countForkableBack(deps.db, head)
          return { error: `only ${available} forkable turns available; cannot go back ${n}` }
        }
      }

      // Reconstruct messages[] at the fork point.
      const baseMessages = await reconstructForkMessages(deps, target)
      if (!baseMessages) {
        return { error: 'unable to reconstruct messages[] for fork_point (no usable source blob)' }
      }
      baseMessages.push({ role: 'user', content: message })

      const newMessageBlob = await blobRefFromBytes(
        Buffer.from(JSON.stringify({ role: 'user', content: message }), 'utf8'),
      )

      // Prior fork's outcome (A-R8): if the previous TOBE-applied request
      // ended in failure, the LLM sees that here along with the new fork.
      const prior = lastForkOutcome(deps.db, ctx.sessionId)

      const targetViewId = generateTraceId()
      deps.tobeStore.write(ctx.sessionId, {
        messages: baseMessages,
        fork_point_revision_id: target.id,
        source_view_id: ctx.sessionId,
      })

      // Persistent fork branch context — see daemon for downstream consumers.
      deps.db.prepare(`UPDATE sessions SET branch_context_json = ? WHERE id = ?`)
        .run(JSON.stringify(baseMessages), ctx.sessionId)

      ctx.producer.emit(
        'fork.back_requested',
        {
          source_view_id: ctx.sessionId,
          fork_point_revision_id: target.id,
          new_message_cid: newMessageBlob.cid,
          target_view_id: targetViewId,
          task_id: sess.task_id,
        },
        ctx.sessionId,
        [newMessageBlob.ref],
      )

      return rewindScheduledResponse({
        fork_point: target.id,
        target_view_id: targetViewId,
        pending_path: deps.tobeStore.fileFor(ctx.sessionId),
        prior_outcome: prior,
      })
    },
  })

  // ── bookmark ──────────────────────────────────────────────────────────────
  // Renamed from fork_bookmark. Same semantics, intent-aligned name.
  tools.set('bookmark', {
    description:
      'USE WHEN: the user wants to save the current spot in the conversation so they can return to it later. '
      + 'Bookmarks the most recent forkable turn with an optional human label. The bookmark survives /clear, /compact, and resume — call `recall` later to find it. '
      + 'NEXT STEPS: to revisit a bookmarked turn, call `recall` (which lists turn ids) followed by `rewind_to`.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable label for this bookmark (e.g., "before refactor" or "v1 baseline").' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = (args ?? {}) as { label?: string }

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }

      const head = mostRecentForkableRevision(deps.db, sess.task_id)
      if (!head) {
        return {
          error: 'no forkable turn yet — wait for the current turn to close before bookmarking',
        }
      }

      const viewId = generateTraceId()
      ctx.producer.emit(
        'fork.bookmark_created',
        {
          view_id: viewId,
          task_id: sess.task_id,
          head_revision_id: head.id,
          label: parsed.label ?? null,
          auto_label: `bookmark@${new Date().toISOString()}`,
        },
        ctx.sessionId,
      )
      return {
        view_id: viewId,
        head_revision_id: head.id,
        label: parsed.label ?? null,
        next_steps: 'Bookmark saved. The next time you want to return here, call `recall` to list turns (this bookmark is the current head, so you\'ll see its `head_revision_id` as `current_head_turn_id`) and then `rewind_to` with `turn_id` matching it.',
      }
    },
  })

  // ── delete_bookmark ───────────────────────────────────────────────────────
  // Resolves an id-or-label to a single branch_view row in the current session,
  // emits fork.bookmark_deleted, projector deletes. Auto fork-point views (from
  // rewind_to) are stored as branch_views too — they CAN be deleted by view_id
  // but NOT by label, since their `label` field is NULL (and the resolver only
  // matches non-NULL labels to avoid accidental deletion of the most recent
  // fork-point when the user says "delete the bookmark with no label").
  tools.set('delete_bookmark', {
    description:
      'USE WHEN: the user wants to remove a saved spot. '
      + 'Deletes a single branch_view by its view_id or unique label. Auto fork-point views (created when you rewind_to elsewhere) can only be deleted by view_id since their label is NULL. Errors if the label matches multiple views. The deletion is recorded in the event log; replay reconstructs branch_views before the deletion. '
      + 'NEXT STEPS: call `list_branches` to see what remains.',
    inputSchema: {
      type: 'object',
      properties: {
        id_or_label: { type: 'string', description: 'view_id (e.g., "01...") OR unique label of the branch_view to delete. Errors if a label matches >1 view.' },
      },
      required: ['id_or_label'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = (args ?? {}) as { id_or_label?: unknown }

      if (typeof parsed.id_or_label !== 'string' || parsed.id_or_label.length === 0) {
        return { error: 'id_or_label is required and must be a non-empty string' }
      }
      const idOrLabel = parsed.id_or_label

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }

      // Try id match first (fast path, exact). Then label match scoped to this
      // session's task. Label match deliberately excludes NULL-label rows so
      // a label query never accidentally targets a fork_point.
      const byId = deps.db
        .prepare(`SELECT id, task_id, label, head_revision_id, auto_label FROM branch_views WHERE id = ? AND task_id = ?`)
        .get(idOrLabel, sess.task_id) as
        | { id: string, task_id: string, label: string | null, head_revision_id: string, auto_label: string }
        | undefined

      let target: typeof byId
      if (byId) {
        target = byId
      }
      else {
        const byLabel = deps.db
          .prepare(`SELECT id, task_id, label, head_revision_id, auto_label FROM branch_views WHERE task_id = ? AND label = ?`)
          .all(sess.task_id, idOrLabel) as Array<{
          id: string
          task_id: string
          label: string | null
          head_revision_id: string
          auto_label: string
        }>
        if (byLabel.length === 0) {
          return { error: `no branch_view with id or label '${idOrLabel}' in this session` }
        }
        if (byLabel.length > 1) {
          return {
            error: `label '${idOrLabel}' matches ${byLabel.length} views — pass view_id instead`,
            ambiguous_view_ids: byLabel.map(r => r.id),
          }
        }
        target = byLabel[0]
      }

      ctx.producer.emit(
        'fork.bookmark_deleted',
        { view_id: target!.id, task_id: target!.task_id },
        ctx.sessionId,
      )
      // Determine kind from auto_label prefix (matches list_branches semantics).
      const kind = target!.auto_label.startsWith('fork@') ? 'fork_point' : 'bookmark'
      return {
        deleted: {
          view_id: target!.id,
          kind,
          label: target!.label,
          head_turn_id_at_delete: target!.head_revision_id,
        },
        next_steps: 'Branch view removed. Call `list_branches` to see what remains.',
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
      'USE WHEN: the user asks what bookmarks/branches/saved spots exist, or you need to navigate to one. '
      + 'Lists every branch_view for this session — both explicit bookmarks (created via `bookmark`) and automatic fork-point views (created when you `rewind_to`). Each entry has a `kind` field. Branches auto-advance: their `head_turn_id` moves forward as new turns close on the same branch, until you fork. '
      + 'NEXT STEPS: pass a view_id to `recall` to inspect the turn it points at, then `rewind_to` to return there. To remove a branch, call `delete_bookmark`.',
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
      'USE WHEN: you want to inspect or edit the conversation history before continuing. '
      + 'Writes the conversation through a target turn\'s assistant response to a JSONL file (one Anthropic message per line). The file lives at ~/.retcon/dumps/<id>.jsonl, which retcon pre-allowed for Read/Edit/Write/Glob/Grep, so you can use those tools without prompting the user. '
      + 'No args = dump current state. `turn_id` or `turn_back_n` = dump through that turn. '
      + 'NEXT STEPS: use `Read` to view the dump, `Edit` to modify any message, then call `submit_file` with the path + a new user instruction to apply.',
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
        // is active (branch_context_json set), that's the source — and the
        // target is the current branch head. Otherwise the head's response
        // body isn't reliably available from the request-body chain (the
        // head's child doesn't exist yet), so we step back one forkable
        // turn — `reconstructForkMessages(target=N-1)` uses head as the
        // child and slices off head's user input, ending the dump at the
        // one-before-head's assistant response.
        const branchRowEarly = deps.db.prepare(
          'SELECT branch_context_json FROM sessions WHERE id = ?',
        ).get(ctx.sessionId) as { branch_context_json: string | null } | undefined
        if (branchRowEarly?.branch_context_json) {
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

      // Resolve messages. If we're on a forked branch (branch_context_json
      // populated) AND the target IS the current branch head, dump the
      // branch's view directly — that's the truth of what Anthropic has been
      // seeing across this branch's lifetime. Otherwise reconstruct from the
      // request body via reconstructForkMessages (same path rewind_to uses).
      //
      // CRITICAL: branch_context_json's tail is ALWAYS user-role in production.
      // rewind_to writes it as [history..., new_user_message]; subsequent
      // applyBranchContextRewrite extends it to [..., asst, final_user]
      // because Anthropic requires request bodies end in user. So when we
      // adopt branch_context as the dump source, we MUST slice off the
      // trailing user line(s) to satisfy the load-bearing assistant-tail
      // rule. See proxy-handler.ts:240-274 for the upstream invariant.
      let messages: unknown[] | null = null
      const branchRow = deps.db.prepare(
        'SELECT branch_context_json FROM sessions WHERE id = ?',
      ).get(ctx.sessionId) as { branch_context_json: string | null } | undefined
      const headRev = mostRecentForkableRevision(deps.db, sess.task_id)
      const isHead = headRev?.id === target.id
      const usedBranchView = isHead && !!branchRow?.branch_context_json
      if (usedBranchView) {
        try {
          const parsedJson = JSON.parse(branchRow!.branch_context_json!) as unknown
          if (Array.isArray(parsedJson)) {
            // Slice off any trailing user line(s) so the dump ends at the
            // most recent assistant response. Empty result falls through to
            // reconstructForkMessages.
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
        next_steps: 'Use the Read tool to inspect this dump (one Anthropic message per line). Use Edit to modify any line — keep the {role, content} shape intact. The LAST line MUST remain an assistant-role message; submit_file will reject otherwise. When ready, call `submit_file` with `path` set to this file and `message` set to your new user instruction.',
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
      'USE WHEN: you have edited a dump file (or want to apply one as-is) and need to make those changes the conversation history going forward. '
      + 'Reads a JSONL dump from ~/.retcon/dumps/, validates it (each line a message, last line assistant-role), appends your `message` as a new user turn, and queues it as the next /v1/messages. '
      + 'TWO-STEP CALL: first call WITHOUT a `confirm` token returns rules + a single-use token pair. Pick the token matching your message and re-call. '
      + 'NEXT STEPS: after a successful submit, WAIT for the next /v1/messages — the result lands there. Do not call further tools.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the JSONL dump (must resolve inside ~/.retcon/dumps/).' },
        message: { type: 'string', description: 'New user message to deliver after the dumped history. Must stand alone (no meta-references).' },
        confirm: { type: 'string', description: 'Token from this tool\'s prior rules-return call. Pick clean if message stands alone, meta if you spotted a meta-reference.' },
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
      const finalMessages: unknown[] = [...messages, { role: 'user', content: message }]
      const newMessageBlob = await blobRefFromBytes(
        Buffer.from(JSON.stringify({ role: 'user', content: message }), 'utf8'),
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

      deps.tobeStore.write(ctx.sessionId, {
        messages: finalMessages,
        fork_point_revision_id: headForkable.id,
        source_view_id: ctx.sessionId,
      })

      // Persist as branch context (same as rewind_to) so subsequent turns
      // continue on the submitted branch.
      deps.db.prepare(`UPDATE sessions SET branch_context_json = ? WHERE id = ?`)
        .run(JSON.stringify(finalMessages), ctx.sessionId)

      ctx.producer.emit(
        'fork.back_requested',
        {
          source_view_id: ctx.sessionId,
          fork_point_revision_id: headForkable.id,
          new_message_cid: newMessageBlob.cid,
          target_view_id: targetViewId,
          task_id: sess.task_id,
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
        pending_path: deps.tobeStore.fileFor(ctx.sessionId),
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
