// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unified HTTP server for retcon.
//
// Routes:
//   /v1/*   → transparent proxy to api.anthropic.com (pass-through)
//   /mcp    → MCP Streamable HTTP transport (JSON-RPC POST + SSE GET)
//   /health → JSON liveness + identity check (used by retcon CLI to detect
//             whether port 4099 is occupied by us or by a foreign process)
//   anything else → 404
//
// Both route groups share one `http.createServer`, one SQLite DB, one
// EventProducer, and one SessionQueue in the same process. The per-session
// in-flight queue enforces the G2 session sequencing invariant for /v1/messages.

import fs from 'node:fs'
import http from 'node:http'
import { BranchViewsV1Projector } from './branch-views-v1.js'
import type { DB } from './db.js'
import { createEventProducer, type EventProducer, type Projection } from './events.js'
import { ForkAwaiter } from './fork-awaiter.js'
import { handleMcpRequest, type McpContext, type McpTool } from './mcp-handler.js'
import { ANTHROPIC_UPSTREAM, handleProxyRequest, type ProxyContext } from './proxy-handler.js'
import { DEFAULT_REDACTED_HEADERS } from './redaction.js'
import { RevisionsV1Projector } from './revisions-v1.js'
import { SessionQueue } from './session-queue.js'
import { SessionsV1Projector } from './sessions-v1.js'
import type { TobeStore } from './tobe.js'
import { VERSION } from './version.js'

/**
 * Build the standard set of projectors wired into a v1 producer.
 *
 * Declared dispatch order:
 *   1. sessions_v1     — must run first so a session/task row exists before
 *                        revisions_v1 tries to reference it on FK.
 *   2. revisions_v1    — sets revisions.parent_revision_id on response_completed;
 *                        branch_views_v1 reads that field later in the same tx.
 *   3. branch_views_v1 — advances matching branch_view's head to the newly
 *                        sealed Revision.
 */
export function defaultProjectors(): Projection[] {
  return [new SessionsV1Projector(), new RevisionsV1Projector(), new BranchViewsV1Projector()]
}

/** Convenience: build an EventProducer pre-wired with the v1 projectors. */
export function createDefaultProducer(db: DB): EventProducer {
  return createEventProducer(db, defaultProjectors())
}

export const DEFAULT_PORT = 4099

/** Stable server identity reported on /health. */
export const SERVER_NAME = 'retcon'

export interface HealthSnapshot {
  name: typeof SERVER_NAME
  version: string
  port: number
  pid: number
  started_at: number
  uptime_s: number
  sessions: number
  db_size_bytes: number
}

export interface ServerOptions {
  port?: number
  host?: string
  /** Full override of the upstream target. Defaults to the Anthropic API base. */
  upstream?: string
  /** Required: where events get emitted. */
  producer: EventProducer
  /** Required: file-based TOBE state (per-session). */
  tobeStore: TobeStore
  /** Optional: override the default header redaction list. */
  redactSet?: ReadonlySet<string>
  /**
   * Optional: pre-constructed ForkAwaiter. Provide one if you want to share
   * it with the MCP handler (so fork_back can wait() on outcomes that the
   * /v1/* handler's emitTerminal notifies). Defaults to a fresh instance.
   */
  forkAwaiter?: ForkAwaiter
  /**
   * Optional: map of MCP tool handlers to expose at /mcp. Keyed by tool name
   * (e.g. "fork_list", "fork_back"). Empty map means no tools — initialize +
   * tools/list still work, just with a zero-length tool list.
   */
  mcpTools?: Map<string, McpTool>
  /**
   * Optional: DB handle for /health to count sessions. When omitted (e.g.
   * unit tests that don't care about /health detail), sessions reads as 0.
   */
  db?: DB
  /**
   * Optional: SQLite file path for /health to report db_size_bytes. When
   * omitted, db_size_bytes reads as 0.
   */
  dbPath?: string
}

export interface ServerHandle {
  readonly port: number
  readonly forkAwaiter: ForkAwaiter
  /** Graceful close: closes idle keep-alive connections, then waits for in-flight requests. */
  close(): Promise<void>
  /** Forcible close: drops all open keep-alive connections (e.g. MCP SSE channels) so close() can complete. */
  closeAllConnections(): void
}

export function startServer(options: ServerOptions): Promise<ServerHandle> {
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? '127.0.0.1'
  const sessionQueue = new SessionQueue()
  const forkAwaiter = options.forkAwaiter ?? new ForkAwaiter()
  const proxyCtx: ProxyContext = {
    producer: options.producer,
    sessionQueue,
    tobeStore: options.tobeStore,
    redactSet: options.redactSet ?? DEFAULT_REDACTED_HEADERS,
    upstream: options.upstream ?? ANTHROPIC_UPSTREAM,
    forkAwaiter,
  }
  const mcpCtx: McpContext = {
    producer: options.producer,
    tools: options.mcpTools ?? new Map(),
    sessionQueue,  // shared with the /v1/* proxy so tools/call serializes with /v1/messages
  }

  const startedAt = Date.now()
  let resolvedPort = port

  function buildHealth(): HealthSnapshot {
    let sessions = 0
    if (options.db) {
      try {
        sessions = (options.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
      }
      catch { /* DB closed or migration mid-flight: report 0 */ }
    }
    let dbSize = 0
    if (options.dbPath) {
      try { dbSize = fs.statSync(options.dbPath).size }
      catch { /* file may not exist yet on first boot */ }
    }
    return {
      name: SERVER_NAME,
      version: VERSION,
      port: resolvedPort,
      pid: process.pid,
      started_at: startedAt,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      sessions,
      db_size_bytes: dbSize,
    }
  }

  const server = http.createServer((req, res) => {
    const path = req.url ?? ''

    if (path === '/health' || path === '/healthz') {
      const body = JSON.stringify(buildHealth())
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body + '\n')
      return
    }

    if (path === '/mcp' || path.startsWith('/mcp?') || path.startsWith('/mcp/')) {
      void handleMcpRequest(req, res, mcpCtx)
      return
    }

    if (path.startsWith('/v1/')) {
      void handleProxyRequest(req, res, proxyCtx)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found\n')
  })

  return new Promise<ServerHandle>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      resolvedPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        port: resolvedPort,
        forkAwaiter,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close(err => (err ? fail(err) : done()))
          }),
        closeAllConnections: () => {
          // Node 18.2+: forcibly drop persistent connections (MCP SSE, HTTP
          // keep-alive) so close()'s drain promise can resolve. Without this,
          // a held-open SSE channel keeps the daemon alive past SIGTERM.
          server.closeAllConnections()
        },
      })
    })
  })
}
