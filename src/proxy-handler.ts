// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// HTTP pass-through handler for /v1/*.
//
// Behavior:
//   - Buffers the incoming request body fully (needed for TOBE swap + body_cid).
//   - Consumes a per-session TOBE pending file if present and rewrites the body's
//     `messages` array. Carries fork metadata into `proxy.request_received.payload.tobe_applied_from`.
//   - Forwards hop-by-hop-filtered headers to the upstream target.
//   - Streams upstream response bytes DIRECTLY to the client as they arrive
//     (the SSE parser taps chunks passively; it NEVER interposes).
//   - On response end: computes response_body_cid, emits proxy.response_completed
//     with raw stop_reason (classification is the projector's job).
//   - On error: emits proxy.upstream_error; on client-side abort: proxy.response_aborted.
//
// Header redaction runs before computing headers_cid — plaintext API keys
// never land in blobs (G3).

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import zlib from 'node:zlib'
import { blobRefFromBytes } from './body-blob.js'
import type { EventProducer } from './events.js'
import { redactHeaders } from './redaction.js'
import type { SessionQueue } from './session-queue.js'
import { extractStopReasonFromJsonBody, SseStopReasonParser } from './sse-parser.js'
import type { TobePending, TobeStore } from './tobe.js'

export const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com'
export const SESSION_HEADER = 'x-playtiss-session'

// Hop-by-hop headers per RFC 7230 plus ones Node's fetch would have set itself.
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',   // recomputed after potential TOBE swap
  'transfer-encoding',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
])

export interface ProxyContext {
  readonly producer: EventProducer
  readonly sessionQueue: SessionQueue
  readonly tobeStore: TobeStore
  readonly redactSet: ReadonlySet<string>
  readonly upstream: string
}

/**
 * Resolve a session id for this request. Prefer the x-playtiss-session header
 * injected by the /fork skill; fall back to a per-connection id so every
 * request lands in SOME session (orphan mode).
 */
export function resolveSessionId(req: http.IncomingMessage): string {
  const raw = req.headers[SESSION_HEADER]
  if (typeof raw === 'string' && raw.length > 0) return raw
  const sock = req.socket
  return `orphan-${sock.remoteAddress ?? 'unknown'}-${sock.remotePort ?? 0}`
}

function readFullBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function applyTobe(
  body: Buffer,
  pending: TobePending,
): { rewritten: Buffer, originalBody: Buffer } {
  // Only mutate if the body is JSON with a messages[] — otherwise pass-through.
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { messages?: unknown }
    parsed.messages = pending.messages
    const rewritten = Buffer.from(JSON.stringify(parsed), 'utf8')
    return { rewritten, originalBody: body }
  }
  catch {
    return { rewritten: body, originalBody: body }
  }
}

async function decompressIfNeeded(buf: Buffer, encoding: string | undefined): Promise<Buffer> {
  if (!encoding || encoding === 'identity') return buf
  const enc = encoding.toLowerCase()
  if (enc === 'gzip' || enc === 'x-gzip') {
    return await new Promise<Buffer>((resolve, reject) =>
      zlib.gunzip(buf, (err, out) => (err ? reject(err) : resolve(out))),
    )
  }
  if (enc === 'deflate') {
    return await new Promise<Buffer>((resolve, reject) =>
      zlib.inflate(buf, (err, out) => (err ? reject(err) : resolve(out))),
    )
  }
  if (enc === 'br') {
    return await new Promise<Buffer>((resolve, reject) =>
      zlib.brotliDecompress(buf, (err, out) => (err ? reject(err) : resolve(out))),
    )
  }
  return buf
}

export async function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ProxyContext,
): Promise<void> {
  const sessionId = resolveSessionId(req)
  // Per-session serialization for /v1/messages only. Other /v1/* calls
  // (e.g., /v1/models listing) don't need ordering.
  const shouldSerialize = (req.url ?? '').includes('/messages')
  const run = shouldSerialize
    ? (fn: () => Promise<void>) => ctx.sessionQueue.run(sessionId, fn)
    : (fn: () => Promise<void>) => fn()

  try {
    await run(() => dispatch(req, res, ctx, sessionId))
  }
  catch (err) {
    // dispatch() already writes a response on errors; this is last-resort
    // safety for unexpected throws inside the session queue.
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`proxy error: ${(err as Error).message}\n`)
    }
  }
}

