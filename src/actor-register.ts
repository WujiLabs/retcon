// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// POST /actor/register handler. retcon CLI hits this at launch with the
// transport id it minted (or adopted from --session-id) and the actor it
// was launched under. We persist the (transport_id, actor) pair in the
// `pending_actors` table so the sessions_v1 projector can stamp it on the
// session row when the first event arrives.
//
// Persistent (vs in-memory) so a daemon restart between CLI register-time
// and the first event landing doesn't lose the actor. Stale entries are
// pruned by the projector on consume; any rows older than an hour are
// garbage-collected on daemon startup.

import http from 'node:http'

import type { DB } from './db.js'
import { ACTOR_RE } from './util/actor-name.js'
import { readBoundedBody } from './util/http-body.js'

const REGISTER_MAX_BODY_BYTES = 4 * 1024
const TRANSPORT_RE = /^[A-Za-z0-9_-]{1,128}$/

interface RegisterPayload {
  transport_id?: unknown
  actor?: unknown
}

export async function handleActorRegister(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: DB,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain', 'allow': 'POST' })
    res.end('method not allowed\n')
    return
  }

  let raw: Buffer
  try {
    raw = await readBoundedBody(req, REGISTER_MAX_BODY_BYTES)
  }
  catch {
    res.writeHead(413, { 'content-type': 'text/plain' })
    res.end('register body too large\n')
    return
  }

  let body: RegisterPayload
  try {
    body = JSON.parse(raw.toString('utf8')) as RegisterPayload
  }
  catch {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('register body must be JSON\n')
    return
  }

  const transportId = typeof body.transport_id === 'string' ? body.transport_id : ''
  const actor = typeof body.actor === 'string' ? body.actor : ''
  if (!TRANSPORT_RE.test(transportId)) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('transport_id missing or malformed\n')
    return
  }
  if (!ACTOR_RE.test(actor)) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('actor missing or malformed\n')
    return
  }

  // INSERT OR REPLACE: if the same transport id is registered twice (rare,
  // but harmless — e.g. a CLI retried after a transient failure), the latest
  // value wins.
  db.prepare(`
    INSERT INTO pending_actors (transport_id, actor, registered_at)
    VALUES (?, ?, ?)
    ON CONFLICT(transport_id) DO UPDATE SET
      actor = excluded.actor,
      registered_at = excluded.registered_at
  `).run(transportId, actor, Date.now())

  res.writeHead(204)
  res.end()
}
