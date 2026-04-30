// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Integration tests for the /v1/* pass-through.
//
// Each test spins up a mock upstream (plain Node http) to play the role of
// api.anthropic.com, then starts the proxy pointed at that mock. We inspect
// the `events` table to assert what was recorded.

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type DB, migrate, openDb } from '../db.js'
import { createEventConsumer, createEventProducer, type EventProducer } from '../events.js'
import { capCacheControlBlocks, MAX_CACHE_CONTROL_BLOCKS, SESSION_HEADER } from '../proxy-handler.js'
import { REDACTED_VALUE } from '../redaction.js'
import { defaultProjectors } from '../server.js'
import { type ServerHandle, startServer } from '../server.js'
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
    await res.text() // drain

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
      fork_point_revision_id: 'ver-fork-point-xyz',
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
      tobe_applied_from?: { fork_point_revision_id: string, source_view_id: string, original_body_cid: string }
    }
    expect(reqPayload.tobe_applied_from).toBeDefined()
    expect(reqPayload.tobe_applied_from!.fork_point_revision_id).toBe('ver-fork-point-xyz')
    expect(reqPayload.tobe_applied_from!.source_view_id).toBe('view-origin')
    expect(typeof reqPayload.tobe_applied_from!.original_body_cid).toBe('string')

    // TOBE should have been committed (2xx upstream → file deleted).
    expect(fx.tobeStore.peek(sessionId)).toBeNull()
  })

  it('end-to-end: HTTP call populates sessions + versions projected views', async () => {
    // Use the standard projector chain (sessions_v1 + versions_v1).
    const db = openDb({ path: ':memory:' })
    migrate(db)
    const producer = createEventProducer(db, defaultProjectors())

    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hi' }],
      }))
    })
    proxy = await startServer({
      port: 0,
      producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: 'sess-e2e' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    await res.text()

    // Sessions view: orphan session was bootstrapped.
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-e2e') as
      | { task_id: string, harness: string }
      | undefined
    expect(session).toBeTruthy()
    expect(session!.harness).toBe('orphan')

    // Versions view: one sealed Version with end_turn classification.
    const version = db.prepare(
      `SELECT id, task_id, classification, stop_reason, asset_cid, sealed_at
         FROM revisions WHERE task_id = ?`,
    ).get(session!.task_id) as {
      id: string
      classification: string
      stop_reason: string
      asset_cid: string | null
      sealed_at: number | null
    } | undefined
    expect(version).toBeTruthy()
    expect(version!.classification).toBe('closed_forkable')
    expect(version!.stop_reason).toBe('end_turn')
    // CIDv1 base32 always starts with 'b'; the exact codec prefix varies.
    expect(version!.asset_cid).toMatch(/^b[a-z0-9]+$/)
    expect(version!.sealed_at).toBeGreaterThan(0)

    // Asset blob was persisted alongside the event.
    const assetBlob = db.prepare('SELECT 1 FROM blobs WHERE cid = ?').get(version!.asset_cid)
    expect(assetBlob).toBeTruthy()
  })

  it('emits proxy.upstream_error when upstream is unreachable', async () => {
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: 'http://127.0.0.1:1', // port 1 is reserved / unreachable
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

  it('rejects absolute URLs with 400 (SSRF guard)', async () => {
    // Use a mock upstream we can observe: if SSRF worked, THIS server would
    // see the request. We assert it does NOT.
    let upstreamHit = false
    mock = await startMock((_req, res) => {
      upstreamHit = true
      res.writeHead(200)
      res.end('ok')
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: 'http://127.0.0.1:1', // unreachable; any forwarded request fails
    })

    // Craft an absolute-form request line by hand. `fetch` normalizes paths,
    // so we open a raw TCP socket.
    const net = await import('node:net')
    const response = await new Promise<string>((resolve, reject) => {
      const sock = net.createConnection(proxy!.port, '127.0.0.1', () => {
        const absPath = `http://127.0.0.1:${mock!.port}/v1/messages`
        sock.write(
          `POST ${absPath} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n`,
        )
      })
      const chunks: Buffer[] = []
      sock.on('data', (c: Buffer) => chunks.push(c))
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      sock.on('error', reject)
      setTimeout(() => sock.end(), 500)
    })
    // The key property: the upstream we named in the absolute URL must NOT
    // have been hit. Either the router rejects (404 because path doesn't
    // start with /v1/) or the handler's SSRF guard rejects (400). Both are
    // correct; both prevent the SSRF.
    expect(response).toMatch(/HTTP\/1\.1 (400|404)/)
    expect(upstreamHit).toBe(false)
  })

  it('serializes /v1/messages per session (second request waits for first response to complete)', async () => {
    const order: string[] = []
    let release1: (() => void) | null = null
    mock = await startMock((_req, res, body) => {
      const parsed = JSON.parse(body.toString('utf8')) as { tag: string }
      order.push(`start:${parsed.tag}`)
      const reply = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ stop_reason: 'end_turn' }))
        order.push(`end:${parsed.tag}`)
      }
      if (parsed.tag === 'a') {
        release1 = reply
      }
      else {
        reply()
      }
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })
    const send = (tag: string) => fetch(`http://127.0.0.1:${proxy!.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: 'sess-order' },
      body: JSON.stringify({ tag }),
    }).then(r => r.text())

    const p1 = send('a')
    // Give a beat for p1 to reach the mock.
    await new Promise(r => setTimeout(r, 30))
    const p2 = send('b')
    await new Promise(r => setTimeout(r, 50))

    // At this point, a should have started but b should not have — serialized.
    expect(order).toEqual(['start:a'])
    release1!()
    await Promise.all([p1, p2])
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })

  it('strips hop-by-hop response headers (transfer-encoding, connection)', async () => {
    mock = await startMock((_req, res) => {
      // Write with an explicit hop-by-hop header that must NOT reach the client.
      res.writeHead(200, {
        'content-type': 'application/json',
        'connection': 'close',
        'transfer-encoding': 'chunked',
      })
      res.end(JSON.stringify({ stop_reason: 'end_turn' }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: 'sess-hbh' },
      body: JSON.stringify({}),
    })
    await res.text()
    // Node's fetch normalizes casing. The hop-by-hop headers must not have
    // been forwarded; Node re-frames the response itself.
    expect(res.headers.get('connection')).not.toBe('close')
  })

  it('retains TOBE on upstream 5xx so the next retry re-applies it (A-R8)', async () => {
    let call = 0
    mock = await startMock((_req, res, _body) => {
      call++
      if (call === 1) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'transient upstream failure' }))
      }
      else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ stop_reason: 'end_turn' }))
      }
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })
    const sessionId = 'sess-retry'
    fx.tobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'retry-me' }],
      fork_point_revision_id: 'v-retry-fp',
      source_view_id: 'view-retry',
    })

    // First call — upstream returns 5xx. TOBE must survive.
    const r1 = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ORIG' }] }),
    })
    expect(r1.status).toBe(502)
    expect(fx.tobeStore.peek(sessionId)).not.toBeNull()

    // Second call — upstream returns 2xx. TOBE now commits (deleted).
    const r2 = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ORIG' }] }),
    })
    expect(r2.status).toBe(200)
    expect(fx.tobeStore.peek(sessionId)).toBeNull()
  })

  it('notifies ForkAwaiter on a completed TOBE request (A-R8 scaffolding)', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn' }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })
    const sessionId = 'sess-await'
    fx.tobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'forked' }],
      fork_point_revision_id: 'v-await-fp',
      source_view_id: 'view-await',
    })
    // Register the waiter BEFORE the HTTP call so the awaiter is primed.
    const outcomeP = proxy.forkAwaiter.wait(sessionId, 5000)
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ORIG' }] }),
    })
    await res.text()
    const outcome = await outcomeP
    expect(outcome.status).toBe('completed')
    expect(outcome.http_status).toBe(200)
    expect(outcome.stop_reason).toBe('end_turn')
    expect(outcome.fork_point_revision_id).toBe('v-await-fp')
    expect(outcome.source_view_id).toBe('view-await')
  })

  it('notifies ForkAwaiter with aborted/http_error on upstream failure', async () => {
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: 'http://127.0.0.1:1', // unreachable
    })
    const sessionId = 'sess-await-err'
    fx.tobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'forked' }],
      fork_point_revision_id: 'v-fp',
      source_view_id: 'view-err',
    })
    const outcomeP = proxy.forkAwaiter.wait(sessionId, 5000)
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: JSON.stringify({ messages: [] }),
    })
    const outcome = await outcomeP
    expect(outcome.status).toBe('upstream_error')
    expect(outcome.http_status).toBe(502)
    // TOBE retained for retry — upstream failure.
    expect(fx.tobeStore.peek(sessionId)).not.toBeNull()
  })

  it('does NOT consume TOBE for non-messages /v1/* paths', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })
    const sessionId = 'sess-nontarget'
    fx.tobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'only-apply-to-messages' }],
      fork_point_revision_id: 'v-keep',
      source_view_id: 'view-keep',
    })
    // Hit /v1/models — must NOT consume the pending TOBE.
    await fetch(`http://127.0.0.1:${proxy.port}/v1/models`, {
      method: 'GET',
      headers: { [SESSION_HEADER]: sessionId },
    })
    // TOBE should still be there for the next /v1/messages.
    const stillPending = fx.tobeStore.peek(sessionId)
    expect(stillPending).not.toBeNull()
    expect(stillPending!.fork_point_revision_id).toBe('v-keep')
  })

  it('emits session.branch_context_overflow when fork context grows past 8 MiB', async () => {
    // Seed a session whose branch_context_json is already at the cap, so
    // any suffix from claude's body pushes the next write over.
    const sessionId = 'sess-overflow'
    fx.db.prepare(
      'INSERT INTO sessions (id, task_id, actor, created_at, harness, branch_context_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      sessionId,
      'task-overflow',
      'default',
      Date.now(),
      'claude-code',
      JSON.stringify([{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }]),
    )

    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      db: fx.db,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      // Three messages: first matches branchContext head, second is the
      // assistant intermediate, third is the new user input. The
      // penultimate-user splice would produce a column past the cap.
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'user', content: 'x'.repeat(8 * 1024 * 1024) },
          { role: 'assistant', content: 'a-resp' },
          { role: 'user', content: 'follow-up' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    await res.text()

    const overflowPayload = await waitForEvent(fx.db, 'session.branch_context_overflow') as {
      session_id: string
      max_bytes: number
    }
    expect(overflowPayload.session_id).toBe(sessionId)
    expect(overflowPayload.max_bytes).toBe(8 * 1024 * 1024)

    // Column NULL'd so future requests fall back to claude's local view.
    const row = fx.db
      .prepare('SELECT branch_context_json FROM sessions WHERE id = ?')
      .get(sessionId) as { branch_context_json: string | null }
    expect(row.branch_context_json).toBeNull()
  })
})