async function dispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ProxyContext,
  sessionId: string,
): Promise<void> {
  const rawBody = await readFullBody(req)

  // TOBE swap (optional; if no pending file exists, pass-through unchanged).
  const pending = ctx.tobeStore.consume(sessionId)
  let bodyToForward = rawBody
  let tobeAppliedFrom: {
    fork_point_version_id: string
    source_view_id: string
    original_body_cid: string
  } | undefined
  if (pending) {
    const { rewritten, originalBody } = applyTobe(rawBody, pending)
    bodyToForward = rewritten
    const originalCid = (await blobRefFromBytes(originalBody)).cid
    tobeAppliedFrom = {
      fork_point_version_id: pending.fork_point_version_id,
      source_view_id: pending.source_view_id,
      original_body_cid: originalCid,
    }
  }

  // Compute blobs (request body + redacted headers) BEFORE upstream dispatch
  // so the event we emit at request time references committed blobs.
  const redactedHeaders = redactHeaders(req.headers, ctx.redactSet)
  const headerJson = Buffer.from(JSON.stringify(redactedHeaders), 'utf8')
  const bodyBlob = await blobRefFromBytes(bodyToForward)
  const headerBlob = await blobRefFromBytes(headerJson)

  const originalBodyBlob = tobeAppliedFrom
    ? await blobRefFromBytes(rawBody)
    : undefined

  // Emit proxy.request_received (atomic with blobs, per G1).
  const requestEvent = ctx.producer.emit(
    'proxy.request_received',
    {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers_cid: headerBlob.cid,
      body_cid: bodyBlob.cid,
      ...(tobeAppliedFrom ? { tobe_applied_from: tobeAppliedFrom } : {}),
    },
    sessionId,
    originalBodyBlob
      ? [bodyBlob.ref, headerBlob.ref, originalBodyBlob.ref]
      : [bodyBlob.ref, headerBlob.ref],
  )

  // Build upstream request.
  const target = new URL(req.url ?? '/', ctx.upstream)
  const forwardHeaders: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue
    forwardHeaders[key] = value
  }
  forwardHeaders['content-length'] = String(bodyToForward.byteLength)

  const proto = target.protocol === 'http:' ? http : https
  const upstreamReq = proto.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'http:' ? 80 : 443),
    path: target.pathname + target.search,
    method: req.method ?? 'GET',
    headers: forwardHeaders,
  })

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    void ctx.producer.emit(
      'proxy.upstream_error',
      {
        request_event_id: requestEvent.id,
        status: 502,
        error_message: err.message,
      },
      sessionId,
    )
  })

  upstreamReq.on('response', async (upstreamRes) => {
    const contentType = upstreamRes.headers['content-type'] ?? ''
    const contentEncoding = String(upstreamRes.headers['content-encoding'] ?? 'identity')
    const isSse = contentType.includes('text/event-stream')

    const respHeaderJson = Buffer.from(JSON.stringify(redactHeaders(upstreamRes.headers, ctx.redactSet)), 'utf8')
    const respHeaderBlob = await blobRefFromBytes(respHeaderJson)

    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)

    const responseChunks: Buffer[] = []
    const sseParser = isSse ? new SseStopReasonParser() : null

    let aborted = false
    res.on('close', () => {
      if (!res.writableEnded) aborted = true
    })

    upstreamRes.on('data', (chunk: Buffer) => {
      // Pipe raw bytes to client immediately.
      res.write(chunk)
      responseChunks.push(chunk)
      if (sseParser) sseParser.feed(chunk)
    })

    upstreamRes.on('end', async () => {
      res.end()
      if (sseParser) sseParser.end()

      const rawResponse = Buffer.concat(responseChunks)
      const respBodyBlob = await blobRefFromBytes(rawResponse)

      let stopReason: string | null = null
      if (isSse) {
        stopReason = sseParser!.snapshot().stopReason
      }
      else {
        try {
          const decompressed = await decompressIfNeeded(rawResponse, contentEncoding)
          stopReason = extractStopReasonFromJsonBody(decompressed.toString('utf8'))
        }
        catch {
          stopReason = null
        }
      }

      if (aborted) {
        ctx.producer.emit(
          'proxy.response_aborted',
          { request_event_id: requestEvent.id, reason: 'client_disconnect' },
          sessionId,
        )
        return
      }

      ctx.producer.emit(
        'proxy.response_completed',
        {
          request_event_id: requestEvent.id,
          status: upstreamRes.statusCode ?? 0,
          headers_cid: respHeaderBlob.cid,
          body_cid: respBodyBlob.cid,
          stop_reason: stopReason,
        },
        sessionId,
        [respHeaderBlob.ref, respBodyBlob.ref],
      )
    })

    upstreamRes.on('error', (err) => {
      ctx.producer.emit(
        'proxy.response_aborted',
        { request_event_id: requestEvent.id, reason: `upstream_stream_error: ${err.message}` },
        sessionId,
      )
    })
  })

  if (bodyToForward.byteLength > 0) upstreamReq.write(bodyToForward)
  upstreamReq.end()
}
