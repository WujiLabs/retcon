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
import { capCacheControlBlocks, MAX_CACHE_CONTROL_BLOCKS, SESSION_HEADER, stripTtlViolations } from '../proxy-handler.js'
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

  // ── Phase 1 (v0.5.0): fork.forked emission ───────────────────────────────
  // SR is born only when (a) TOBE was consumed, (b) HTTP status is 2xx,
  // (c) stop_reason is 'end_turn', (d) the TOBE pending file carried the
  // synthetic SR-construction metadata. Each test below pins one of those
  // gates.

  it('fork.forked: emitted when TOBE consumed AND 2xx AND end_turn AND synthetic present', async () => {
    // Seed R1: a real request_received + response_completed with body blobs.
    // buildSyntheticAsset (Phase 2) walks these to compose the SR's body.
    const { blobRefFromBytes, blobRefFromMessagesBody } = await import('../body-blob.js')
    const reqBodyBytes = Buffer.from(
      JSON.stringify({ messages: [{ role: 'user', content: 'q1' }] }),
      'utf8',
    )
    const reqSplit = await blobRefFromMessagesBody(reqBodyBytes)
    const r1Event = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: reqSplit.topCid },
      'sess-forked-happy',
      reqSplit.refs,
    )
    const respBodyBytes = Buffer.from(
      JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_42', name: 'rewind_to', input: {} }] }),
      'utf8',
    )
    const respBlob = await blobRefFromBytes(respBodyBytes)
    fx.producer.emit(
      'proxy.response_completed',
      {
        request_event_id: r1Event.id,
        status: 200,
        headers_cid: 'h',
        body_cid: respBlob.cid,
        stop_reason: 'tool_use',
        asset_cid: 'asset-r1',
      },
      'sess-forked-happy',
      [respBlob.ref],
    )

    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: fx.db,
    })

    const sessionId = 'sess-forked-happy'
    fx.tobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'rewritten' }],
      fork_point_revision_id: 'ver-fork-x',
      source_view_id: 'view-x',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'view-target',
        synthetic_revision_id: 'rev-synth-1',
        synthetic_tool_result_text: 'Rewind initiated. Target: rev_abcd1234. Synthetic message: hi.',
        synthetic_assistant_text: 'Rewind initiated. Jumping to rev_abcd1234.',
        synthetic_user_message: 'hi',
        tool_use_id: 'toolu_42',
        parent_revision_id: r1Event.id,
        back_requested_at: 1234567890,
      },
    })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'orig' }] }),
    })
    await res.text()

    const forkedPayload = await waitForEvent(fx.db, 'fork.forked') as {
      kind?: string
      synthetic_revision_id?: string
      parent_revision_id?: string
      target_revision_id?: string
      to_revision_id?: string
      synthetic_tool_result_text?: string
      synthetic_user_message?: string
      tool_use_id?: string
      target_view_id?: string
      sealed_at?: number
      synthetic_asset_cid?: string
    }
    expect(forkedPayload.kind).toBe('rewind')
    expect(forkedPayload.synthetic_revision_id).toBe('rev-synth-1')
    expect(forkedPayload.parent_revision_id).toBe(r1Event.id)
    expect(forkedPayload.target_revision_id).toBe('ver-fork-x')
    expect(forkedPayload.to_revision_id).toMatch(/.+/)
    expect(forkedPayload.synthetic_tool_result_text).toContain('rev_abcd1234')
    expect(forkedPayload.synthetic_user_message).toBe('hi')
    expect(forkedPayload.tool_use_id).toBe('toolu_42')
    expect(forkedPayload.target_view_id).toBe('view-target')
    expect(forkedPayload.sealed_at).toBe(1234567890)
    expect(forkedPayload.synthetic_asset_cid).toMatch(/.+/)
  })

  it('fork.forked: NOT emitted when stop_reason is not end_turn', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '...' }] }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const sessionId = 'sess-no-end-turn'
    fx.tobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'r' }],
      fork_point_revision_id: 'ver-fork-y',
      source_view_id: 'view-y',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'tv',
        synthetic_revision_id: 'rev-skip',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        tool_use_id: 'toolu',
        parent_revision_id: 'r1',
        back_requested_at: 1,
      },
    })
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'orig' }] }),
    })

    // response_completed must already be in the log; fork.forked must NOT.
    await waitForEvent(fx.db, 'proxy.response_completed')
    const consumer = createEventConsumer(fx.db)
    const found = consumer.poll('_probe_no_forked', ['fork.forked'], 1)
    expect(found.length).toBe(0)
  })

  it('fork.forked: NOT emitted on 4xx upstream (not 2xx)', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit' } }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const sessionId = 'sess-4xx'
    fx.tobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'r' }],
      fork_point_revision_id: 'ver-fork-z',
      source_view_id: 'view-z',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'tv',
        synthetic_revision_id: 'rev-4xx',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        tool_use_id: 'toolu',
        parent_revision_id: 'r1',
        back_requested_at: 1,
      },
    })
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'orig' }] }),
    })

    await waitForEvent(fx.db, 'proxy.response_completed')
    const consumer = createEventConsumer(fx.db)
    const found = consumer.poll('_probe_no_forked_4xx', ['fork.forked'], 1)
    expect(found.length).toBe(0)
  })

  it('fork.forked: NOT emitted when TOBE has no synthetic field (backward-compat)', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const sessionId = 'sess-no-synth'
    // Pre-v0.5.0 TOBE shape: no `synthetic`.
    fx.tobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'r' }],
      fork_point_revision_id: 'ver-old',
      source_view_id: 'view-old',
    })
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'orig' }] }),
    })

    await waitForEvent(fx.db, 'proxy.response_completed')
    const consumer = createEventConsumer(fx.db)
    const found = consumer.poll('_probe_no_forked_old', ['fork.forked'], 1)
    expect(found.length).toBe(0)
  })

  it('fork.forked: NOT emitted on a normal /v1/messages with no TOBE pending', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }))
    })
    proxy = await startServer({
      port: 0,
      producer: fx.producer,
      tobeStore: fx.tobeStore,
      upstream: `http://127.0.0.1:${mock.port}`,
    })
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: 'sess-noop' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    })

    await waitForEvent(fx.db, 'proxy.response_completed')
    const consumer = createEventConsumer(fx.db)
    const found = consumer.poll('_probe_no_forked_noop', ['fork.forked'], 1)
    expect(found.length).toBe(0)
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

