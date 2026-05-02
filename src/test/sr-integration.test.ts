// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Phase 4 (v0.5.0): end-to-end SR integration tests.
//
// Wires:
//   MCP rewind_to → TOBE pending file → /v1/messages → splice → fork.forked →
//   RewindMarkerV1Projector → SR row in revisions
//
// Each test exercises the full pipeline so a regression at any layer surfaces
// here. Unit tests in mcp-tools.test.ts, proxy-handler.test.ts, and
// rewind-marker-v1.test.ts cover layer-specific behavior in isolation.

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { blobRefFromBytes, blobRefFromMessagesBody } from '../body-blob.js'
import { type DB, migrate, openDb } from '../db.js'
import { createEventConsumer, createEventProducer } from '../events.js'
import { ConfirmTokenStore, createMcpToolsWithTokens } from '../mcp-tools.js'
import { SESSION_HEADER } from '../proxy-handler.js'
import { defaultProjectors, type ServerHandle, startServer } from '../server.js'
import { SqliteStorageProvider } from '../storage.js'
import { createTobeStore } from '../tobe.js'

interface E2EFixture {
  db: DB
  proxy: ServerHandle
  mock: { port: number, close: () => Promise<void> }
  tmpRoot: string
  cleanup: () => Promise<void>
}

async function startMock(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
): Promise<{ port: number, close: () => Promise<void> }> {
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

async function setup(
  upstreamHandler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
): Promise<E2EFixture> {
  const db = openDb({ path: ':memory:' })
  migrate(db)
  const producer = createEventProducer(db, defaultProjectors())
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'sr-int-'))
  const tobeStore = createTobeStore(tmpRoot)
  const mock = await startMock(upstreamHandler)
  const proxy = await startServer({
    port: 0,
    producer,
    tobeStore,
    upstream: `http://127.0.0.1:${mock.port}`,
    db,
  })
  return {
    db,
    proxy,
    mock,
    tmpRoot,
    cleanup: async (): Promise<void> => {
      await proxy.close()
      await mock.close()
      rmSync(tmpRoot, { recursive: true, force: true })
    },
  }
}

/**
 * Drive a real /v1/messages call through the proxy and wait for the response
 * to be fully recorded. The mock upstream's stop_reason determines what
 * classification the resulting Revision lands at.
 */
async function driveTurn(
  fx: E2EFixture,
  sessionId: string,
  messages: unknown[],
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${fx.proxy.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', messages }),
  })
  await res.text()
}

/**
 * Seed a tool-use turn (R1): emit request_received + response_completed
 * directly with real body blobs. The response body contains a tool_use block
 * for the named tool (rewind_to or submit_file) so the parallel-tool guard
 * doesn't reject and so buildSyntheticAsset can pair the synthetic
 * tool_result with the right tool_use_id.
 *
 * Returns the request event id (= R1.id) and the synthetic tool_use_id used.
 */
async function seedR1ToolUse(
  fx: E2EFixture,
  sessionId: string,
  history: unknown[],
  toolName: 'rewind_to' | 'submit_file',
  toolUseId: string,
): Promise<{ r1Id: string }> {
  const producer = createEventProducer(fx.db, [])
  // Use the existing producer chain — but we need to use the same producer the
  // proxy uses, otherwise events go into different streams. Pull it from db
  // (events are global; producer is just an emit interface).
  void producer
  // Instead: drive seeding via a direct producer that shares the db. Easiest:
  // re-emit via the same path we'd use for any test fixture.
  const reqBytes = Buffer.from(JSON.stringify({ messages: history }), 'utf8')
  const reqSplit = await blobRefFromMessagesBody(reqBytes)
  // Need to use the proxy's producer. Steal it via a fresh emit on the same db.
  // Cleaner: expose seeding via a one-shot producer. Since events table is the
  // shared truth, we create a transient producer.
  const seedProducer = createEventProducer(fx.db, defaultProjectors())
  // Bootstrap the session if not yet present.
  seedProducer.emit('mcp.session_initialized', { mcp_session_id: 'm', harness: 'claude-code' }, sessionId)
  const r1 = seedProducer.emit(
    'proxy.request_received',
    { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: reqSplit.topCid },
    sessionId,
    reqSplit.refs,
  )
  const respBytes = Buffer.from(
    JSON.stringify({
      content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: {} }],
    }),
    'utf8',
  )
  const respBlob = await blobRefFromBytes(respBytes)
  seedProducer.emit(
    'proxy.response_completed',
    {
      request_event_id: r1.id,
      status: 200,
      headers_cid: 'h',
      body_cid: respBlob.cid,
      stop_reason: 'tool_use',
      asset_cid: 'a',
    },
    sessionId,
    [respBlob.ref],
  )
  return { r1Id: r1.id }
}

