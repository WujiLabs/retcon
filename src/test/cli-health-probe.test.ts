// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unit tests for the port + identity probe used by retcon's daemon-control.

import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { probeHealth } from '../cli/health-probe.js'

interface StubServer {
  port: number
  close: () => Promise<void>
}

async function startStub(handler: http.RequestListener): Promise<StubServer> {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    port,
    close: () => new Promise<void>(done => server.close(() => done())),
  }
}

async function findFreePort(): Promise<number> {
  // Bind to an ephemeral port, capture it, close — that port is then very
  // likely free for a probeHealth call. Race-prone in theory; fine for tests.
  const s = await startStub(() => undefined)
  await s.close()
  return s.port
}

describe('probeHealth', () => {
  let stub: StubServer | undefined

  afterEach(async () => {
    if (stub) {
      await stub.close()
      stub = undefined
    }
  })

  it('returns "free" when nothing is listening', async () => {
    const port = await findFreePort()
    const r = await probeHealth(port, '0.1.0-alpha.0', { timeoutMs: 500 })
    expect(r.kind).toBe('free')
  })

  it('returns "match" when /health JSON name+version match', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'retcon', version: '0.1.0-alpha.0', port: 9999 }))
    })
    const r = await probeHealth(stub.port, '0.1.0-alpha.0', { timeoutMs: 500 })
    expect(r.kind).toBe('match')
    if (r.kind === 'match') {
      expect(r.snapshot.version).toBe('0.1.0-alpha.0')
    }
  })

  it('returns "mismatch" when version differs', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'retcon', version: '0.0.9' }))
    })
    const r = await probeHealth(stub.port, '0.1.0-alpha.0', { timeoutMs: 500 })
    expect(r.kind).toBe('mismatch')
  })

  it('returns "foreign" when name is not retcon', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'something-else', version: '0.1.0-alpha.0' }))
    })
    const r = await probeHealth(stub.port, '0.1.0-alpha.0', { timeoutMs: 500 })
    expect(r.kind).toBe('foreign')
    if (r.kind === 'foreign') expect(r.reason).toMatch(/something-else/)
  })

  it('returns "foreign" when /health response is not JSON', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('not json at all\n')
    })
    const r = await probeHealth(stub.port, '0.1.0-alpha.0', { timeoutMs: 500 })
    expect(r.kind).toBe('foreign')
    if (r.kind === 'foreign') expect(r.reason).toMatch(/JSON parse failed/)
  })

  it('returns "foreign" when /health JSON is missing required fields', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ port: 4099 }))
    })
    const r = await probeHealth(stub.port, '0.1.0-alpha.0', { timeoutMs: 500 })
    expect(r.kind).toBe('foreign')
    if (r.kind === 'foreign') expect(r.reason).toMatch(/missing name\/version/)
  })

  it('returns "foreign" when /health returns 500', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom\n')
    })
    const r = await probeHealth(stub.port, '0.1.0-alpha.0', { timeoutMs: 500 })
    expect(r.kind).toBe('foreign')
    if (r.kind === 'foreign') expect(r.reason).toMatch(/500/)
  })

  it('returns "foreign" when /health hangs past the timeout', async () => {
    stub = await startStub(() => {
      // Never respond; let the probe time out. Connection is still open.
    })
    const r = await probeHealth(stub.port, '0.1.0-alpha.0', { timeoutMs: 200 })
    expect(r.kind).toBe('foreign')
    if (r.kind === 'foreign') expect(r.reason).toMatch(/timed out|timeout/i)
  })
})
