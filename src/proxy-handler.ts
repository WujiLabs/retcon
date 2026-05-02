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

import type { BindingTable } from './binding-table.js'
import { blobRefFromBytes, blobRefFromMessagesBody } from './body-blob.js'
import type { DB } from './db.js'
import type { BlobRef, EventProducer } from './events.js'
import type { ForkAwaiter, ForkOutcome } from './fork-awaiter.js'
import { redactHeaders } from './redaction.js'
import { computeRevisionAsset } from './revisions-v1.js'
import { buildSyntheticAsset } from './rewind-marker-v1.js'
import type { SessionQueue } from './session-queue.js'
import { extractStopReasonFromJsonBody, extractStopReasonFromSseBody } from './sse-parser.js'
import { SqliteStorageProvider } from './storage.js'
import type { TobePending, TobeStore } from './tobe.js'

export const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com'
export const SESSION_HEADER = 'x-playtiss-session'

/**
 * Combine an upstream base (e.g. `https://api.anthropic.com` or
 * `https://openrouter.ai/api`) with a request path (e.g. `/v1/messages`).
 *
 * Plain `new URL(path, base)` REPLACES base.pathname when path starts with `/`,
 * so `new URL('/v1/messages', 'https://openrouter.ai/api')` returns
 * `https://openrouter.ai/v1/messages` — wrong, drops `/api`. We concatenate
 * strings directly so a non-empty upstream path is preserved verbatim.
 */
export function buildUpstreamUrl(upstream: string, path: string): URL {
  const base = upstream.endsWith('/') ? upstream.slice(0, -1) : upstream
  const p = path.startsWith('/') ? path : `/${path}`
  return new URL(base + p)
}

// Hop-by-hop headers per RFC 7230 plus ones Node's http client will set itself.
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length', // recomputed after potential TOBE swap
  'transfer-encoding',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'expect', // Expect: 100-continue would stall upstream
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
  /**
   * Optional binding table for late-bound resumed sessions. When the SessionStart
   * hook has fired, the transport id (binding_token) resolves to the actual
   * claude session_id; events get attributed there directly. When undefined or
   * the transport id has no binding, requests stay attributed under the transport
   * id (which becomes the canonical session_id for new sessions).
   */
  readonly bindingTable?: BindingTable
  /**
   * Optional DB handle. When provided, dispatch reads sessions.branch_context_json
   * to apply persistent fork rewrites to /v1/messages, and writes back the new
   * branch state after each successful upstream response. Without this handle
   * the proxy still works for non-fork traffic; fork persistence simply degrades
   * to TOBE one-shot behavior.
   */
  readonly db?: DB
}

/**
 * Resolve a session id for this request. Prefer the x-playtiss-session header
 * injected by the /fork skill; fall back to a per-request random id for orphan
 * mode. A socket-tuple fallback would collide when the OS reuses ports — two
 * unrelated orphan requests sharing `remoteAddress:remotePort` would cross-read
 * each other's TOBE files and cross-project events.
 *
 * If a binding table is provided and the header is set, we resolve through it
 * so resumed sessions land under claude's actual session_id post-rebind.
 */