describe('SR end-to-end (Phase 4)', () => {
  let fx: E2EFixture | undefined

  afterEach(async () => {
    if (fx) {
      await fx.cleanup()
      fx = undefined
    }
  })

  it('rewind_to → next /v1/messages → SR row exists in revisions', async () => {
    fx = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }))
    })
    const sessionId = 'sess-e2e-1'

    // Seed history: 2 closed_forkable turns (T1=rewind target, T2=current
    // head) + R1 (tool_use turn calling rewind_to).
    const seedProducer = createEventProducer(fx.db, defaultProjectors())
    seedProducer.emit('mcp.session_initialized', { mcp_session_id: 'm', harness: 'claude-code' }, sessionId)
    for (const label of ['t1', 't2']) {
      const bytes = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: label }] }), 'utf8')
      const split = await blobRefFromMessagesBody(bytes)
      const evt = seedProducer.emit(
        'proxy.request_received',
        { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: split.topCid },
        sessionId,
        split.refs,
      )
      seedProducer.emit('proxy.response_completed', {
        request_event_id: evt.id,
        status: 200,
        headers_cid: 'h',
        body_cid: `cid-resp-${label}`,
        stop_reason: 'end_turn',
        asset_cid: 'a',
      }, sessionId)
    }

    // R1: tool_use turn calling rewind_to.
    const { r1Id } = await seedR1ToolUse(fx, sessionId, [{ role: 'user', content: 't2' }], 'rewind_to', 'toolu_R1')
    void r1Id

    // Drive rewind_to via MCP — two-step token flow.
    const tobeStore = createTobeStore(fx.tmpRoot)
    const storage = new SqliteStorageProvider(fx.db)
    const proxyProducer = createEventProducer(fx.db, defaultProjectors())
    const tools = createMcpToolsWithTokens(
      { db: fx.db, tobeStore, storageProvider: storage, rewindEnabled: true },
      { rewind: new ConfirmTokenStore(), submit: new ConfirmTokenStore() },
    )
    const rewindTool = tools.get('rewind_to')!
    const first = await rewindTool.handler(
      { turn_back_n: 1, message: 'switch to plan B' },
      { sessionId, producer: proxyProducer },
    ) as { confirm_clean: string }
    const second = await rewindTool.handler(
      { turn_back_n: 1, message: 'switch to plan B', confirm: first.confirm_clean },
      { sessionId, producer: proxyProducer },
    ) as { status: string }
    expect(second.status).toBe('scheduled')

    // The TOBE pending file is now sitting in fx.tmpRoot. But the proxy uses
    // its OWN tobeStore (created in setup). We need to write the pending file
    // to the proxy's tobeStore. Easier: skip this test — it requires the MCP
    // tools and proxy to share a tobeStore. Replicate the TOBE write to the
    // proxy's path.
    // (For this integration test, we directly seed the proxy's TOBE store.)
    const pending = tobeStore.peek(sessionId)
    expect(pending).toBeTruthy()
    expect(pending!.synthetic).toBeTruthy()

    // Now drive a /v1/messages through the proxy, but use the proxy's own
    // tobe store. The proxy's tobeStore lives in the fx.tmpRoot (same path
    // we used here), so the pending file IS visible. Verify by reading it
    // back via a fresh tobe store on the same dir.
    const proxyTobeStore = createTobeStore(fx.tmpRoot)
    expect(proxyTobeStore.peek(sessionId)).toBeTruthy()

    // Realistic claude body shape: R1's parsed assistant turn (with
    // tool_use(rewind_to)) and a trailing user turn carrying the
    // tool_result. proxy-handler reads this to derive tool_use_id and
    // detect parallel tools.
    await driveTurn(fx, sessionId, [
      { role: 'user', content: 't2' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_R1', name: 'rewind_to', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_R1', content: 'scheduled' }],
      },
    ])

    // Wait for fork.forked to fire.
    const consumer = createEventConsumer(fx.db)
    let attempts = 0
    let forked: unknown
    while (attempts < 100) {
      const evts = consumer.poll('_probe', ['fork.forked'], 1)
      if (evts.length > 0) {
        forked = evts[0]!.payload
        break
      }
      await new Promise(r => setTimeout(r, 10))
      attempts++
    }
    expect(forked).toBeDefined()
    const forkedPayload = forked as { synthetic_revision_id: string }

    // SR row must exist in revisions, parented to R1, classified closed_forkable.
    const sr = fx.db.prepare(
      'SELECT id, classification, stop_reason FROM revisions WHERE id = ?',
    ).get(forkedPayload.synthetic_revision_id) as
    | { id: string, classification: string, stop_reason: string }
    | undefined
    expect(sr).toBeTruthy()
    expect(sr!.classification).toBe('closed_forkable')
    expect(sr!.stop_reason).toBe('rewind_synthetic')
  })

  it('failure path: 4xx upstream → no SR materializes', async () => {
    fx = await setup((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit' } }))
    })
    const sessionId = 'sess-e2e-fail'

    // Seed a session and an SR-construction TOBE pending file.
    const seedProducer = createEventProducer(fx.db, defaultProjectors())
    seedProducer.emit('mcp.session_initialized', { mcp_session_id: 'm', harness: 'claude-code' }, sessionId)
    await seedR1ToolUse(fx, sessionId, [{ role: 'user', content: 'q' }], 'rewind_to', 'toolu_X')

    const proxyTobeStore = createTobeStore(fx.tmpRoot)
    proxyTobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'rewritten' }],
      fork_point_revision_id: 'ver-fp',
      source_view_id: 'view-src',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'tv',
        synthetic_revision_id: 'rev-should-not-exist',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        tool_use_id: 'toolu_X',
        parent_revision_id: 'r1',
        back_requested_at: 1,
      },
    })

    await driveTurn(fx, sessionId, [{ role: 'user', content: 'orig' }])

    // 4xx means TOBE stays pending (proxy retains for retry) and no SR
    // materializes.
    const sr = fx.db.prepare(
      'SELECT id FROM revisions WHERE id = ?',
    ).get('rev-should-not-exist')
    expect(sr).toBeUndefined()
  })

  it('synthesis_failed audit: emitted when R1 is missing for synthetic_asset build', async () => {
    fx = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }))
    })
    const sessionId = 'sess-e2e-synthfail'

    // Bootstrap session (so proxy doesn't bail on FK).
    const seedProducer = createEventProducer(fx.db, defaultProjectors())
    seedProducer.emit('mcp.session_initialized', { mcp_session_id: 'm', harness: 'claude-code' }, sessionId)

    // Write a TOBE that points at a non-existent R1 — buildSyntheticAsset
    // will return null and proxy-handler emits fork.synthesis_failed.
    const proxyTobeStore = createTobeStore(fx.tmpRoot)
    proxyTobeStore.write(sessionId, {
      messages: [{ role: 'user', content: 'rewritten' }],
      fork_point_revision_id: 'ver-fp',
      source_view_id: 'view-src',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'tv',
        synthetic_revision_id: 'rev-orphan-sr',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        tool_use_id: 'toolu_OOPS',
        parent_revision_id: 'rev-does-not-exist',
        back_requested_at: 1,
      },
    })

    await driveTurn(fx, sessionId, [{ role: 'user', content: 'orig' }])

    // Wait for terminal event so the projector chain has run.
    const consumer = createEventConsumer(fx.db)
    let attempts = 0
    let synthFailed: unknown
    while (attempts < 100) {
      const evts = consumer.poll('_probe_sf', ['fork.synthesis_failed'], 1)
      if (evts.length > 0) {
        synthFailed = evts[0]!.payload
        break
      }
      await new Promise(r => setTimeout(r, 10))
      attempts++
    }
    expect(synthFailed).toBeDefined()
    // No SR row created.
    const sr = fx.db.prepare(
      'SELECT id FROM revisions WHERE id = ?',
    ).get('rev-orphan-sr')
    expect(sr).toBeUndefined()
  })
})
