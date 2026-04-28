// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// MCP Streamable HTTP transport handler for the `/mcp` route.
//
// Per the MCP spec (2025-03-26):
//   - POST /mcp    → JSON-RPC request; server responds JSON-RPC (or SSE stream)
//   - GET  /mcp    → opens an SSE stream for server→client messages (unused by v1)
//   - DELETE /mcp  → explicit session termination
//
// Session identity:
//   - On `initialize`, server MINTS a session id (TraceId) and returns it
//     via the `Mcp-Session-Id` response header. Emits `mcp.session_initialized`.
//   - Client echoes `Mcp-Session-Id` on every subsequent request.
//   - On `notifications/cancelled` we just acknowledge. On DELETE we emit
//     `mcp.session_closed`.
//
// Tool handlers live in `mcp-tools.ts` (C8). This file wires the JSON-RPC
// dispatch, session lifecycle events, and a placeholder `tools/list`.

import http from 'node:http'
import { generateTraceId } from '@playtiss/core'
import type { EventProducer } from './events.js'
import type { SessionQueue } from './session-queue.js'
import { VERSION } from './version.js'

export const MCP_SESSION_HEADER = 'mcp-session-id'

export const PROTOCOL_VERSION = '2025-03-26'

/**
 * Cap on POST body size. MCP requests are small JSON-RPC envelopes; anything
 * larger is either abuse or a client bug. 1 MiB leaves plenty of headroom for
 * tools/call with reasonable argument sizes.
 */
export const MCP_MAX_BODY_BYTES = 1024 * 1024

export interface McpContext {
  readonly producer: EventProducer
  /** Tool handlers keyed by name (with MCP-spec metadata). Wired in C8. */
  readonly tools: Map<string, McpTool>
  /**
   * Session queue shared with the /v1/* handler. `tools/call` invocations
   * run through this queue so fork_back's guard reads + TOBE write + event
   * emit are serialized with any concurrent /v1/messages for the same session
   * (TOC/TOU defense per A-WR1).
   */
  readonly sessionQueue?: SessionQueue
}

export type McpToolHandler = (
  args: unknown,
  ctx: { sessionId: string, producer: EventProducer },
) => Promise<unknown>

/**
 * MCP-spec-compliant tool advertisement. `tools/list` returns one entry per
 * registered tool with name + description + JSON-Schema for arguments. The
 * inputSchema is REQUIRED by the spec — without it, Claude Code accepts the
 * MCP server connection but silently refuses to expose the tool to the LLM.
 */
export interface McpTool {
  description: string
  /** JSON Schema describing the `arguments` payload accepted by `tools/call`. */
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: readonly string[]
    additionalProperties?: boolean
  }
  handler: McpToolHandler
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number, message: string, data?: unknown }
}

// JSON-RPC error codes per spec.
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

/**
 * Handle a single HTTP request on the /mcp path. Dispatches by method and
 * writes the JSON-RPC response to `res` with the appropriate
 * Mcp-Session-Id header.
 */
export async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: McpContext,
): Promise<void> {
  if (req.method === 'DELETE') {
    return handleMcpDelete(req, res, ctx)
  }
  if (req.method === 'GET') {
    // Streamable HTTP transport allows GET to open an SSE stream for
    // server→client messages. v1 of retcon has no server-initiated
    // messages; acknowledge with 200 + empty SSE stream that stays open
    // until the client disconnects, so MCP clients that open this channel
    // don't see an error.
    return handleMcpGet(req, res)
  }
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res)
    return
  }

  let raw: Buffer
  try {
    raw = await readRequestBody(req)
  }
  catch (err) {
    // Body read failed (oversize, network drop). Can't send a proper JSON-RPC
    // reply on some error paths; best-effort 413 if headers not yet sent.
    if (!res.headersSent) {
      res.writeHead(413, { 'content-type': 'text/plain' })
      res.end((err as Error).message + '\n')
    }
    return
  }
  let parsed: JsonRpcRequest
  try {
    parsed = JSON.parse(raw.toString('utf8')) as JsonRpcRequest
  }
  catch {
    sendJsonRpcError(res, null, PARSE_ERROR, 'invalid JSON')
    return
  }

  if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    sendJsonRpcError(res, parsed.id ?? null, INVALID_REQUEST, 'malformed JSON-RPC request')
    return
  }

  const clientSessionId = extractSessionId(req)

  try {
    switch (parsed.method) {
      case 'initialize':
        await handleInitialize(parsed, req, res, ctx)
        return
      case 'initialized':
      case 'notifications/initialized':
        // Notification — no response body. Spec says initialize handshake
        // finishes here; acknowledge with 202.
        res.writeHead(202)
        res.end()
        return
      case 'tools/list':
        sendJsonRpcResult(res, parsed.id ?? null, clientSessionId, {
          tools: listTools(ctx),
        })
        return
      case 'tools/call':
        await handleToolsCall(parsed, res, clientSessionId, ctx)
        return
      case 'ping':
        sendJsonRpcResult(res, parsed.id ?? null, clientSessionId, {})
        return
      default:
        sendJsonRpcError(res, parsed.id ?? null, METHOD_NOT_FOUND, `unknown method: ${parsed.method}`)
    }
  }
  catch (err) {
    const message = (err as Error).message ?? String(err)
    sendJsonRpcError(res, parsed.id ?? null, INTERNAL_ERROR, `handler error: ${message}`)
  }
}

