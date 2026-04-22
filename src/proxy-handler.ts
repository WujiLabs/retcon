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

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import zlib from 'node:zlib'
import { blobRefFromBytes } from './body-blob.js'
import type { EventProducer } from './events.js'
import type { ForkAwaiter, ForkOutcome } from './fork-awaiter.js'
import { redactHeaders } from './redaction.js'
import type { SessionQueue } from './session-queue.js'
import { extractStopReasonFromJsonBody, SseStopReasonParser } from './sse-parser.js'
import type { TobePending, TobeStore } from './tobe.js'

export const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com'
export const SESSION_HEADER = 'x-playtiss-session'

// Hop-by-hop headers per RFC 7230 plus ones Node's http client will set itself.
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',   // recomputed after potential TOBE swap
  'transfer-encoding',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'expect',           // Expect: 100-continue would stall upstream
])

// Same list for the RESPONSE direction: Node re-chunks and re-frames the
// response itself, so forwarding upstream's hop-by-hop + content-length
// produces double framing or conflicting headers to the client.
const SKIP_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
])

function filterResponseHeaders(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

export interface ProxyContext {
  readonly producer: EventProducer
  readonly sessionQueue: SessionQueue
  readonly tobeStore: TobeStore
  readonly redactSet: ReadonlySet<string>
  readonly upstream: string
  readonly forkAwaiter: ForkAwaiter
}

/**
 * Resolve a session id for this request. Prefer the x-playtiss-session header
 * injected by the /fork skill; fall back to a per-request random id for orphan
 * mode. A socket-tuple fallback would collide when the OS reuses ports — two
 * unrelated orphan requests sharing `remoteAddress:remotePort` would cross-read
 * each other's TOBE files and cross-project events.
 */
export function resolveSessionId(req: http.IncomingMessage): string {
  const raw = req.headers[SESSION_HEADER]
  if (typeof raw === 'string' && raw.length > 0) return raw
  return `orphan-${crypto.randomUUID()}`
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
  // Only peek on /v1/messages — other /v1/* paths (e.g. /v1/models listing)
  // shouldn't waste a pending swap intended for the next user turn.
  //
  // peek (not consume) because we commit (delete) only after the upstream
  // call completes with 2xx. On 5xx / abort / upstream_error the TOBE stays
  // so Claude Code's retry loop re-applies it automatically.
  const isMessagesPath = (req.url ?? '').includes('/messages')
  const pending = isMessagesPath ? ctx.tobeStore.peek(sessionId) : null
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

  // Build upstream request. req.url must be treated as path-only — if a client
  // sent an absolute-form request-line (`POST http://evil.example/... HTTP/1.1`),
  // Node's http parser hands that URL through. `new URL(absolute, base)` ignores
  // the base, so we'd SSRF to any host the client names and leak Authorization
  // headers. Reject absolute URLs and anything not starting with `/`.
  const rawPath = req.url ?? '/'
  if (!rawPath.startsWith('/')) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('playtiss-proxy: absolute URLs not allowed; send path only\n')
    return
  }
  const target = new URL(rawPath, ctx.upstream)
  const forwardHeaders: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue
    forwardHeaders[key] = value
  }
  forwardHeaders['content-length'] = String(bodyToForward.byteLength)

  // Everything below returns ONE promise that resolves only after the response
  // cycle finishes (success, aborted, or errored). The session queue awaits
  // this promise, which enforces the G2 session sequencing invariant: a
  // second /v1/messages for the same session cannot begin until the prior
  // one's response_completed / response_aborted / upstream_error has fired.
  await new Promise<void>((resolve) => {
    let responseStarted = false
    let terminalEmitted = false
    const emitTerminal = (
      topic: 'proxy.response_completed' | 'proxy.response_aborted' | 'proxy.upstream_error',
      payload: Record<string, unknown>,
      refs?: Parameters<typeof ctx.producer.emit>[3],
    ): void => {
      if (terminalEmitted) return
      terminalEmitted = true
      ctx.producer.emit(topic, payload, sessionId, refs)
      // TOBE lifecycle: only commit (delete the pending file) when the
      // upstream call actually returned a non-5xx response. Every other
      // outcome (5xx body, client abort, upstream_error) keeps the file
      // so Claude Code's retry loop re-applies it. This is what makes
      // the fork intent idempotent under transient failures.
      if (pending) {
        const isHttpSuccess
          = topic === 'proxy.response_completed'
            && typeof payload.status === 'number'
            && payload.status < 500
        if (isHttpSuccess) ctx.tobeStore.commit(sessionId)

        // Notify any in-flight fork_back awaiter with a structured outcome.
        // fork_back can either await this or query the event log after the
        // fact; both paths go through ForkAwaiter / lastForkOutcome.
        const outcome: ForkOutcome = (() => {
          if (topic === 'proxy.response_completed') {
            const s = typeof payload.status === 'number' ? payload.status : 0
            return {
              status: s >= 500 ? 'http_error' : 'completed',
              version_id: requestEvent.id,
              http_status: s,
              stop_reason: (payload.stop_reason ?? null) as string | null,
              fork_point_version_id: pending.fork_point_version_id,
              source_view_id: pending.source_view_id,
            }
          }
          if (topic === 'proxy.response_aborted') {
            return {
              status: 'aborted',
              version_id: requestEvent.id,
              error_message: typeof payload.reason === 'string' ? payload.reason : undefined,
              fork_point_version_id: pending.fork_point_version_id,
              source_view_id: pending.source_view_id,
            }
          }
          return {
            status: 'upstream_error',
            version_id: requestEvent.id,
            http_status: typeof payload.status === 'number' ? payload.status : undefined,
            error_message:
              typeof payload.error_message === 'string' ? payload.error_message : undefined,
            fork_point_version_id: pending.fork_point_version_id,
            source_view_id: pending.source_view_id,
          }
        })()
        ctx.forkAwaiter.notify(sessionId, outcome)
      }
    }

    const proto = target.protocol === 'http:' ? http : https
    const upstreamReq = proto.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method: req.method ?? 'GET',
      headers: forwardHeaders,
    })

    upstreamReq.on('error', (err) => {
      // Only treat this as the terminal error if the response hadn't started —
      // otherwise upstreamRes.on('error') owns it.
      if (responseStarted) return
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      emitTerminal(
        'proxy.upstream_error',
        {
          request_event_id: requestEvent.id,
          status: 502,
          error_message: err.message,
        },
      )
      resolve()
    })

    upstreamReq.on('response', (upstreamRes) => {
      responseStarted = true
      void (async (): Promise<void> => {
        try {
          const contentType = upstreamRes.headers['content-type'] ?? ''
          const contentEncoding = String(upstreamRes.headers['content-encoding'] ?? 'identity')
          const isSse = contentType.includes('text/event-stream')

          const respHeaderJson = Buffer.from(
            JSON.stringify(redactHeaders(upstreamRes.headers, ctx.redactSet)),
            'utf8',
          )
          const respHeaderBlob = await blobRefFromBytes(respHeaderJson)

          res.writeHead(
            upstreamRes.statusCode ?? 502,
            filterResponseHeaders(upstreamRes.headers),
          )

          const responseChunks: Buffer[] = []
          const sseParser = isSse ? new SseStopReasonParser() : null
          let clientAborted = false
          let upstreamEnded = false

          res.on('close', () => {
            if (!upstreamEnded && !res.writableEnded) clientAborted = true
          })

          upstreamRes.on('data', (chunk: Buffer) => {
            res.write(chunk)
            responseChunks.push(chunk)
            if (sseParser) sseParser.feed(chunk)
          })

          await new Promise<void>((done) => {
            upstreamRes.on('end', () => {
              upstreamEnded = true
              res.end()
              if (sseParser) sseParser.end()
              done()
            })
            upstreamRes.on('error', (err) => {
              if (!res.writableEnded) res.destroy(err)
              emitTerminal(
                'proxy.response_aborted',
                {
                  request_event_id: requestEvent.id,
                  reason: `upstream_stream_error: ${err.message}`,
                },
              )
              done()
            })
          })

          // Terminal event already emitted via the upstream_stream_error path.
          if (terminalEmitted) {
            resolve()
            return
          }

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

          if (clientAborted) {
            emitTerminal(
              'proxy.response_aborted',
              { request_event_id: requestEvent.id, reason: 'client_disconnect' },
            )
          }
          else {
            emitTerminal(
              'proxy.response_completed',
              {
                request_event_id: requestEvent.id,
                status: upstreamRes.statusCode ?? 0,
                headers_cid: respHeaderBlob.cid,
                body_cid: respBodyBlob.cid,
                stop_reason: stopReason,
              },
              [respHeaderBlob.ref, respBodyBlob.ref],
            )
          }
          resolve()
        }
        catch (err) {
          // Any unexpected failure in the async response path: emit terminal
          // error so the projector sees a dangling Version, and unblock the
          // client if we haven't responded yet.
          const message = (err as Error).message ?? String(err)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain' })
            res.end(`proxy error: ${message}\n`)
          }
          else if (!res.writableEnded) {
            res.destroy(err as Error)
          }
          emitTerminal(
            'proxy.upstream_error',
            {
              request_event_id: requestEvent.id,
              status: 500,
              error_message: `proxy_handler_exception: ${message}`,
            },
          )
          resolve()
        }
      })()
    })

    if (bodyToForward.byteLength > 0) upstreamReq.write(bodyToForward)
    upstreamReq.end()
  })
}