// ─── capCacheControlBlocks (pure helper) ────────────────────────────────────

describe('capCacheControlBlocks', () => {
  const cc = (extra: Record<string, unknown> = {}) => ({ type: 'ephemeral', ...extra })

  it('MAX_CACHE_CONTROL_BLOCKS default is 4 (Anthropic limit)', () => {
    expect(MAX_CACHE_CONTROL_BLOCKS).toBe(4)
  })

  it('returns 0 when total markers <= max (no-op)', () => {
    const body = {
      system: [{ type: 'text', text: 's', cache_control: cc() }],
      tools: [{ name: 't1', cache_control: cc() }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q', cache_control: cc() }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      ],
    }
    expect(capCacheControlBlocks(body)).toBe(0)
  })

  it('strips earliest message markers first; tail survives (cache primes next call)', () => {
    // 1 system + 1 tools + 4 message blocks = 6, max=4 → strip 2 EARLIEST.
    // Heading message markers don't hit Anthropic's prompt cache because
    // retcon's spliced prefix changes every turn; tail markers prime the
    // cache for the upcoming call. So we keep the tail.
    const body = {
      system: [{ type: 'text', text: 's', cache_control: cc({ tag: 'sys' }) }],
      tools: [{ name: 't1', cache_control: cc({ tag: 'tool' }) }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q1', cache_control: cc({ tag: 'm1' }) }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1', cache_control: cc({ tag: 'm2' }) }] },
        { role: 'user', content: [{ type: 'text', text: 'q2', cache_control: cc({ tag: 'm3' }) }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2', cache_control: cc({ tag: 'm4' }) }] },
      ],
    }
    const removed = capCacheControlBlocks(body)
    expect(removed).toBe(2)
    // System + tools survived.
    expect(body.system[0]!.cache_control).toBeDefined()
    expect(body.tools[0]!.cache_control).toBeDefined()
    // Earliest message markers stripped (m1, m2) — they don't pay rent.
    expect(body.messages[0]!.content[0]!.cache_control).toBeUndefined()
    expect(body.messages[1]!.content[0]!.cache_control).toBeUndefined()
    // Latest two survived (m3, m4) — these prime the cache for the next call.
    expect(body.messages[2]!.content[0]!.cache_control).toBeDefined()
    expect(body.messages[3]!.content[0]!.cache_control).toBeDefined()
  })

  it('strips multiple markers within the same message from the START', () => {
    // 1 system + 0 tools + message with 5 cache_controls in content[]: total 6, strip 2.
    const body = {
      system: [{ type: 'text', text: 's', cache_control: cc() }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '0', cache_control: cc({ tag: 'b0' }) },
            { type: 'text', text: '1', cache_control: cc({ tag: 'b1' }) },
            { type: 'text', text: '2', cache_control: cc({ tag: 'b2' }) },
            { type: 'text', text: '3', cache_control: cc({ tag: 'b3' }) },
            { type: 'text', text: '4', cache_control: cc({ tag: 'b4' }) },
          ],
        },
      ],
    }
    const removed = capCacheControlBlocks(body)
    expect(removed).toBe(2)
    expect(body.messages[0]!.content[0]!.cache_control).toBeUndefined() // b0 stripped
    expect(body.messages[0]!.content[1]!.cache_control).toBeUndefined() // b1 stripped
    expect(body.messages[0]!.content[2]!.cache_control).toBeDefined() // b2 survived
    expect(body.messages[0]!.content[3]!.cache_control).toBeDefined() // b3 survived
    expect(body.messages[0]!.content[4]!.cache_control).toBeDefined() // b4 survived
  })

  it('handles string `system` (no array) without crashing', () => {
    const body = {
      system: 'plain string system, no cache_control possible',
      tools: [{ name: 't', cache_control: cc() }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q', cache_control: cc() }] },
      ],
    }
    expect(capCacheControlBlocks(body)).toBe(0) // 0 + 1 + 1 = 2 ≤ 4
  })

  it('handles string `content` (no array) without scanning it', () => {
    const body = {
      messages: [
        { role: 'user', content: 'plain string, no cache_control' },
        { role: 'user', content: [{ type: 'text', text: 'q', cache_control: cc() }] },
      ],
    }
    expect(capCacheControlBlocks(body)).toBe(0)
  })

  it('protects system + tools when only messages exceed; never touches them', () => {
    // 2 system + 2 tools = 4 protected (right at cap). Add 3 message markers
    // → total 7, must strip all 3 message markers.
    const body = {
      system: [
        { type: 'text', text: 's0', cache_control: cc() },
        { type: 'text', text: 's1', cache_control: cc() },
      ],
      tools: [
        { name: 't0', cache_control: cc() },
        { name: 't1', cache_control: cc() },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q1', cache_control: cc() }] },
        { role: 'user', content: [{ type: 'text', text: 'q2', cache_control: cc() }] },
        { role: 'user', content: [{ type: 'text', text: 'q3', cache_control: cc() }] },
      ],
    }
    expect(capCacheControlBlocks(body)).toBe(3)
    // All system + tools preserved.
    expect(body.system[0]!.cache_control).toBeDefined()
    expect(body.system[1]!.cache_control).toBeDefined()
    expect(body.tools[0]!.cache_control).toBeDefined()
    expect(body.tools[1]!.cache_control).toBeDefined()
    // All message markers gone.
    expect(body.messages[0]!.content[0]!.cache_control).toBeUndefined()
    expect(body.messages[1]!.content[0]!.cache_control).toBeUndefined()
    expect(body.messages[2]!.content[0]!.cache_control).toBeUndefined()
  })

  it('leaves protected alone when system+tools ALONE exceed the cap (degenerate case)', () => {
    // 5 system markers, no messages. We don't strip from system — Anthropic
    // will 400 but the operator sees a clear signal rather than retcon
    // mangling their config.
    const body = {
      system: Array.from({ length: 5 }, () => ({ type: 'text', text: 's', cache_control: cc() })),
      messages: [],
    }
    expect(capCacheControlBlocks(body)).toBe(0)
    expect(body.system.filter(s => s.cache_control).length).toBe(5)
  })

  it('respects custom max parameter (strips heading; tail survives)', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '0', cache_control: cc() }] },
        { role: 'user', content: [{ type: 'text', text: '1', cache_control: cc() }] },
        { role: 'user', content: [{ type: 'text', text: '2', cache_control: cc() }] },
      ],
    }
    expect(capCacheControlBlocks(body, 1)).toBe(2) // keep 1 (latest)
    expect(body.messages[0]!.content[0]!.cache_control).toBeUndefined()
    expect(body.messages[1]!.content[0]!.cache_control).toBeUndefined()
    expect(body.messages[2]!.content[0]!.cache_control).toBeDefined()
  })

  it('handles missing system / tools / messages fields', () => {
    expect(capCacheControlBlocks({})).toBe(0)
    expect(capCacheControlBlocks({ messages: [] })).toBe(0)
    expect(capCacheControlBlocks({ system: undefined, tools: null })).toBe(0)
  })
})
