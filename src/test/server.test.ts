// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDb, type DB } from '../db.js'
import { createEventProducer, type EventProducer } from '../events.js'
import { startServer, type ServerHandle } from '../server.js'
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

  it('serves /health', async () => {
    handle = await startServer({ port: 0, producer: fx!.producer, tobeStore: fx!.tobeStore })
    const { status, body } = await get('/health')
    expect(status).toBe(200)
    expect(body.trim()).toBe('ok')
  })

  it('stubs /mcp with 501', async () => {
    handle = await startServer({ port: 0, producer: fx!.producer, tobeStore: fx!.tobeStore })
    const { status } = await get('/mcp')
    expect(status).toBe(501)
  })

  it('returns 404 for unknown paths', async () => {
    handle = await startServer({ port: 0, producer: fx!.producer, tobeStore: fx!.tobeStore })
    const { status } = await get('/nope')
    expect(status).toBe(404)
  })
})