export function resolveSessionId(req: http.IncomingMessage, bindingTable?: BindingTable): string {
  const raw = req.headers[SESSION_HEADER]
  if (typeof raw === 'string' && raw.length > 0) {
    return bindingTable ? bindingTable.resolve(raw) : raw
  }
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

/**
 * Hard cap on the JSON-encoded size of `branch_context_json`. The column
 * grows by one user/assistant turn per /v1/messages once a fork is active.
 * 8 MiB is well past any model's context window (≈2M+ tokens), so hitting
 * this cap means something went wrong: a runaway tool loop, an
 * adversarial LLM, or a misbehaving client. On overflow we wipe the
 * override and fall back to claude's local view — the fork is lost, but
 * we don't grow the column further.
 */
export const BRANCH_CONTEXT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Anthropic's hard limit on ephemeral `cache_control` blocks per /v1/messages
 * request. As of 2026-04, requests with > 4 cache_control markers across
 * `system`, `tools`, and `messages.content[].cache_control` get a 400.
 *
 * retcon's persistent-fork splice naturally accumulates message-level cache
 * markers across turns: each branch_context_json round-trip preserves whatever
 * claude attached on prior turns, then claude attaches more on the new
 * suffix. After 2-3 spliced turns we hit the cap. `capCacheControlBlocks`
 * strips earliest message markers first so the LATEST markers (which extend
 * the cache progressively via Anthropic's 20-block lookback) survive.
 *
 * See https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
 * for the exact mechanics. Key quote: "Place the breakpoint on the last
 * block that stays identical across requests. In a growing conversation
 * the final block works as long as each turn adds fewer than 20 blocks:
 * earlier content never changes, so the next request's lookback finds the
 * prior write."
 */
export const MAX_CACHE_CONTROL_BLOCKS = 4

/**
 * Anthropic enforces a TTL ordering invariant on cache_control markers in
 * addition to the count cap: a `ttl='1h'` block must NOT come after a
 * `ttl='5m'` block in the processing order (`tools` → `system` → `messages`).
 * Violation produces a 400 like:
 *
 *   messages.130.content.0.cache_control.ttl: a ttl='1h' cache_control block
 *   must not come after a ttl='5m' cache_control block.
 *
 * Empirically observed when claude assembled a body with a stale 5m marker
 * earlier in `messages` and a fresh 1h marker on the latest user turn — the
 * exact case b17275fb hit twice on 2026-05-01 after a `/compact` that ran
 * inside a forked branch (so the compact summary itself carries cache markers
 * inherited from the rewound history, even though branch_context_json was
 * NULL'd by /compact's release).
 *
 * Fix: any earlier 5m marker is REDUNDANT once a later 1h marker exists,
 * because Anthropic's prefix-lookback caches the same content the 5m marker
 * would have anchored, plus more, for longer. Stripping the earlier 5m
 * loses no useful caching.
 *
 * `stripTtlViolations` walks markers in processing order and strips every
 * 5m that has a 1h after it. Run BEFORE `capCacheControlBlocks` so the
 * count cap doesn't waste a slot on a redundant 5m. Returns the number of
 * markers stripped; the proxy emits `proxy.cache_control_ttl_violation_fixed`
 * when > 0 so we can track how often this happens.
 */

export interface BranchContextRewriteResult {
  /** Rewritten body to forward upstream. Empty buffer when overflow=true. */
  body: Buffer
  /** True iff the fork's branch_context_json crossed BRANCH_CONTEXT_MAX_BYTES
   *  on this turn. Caller wipes the column, emits an audit event, and
   *  forwards the original (unrewritten) body. */
  overflow: boolean
}

/**
 * Persistent fork-context rewrite. If the session has a `branch_context_json`
 * stored (set by `fork_back`), splice it into claude's outgoing /v1/messages
 * request body and persist the extended branch_context for next time.
 *
 * Algorithm: claude's body always carries the model's view of the
 * conversation, ending with the new user input. We extract the suffix
 * AFTER the penultimate user message — that suffix is exactly "what claude
 * added since our last upstream call": the previous turn's assistant
 * message (which claude assembled from the SSE stream itself), plus any
 * tool_use / tool_result rounds, plus the fresh user input. Append that
 * suffix to branch_context_json.
 *
 * Why penultimate user (and not "anything after last assistant"): tool
 * round-trips have multiple alternating user/assistant entries within a
 * single turn from the user's POV (asst tool_use → user tool_result →
 * asst final_text). The last user message is always the one we're about
 * to ask the model about. The penultimate user message is the one we
 * already sent upstream last time. Everything between those two indices
 * is the model's intermediate output that claude already assembled for
 * us — no need to parse the SSE response ourselves.
 *
 * Special case: the FIRST /v1/messages after fork_back is handled by TOBE
 * (existing flow). branch_context_json is set to [..., fork_user] at that
 * point. After TOBE commits, this function takes over for subsequent
 * turns. The penultimate-user algorithm naturally aligns: claude's body
 * by then contains [..., user_that_triggered_fork_back, asst_response,
 * new_user_input], and the suffix after `user_that_triggered_fork_back`
 * picks up exactly the assistant + new user input we want to fold in.
 *
 * Returns null (pass-through) when:
 *   - branch_context_json is unset
 *   - claude's body isn't parseable JSON
 *   - claude has fewer than 2 user messages (shouldn't happen post-fork
 *     since the fork always followed at least 2 user turns)
 *
 * Returns `{overflow: true}` when extending the branch_context would push
 * the JSON-encoded column past BRANCH_CONTEXT_MAX_BYTES. Caller wipes the
 * column, emits an audit event, and forwards claude's body unchanged.
 */
export function applyBranchContextRewrite(
  rawBody: Buffer,
  sessionId: string,
  db: DB,
): BranchContextRewriteResult | null {
  const row = db
    .prepare('SELECT branch_context_json FROM sessions WHERE id = ?')
    .get(sessionId) as { branch_context_json: string | null } | undefined
  if (!row?.branch_context_json) return null

  let branchContext: unknown[]
  try {
    const parsed = JSON.parse(row.branch_context_json) as unknown
    if (!Array.isArray(parsed)) return null
    branchContext = parsed
  }
  catch {
    return null
  }
  if (branchContext.length === 0) return null

  let parsedBody: { messages?: unknown[] }
  try {
    parsedBody = JSON.parse(rawBody.toString('utf8')) as { messages?: unknown[] }
  }
  catch {
    return null
  }
  if (!Array.isArray(parsedBody.messages) || parsedBody.messages.length === 0) {
    return null
  }

  // Find the penultimate user-role message in claude's body. Everything
  // after it is what claude has added since our last upstream send.
  const userIndices: number[] = []
  for (let i = 0; i < parsedBody.messages.length; i++) {
    const m = parsedBody.messages[i] as { role?: string }
    if (m?.role === 'user') userIndices.push(i)
  }
  if (userIndices.length < 2) {
    // Claude's body only has one user message — nothing has happened since
    // fork_back from claude's POV. Send branch_context as-is (this is the
    // hook-fires-first race; uncommon but defensible).
    const messagesToSend = [...branchContext]
    return finalizeRewrite(parsedBody, messagesToSend, db, sessionId, branchContext)
  }
  const penultimateIdx = userIndices[userIndices.length - 2]
  const claudeSuffix = parsedBody.messages.slice(penultimateIdx + 1)

  const messagesToSend = [...branchContext, ...claudeSuffix]
  return finalizeRewrite(parsedBody, messagesToSend, db, sessionId, branchContext)
}

/**
 * Helper: serialize the rewritten body, persist the extended branch_context
 * (only when it actually grew so daemon-restart-then-replay stays idempotent),
 * and return. On overflow (column would exceed BRANCH_CONTEXT_MAX_BYTES),
 * NULL the column and signal the caller to fall back to the unrewritten body.
 */
function finalizeRewrite(
  parsedBody: { messages?: unknown[] },
  messagesToSend: unknown[],
  db: DB,
  sessionId: string,
  prevBranchContext: unknown[],
): BranchContextRewriteResult {
  if (messagesToSend.length > prevBranchContext.length) {
    const json = JSON.stringify(messagesToSend)
    if (json.length > BRANCH_CONTEXT_MAX_BYTES) {
      db.prepare('UPDATE sessions SET branch_context_json = NULL WHERE id = ?')
        .run(sessionId)
      return { body: Buffer.alloc(0), overflow: true }
    }
    db.prepare('UPDATE sessions SET branch_context_json = ? WHERE id = ?')
      .run(json, sessionId)
  }
  return {
    body: Buffer.from(
      JSON.stringify({ ...parsedBody, messages: messagesToSend }),
      'utf8',
    ),
    overflow: false,
  }
}

/**
 * Cap the number of ephemeral `cache_control` markers in a /v1/messages body
 * to `max` (default 4 — Anthropic's hard limit). Counts markers across
 * `system` (array form), `tools`, and `messages[i].content[j]` content blocks.
 *
 * Stripping policy: protect system + tools (the truly stable prefix), and
 * strip the EARLIEST message markers first — keeping the tail markers.
 *
 * Why tail wins: Anthropic's caching writes an entry AT each marker (the
 * cumulative prefix up through that block). The next request's marker
 * triggers a 20-block lookback that hits any of the prior entries whose
 * positions are still in range. A marker at the LATEST stable point caches
 * the LONGEST prefix, and as the conversation grows the next turn's marker
 * (a few blocks further) finds it via lookback — so the cache grows with
 * the conversation.
 *
 * A heading-only strategy still hits cache (the heading prefix is byte-
 * identical across retcon's spliced turns), but the cached prefix never
 * extends past the heading. Everything after pays full input price every
 * turn. The tail strategy progressively caches more, paying off increasingly
 * over the session lifetime.
 *
 * Mutates `parsedBody` in-place. Returns the number of markers removed;
 * 0 means no change. Caller is responsible for re-serializing.
 *
 * Exported for unit testing.
 */
export function capCacheControlBlocks(
  parsedBody: { system?: unknown, tools?: unknown, messages?: unknown },
  max: number = MAX_CACHE_CONTROL_BLOCKS,
): number {
  let protectedCount = 0

  // hasMarker: a `cache_control` field counts only if it's a truthy object
  // (Anthropic's actual semantics — `null` and `undefined` are no-op
  // markers that don't consume one of the 4 slots).
  const hasMarker = (x: unknown): x is { cache_control: object } =>
    !!x && typeof x === 'object' && 'cache_control' in x
    && !!(x as { cache_control?: unknown }).cache_control
    && typeof (x as { cache_control?: unknown }).cache_control === 'object'

  // System (array form only; string form has no cache_control).
  if (Array.isArray(parsedBody.system)) {
    for (const block of parsedBody.system) {
      if (hasMarker(block)) protectedCount++
    }
  }

  // Tools (array of tool definitions; cache_control is a top-level field).
  if (Array.isArray(parsedBody.tools)) {
    for (const tool of parsedBody.tools) {
      if (hasMarker(tool)) protectedCount++
    }
  }

  // Messages: enumerate cache_control sites in heading-first order. We strip
  // from the START (earliest first) so the latest markers — the ones that
  // prime the cache for the NEXT request — survive.
  const messageStrippers: Array<() => void> = []
  if (Array.isArray(parsedBody.messages)) {
    for (let i = 0; i < parsedBody.messages.length; i++) {
      const msg = parsedBody.messages[i] as { content?: unknown } | null
      if (!msg || typeof msg !== 'object') continue
      const content = msg.content
      if (!Array.isArray(content)) continue
      for (let j = 0; j < content.length; j++) {
        const block = content[j]
        if (hasMarker(block)) {
          // Capture by reference so the closure deletes the right field.
          const target = block as { cache_control?: unknown }
          messageStrippers.push(() => {
            delete target.cache_control
          })
        }
      }
    }
  }

  const total = protectedCount + messageStrippers.length
  if (total <= max) return 0

  // Strip from the START (earliest first). If protected alone exceeds max
  // (degenerate case retcon doesn't normally produce), we leave protected
  // alone — Anthropic will still 400 but the operator sees a clearer signal
  // than retcon silently messing with their system/tools markers.
  const toStrip = total - max
  let stripped = 0
  for (let k = 0; k < messageStrippers.length && stripped < toStrip; k++) {
    messageStrippers[k]!()
    stripped++
  }
  return stripped
}

/**
 * See the doc on the export above for the full motivation. Strip every
 * `ttl='5m'` (or default-TTL, which Anthropic defines as 5m) marker that is
 * followed in processing order by a `ttl='1h'` marker. Run before
 * `capCacheControlBlocks` so we don't waste a count-cap slot on a marker
 * that's about to be invalidated anyway.
 *
 * Mutates `parsedBody` in-place. Returns the number of markers removed;
 * 0 means no change. Caller is responsible for re-serializing.
 *
 * Exported for unit testing.
 */
export function stripTtlViolations(
  parsedBody: { system?: unknown, tools?: unknown, messages?: unknown },
): number {
  // Same hasMarker semantics as capCacheControlBlocks: only truthy-object
  // cache_control values count. null / undefined are no-op markers.
  const hasMarker = (x: unknown): x is { cache_control: { ttl?: unknown } } =>
    !!x && typeof x === 'object' && 'cache_control' in x
    && !!(x as { cache_control?: unknown }).cache_control
    && typeof (x as { cache_control?: unknown }).cache_control === 'object'

  // Walk markers in Anthropic's processing order: tools → system → messages.
  // `ttlOf` returns the effective TTL string ("5m" or "1h"); Anthropic's
  // default when `ttl` is absent is "5m".
  const ttlOf = (marker: { cache_control: { ttl?: unknown } }): string => {
    const t = marker.cache_control.ttl
    return typeof t === 'string' ? t : '5m'
  }

  type Entry = { ttl: string, strip: () => void }
  const all: Entry[] = []

  const stripFn = (host: { cache_control?: unknown }) => () => {
    delete host.cache_control
  }
  if (Array.isArray(parsedBody.tools)) {
    for (const tool of parsedBody.tools) {
      if (hasMarker(tool)) {
        all.push({ ttl: ttlOf(tool), strip: stripFn(tool as { cache_control?: unknown }) })
      }
    }
  }
  if (Array.isArray(parsedBody.system)) {
    for (const block of parsedBody.system) {
      if (hasMarker(block)) {
        all.push({ ttl: ttlOf(block), strip: stripFn(block as { cache_control?: unknown }) })
      }
    }
  }
  if (Array.isArray(parsedBody.messages)) {
    for (const msg of parsedBody.messages) {
      if (!msg || typeof msg !== 'object') continue
      const content = (msg as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (hasMarker(block)) {
          all.push({ ttl: ttlOf(block), strip: stripFn(block as { cache_control?: unknown }) })
        }
      }
    }
  }

  // Find the LAST 1h marker. Anything earlier than it that's 5m is a
  // violation. If no 1h exists, or it's at position 0, nothing to do.
  let lastOneHour = -1
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.ttl === '1h') {
      lastOneHour = i
      break
    }
  }
  if (lastOneHour <= 0) return 0

  let removed = 0
  for (let i = 0; i < lastOneHour; i++) {
    if (all[i]!.ttl === '5m') {
      all[i]!.strip()
      removed++
    }
  }
  return removed
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
  const sessionId = resolveSessionId(req, ctx.bindingTable)
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
    fork_point_revision_id: string
    source_view_id: string
    original_body_cid: string
  } | undefined
  // Same bytes get hashed by both the tobe_applied_from metadata block
  // and the proxy.request_received emit. Compute once.
  let originalBodyBlob: Awaited<ReturnType<typeof blobRefFromBytes>> | undefined
  if (pending) {
    const { rewritten, originalBody } = applyTobe(rawBody, pending)
    bodyToForward = rewritten
    originalBodyBlob = await blobRefFromBytes(originalBody)
    tobeAppliedFrom = {
      fork_point_revision_id: pending.fork_point_revision_id,
      source_view_id: pending.source_view_id,
      original_body_cid: originalBodyBlob.cid,
    }
  }
  else if (isMessagesPath && ctx.db) {
    // No TOBE pending — check if this session is on a forked branch and, if
    // so, rewrite messages so the upstream sees the forked context plus
    // claude's new user input. Non-fork sessions skip this entirely.
    //
    // We deliberately don't set tobe_applied_from here; the default parent-
    // linking ("most recent sealed revision in task") naturally lands on the
    // previous turn within the active branch, since the active branch's tail
    // is always the most recent sealed revision after fork_back.
    const rewritten = applyBranchContextRewrite(rawBody, sessionId, ctx.db)
    if (rewritten?.overflow) {
      // branch_context_json was about to exceed BRANCH_CONTEXT_MAX_BYTES
      // (8 MiB). The column has been NULL'd; pass claude's body through
      // unchanged. The fork is now broken — claude's local view drives
      // future turns. Emit an audit event so the operator sees it.
      ctx.producer.emit(
        'session.branch_context_overflow',
        { session_id: sessionId, max_bytes: BRANCH_CONTEXT_MAX_BYTES },
        sessionId,
      )
    }
    else if (rewritten) {
      bodyToForward = rewritten.body
    }
  }

  // Cap cache_control markers to MAX_CACHE_CONTROL_BLOCKS (Anthropic's hard
  // limit). Persistent-fork splicing accumulates markers across turns;
  // without this cap, the second or third spliced turn 400s with "A maximum
  // of 4 blocks with cache_control may be provided." Stripping prefers the
  // latest markers (system + tools + tail messages) because the tail caches
  // a progressively longer prefix via Anthropic's 20-block lookback —
  // see capCacheControlBlocks doc for the why.
  if (isMessagesPath) {
    try {
      const parsed = JSON.parse(bodyToForward.toString('utf8')) as {
        system?: unknown
        tools?: unknown
        messages?: unknown
      }
      // TTL ordering pre-pass FIRST. Removes any 5m marker that's followed by
      // a later 1h marker — Anthropic 400s when 1h appears after 5m, and the
      // earlier 5m is redundant once a later 1h exists (the 1h covers the
      // same prefix and more).
      const ttlFixed = stripTtlViolations(parsed)
      const stripped = capCacheControlBlocks(parsed, MAX_CACHE_CONTROL_BLOCKS)
      if (ttlFixed > 0) {
        ctx.producer.emit(
          'proxy.cache_control_ttl_violation_fixed',
          { session_id: sessionId, removed: ttlFixed },
          sessionId,
        )
      }
      if (stripped > 0) {
        ctx.producer.emit(
          'proxy.cache_control_capped',
          { session_id: sessionId, removed: stripped, max: MAX_CACHE_CONTROL_BLOCKS },
          sessionId,
        )
      }
      if (ttlFixed > 0 || stripped > 0) {
        bodyToForward = Buffer.from(JSON.stringify(parsed), 'utf8')
      }
    }
    catch {
      // Body wasn't JSON — leave it alone (the upstream will surface its
      // own error). Capping is opportunistic, not a hard prerequisite.
    }
  }

  // Compute blobs (request body + redacted headers) BEFORE upstream dispatch
  // so the event we emit at request time references committed blobs.
  //
  // For /v1/messages requests we use blobRefFromMessagesBody, which splits
  // each message and tool into its own dag-json blob. That deduplicates the
  // long static prefix (system-reminder, repeated user/assistant pairs) so
  // storage scales linearly with NEW content rather than O(N²) with the
  // conversation length. Other /v1/* paths (model listing, etc.) use the
  // single-byte-blob path.
  const redactedHeaders = redactHeaders(req.headers, ctx.redactSet)
  const headerJson = Buffer.from(JSON.stringify(redactedHeaders), 'utf8')
  const headerBlob = await blobRefFromBytes(headerJson)

  let bodyCid: string
  let bodyRefs: BlobRef[]
  if (isMessagesPath) {
    const split = await blobRefFromMessagesBody(bodyToForward)
    bodyCid = split.topCid
    bodyRefs = split.refs
  }
  else {
    const single = await blobRefFromBytes(bodyToForward)
    bodyCid = single.cid
    bodyRefs = [single.ref]
  }

  // originalBodyBlob was already set in the `pending` branch above.

  // Emit proxy.request_received (atomic with blobs, per G1).
  const requestEvent = ctx.producer.emit(
    'proxy.request_received',
    {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers_cid: headerBlob.cid,
      body_cid: bodyCid,
      ...(tobeAppliedFrom ? { tobe_applied_from: tobeAppliedFrom } : {}),
    },
    sessionId,
    originalBodyBlob
      ? [...bodyRefs, headerBlob.ref, originalBodyBlob.ref]
      : [...bodyRefs, headerBlob.ref],
  )

  // Build upstream request. req.url must be treated as path-only — if a client
  // sent an absolute-form request-line (`POST http://evil.example/... HTTP/1.1`),
  // Node's http parser hands that URL through. `new URL(absolute, base)` ignores
  // the base, so we'd SSRF to any host the client names and leak Authorization
  // headers. Reject absolute URLs and anything not starting with `/`.
  const rawPath = req.url ?? '/'
  if (!rawPath.startsWith('/')) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('retcon: absolute URLs not allowed; send path only\n')
    return
  }
  const target = buildUpstreamUrl(ctx.upstream, rawPath)
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

        // Note: fork.forked emission lives in the response-handler's async
        // path (after emitTerminal) — it requires building the synthetic
        // asset, which is async. See the call-site at the end of the
        // response handler below.

        // Notify any in-flight fork_back awaiter with a structured outcome.
        // fork_back can either await this or query the event log after the
        // fact; both paths go through ForkAwaiter / lastForkOutcome.
        const outcome: ForkOutcome = (() => {
          if (topic === 'proxy.response_completed') {
            const s = typeof payload.status === 'number' ? payload.status : 0
            return {
              status: s >= 500 ? 'http_error' : 'completed',
              revision_id: requestEvent.id,
              http_status: s,
              stop_reason: (payload.stop_reason ?? null) as string | null,
              fork_point_revision_id: pending.fork_point_revision_id,
              source_view_id: pending.source_view_id,
            }
          }
          if (topic === 'proxy.response_aborted') {
            return {
              status: 'aborted',
              revision_id: requestEvent.id,
              error_message: typeof payload.reason === 'string' ? payload.reason : undefined,
              fork_point_revision_id: pending.fork_point_revision_id,
              source_view_id: pending.source_view_id,
            }
          }
          return {
            status: 'upstream_error',
            revision_id: requestEvent.id,
            http_status: typeof payload.status === 'number' ? payload.status : undefined,
            error_message:
              typeof payload.error_message === 'string' ? payload.error_message : undefined,
            fork_point_revision_id: pending.fork_point_revision_id,
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
          let clientAborted = false
          let upstreamEnded = false

          res.on('close', () => {
            if (!upstreamEnded && !res.writableEnded) clientAborted = true
          })

          // Pass through raw chunks to the client unchanged. Stop-reason
          // extraction happens AFTER the stream ends, off the buffered body
          // (decompressing as needed) — see below. We deliberately don't
          // tap-parse during streaming because that would require a stream-
          // ing zlib pipeline to handle content-encoding: gzip responses,
          // and we already buffer the full body for blob storage anyway.
          upstreamRes.on('data', (chunk: Buffer) => {
            res.write(chunk)
            responseChunks.push(chunk)
          })

          await new Promise<void>((done) => {
            upstreamRes.on('end', () => {
              upstreamEnded = true
              res.end()
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
          try {
            const decompressed = await decompressIfNeeded(rawResponse, contentEncoding)
            const text = decompressed.toString('utf8')
            stopReason = isSse
              ? extractStopReasonFromSseBody(text)
              : extractStopReasonFromJsonBody(text)
          }
          catch {
            stopReason = null
          }
          // We intentionally don't parse the upstream response to harvest the
          // assistant message for branch_context_json. Instead, the next
          // /v1/messages from claude will arrive with the assistant turn
          // already folded into claude's body — applyBranchContextRewrite
          // walks claude's body to find the suffix-after-penultimate-user
          // and appends it. Letting claude do its own SSE assembly keeps us
          // out of the response-format business.

          if (clientAborted) {
            emitTerminal(
              'proxy.response_aborted',
              { request_event_id: requestEvent.id, reason: 'client_disconnect' },
            )
          }
          else {
            // Pre-compute the Version asset (dag-json of {request_body_cid,
            // response_body_cid}) so the projector can stay synchronous.
            // Hashing is async; the single-tx event-emit invariant requires
            // all hashing to happen before we enter the transaction.
            const asset = await computeRevisionAsset(bodyCid, respBodyBlob.cid)
            const status = upstreamRes.statusCode ?? 0
            emitTerminal(
              'proxy.response_completed',
              {
                request_event_id: requestEvent.id,
                status,
                headers_cid: respHeaderBlob.cid,
                body_cid: respBodyBlob.cid,
                stop_reason: stopReason,
                asset_cid: asset.cid,
              },
              [respHeaderBlob.ref, respBodyBlob.ref, { cid: asset.cid, bytes: asset.bytes }],
            )

            // Synthetic departure Revision (SR) — v0.5.0. Gate on the same
            // strict triad: TOBE consumed, status 2xx (not just <500 — a 4xx
            // means the rewind didn't actually progress), stop_reason='end_turn'
            // (mid-tool-use turns aren't forkable navigation points), and
            // pending.synthetic populated (pre-v0.5 daemon TOBEs lack it).
            //
            // The work happens here (not inside emitTerminal) because building
            // the synthetic body requires async I/O — loading R1's request +
            // response blobs through the StorageProvider, walking the link
            // structure, hashing the synthetic body. Doing it inline keeps
            // emitTerminal sync (it's also called from the upstream-error and
            // client-abort sync paths above).
            //
            // Failure is loud-but-non-fatal: if the synthetic body can't be
            // built, emit fork.synthesis_failed for the audit trail and skip
            // the SR. The rewind itself still applied (TOBE was consumed,
            // R_new exists) — we just won't have a navigation marker for it.
            if (
              pending
              && pending.synthetic
              && status >= 200
              && status < 300
              && stopReason === 'end_turn'
              && ctx.db
            ) {
              const s = pending.synthetic
              const storageProvider = new SqliteStorageProvider(ctx.db)
              try {
                const built = await buildSyntheticAsset(
                  { db: ctx.db, storageProvider },
                  {
                    parentRevisionId: s.parent_revision_id,
                    syntheticToolResultText: s.synthetic_tool_result_text,
                    syntheticAssistantText: s.synthetic_assistant_text,
                    toolUseId: s.tool_use_id,
                  },
                )
                if (built) {
                  ctx.producer.emit(
                    'fork.forked',
                    {
                      kind: s.kind,
                      synthetic_revision_id: s.synthetic_revision_id,
                      parent_revision_id: s.parent_revision_id,
                      target_revision_id: pending.fork_point_revision_id,
                      to_revision_id: requestEvent.id,
                      synthetic_tool_result_text: s.synthetic_tool_result_text,
                      synthetic_assistant_text: s.synthetic_assistant_text,
                      synthetic_user_message: s.synthetic_user_message,
                      tool_use_id: s.tool_use_id,
                      target_view_id: s.target_view_id,
                      sealed_at: s.back_requested_at,
                      synthetic_asset_cid: built.topCid,
                    },
                    sessionId,
                    built.refs,
                  )
                }
                else {
                  ctx.producer.emit(
                    'fork.synthesis_failed',
                    {
                      parent_revision_id: s.parent_revision_id,
                      target_revision_id: pending.fork_point_revision_id,
                      error_message: 'buildSyntheticAsset returned null (R1 blob missing or unparseable)',
                    },
                    sessionId,
                  )
                }
              }
              catch (synthErr) {
                const errMsg = (synthErr as Error).message ?? String(synthErr)
                ctx.producer.emit(
                  'fork.synthesis_failed',
                  {
                    parent_revision_id: s.parent_revision_id,
                    target_revision_id: pending.fork_point_revision_id,
                    error_message: `buildSyntheticAsset threw: ${errMsg}`,
                  },
                  sessionId,
                )
              }
            }
            else if (
              pending
              && !pending.synthetic
              && status >= 200
              && status < 300
              && stopReason === 'end_turn'
            ) {
              console.warn(
                `[proxy-handler] TOBE consumed for session=${sessionId} but `
                + `pending.synthetic is missing — likely written by a pre-v0.5 daemon. `
                + `Skipping fork.forked emission; no SR will materialize.`,
              )
            }
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
