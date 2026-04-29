// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// HTTP-driven coverage for handleSessionStartHook. The hook is the only
// way the daemon learns claude's actual session_id when /actor/register
// + /v1/* arrived under a binding token. Regressions here (drop the
// rebind, swallow ActorConflictError, fail to NULL branch_context_json
// on /clear) only surface in the gated tmux assumption suite. Drive
// every branch directly through node:http.

import http from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BindingTable } from '../binding-table.js'
import { type DB, migrate, openDb } from '../db.js'
import { createEventProducer, type EventProducer } from '../events.js'
import { handleSessionStartHook } from '../hook-handler.js'
import { SESSION_HEADER } from '../proxy-handler.js'

interface PostResponse {
  status: number
  body: string
}

function startServer(
  db: DB,
  bindingTable: BindingTable,
  producer: EventProducer,
): Promise<{ port: number, close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleSessionStartHook(req, res, { db, bindingTable, producer })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        resolve({
          port: addr.port,
          close: () => new Promise<void>(r => server.close(() => r())),
        })
      }
      else {
        reject(new Error('no address'))
      }
    })
  })
}

function post(
  port: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<PostResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c as Buffer))
        res.on('end', () => resolve({
          status: res.statusCode!,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

function eventsForTopic(db: DB, topic: string): unknown[] {
  return (db.prepare(`SELECT payload FROM events WHERE topic = ?`).all(topic) as Array<{ payload: string }>)
    .map(r => JSON.parse(r.payload) as unknown)
}

describe('handleSessionStartHook', () => {
  let db: DB
  let bindingTable: BindingTable
  let producer: EventProducer
  let port: number
  let close: () => Promise<void>

  beforeEach(async () => {
    db = openDb({ path: ':memory:' })
    migrate(db)
    bindingTable = new BindingTable()
    producer = createEventProducer(db, [])
    const s = await startServer(db, bindingTable, producer)
    port = s.port
    close = s.close
  })
  afterEach(async () => {
    await close()
    db.close()
  })

  it('returns 405 on GET', async () => {
    expect((await post(port, '', {}, 'GET')).status).toBe(405)
  })

  it('returns 200 + continue:true with no x-playtiss-session header (no rebind possible)', async () => {
    const r = await post(port, JSON.stringify({ session_id: 'sid-1', source: 'startup' }))
    expect(r.status).toBe(200)
    expect(r.body).toMatch(/continue/)
  })

  it('rejects oversized bodies (slow-loris guard destroys socket)', async () => {
    // HOOK_MAX_BODY_BYTES = 64 KB. Send 128 KB.
    const huge = Buffer.alloc(128 * 1024)
    await expect(post(port, huge, { [SESSION_HEADER]: 'tid-x' })).rejects.toThrow()
  })

  it('returns 400 on non-JSON body', async () => {
    const r = await post(port, 'not-json', { [SESSION_HEADER]: 'tid' })
    expect(r.status).toBe(400)
  })

  it('returns 400 when payload is missing session_id', async () => {
    const r = await post(port, JSON.stringify({ source: 'startup' }), { [SESSION_HEADER]: 'tid' })
    expect(r.status).toBe(400)
    expect(r.body).toMatch(/session_id/)
  })

  it('returns 200 + same transport_id == session_id is a no-op', async () => {
    const r = await post(
      port,
      JSON.stringify({ session_id: 'tid-same', source: 'startup' }),
      { [SESSION_HEADER]: 'tid-same' },
    )
    expect(r.status).toBe(200)
    // No session.rebound event should have been emitted.
    expect(eventsForTopic(db, 'session.rebound')).toHaveLength(0)
  })

  it('rebinds T → claude session_id and emits session.rebound', async () => {
    const r = await post(
      port,
      JSON.stringify({ session_id: 'claude-sid', source: 'resume' }),
      { [SESSION_HEADER]: 'binding-T' },
    )
    expect(r.status).toBe(200)
    expect(bindingTable.resolve('binding-T')).toBe('claude-sid')
    const rebound = eventsForTopic(db, 'session.rebound') as Array<{
      binding_token: string
      session_id: string
      source: string
    }>
    expect(rebound).toHaveLength(1)
    expect(rebound[0]).toMatchObject({
      binding_token: 'binding-T',
      session_id: 'claude-sid',
      source: 'resume',
    })
  })

  it('returns 409 + emits session.actor_conflict + unsets bindingTable on ActorConflictError', async () => {
    // Seed a session under the new id with actor=alice and a pending entry
    // tagged bob under the binding token. The rebind transaction will throw
    // ActorConflictError; we want the in-memory binding rolled back too.
    db.prepare('INSERT INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)')
      .run('claude-sid', 'task-c', 'alice', Date.now(), 'claude-code')
    db.prepare('INSERT INTO pending_actors (transport_id, actor, registered_at) VALUES (?, ?, ?)')
      .run('binding-T', 'bob', Date.now())

    const r = await post(
      port,
      JSON.stringify({ session_id: 'claude-sid', source: 'resume' }),
      { [SESSION_HEADER]: 'binding-T' },
    )
    expect(r.status).toBe(409)
    expect(r.body).toMatch(/actor_conflict/)
    // bindingTable.unset rolled back the speculative set.
    expect(bindingTable.size()).toBe(0)
    // Audit event was emitted with both actors.
    const conflicts = eventsForTopic(db, 'session.actor_conflict') as Array<{
      existing_actor: string
      requested_actor: string
    }>
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ existing_actor: 'alice', requested_actor: 'bob' })
  })

  it('NULLs branch_context_json + emits session.branch_context_cleared on /clear', async () => {
    db.prepare('INSERT INTO sessions (id, task_id, actor, created_at, harness, branch_context_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run('sid-clear', 'task-clear', 'default', Date.now(), 'claude-code', JSON.stringify([{ role: 'user', content: 'forked' }]))
    const r = await post(
      port,
      JSON.stringify({ session_id: 'sid-clear', source: 'clear' }),
      { [SESSION_HEADER]: 'sid-clear' },
    )
    expect(r.status).toBe(200)
    const row = db.prepare('SELECT branch_context_json FROM sessions WHERE id=?').get('sid-clear') as { branch_context_json: string | null }
    expect(row.branch_context_json).toBeNull()
    const cleared = eventsForTopic(db, 'session.branch_context_cleared') as Array<{ source: string }>
    expect(cleared).toHaveLength(1)
    expect(cleared[0].source).toBe('clear')
  })

  it('NULLs branch_context_json + emits session.branch_context_cleared on /compact', async () => {
    db.prepare('INSERT INTO sessions (id, task_id, actor, created_at, harness, branch_context_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run('sid-comp', 'task-comp', 'default', Date.now(), 'claude-code', JSON.stringify([{ role: 'user', content: 'x' }]))
    const r = await post(
      port,
      JSON.stringify({ session_id: 'sid-comp', source: 'compact' }),
      { [SESSION_HEADER]: 'sid-comp' },
    )
    expect(r.status).toBe(200)
    const row = db.prepare('SELECT branch_context_json FROM sessions WHERE id=?').get('sid-comp') as { branch_context_json: string | null }
    expect(row.branch_context_json).toBeNull()
    const cleared = eventsForTopic(db, 'session.branch_context_cleared') as Array<{ source: string }>
    expect(cleared.find(c => c.source === 'compact')).toBeTruthy()
  })

  it('does NOT emit branch_context_cleared on startup (no clear-source)', async () => {
    db.prepare('INSERT INTO sessions (id, task_id, actor, created_at, harness, branch_context_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run('sid-startup', 'task-s', 'default', Date.now(), 'claude-code', JSON.stringify([{ role: 'user', content: 'x' }]))
    await post(
      port,
      JSON.stringify({ session_id: 'sid-startup', source: 'startup' }),
      { [SESSION_HEADER]: 'sid-startup' },
    )
    // branch_context_json untouched.
    const row = db.prepare('SELECT branch_context_json FROM sessions WHERE id=?').get('sid-startup') as { branch_context_json: string | null }
    expect(row.branch_context_json).not.toBeNull()
    expect(eventsForTopic(db, 'session.branch_context_cleared')).toHaveLength(0)
  })
})
