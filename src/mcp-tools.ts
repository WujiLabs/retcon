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
// fork_back's F4 guard: reject when the current head Version is `open`
// (mid-tool-use) or `in_flight`. A fork from that state would inject a
// fresh user message where Anthropic expects a tool_result.
//
// fork_bookmark's G10 guard: reject when no closed_forkable Version exists
// yet for this session.

import { generateTraceId } from '@playtiss/core'
import type { DB } from './db.js'
import type { EventProducer } from './events.js'
import { lastForkOutcome } from './fork-awaiter.js'
import type { McpToolHandler } from './mcp-handler.js'
import type { TobeStore } from './tobe.js'

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

interface VersionRow {
  id: string
  task_id: string
  asset_cid: string | null
  parent_version_id: string | null
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

function loadVersion(db: DB, versionId: string): VersionRow | undefined {
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId) as VersionRow | undefined
}

function mostRecentVersion(db: DB, taskId: string): VersionRow | undefined {
  // id DESC breaks ties when multiple Versions land in the same millisecond.
  // Event ids are monotonic within a producer (TraceIdGenerator sequence),
  // so id DESC is the correct stable order.
  return db.prepare(
    'SELECT * FROM versions WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
  ).get(taskId) as VersionRow | undefined
}

function mostRecentForkableVersion(db: DB, taskId: string): VersionRow | undefined {
  return db.prepare(`
    SELECT * FROM versions
     WHERE task_id = ? AND classification = 'closed_forkable' AND sealed_at IS NOT NULL
     ORDER BY sealed_at DESC, id DESC LIMIT 1
  `).get(taskId) as VersionRow | undefined
}

function loadBlob(db: DB, cid: string): Uint8Array | undefined {
  const row = db.prepare('SELECT bytes FROM blobs WHERE cid = ?').get(cid) as
    | { bytes: Uint8Array } | undefined
  return row?.bytes
}

/**
 * Look up the request_received event for a given version id and return its
 * request body CID. Versions table doesn't carry this directly (the Version's
 * asset_cid points at the {request_body_cid, response_body_cid} DictAsset);
 * rather than parsing the asset, we query the events table by the version id.
 */
