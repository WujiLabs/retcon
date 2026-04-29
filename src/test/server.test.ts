// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type DB, migrate, openDb } from '../db.js'
import { createEventProducer, type EventProducer } from '../events.js'
import { type ServerHandle, startServer } from '../server.js'
import { createTobeStore, type TobeStore } from '../tobe.js'

function fixture(): {
  db: DB
  producer: EventProducer
  tobeStore: TobeStore
  tmpRoot: string
  cleanup: () => void
} {
  const db = openDb({ path: ':memory:' })
  migrate(db)
  const producer = createEventProducer(db, [])
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'playtiss-proxy-test-'))
  const tobeStore = createTobeStore(tmpRoot)
  return { db, producer, tobeStore, tmpRoot, cleanup: () => rmSync(tmpRoot, { recursive: true, force: true }) }
}

describe('startServer routing', () => {
  let handle: ServerHandle | undefined
  let fx: ReturnType<typeof fixture> | undefined

  beforeEach(() => {
    fx = fixture()
  })

  afterEach(async () => {
    if (handle) {
      await handle.close()
      handle = undefined
    }
    if (fx) {
      fx.cleanup()
      fx = undefined
    }
  })

  async function get(p: string): Promise<{ status: number, body: string }> {
    const res = await fetch(`http://127.0.0.1:${handle!.port}${p}`)
    const body = await res.text()
    return { status: res.status, body }
  }

  it('serves /health as JSON identity + status', async () => {
    handle = await startServer({
      port: 0,
      producer: fx!.producer,
      tobeStore: fx!.tobeStore,
      db: fx!.db,
    })
    const { status, body } = await get('/health')
    expect(status).toBe(200)
    const parsed = JSON.parse(body) as {
      name: string
      version: string
      port: number
      pid: number
      started_at: number
      uptime_s: number
      sessions: number
      db_size_bytes: number
    }
    expect(parsed.name).toBe('retcon')
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/)
    expect(parsed.port).toBe(handle!.port)
    expect(parsed.pid).toBe(process.pid)
    expect(parsed.started_at).toBeGreaterThan(0)
    expect(parsed.uptime_s).toBeGreaterThanOrEqual(0)
    // Empty in-memory DB → 0 sessions, 0 db_size_bytes (no path provided).
    expect(parsed.sessions).toBe(0)
    expect(parsed.db_size_bytes).toBe(0)
  })

  it('/mcp GET returns 200 with text/event-stream (spec-compliant SSE open)', async () => {
    handle = await startServer({ port: 0, producer: fx!.producer, tobeStore: fx!.tobeStore })
    // GET /mcp holds the SSE stream open; assert headers then abort so the
    // afterEach close() doesn't wait on a never-terminating response.
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    controller.abort()
  })

  it('/mcp 405s on unsupported methods', async () => {
    handle = await startServer({ port: 0, producer: fx!.producer, tobeStore: fx!.tobeStore })
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: 'PUT' })
    expect(res.status).toBe(405)
  })

  it('returns 404 for unknown paths', async () => {
    handle = await startServer({ port: 0, producer: fx!.producer, tobeStore: fx!.tobeStore })
    const { status } = await get('/nope')
    expect(status).toBe(404)
  })
})
