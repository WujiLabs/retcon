// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Integration tests for the /v1/* pass-through.
//
// Each test spins up a mock upstream (plain Node http) to play the role of
// api.anthropic.com, then starts the proxy pointed at that mock. We inspect
// the `events` table to assert what was recorded.

import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDb, type DB } from '../db.js'
import { createEventConsumer, createEventProducer, type EventProducer } from '../events.js'
import { SESSION_HEADER } from '../proxy-handler.js'
import { REDACTED_VALUE } from '../redaction.js'
import { startServer, type ServerHandle } from '../server.js'
import { createTobeStore, type TobeStore } from '../tobe.js'

type MockHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
) => void

async function startMock(handler: MockHandler): Promise<{ port: number, close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => handler(req, res, Buffer.concat(chunks)))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    port,
    close: () => new Promise<void>((done, fail) => server.close(err => (err ? fail(err) : done()))),
  }
}

function fixture() {
  const db = openDb({ path: ':memory:' })
  migrate(db)
  const producer: EventProducer = createEventProducer(db, [])
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'proxy-ph-test-'))
  const tobeStore: TobeStore = createTobeStore(tmpRoot)
  return {
    db,
    producer,
    tobeStore,
    tmpRoot,
    cleanup: () => rmSync(tmpRoot, { recursive: true, force: true }),
  }
}

async function waitForEvent(db: DB, topic: string, timeoutMs = 2000): Promise<unknown> {
  const consumer = createEventConsumer(db)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [evt] = consumer.poll(`_test_probe_${Math.random()}`, [topic], 1)
    if (evt) return evt.payload
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${topic}`)
}

describe('proxy pass-through + event emission', () => {
  let fx: ReturnType<typeof fixture>
  let mock: Awaited<ReturnType<typeof startMock>> | undefined
  let proxy: ServerHandle | undefined

  beforeEach(() => {
    fx = fixture()
  })

  afterEach(async () => {
    if (proxy) {
      await proxy.close()
      proxy = undefined
    }
    if (mock) {
      await mock.close()
      mock = undefined
    }
    fx.cleanup()
  })

  it('forwards a non-streaming /v1/messages and records expected events', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
      }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer sk-ant-SUPERSECRET',
        [SESSION_HEADER]: 'sess-1',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { stop_reason: string }
    expect(body.stop_reason).toBe('end_turn')

    const requestPayload = await waitForEvent(fx.db, 'proxy.request_received') as {
      method: string
      path: string
      headers_cid: string
      body_cid: string
    }
    expect(requestPayload.method).toBe('POST')
    expect(requestPayload.path).toBe('/v1/messages')
    // Header blob must NOT contain the authorization value.
    const headerBlob = fx.db
      .prepare('SELECT bytes FROM blobs WHERE cid=?')
      .get(requestPayload.headers_cid) as { bytes: Uint8Array }
    const headerJson = Buffer.from(headerBlob.bytes).toString('utf8')
    expect(headerJson).toContain(REDACTED_VALUE)
    expect(headerJson).not.toContain('SUPERSECRET')

    const responsePayload = await waitForEvent(fx.db, 'proxy.response_completed') as {
      request_event_id: string
      status: number
      stop_reason: string | null
    }
    expect(responsePayload.status).toBe(200)
    expect(responsePayload.stop_reason).toBe('end_turn')
  })

  it('extracts stop_reason from a streaming SSE response', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (evt: string, data: object) =>
        res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`)
      frame('message_start', { type: 'message_start', message: { id: 'msg_1' } })
      frame('content_block_start', { type: 'content_block_start', index: 0 })
      frame('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })
      frame('content_block_stop', { type: 'content_block_stop', index: 0 })
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} })
      frame('message_stop', { type: 'message_stop' })
      res.end()
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: 'sess-sse' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.status).toBe(200)
    await res.text()  // drain

    const responsePayload = await waitForEvent(fx.db, 'proxy.response_completed') as {
      stop_reason: string | null
    }
    expect(responsePayload.stop_reason).toBe('end_turn')
  })

  it('consumes a pending TOBE and carries tobe_applied_from in the event payload', async () => {
    mock = await startMock((_req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        echoed_messages: JSON.parse(body.toString('utf8')).messages,
        stop_reason: 'end_turn',
      }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const sessionId = 'sess-tobe'
    fx.tobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'rewritten' }],
      fork_point_version_id: 'ver-fork-point-xyz',
      source_view_id: 'view-origin',
    })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'ORIGINAL' }] }),
    })
    const body = await res.json() as { echoed_messages: Array<{ content: string }> }
    expect(body.echoed_messages[0].content).toBe('rewritten')

    const reqPayload = await waitForEvent(fx.db, 'proxy.request_received') as {
      tobe_applied_from?: { fork_point_version_id: string, source_view_id: string, original_body_cid: string }
    }
    expect(reqPayload.tobe_applied_from).toBeDefined()
    expect(reqPayload.tobe_applied_from!.fork_point_version_id).toBe('ver-fork-point-xyz')
    expect(reqPayload.tobe_applied_from!.source_view_id).toBe('view-origin')
    expect(typeof reqPayload.tobe_applied_from!.original_body_cid).toBe('string')

    // TOBE should have been consumed.
    expect(fx.tobeStore.consume(sessionId)).toBeNull()
  })

  it('emits proxy.upstream_error when upstream is unreachable', async () => {
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: 'http://127.0.0.1:1',  // port 1 is reserved / unreachable
    })
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: 'sess-err' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    expect(res.status).toBe(502)
    const payload = await waitForEvent(fx.db, 'proxy.upstream_error') as { status: number }
    expect(payload.status).toBe(502)
  })
})
