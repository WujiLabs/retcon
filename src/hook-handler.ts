// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// HTTP hook receiver for Claude Code's SessionStart hook.
//
// Claude Code POSTs a JSON body to this URL whenever a session lifecycle
// event fires. Single hook event, four sources:
//
//   startup  — fresh `claude` invocation. We bind T → claude session_id.
//   resume   — `claude --resume`. We rebind T → claude actual session_id
//              and merge any events that landed under T pre-hook.
//   clear    — user typed `/clear`. claude wiped its local conversation;
//              we drop sessions.branch_context_json so the next /v1/messages
//              isn't rewritten with a now-stale forked context.
//   compact  — user typed `/compact`. claude rebuilt its local jsonl from
//              a summary that already incorporated whatever forked context
//              we'd been feeding it. Continuing to override would just
//              re-inflate the body claude just compressed; clear the
//              override and let claude's compacted view drive future
//              upstream calls.
//
// The hook payload shape (per Claude Code docs):
//   { session_id, source, transcript_path?, cwd?, hook_event_name }

import http from 'node:http'

import type { BindingTable } from './binding-table.js'
import { ActorConflictError, rebindSession } from './binding-table.js'
import type { DB } from './db.js'
import type { EventProducer } from './events.js'
import { SESSION_HEADER } from './proxy-handler.js'
import { readBoundedBody } from './util/http-body.js'

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
    body = await readBoundedBody(req, HOOK_MAX_BODY_BYTES)
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
  const source = typeof payload.source === 'string' ? payload.source : null

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
    try {
      rebindSession(ctx.db, transportId, sessionId)
    }
    catch (err) {
      if (err instanceof ActorConflictError) {
        // Resume specified --actor that disagrees with the resumed session's
        // existing actor. Roll back the speculative bindingTable.set() so
        // in-memory routing matches the rolled-back DB state — otherwise
        // subsequent /v1/* traffic would resolve transportId → sessionId
        // even though the SQL merge never committed. Emit an audit event,
        // return 409 to claude. The hook is advisory so claude continues;
        // new traffic stays attributed to transportId until reconciled.
        ctx.bindingTable.unset(transportId)
        ctx.producer.emit(
          'session.actor_conflict',
          {
            binding_token: transportId,
            session_id: sessionId,
            existing_actor: err.existingActor,
            requested_actor: err.requestedActor,
            source: typeof payload.source === 'string' ? payload.source : null,
          },
          sessionId,
        )
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'actor_conflict', message: err.message }) + '\n')
        return
      }
      throw err
    }
    ctx.producer.emit(
      'session.rebound',
      { binding_token: transportId, session_id: sessionId, source },
      sessionId,
    )
  }
  else {
    ctx.bindingTable.set(transportId, sessionId)
  }

  // Clear any active fork override on /clear or /compact. claude has just
  // dropped or rewritten its local conversation history; persisting our
  // own override past that point would either re-inflate the bytes claude
  // just compressed (compact) or revive a conversation the user explicitly
  // wiped (clear). Either way, hand the wheel back to claude.
  if (source === 'clear' || source === 'compact') {
    const result = ctx.db
      .prepare(`UPDATE sessions SET branch_context_json = NULL
                WHERE id = ? AND branch_context_json IS NOT NULL`)
      .run(sessionId)
    if (result.changes > 0) {
      ctx.producer.emit(
        'session.branch_context_cleared',
        { session_id: sessionId, source },
        sessionId,
      )
    }
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