function requestBodyCidFor(db: DB, versionId: string): string | null {
  const row = db.prepare(`
    SELECT payload FROM events WHERE event_id = ? AND topic = 'proxy.request_received'
  `).get(versionId) as { payload: string } | undefined
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
 * Find ANY child of a Version. Fork-point reconstruction needs the child's
 * request body to recover the messages[] prefix at the fork point.
 */
function firstChild(db: DB, parentVersionId: string): VersionRow | undefined {
  return db.prepare(`
    SELECT * FROM versions WHERE parent_version_id = ? LIMIT 1
  `).get(parentVersionId) as VersionRow | undefined
}

export function createForkTools(deps: ForkToolDeps): Map<string, McpToolHandler> {
  const tools = new Map<string, McpToolHandler>()

  // ── fork_list ─────────────────────────────────────────────────────────────
  tools.set('fork_list', async (args, ctx) => {
    const parsed = args as { limit?: number, offset?: number } | undefined
    const limit = Math.min(Math.max(parsed?.limit ?? 20, 1), 200)
    const offset = Math.max(parsed?.offset ?? 0, 0)

    const sess = loadSession(deps.db, ctx.sessionId)
    if (!sess) return { error: 'session not found', session_id: ctx.sessionId }

    const rows = deps.db.prepare(`
      SELECT id, stop_reason, sealed_at, created_at
        FROM versions
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
      SELECT COUNT(*) AS n FROM versions
       WHERE task_id = ? AND classification = 'closed_forkable'
    `).get(sess.task_id) as { n: number }).n

    return {
      total,
      versions: rows.map(r => ({
        version_id: r.id,
        sealed_at: r.sealed_at,
        stop_reason: r.stop_reason,
      })),
    }
  })

  // ── fork_show ─────────────────────────────────────────────────────────────
  tools.set('fork_show', async (args, ctx) => {
    const parsed = args as { version_id?: string } | undefined
    if (!parsed?.version_id) return { error: 'version_id is required' }

    const sess = loadSession(deps.db, ctx.sessionId)
    if (!sess) return { error: 'session not found' }

    const ver = loadVersion(deps.db, parsed.version_id)
    if (!ver || ver.task_id !== sess.task_id) {
      return { error: 'version not found in this session' }
    }

    // Walk backward to find the chain of open Versions preceding this one,
    // up to (but not including) the previous closed_forkable. Gives the caller
    // a view of the tool-use chain that produced this turn.
    const preceding: string[] = []
    let cursor: string | null = ver.parent_version_id
    while (cursor) {
      const parent = loadVersion(deps.db, cursor)
      if (!parent || parent.classification === 'closed_forkable') break
      preceding.push(parent.id)
      cursor = parent.parent_version_id
    }

    return {
      version: {
        id: ver.id,
        classification: ver.classification,
        stop_reason: ver.stop_reason,
        parent_version_id: ver.parent_version_id,
        asset_cid: ver.asset_cid,
        sealed_at: ver.sealed_at,
        created_at: ver.created_at,
      },
      preceding_open_versions: preceding,
    }
  })

  // ── fork_bookmark ─────────────────────────────────────────────────────────
  tools.set('fork_bookmark', async (args, ctx) => {
    const parsed = args as { label?: string } | undefined

    const sess = loadSession(deps.db, ctx.sessionId)
    if (!sess) return { error: 'session not found' }

    // G10: reject if no closed_forkable exists yet.
    const head = mostRecentForkableVersion(deps.db, sess.task_id)
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
        head_version_id: head.id,
        label: parsed?.label ?? null,
        auto_label: `bookmark@${new Date().toISOString()}`,
      },
      ctx.sessionId,
    )
    return { view_id: viewId, head_version_id: head.id, label: parsed?.label ?? null }
  })

  // ── fork_back ─────────────────────────────────────────────────────────────
  tools.set('fork_back', async (args, ctx) => {
    const parsed = args as { n?: number, message?: string } | undefined
    const n = typeof parsed?.n === 'number' ? Math.floor(parsed.n) : NaN
    const message = typeof parsed?.message === 'string' ? parsed.message : null
    if (!Number.isInteger(n) || n < 1) return { error: '`n` must be an integer ≥ 1' }
    if (!message) return { error: '`message` is required' }

    // F7 feature gate.
    if (deps.forkBackEnabled === false) {
      const bodyBytes = new TextEncoder().encode(JSON.stringify({ n, message }))
      ctx.producer.emit(
        'fork.back_disabled_rejected',
        { inputs_cid: 'inline' },
        ctx.sessionId,
        [{ cid: `bafy-inputs-${ctx.sessionId}-${Date.now()}`, bytes: bodyBytes }],
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
    const currentHead = mostRecentVersion(deps.db, sess.task_id)
    if (!currentHead) {
      return { error: 'no turns yet — nothing to fork from' }
    }
    if (currentHead.classification === 'open' || currentHead.classification === 'in_flight') {
      return {
        error: `cannot fork while current turn is ${currentHead.classification}; wait for it to close`,
        current_classification: currentHead.classification,
      }
    }

    // Walk back `n` closed_forkable Versions. We always start walking from
    // the current head's parent (the current head itself is "where we are";
    // n=1 means go to the nearest parent forkable, n=2 means two back, etc).
    let target: VersionRow | undefined
    let walked = 0
    let cursor: string | null = currentHead.parent_version_id
    while (walked < n) {
      if (!cursor) break
      const ver: VersionRow | undefined = loadVersion(deps.db, cursor)
      if (!ver) break
      if (ver.classification === 'closed_forkable') {
        target = ver
        walked++
        if (walked >= n) break
      }
      cursor = ver.parent_version_id
    }
    if (!target || walked < n) {
      return {
        error: `only ${walked} forkable turns available; cannot go back ${n}`,
      }
    }

    // Reconstruct messages[] at the fork point. Prefer a child's request
    // body (which already includes target's assistant response); fall back
    // to the target's own request body if no child exists yet.
    const child = firstChild(deps.db, target.id)
    let baseMessages: unknown[]
    const sourceCid = child ? requestBodyCidFor(deps.db, child.id) : requestBodyCidFor(deps.db, target.id)
    if (!sourceCid) {
      return { error: 'unable to locate request body blob for fork reconstruction' }
    }
    const bytes = loadBlob(deps.db, sourceCid)
    if (!bytes) return { error: 'fork source blob missing from store' }
    try {
      const parsedBody = JSON.parse(Buffer.from(bytes).toString('utf8')) as { messages?: unknown[] }
      baseMessages = Array.isArray(parsedBody.messages) ? [...parsedBody.messages] : []
    }
    catch {
      return { error: 'fork source blob is not valid JSON' }
    }
    baseMessages.push({ role: 'user', content: message })

    // Report the prior fork's outcome (A-R8 "return outcome on next call"):
    // if the previous TOBE-applied request ended in failure, the LLM sees
    // that in this call's result along with the new fork scheduling.
    const prior = lastForkOutcome(deps.db, ctx.sessionId)

    const targetViewId = generateTraceId()
    const forkBackEventId = generateTraceId()
    deps.tobeStore.write(ctx.sessionId, {
      messages: baseMessages,
      fork_point_version_id: target.id,
      source_view_id: ctx.sessionId,  // placeholder until explicit source view passed in
      fork_back_event_id: forkBackEventId,
    })

    ctx.producer.emit(
      'fork.back_requested',
      {
        source_view_id: ctx.sessionId,
        fork_point_version_id: target.id,
        new_message_cid: 'inline',
        target_view_id: targetViewId,
        task_id: sess.task_id,
      },
      ctx.sessionId,
    )

    return {
      status: 'scheduled',
      fork_point: target.id,
      target_view_id: targetViewId,
      pending_path: deps.tobeStore.fileFor(ctx.sessionId),
      prior_outcome: prior,
    }
  })

  return tools
}
