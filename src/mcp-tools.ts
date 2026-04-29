// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Fork MCP tool handlers — fork_list, fork_show, fork_bookmark, fork_back.
//
// These tools are wired into the /mcp JSON-RPC dispatcher via the `mcpTools`
// option on startServer(). Each handler receives the session id (from the
// Mcp-Session-Id header that the MCP handler extracts) and the producer,
// and operates on the proxy's own SQLite DB.
//
// fork_back's F4 guard: reject when the current head Revision is `open`
// (mid-tool-use) or `in_flight`. A fork from that state would inject a
// fresh user message where Anthropic expects a tool_result.
//
// fork_bookmark's G10 guard: reject when no closed_forkable Revision exists
// yet for this session.

import { generateTraceId } from '@playtiss/core'

import { blobRefFromBytes } from './body-blob.js'
import type { DB } from './db.js'
import { lastForkOutcome } from './fork-awaiter.js'
import type { McpTool } from './mcp-handler.js'
import type { TobeStore } from './tobe.js'

/**
 * Safety cap on fork_back's user message. Anything larger hints at abuse;
 * legit prompts stay well under this. Also applies to the whole serialized
 * inputs object (n + message).
 */
export const MAX_FORK_BACK_MESSAGE_BYTES = 1024 * 1024 // 1 MiB

/**
 * Safety cap on fork_show walk-back depth. Prevents unbounded CPU from a
 * cyclic parent chain (corrupted projection) or pathologically deep session.
 */
export const FORK_SHOW_MAX_DEPTH = 1000

