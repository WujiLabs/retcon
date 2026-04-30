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

import type { AssetId, StorageProvider } from '@playtiss/core'
import { generateTraceId } from '@playtiss/core'

import { blobRefFromBytes, loadHydratedMessagesBody } from './body-blob.js'
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
 * Returns undefined if no settled revision is reachable.
 */
function effectiveHead(db: DB, taskId: string): RevisionRow | undefined {
  let head: RevisionRow | undefined = mostRecentRevision(db, taskId)
  while (head && (head.classification === 'open' || head.classification === 'in_flight')) {
    if (!head.parent_revision_id) return undefined
    head = loadRevision(db, head.parent_revision_id)
  }
  return head
}

/**
 * Walk backward from `start` (inclusive) collecting the first N closed_forkable
 * revisions. Returns the Nth (1-indexed) or undefined if fewer than N exist.
 * The returned revision is the FORK POINT for rewind_to.
 *
 * `start` itself is "where we are" — it is NOT counted, even if it's closed_forkable.
 */
function nthForkableBack(db: DB, start: RevisionRow, n: number): RevisionRow | undefined {
  let walked = 0
  let cursor: string | null = start.parent_revision_id
  let target: RevisionRow | undefined
  while (walked < n && cursor) {
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
    const pair: ConfirmTokenPair = {
      clean: opaqueToken(),
      meta: opaqueToken(),
      expiresAt: now + this.ttlMs,
    }
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
 * from a 62-char alphabet → 62^8 ≈ 2.18×10^14 possible values — collision
 * is statistically negligible for the per-session use case.
 *
 * Avoids common confusables intentionally? No — we want full entropy.
 * The AI doesn't read tokens letter-by-letter; it copies them verbatim from
 * the rules text into the next call.
 */
function opaqueToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i]! % alphabet.length]
  }
  return out
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
  /\b(see|saw|read) above\b/i,
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
  }
}

// ─── Tool factory ────────────────────────────────────────────────────────────

export function createMcpTools(deps: McpToolDeps): Map<string, McpTool> {
  const tokenStore = new ConfirmTokenStore()
  return createMcpToolsWithTokens(deps, tokenStore)
}

/**
 * Internal entry for tests that need to inspect the token store. External
 * callers should use createMcpTools() which manages its own store.
 */
