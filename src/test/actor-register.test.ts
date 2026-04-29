// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// HTTP-driven coverage for /actor/register. Exercises every guarded
// error path (405, 413, 400×3) plus the happy 204, the
// INSERT-OR-REPLACE second-write-wins semantics, and the daemon-
// startup pending_actors GC sweep that runs in cli/daemon.ts.

import http from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { handleActorRegister } from '../actor-register.js'
import { type DB, migrate, openDb } from '../db.js'

interface PostResponse {
  status: number
  body: string
}

function startServer(db: DB): Promise<{ port: number, close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleActorRegister(req, res, db)
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

function post(port: number, body: string | Buffer, method = 'POST'): Promise<PostResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method,
        headers: { 'content-type': 'application/json' },
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

describe('handleActorRegister', () => {
  let db: DB
  let port: number
  let close: () => Promise<void>

  beforeEach(async () => {
    db = openDb({ path: ':memory:' })
    migrate(db)
    const s = await startServer(db)
    port = s.port
    close = s.close
  })
  afterEach(async () => {
    await close()
    db.close()
  })

  it('returns 405 on GET', async () => {
    expect((await post(port, '', 'GET')).status).toBe(405)
  })

  it('rejects on oversized body (server destroys socket; client sees hang-up)', async () => {
    // The 4 KB cap is enforced via readBoundedBody, which destroys the
    // socket on overflow as a slow-loris guard. The 413 the handler tries
    // to write never reaches the client because the socket is already
    // gone. We assert the client-visible behavior: the request rejects.
    const huge = Buffer.alloc(8 * 1024)
    await expect(post(port, huge)).rejects.toThrow()
  })

  it('returns 400 on non-JSON body', async () => {
    expect((await post(port, 'not-json')).status).toBe(400)
  })

  it('returns 400 on missing transport_id', async () => {
    const r = await post(port, JSON.stringify({ actor: 'alice' }))
    expect(r.status).toBe(400)
    expect(r.body).toMatch(/transport_id/)
  })

  it('returns 400 on transport_id with disallowed chars', async () => {
    const r = await post(port, JSON.stringify({ transport_id: 'has space', actor: 'alice' }))
    expect(r.status).toBe(400)
    expect(r.body).toMatch(/transport_id/)
  })

  it('returns 400 on actor with disallowed chars', async () => {
    const r = await post(port, JSON.stringify({ transport_id: 'tid-1', actor: 'has;semi' }))
    expect(r.status).toBe(400)
    expect(r.body).toMatch(/actor/)
  })

  it('returns 204 on happy path and INSERTs into pending_actors', async () => {
    const r = await post(port, JSON.stringify({ transport_id: 'tid-happy', actor: 'alice' }))
    expect(r.status).toBe(204)
    const row = db
      .prepare('SELECT actor FROM pending_actors WHERE transport_id=?')
      .get('tid-happy') as { actor: string } | undefined
    expect(row?.actor).toBe('alice')
  })

  it('INSERT OR REPLACE: second register overwrites the first', async () => {
    await post(port, JSON.stringify({ transport_id: 'tid-r', actor: 'alice' }))
    await post(port, JSON.stringify({ transport_id: 'tid-r', actor: 'bob' }))
    const row = db
      .prepare('SELECT actor FROM pending_actors WHERE transport_id=?')
      .get('tid-r') as { actor: string } | undefined
    expect(row?.actor).toBe('bob')
  })
})

describe('pending_actors startup GC sweep (1 hour)', () => {
  let db: DB
  beforeEach(() => {
    db = openDb({ path: ':memory:' })
    migrate(db)
  })
  afterEach(() => db.close())

  it('deletes rows older than 1 hour, keeps newer ones', () => {
    const now = Date.now()
    const stale = now - (3600_000 + 60_000) // 1h 1m old
    const fresh = now - 60_000 // 1m old
    db.prepare('INSERT INTO pending_actors (transport_id, actor, registered_at) VALUES (?, ?, ?)')
      .run('stale-tid', 'alice', stale)
    db.prepare('INSERT INTO pending_actors (transport_id, actor, registered_at) VALUES (?, ?, ?)')
      .run('fresh-tid', 'bob', fresh)

    // Same statement that runs in runDaemon() at startup.
    db.prepare('DELETE FROM pending_actors WHERE registered_at < ?')
      .run(now - 3600_000)

    const rows = db.prepare('SELECT transport_id FROM pending_actors').all() as Array<{ transport_id: string }>
    expect(rows.map(r => r.transport_id)).toEqual(['fresh-tid'])
  })
})