interface ForkToolDeps {
  db: DB
  tobeStore: TobeStore
  /** When false, fork_back returns an error + emits fork.back_disabled_rejected. */
  forkBackEnabled?: boolean
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

function loadBlob(db: DB, cid: string): Uint8Array | undefined {
  const row = db.prepare('SELECT bytes FROM blobs WHERE cid = ?').get(cid) as
    | { bytes: Uint8Array } | undefined
  return row?.bytes
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

export function createForkTools(deps: ForkToolDeps): Map<string, McpTool> {
  const tools = new Map<string, McpTool>()

  // ── fork_list ─────────────────────────────────────────────────────────────
  tools.set('fork_list', {
    description:
      'List recent forkable Revisions in this session. A Revision is one /v1/messages turn; '
      + 'a "forkable" Revision is one that closed cleanly (end_turn / stop_sequence) and can be '
      + 'used as a fork_back target.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max revisions to return (1-200, default 20).' },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = args as { limit?: number, offset?: number } | undefined
      const limit = Math.min(Math.max(parsed?.limit ?? 20, 1), 200)
      const offset = Math.max(parsed?.offset ?? 0, 0)

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found', session_id: ctx.sessionId }

      const rows = deps.db.prepare(`
      SELECT id, stop_reason, sealed_at, created_at
        FROM revisions
       WHERE task_id = ? AND classification = 'closed_forkable'
       ORDER BY sealed_at DESC
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

      return {
        total,
        revisions: rows.map(r => ({
          revision_id: r.id,
          sealed_at: r.sealed_at,
          stop_reason: r.stop_reason,
        })),
      }
    },
  })

  // ── fork_show ─────────────────────────────────────────────────────────────
  tools.set('fork_show', {
    description:
      'Show details of a single Revision by id, including the chain of preceding open Revisions '
      + '(tool_use / pause_turn turns) leading up to it.',
    inputSchema: {
      type: 'object',
      properties: {
        revision_id: { type: 'string', description: 'Revision id (TraceId) returned by fork_list.' },
      },
      required: ['revision_id'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = args as { revision_id?: string } | undefined
      if (!parsed?.revision_id) return { error: 'revision_id is required' }

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }

      const rev = loadRevision(deps.db, parsed.revision_id)
      if (!rev || rev.task_id !== sess.task_id) {
        return { error: 'revision not found in this session' }
      }

      // Walk backward to find the chain of open Revisions preceding this one,
      // up to (but not including) the previous closed_forkable. Capped in depth
      // and by visited-set to survive corrupt or cyclic parent chains.
      const preceding: string[] = []
      const visited = new Set<string>([rev.id])
      let cursor: string | null = rev.parent_revision_id
      for (let i = 0; cursor && i < FORK_SHOW_MAX_DEPTH; i++) {
        if (visited.has(cursor)) break // cycle — stop
        visited.add(cursor)
        const parent = loadRevision(deps.db, cursor)
        if (!parent || parent.classification === 'closed_forkable') break
        preceding.push(parent.id)
        cursor = parent.parent_revision_id
      }

      return {
        revision: {
          id: rev.id,
          classification: rev.classification,
          stop_reason: rev.stop_reason,
          parent_revision_id: rev.parent_revision_id,
          asset_cid: rev.asset_cid,
          sealed_at: rev.sealed_at,
          created_at: rev.created_at,
        },
        preceding_open_revisions: preceding,
      }
    },
  })

  // ── fork_bookmark ─────────────────────────────────────────────────────────
  tools.set('fork_bookmark', {
    description:
      'Bookmark the most recent forkable Revision in this session with an optional human label, '
      + 'so you can return to it later via fork_back.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable label for the bookmark.' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = args as { label?: string } | undefined

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }

      // G10: reject if no closed_forkable exists yet.
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
          label: parsed?.label ?? null,
          auto_label: `bookmark@${new Date().toISOString()}`,
        },
        ctx.sessionId,
      )
      return { view_id: viewId, head_revision_id: head.id, label: parsed?.label ?? null }
    },
  })

  // ── fork_back ─────────────────────────────────────────────────────────────
  tools.set('fork_back', {
    description:
      'Walk back N forkable Revisions and replace the current turn with a new user message. '
      + 'The next /v1/messages call from the same session will have its messages[] rewritten so '
      + 'the conversation continues from the chosen fork point with your new message — letting '
      + 'you "edit the past turn and replay forward."',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'How many forkable turns back to go (≥1).' },
        message: { type: 'string', description: 'New user message to inject at the fork point.' },
      },
      required: ['n', 'message'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const parsed = args as { n?: number, message?: string } | undefined
      const n = typeof parsed?.n === 'number' ? Math.floor(parsed.n) : NaN
      const message = typeof parsed?.message === 'string' ? parsed.message : null
      if (!Number.isInteger(n) || n < 1) return { error: '`n` must be an integer ≥ 1' }
      if (!message) return { error: '`message` is required' }
      if (Buffer.byteLength(message, 'utf8') > MAX_FORK_BACK_MESSAGE_BYTES) {
        return { error: `message exceeds ${MAX_FORK_BACK_MESSAGE_BYTES} bytes; trim your prompt` }
      }

      // F7 feature gate.
      if (deps.forkBackEnabled === false) {
        const bodyBytes = Buffer.from(JSON.stringify({ n, message }), 'utf8')
        const inputsBlob = await blobRefFromBytes(bodyBytes)
        ctx.producer.emit(
          'fork.back_disabled_rejected',
          { inputs_cid: inputsBlob.cid },
          ctx.sessionId,
          [inputsBlob.ref],
        )
        return {
          error: 'fork_back disabled; proxy running in recording-only mode. Set PLAYTISS_PROXY_FORK_BACK_ENABLED=1 to enable.',
        }
      }

      const sess = loadSession(deps.db, ctx.sessionId)
      if (!sess) return { error: 'session not found' }
      if (sess.harness === 'orphan') {
        return { error: 'fork_back requires an MCP-initialized session (orphan sessions cannot fork)' }
      }

      // F4: reject if the current head is open (mid-tool-use) or in_flight.
      const currentHead = mostRecentRevision(deps.db, sess.task_id)
      if (!currentHead) {
        return { error: 'no turns yet — nothing to fork from' }
      }
      if (currentHead.classification === 'open' || currentHead.classification === 'in_flight') {
        return {
          error: `cannot fork while current turn is ${currentHead.classification}; wait for it to close`,
          current_classification: currentHead.classification,
        }
      }

      // Walk back `n` closed_forkable Revisions. We always start walking from
      // the current head's parent (the current head itself is "where we are";
      // n=1 means go to the nearest parent forkable, n=2 means two back, etc).
      let target: RevisionRow | undefined
      let walked = 0
      let cursor: string | null = currentHead.parent_revision_id
      while (walked < n) {
        if (!cursor) break
        const rev: RevisionRow | undefined = loadRevision(deps.db, cursor)
        if (!rev) break
        if (rev.classification === 'closed_forkable') {
          target = rev
          walked++
          if (walked >= n) break
        }
        cursor = rev.parent_revision_id
      }
      if (!target || walked < n) {
        return {
          error: `only ${walked} forkable turns available; cannot go back ${n}`,
        }
      }

      // Reconstruct messages[] at the fork point. Prefer a child's request
      // body (which already includes target's assistant response); fall back
      // to the target's own request body if no child exists OR the child's
      // body is malformed. This maximises the chance of a successful fork
      // reconstruction on imperfect data.
      const baseMessages = reconstructForkMessages(deps.db, target)
      if (!baseMessages) {
        return { error: 'unable to reconstruct messages[] for fork_point (no usable source blob)' }
      }
      baseMessages.push({ role: 'user', content: message })

      // Compute a real CID for the new message so downstream consumers can
      // resolve new_message_cid via the blobs table.
      const newMessageBlob = await blobRefFromBytes(
        Buffer.from(JSON.stringify({ role: 'user', content: message }), 'utf8'),
      )

      // Report the prior fork's outcome (A-R8 "return outcome on next call"):
      // if the previous TOBE-applied request ended in failure, the LLM sees
      // that in this call's result along with the new fork scheduling.
      const prior = lastForkOutcome(deps.db, ctx.sessionId)

      const targetViewId = generateTraceId()
      deps.tobeStore.write(ctx.sessionId, {
        messages: baseMessages,
        fork_point_revision_id: target.id,
        source_view_id: ctx.sessionId, // placeholder until explicit source view passed in
      })

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

      return {
        status: 'scheduled',
        fork_point: target.id,
        target_view_id: targetViewId,
        pending_path: deps.tobeStore.fileFor(ctx.sessionId),
        prior_outcome: prior,
      }
    },
  })

  return tools
}

/**
 * Reconstruct the messages[] array at a fork point. Tries the earliest
 * child's request body first (contains target's assistant response); if that
 * fails (no child / missing blob / malformed JSON), falls back to the
 * target's OWN request body (won't include target's assistant response but
 * is a valid conversation prefix).
 *
 * Returns null only if NEITHER source yields a valid messages array.
 */
function reconstructForkMessages(db: DB, target: RevisionRow): unknown[] | null {
  const attempts: string[] = []
  const child = firstChild(db, target.id)
  if (child) {
    const childCid = requestBodyCidFor(db, child.id)
    if (childCid) attempts.push(childCid)
  }
  const targetCid = requestBodyCidFor(db, target.id)
  if (targetCid) attempts.push(targetCid)

  for (const cid of attempts) {
    const bytes = loadBlob(db, cid)
    if (!bytes) continue
    try {
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as { messages?: unknown[] }
      if (Array.isArray(parsed.messages)) return [...parsed.messages]
    }
    catch { /* try next */ }
  }
  return null
}