export function createMcpToolsWithTokens(
  deps: McpToolDeps,
  tokenStore: ConfirmTokenStore,
): Map<string, McpTool> {
  const tools = new Map<string, McpTool>()

  // ── recall ────────────────────────────────────────────────────────────────
  // Combines fork_list + fork_show. No args = list recent forkable turns.
  // turn_back_n = inspect Nth turn back. turn_id = inspect specific turn.
  tools.set('recall', {
    description:
      'USE WHEN: the user wants to revisit, rewind, recall, or pull up a past moment in this conversation. ALSO use when YOU recognize you have gone off track and want to back up. '
      + 'Returns recent forkable turns (closed_forkable Revisions) with content previews and turn ids you can pass to `rewind_to`. '
      + 'No args: list recent turns. `turn_back_n`: inspect the Nth turn back (1=most recent forkable). `turn_id`: inspect a specific turn. '
      + 'NEXT STEPS: to rewind to a turn, call `rewind_to`. To bookmark the latest turn, call `bookmark`.',
    inputSchema: {
      type: 'object',
      properties: {
        turn_back_n: { type: 'number', description: 'Inspect the Nth forkable turn back (1=most recent). Mutually exclusive with turn_id.' },
        turn_id: { type: 'string', description: 'Inspect a specific turn by id (returned by an earlier recall call). Mutually exclusive with turn_back_n.' },
        limit: { type: 'number', description: 'When listing (no turn_back_n/turn_id), max turns to return (1-200, default 20).' },
        offset: { type: 'number', description: 'When listing, pagination offset (default 0).' },
        verbose: { type: 'boolean', description: 'Include internal fields (revision ids, asset CIDs, classifications) for debugging.' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = (args ?? {}) as {
        turn_back_n?: number
        turn_id?: string
        limit?: number
        offset?: number
        verbose?: boolean
      }
      const verbose = parsed.verbose === true

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found', session_id: ctx.sessionId }

      // Detail mode: turn_id or turn_back_n.
      if (typeof parsed.turn_id === 'string' || typeof parsed.turn_back_n === 'number') {
        if (typeof parsed.turn_id === 'string' && typeof parsed.turn_back_n === 'number') {
          return { error: 'pass either turn_id or turn_back_n, not both' }
        }

        let target: RevisionRow | undefined
        if (typeof parsed.turn_id === 'string') {
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
        if (!verbose) {
          return {
            turn: lean,
            preceding_open_turn_count: preceding.length,
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
        }
      }

      // List mode.
      const limit = Math.min(Math.max(parsed.limit ?? 20, 1), 200)
      const offset = Math.max(parsed.offset ?? 0, 0)

      const rows = deps.db.prepare(`
        SELECT id, stop_reason, sealed_at, created_at
          FROM revisions
         WHERE task_id = ? AND classification = 'closed_forkable'
         ORDER BY sealed_at DESC, id DESC
         LIMIT ? OFFSET ?
      `).all(sess.task_id, limit, offset) as Array<{
        id: string
        stop_reason: string | null
        sealed_at: number | null
        created_at: number
      }>

      const total = (deps.db.prepare(`
        SELECT COUNT(*) AS n FROM revisions
         WHERE task_id = ? AND classification = 'closed_forkable'
      `).get(sess.task_id) as { n: number }).n

      const turns = await Promise.all(rows.map(async (r, idx) => {
        const preview = await turnPreview(deps, r.id)
        const lean = {
          turn_id: r.id,
          n_back: offset + idx + 1,
          preview,
          stop_reason: r.stop_reason,
          sealed_at: r.sealed_at,
        }
        if (!verbose) return lean
        return { ...lean, created_at: r.created_at }
      }))

      return { total, turns }
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
      if (Buffer.byteLength(message, 'utf8') > MAX_REWIND_MESSAGE_BYTES) {
        return { error: `message exceeds ${MAX_REWIND_MESSAGE_BYTES} bytes; trim your prompt` }
      }

      // ── Phase 1 of dual-secret flow: classify the confirm token ───────────
      const confirmValue = typeof parsed.confirm === 'string' ? parsed.confirm : ''
      const matchKind = confirmValue.length > 0
        ? tokenStore.match(ctx.sessionId, confirmValue)
        : null

      if (matchKind === null) {
        // First call (no confirm) OR mismatched/expired/unknown value.
        // Either way: return rules + a fresh token pair. No side effects.
        const tokens = tokenStore.generate(ctx.sessionId)
        return {
          status: 'rules_returned',
          rules: rewindRulesText(tokens),
          confirm_clean: tokens.clean,
          confirm_meta: tokens.meta,
        }
      }

      // Whichever path we take, the original pair is consumed.
      tokenStore.consume(ctx.sessionId)

      if (matchKind === 'meta') {
        // AI self-flagged its own message. Educational response + new pair.
        const newTokens = tokenStore.generate(ctx.sessionId)
        return rewindMetaFlaggedResponse(newTokens)
      }

      // matchKind === 'clean'. Run narrow regex backstop unless allow_meta_refs.
      if (parsed.allow_meta_refs !== true) {
        const matched = detectMetaRef(message)
        if (matched) {
          const newTokens = tokenStore.generate(ctx.sessionId)
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
          // Count what was available for the error message.
          let walked = 0
          let cursor: string | null = head.parent_revision_id
          while (cursor) {
            const r = loadRevision(deps.db, cursor)
            if (!r) break
            if (r.classification === 'closed_forkable') walked++
            cursor = r.parent_revision_id
          }
          return { error: `only ${walked} forkable turns available; cannot go back ${n}` }
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
      return { view_id: viewId, head_revision_id: head.id, label: parsed.label ?? null }
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