// ─── stripTtlViolations (TTL ordering pre-pass) ─────────────────────────────
//
// Anthropic forbids `ttl='1h'` from coming after `ttl='5m'` in processing
// order (`tools` → `system` → `messages`). These tests pin our pre-pass
// behavior. Field shape mirrors a real Anthropic body.

describe('stripTtlViolations', () => {
  const ccm = (ttl?: '5m' | '1h') => ({ type: 'ephemeral', ...(ttl ? { ttl } : {}) })

  it('returns 0 when no markers present', () => {
    expect(stripTtlViolations({})).toBe(0)
    expect(stripTtlViolations({ messages: [] })).toBe(0)
  })

  it('returns 0 when all markers are 1h (no 5m to strip)', () => {
    const body = {
      system: [{ type: 'text', text: 's', cache_control: ccm('1h') }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q', cache_control: ccm('1h') }] },
      ],
    }
    expect(stripTtlViolations(body)).toBe(0)
    expect(body.system[0].cache_control).toBeDefined()
  })

  it('returns 0 when all markers are 5m (no 1h triggers a strip)', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a', cache_control: ccm('5m') }] },
        { role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: ccm('5m') }] },
      ],
    }
    expect(stripTtlViolations(body)).toBe(0)
    expect(body.messages[0].content[0].cache_control).toBeDefined()
    expect(body.messages[1].content[0].cache_control).toBeDefined()
  })

  it('returns 0 when markers are already in valid order (1h then 5m)', () => {
    const body = {
      system: [{ type: 'text', text: 's', cache_control: ccm('1h') }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q', cache_control: ccm('5m') }] },
      ],
    }
    expect(stripTtlViolations(body)).toBe(0)
    expect(body.system[0].cache_control).toBeDefined()
    expect(body.messages[0].content[0].cache_control).toBeDefined()
  })

  it('strips a 5m followed by a 1h within messages (the b17275fb evt 0090 case)', () => {
    // Recreates the failing body shape:
    //   system[1]=1h, system[2]=1h, messages[110]=5m, messages[113]=1h
    const body = {
      system: [
        { type: 'text', text: 's0' }, // no marker
        { type: 'text', text: 's1', cache_control: ccm('1h') },
        { type: 'text', text: 's2', cache_control: ccm('1h') },
      ],
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'old', cache_control: ccm('5m') }] },
        { role: 'user', content: [{ type: 'text', text: 'new', cache_control: ccm('1h') }] },
      ],
    }
    expect(stripTtlViolations(body)).toBe(1)
    // The 5m on the old assistant turn is gone; everything else is intact.
    expect(body.messages[0].content[0].cache_control).toBeUndefined()
    expect(body.messages[1].content[0].cache_control).toBeDefined()
    expect(body.system[1].cache_control).toBeDefined()
    expect(body.system[2].cache_control).toBeDefined()
  })

  it('strips system-level 5m when a later messages-level 1h exists (b17275fb evt 00ae case)', () => {
    // Failing body:
    //   system[1]=5m, system[2]=5m, messages[131]=1h, messages[132]=5m
    const body = {
      system: [
        { type: 'text', text: 's0' },
        { type: 'text', text: 's1', cache_control: ccm('5m') },
        { type: 'text', text: 's2', cache_control: ccm('5m') },
      ],
      messages: [
        { role: 'user', content: [{ type: 'tool_result', content: 'r', cache_control: ccm('1h') }] },
        { role: 'assistant', content: [
          { type: 'text', text: 'preamble' },
          { type: 'text', text: 'tail', cache_control: ccm('5m') },
        ] },
      ],
    }
    // Both system 5m's strip (they're earlier than the messages[0] 1h).
    // The trailing messages[1] 5m stays — it's after the last 1h.
    expect(stripTtlViolations(body)).toBe(2)
    expect(body.system[1].cache_control).toBeUndefined()
    expect(body.system[2].cache_control).toBeUndefined()
    expect(body.messages[0].content[0].cache_control).toBeDefined()
    expect(body.messages[1].content[1].cache_control).toBeDefined()
  })

  it('only strips up to the LAST 1h marker — trailing 5m markers survive', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a', cache_control: ccm('5m') }] }, // strip
        { role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: ccm('1h') }] },
        { role: 'user', content: [{ type: 'text', text: 'c', cache_control: ccm('5m') }] }, // strip
        { role: 'assistant', content: [{ type: 'text', text: 'd', cache_control: ccm('1h') }] }, // last 1h
        { role: 'user', content: [{ type: 'text', text: 'e', cache_control: ccm('5m') }] }, // KEEP — after last 1h
      ],
    }
    expect(stripTtlViolations(body)).toBe(2)
    expect(body.messages[0].content[0].cache_control).toBeUndefined()
    expect(body.messages[1].content[0].cache_control).toBeDefined()
    expect(body.messages[2].content[0].cache_control).toBeUndefined()
    expect(body.messages[3].content[0].cache_control).toBeDefined()
    expect(body.messages[4].content[0].cache_control).toBeDefined()
  })

  it('treats missing ttl as 5m (Anthropic default) and strips it before a 1h', () => {
    const body = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q', cache_control: ccm('1h') }] },
      ],
    }
    expect(stripTtlViolations(body)).toBe(1)
    expect(body.system[0].cache_control).toBeUndefined()
  })

  it('processes order is tools → system → messages, not array-of-arrays order', () => {
    // 1h on tools[0] should mean any earlier 5m in tools[*] before it strips,
    // but a 5m in system that comes AFTER tools[0]=1h… wait, tools always
    // come BEFORE system in processing order. So system 5m IS after tools 1h
    // in the stream → triggers nothing because 5m-after-1h is fine. We're
    // testing the asymmetry: system markers don't get stripped just because
    // tools has a later 1h, because system PRECEDES tools? No — the rule is
    // tools→system→messages, so tools EARLIER than system. system 5m comes
    // AFTER tools 1h. That's `1h then 5m` — valid, no strip.
    const body = {
      tools: [{ name: 't', description: 'd', cache_control: ccm('1h') }],
      system: [{ type: 'text', text: 's', cache_control: ccm('5m') }],
      messages: [],
    }
    expect(stripTtlViolations(body)).toBe(0)
    expect(body.tools[0].cache_control).toBeDefined()
    expect(body.system[0].cache_control).toBeDefined()
  })

  it('strips a 5m in tools that precedes a 1h in messages (cross-section)', () => {
    const body = {
      tools: [{ name: 't', description: 'd', cache_control: ccm('5m') }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q', cache_control: ccm('1h') }] },
      ],
    }
    expect(stripTtlViolations(body)).toBe(1)
    expect((body.tools[0] as { cache_control?: unknown }).cache_control).toBeUndefined()
  })

  it('null cache_control is not counted (matches capCacheControlBlocks semantics)', () => {
    const body = {
      messages: [
        // null marker — should be ignored (not a 5m, not a 1h)
        { role: 'user', content: [{ type: 'text', text: 'a', cache_control: null }] },
        { role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: ccm('1h') }] },
      ],
    }
    expect(stripTtlViolations(body)).toBe(0)
    expect(body.messages[1].content[0].cache_control).toBeDefined()
  })

  it('runs cleanly alongside capCacheControlBlocks (TTL fix first, then count cap)', () => {
    // Build a body where TTL fix removes redundant 5m markers and the count
    // cap doesn't need to fire afterward.
    const body = {
      system: [
        { type: 'text', text: 's1', cache_control: ccm('1h') },
        { type: 'text', text: 's2', cache_control: ccm('1h') },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q1', cache_control: ccm('5m') }] }, // strip
        { role: 'assistant', content: [{ type: 'text', text: 'a1', cache_control: ccm('5m') }] }, // strip
        { role: 'user', content: [{ type: 'text', text: 'q2', cache_control: ccm('1h') }] },
      ],
    }
    expect(stripTtlViolations(body)).toBe(2)
    expect(capCacheControlBlocks(body)).toBe(0) // 3 left, ≤ 4
    expect(body.messages[0].content[0].cache_control).toBeUndefined()
    expect(body.messages[1].content[0].cache_control).toBeUndefined()
    expect(body.messages[2].content[0].cache_control).toBeDefined()
  })
})