function listTools(ctx: McpContext): Array<{ name: string, description: string, inputSchema: McpTool['inputSchema'] }> {
  const out: Array<{ name: string, description: string, inputSchema: McpTool['inputSchema'] }> = []
  for (const [name, tool] of ctx.tools) {
    out.push({ name, description: tool.description, inputSchema: tool.inputSchema })
  }
  return out
}

async function handleInitialize(
  req: JsonRpcRequest,
  httpReq: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: McpContext,
): Promise<void> {
  // Idempotent initialize: if the client echoed an existing Mcp-Session-Id
  // (e.g. reconnect after a transient network blip), reuse that id rather
  // than minting a fresh session. Prevents duplicate sessions rows and
  // follows MCP spec intent — initialize is part of session setup, not
  // session creation per call.
  //
  // Note: we don't read the sessions table here because sessions_v1 runs in
  // the same projector chain as the producer we're emitting on, and cross-
  // transaction consistency would require a separate query. Instead we re-
  // emit on the existing id; projector INSERT OR IGNORE + ON CONFLICT keeps
  // the row stable.
  const existing = extractSessionId(httpReq)
  const sessionId = existing && existing.length > 0 ? existing : generateTraceId()

  const params = (req.params ?? {}) as {
    clientInfo?: { name?: string, version?: string }
  }
  const harness = params.clientInfo?.name ?? 'unknown'

  ctx.producer.emit(
    'mcp.session_initialized',
    {
      mcp_session_id: sessionId,
      pid: process.pid,
      harness,
    },
    sessionId,
  )

  sendJsonRpcResult(res, req.id ?? null, sessionId, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: 'retcon',
      version: VERSION,
    },
  })
}

async function handleToolsCall(
  req: JsonRpcRequest,
  res: http.ServerResponse,
  sessionId: string | undefined,
  ctx: McpContext,
): Promise<void> {
  if (!sessionId) {
    sendJsonRpcError(res, req.id ?? null, INVALID_REQUEST, 'missing Mcp-Session-Id header')
    return
  }
  const params = req.params as { name?: string, arguments?: unknown } | undefined
  const toolName = params?.name
  if (typeof toolName !== 'string') {
    sendJsonRpcError(res, req.id ?? null, INVALID_REQUEST, 'tools/call missing `name`')
    return
  }
  const tool = ctx.tools.get(toolName)
  if (!tool) {
    sendJsonRpcError(res, req.id ?? null, METHOD_NOT_FOUND, `unknown tool: ${toolName}`)
    return
  }
  // Route tool invocation through the shared session queue if provided.
  // This closes a TOC/TOU window in fork_back: the handler's guard read +
  // TOBE write + event emit are atomic with respect to any concurrent
  // /v1/messages the proxy is processing for the same session.
  const invoke = (): Promise<unknown> => tool.handler(params?.arguments ?? {}, {
    sessionId,
    producer: ctx.producer,
  })
  const result = ctx.sessionQueue
    ? await ctx.sessionQueue.run(sessionId, invoke)
    : await invoke()
  sendJsonRpcResult(res, req.id ?? null, sessionId, {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  })
}

async function handleMcpDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: McpContext,
): Promise<void> {
  const sessionId = extractSessionId(req)
  if (sessionId) {
    ctx.producer.emit('mcp.session_closed', {}, sessionId)
  }
  res.writeHead(204)
  res.end()
}

function handleMcpGet(_req: http.IncomingMessage, res: http.ServerResponse): void {
  // Hold the SSE channel open but send no events. Keeps MCP clients that
  // optionally open this stream happy without introducing streaming state.
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })
  res.write(': retcon mcp sse\n\n')
  // Don't call res.end() — leave it open. It'll close when the client disconnects.
}

function extractSessionId(req: http.IncomingMessage): string | undefined {
  // Mcp-Session-Id may arrive duplicated when multiple sources set it on the
  // same request — for example, Claude Code's --mcp-config "headers" injects
  // it AND the MCP transport's own session-id-echo logic also sets it. Node's
  // http parser concatenates duplicate header values into a single comma-
  // separated string ("id, id, id"). Take the first value; legitimate uses
  // always set the same id, so any of them is correct.
  const raw = req.headers[MCP_SESSION_HEADER]
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const first = raw.split(',')[0].trim()
  return first.length > 0 ? first : undefined
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let overflowed = false
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > MCP_MAX_BODY_BYTES) {
        overflowed = true
        // Keep draining to a no-op so the client finishes cleanly and the
        // 413 response actually reaches it. Destroying the request aborts
        // the TCP socket and the client surfaces a generic network error
        // instead of the 413 status.
        return
      }
      if (!overflowed) chunks.push(c)
    })
    req.on('end', () => {
      if (overflowed) {
        reject(new Error(`request body exceeds ${MCP_MAX_BODY_BYTES} bytes`))
      }
      else {
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', reject)
  })
}

function sendJsonRpcResult(
  res: http.ServerResponse,
  id: string | number | null,
  sessionId: string | undefined,
  result: unknown,
): void {
  const response: JsonRpcResponse = { jsonrpc: '2.0', id, result }
  sendJson(res, 200, response, sessionId)
}

function sendJsonRpcError(
  res: http.ServerResponse,
  id: string | number | null,
  code: number,
  message: string,
): void {
  const response: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }
  sendJson(res, 200, response, undefined)
}

function sendMethodNotAllowed(res: http.ServerResponse): void {
  res.writeHead(405, { 'content-type': 'text/plain', 'allow': 'POST, GET, DELETE' })
  res.end('method not allowed\n')
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  sessionId: string | undefined,
): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sessionId) headers[MCP_SESSION_HEADER] = sessionId
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}
