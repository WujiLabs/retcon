// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from 'vitest'
import { startServer, type ServerHandle } from '../server.js'

describe('startServer routing', () => {
  let handle: ServerHandle | undefined

  afterEach(async () => {
    if (handle) {
      await handle.close()
      handle = undefined
    }
  })

  async function get(path: string): Promise<{ status: number, body: string }> {
    const res = await fetch(`http://127.0.0.1:${handle!.port}${path}`)
    const body = await res.text()
    return { status: res.status, body }
  }

  it('serves /health', async () => {
    handle = await startServer({ port: 0 })
    const { status, body } = await get('/health')
    expect(status).toBe(200)
    expect(body.trim()).toBe('ok')
  })

  it('stubs /mcp with 501', async () => {
    handle = await startServer({ port: 0 })
    const { status } = await get('/mcp')
    expect(status).toBe(501)
  })

  it('stubs /v1/messages with 501', async () => {
    handle = await startServer({ port: 0 })
    const { status } = await get('/v1/messages')
    expect(status).toBe(501)
  })

  it('returns 404 for unknown paths', async () => {
    handle = await startServer({ port: 0 })
    const { status } = await get('/nope')
    expect(status).toBe(404)
  })
})
