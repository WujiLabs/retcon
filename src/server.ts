// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unified HTTP server for playtiss-proxy.
//
// Routes:
//   /v1/*   → transparent proxy to api.anthropic.com (pass-through)
//   /mcp    → MCP Streamable HTTP transport (JSON-RPC POST + SSE GET)
//   /health → liveness check
//   anything else → 404
//
// Both route groups share one `http.createServer`, one SQLite DB, one
// EventProducer, and one SessionQueue in the same process. The per-session
// in-flight queue enforces the G2 session sequencing invariant for /v1/messages.
//
// Sub-handlers are wired here as stubs and filled in by later commits (HTTP
// pass-through in C4, MCP route in week-2 commits).

import http from 'node:http'
import type { EventProducer } from './events.js'
import { ForkAwaiter } from './fork-awaiter.js'
import { ANTHROPIC_UPSTREAM, handleProxyRequest, type ProxyContext } from './proxy-handler.js'
import { DEFAULT_REDACTED_HEADERS } from './redaction.js'
import { SessionQueue } from './session-queue.js'
import type { TobeStore } from './tobe.js'

export const DEFAULT_PORT = 4099

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
}

export interface ServerHandle {
  readonly port: number
  readonly forkAwaiter: ForkAwaiter
  close(): Promise<void>
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

  const server = http.createServer((req, res) => {
    const path = req.url ?? ''

    if (path === '/health' || path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok\n')
      return
    }

    if (path === '/mcp' || path.startsWith('/mcp?') || path.startsWith('/mcp/')) {
      handleMcpStub(req, res)
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
      const resolvedPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        port: resolvedPort,
        forkAwaiter,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close(err => (err ? fail(err) : done()))
          }),
      })
    })
  })
}

/**
 * STUB: MCP Streamable HTTP. Week-2 commits implement the real JSON-RPC
 * handler and SSE stream endpoint.
 */
function handleMcpStub(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(501, { 'content-type': 'text/plain' })
  res.end('MCP not yet implemented (week-2)\n')
}
