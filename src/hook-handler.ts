// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// HTTP hook receiver for Claude Code's SessionStart hook.
//
// Claude Code POSTs a JSON body to a configured URL on session start (and on
// resume / clear / compact). We use this to learn the actual session_id for
// resumed sessions — at retcon CLI startup we only have a binding_token T
// (passed via x-playtiss-session header). The hook arrives with claude's
// session_id and our binding_token (echoed via the hook's headers config),
// letting the daemon rebind T → claude's actual session_id.
//
// The hook payload shape (per Claude Code docs):
//   { session_id: string, source: "startup"|"resume"|"clear"|"compact", ... }
//
// We don't care about `source` here — rebind is idempotent and a no-op when
// transport id already equals session_id (the new-session case).

import http from 'node:http'
import type { BindingTable } from './binding-table.js'
import { rebindSession } from './binding-table.js'
import type { DB } from './db.js'
import type { EventProducer } from './events.js'
import { SESSION_HEADER } from './proxy-handler.js'

const HOOK_MAX_BODY_BYTES = 64 * 1024

export interface HookContext {
  readonly db: DB
  readonly bindingTable: BindingTable
  readonly producer: EventProducer
}

export async function handleSessionStartHook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HookContext,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain', 'allow': 'POST' })
    res.end('method not allowed\n')
    return
  }

  const transportId = readBindingHeader(req)
  if (!transportId) {
    // Hook fired but we have no binding_token to rebind against. Either retcon
    // didn't install the hook (someone else did) or the header was stripped.
    // Acknowledge so claude doesn't error, but log via 200 + empty.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"continue":true}\n')
    return
  }

  let body: Buffer
  try {
    body = await readBody(req)
  }
  catch {
    res.writeHead(413, { 'content-type': 'text/plain' })
    res.end('hook body too large\n')
    return
  }

  let payload: { session_id?: unknown, source?: unknown }
  try {
    payload = JSON.parse(body.toString('utf8')) as typeof payload
  }
  catch {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('hook body must be JSON\n')
    return
  }

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined
  if (!sessionId) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('hook payload missing session_id\n')
    return
  }

  // Same transport_id and session_id → new-session path, no-op rebind.
  if (transportId !== sessionId) {
    // Order matters: register the in-memory binding BEFORE the SQL rebind.
    // If a /v1/* request lands in the window between transaction commit and
    // bindingTable.set, it would otherwise resolve transportId → transportId
    // (binding not yet known) and write events under the stale id. Setting
    // the binding first means concurrent traffic immediately routes to the
    // new sessionId; the rebind transaction then migrates any events that
    // historically landed under transportId before the hook fired.
    ctx.bindingTable.set(transportId, sessionId)
    rebindSession(ctx.db, transportId, sessionId)
    ctx.producer.emit(
      'session.rebound',
      { binding_token: transportId, session_id: sessionId, source: typeof payload.source === 'string' ? payload.source : null },
      sessionId,
    )
  }
  else {
    ctx.bindingTable.set(transportId, sessionId)
  }

  // Respond with continue=true so claude proceeds without injecting any
  // additional context. Empty additionalContext is the documented "I have
  // nothing to add" form.
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"continue":true}\n')
}

function readBindingHeader(req: http.IncomingMessage): string | undefined {
  const raw = req.headers[SESSION_HEADER]
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  return raw.split(',')[0].trim() || undefined
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finishOverflow = (): void => {
      if (settled) return
      settled = true
      // Tear down the socket so a slow-loris client can't pin the connection
      // by streaming bytes-past-the-limit indefinitely.
      req.destroy()
      reject(new Error('overflow'))
    }
    req.on('data', (c: Buffer) => {
      if (settled) return
      total += c.length
      if (total > HOOK_MAX_BODY_BYTES) {
        finishOverflow()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}
