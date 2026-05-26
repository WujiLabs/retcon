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

import { createChannel } from '@playtiss/core/channel'
import { SqliteStorageProvider } from '@playtiss/core/channel'
import { afterEach, describe, expect, it } from 'vitest'

import { blobRefFromBytes, blobRefFromMessagesBody } from '../body-blob.js'
import { type DB, migrate, openDb } from '../db.js'
import { createEventConsumer, createEventProducer } from '../events.js'
import { ConfirmTokenStore, createMcpToolsWithTokens } from '../mcp-tools.js'
import { SESSION_HEADER } from '../proxy-handler.js'
import { defaultProjectors, defaultTasks, type ServerHandle, startServer } from '../server.js'

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
  const channel = createChannel({ db, tasks: await defaultTasks() })
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'sr-int-'))
  const mock = await startMock(upstreamHandler)
  const proxy = await startServer({
    port: 0,
    channel,
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

    // Seed history: 2 closed_forkable turns + R1 (tool_use turn calling
    // rewind_to). The MCP tool handler reads recent revisions to compute
    // the target's revision id and reconstruct the fork's prefix history.
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
    await seedR1ToolUse(fx, sessionId, [{ role: 'user', content: 't2' }], 'rewind_to', 'toolu_R1')

    // Drive rewind_to via MCP — two-step confirm token flow. The MCP handler
    // writes the active fork_anchors row + returns a tool_result containing
    // <retcon-anchor token="..." /> that the proxy will scan for on the next
    // /v1/messages.
    const storage = new SqliteStorageProvider(fx.db)
    const proxyChannel = createChannel({ db: fx.db, tasks: await defaultTasks() })
    const tools = createMcpToolsWithTokens(
      { db: fx.db, storageProvider: storage, rewindEnabled: true },
      { rewind: new ConfirmTokenStore(), submit: new ConfirmTokenStore() },
    )
    const rewindTool = tools.get('rewind_to')!
    const first = await rewindTool.handler(
      { turn_back_n: 1, message: 'switch to plan B' },
      { sessionId, channel: proxyChannel },
    ) as { confirm_clean: string }
    const second = await rewindTool.handler(
      { turn_back_n: 1, message: 'switch to plan B', confirm: first.confirm_clean },
      { sessionId, channel: proxyChannel },
    ) as { status: string, message: string }
    expect(second.status).toBe('scheduled')

    // Extract the anchor token from the scheduled tool_result text — the
    // proxy will scan for the SAME token in the body's tool_result.
    const anchorMatch = second.message.match(/<retcon-anchor token="(tok_[0-9a-f]{12})"/)
    expect(anchorMatch).not.toBeNull()
    const anchorToken = anchorMatch![1]

    // The fork_anchors row should be active.
    const seededRow = fx.db.prepare(
      'SELECT state, synthetic_metadata_json FROM fork_anchors WHERE anchor_token=?',
    ).get(anchorToken) as { state: string, synthetic_metadata_json: string | null }
    expect(seededRow.state).toBe('active')
    expect(seededRow.synthetic_metadata_json).toBeTruthy()

    // Drive a /v1/messages with R1's tool_use + the anchor-bearing
    // tool_result. proxy-handler reads R1 to derive tool_use_id and fires
    // fork.forked on the 2xx+end_turn response.
    await driveTurn(fx, sessionId, [
      { role: 'user', content: 't2' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_R1', name: 'rewind_to', input: {} }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_R1',
          content: `Rewind scheduled.\n<retcon-anchor token="${anchorToken}" />`,
        }],
      },
    ])

    // Wait for fork.forked.
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

    // SR row must exist in revisions, classified closed_forkable.
    const sr = fx.db.prepare(
      'SELECT id, classification, stop_reason FROM revisions WHERE id = ?',
    ).get(forkedPayload.synthetic_revision_id) as
    | { id: string, classification: string, stop_reason: string }
    | undefined
    expect(sr).toBeTruthy()
    expect(sr!.classification).toBe('closed_forkable')
    expect(sr!.stop_reason).toBe('rewind_synthetic')
  })

  it('failure path: 4xx upstream → no SR materializes, anchor stays active', async () => {
    fx = await setup((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit' } }))
    })
    const sessionId = 'sess-e2e-fail'

    const seedProducer = createEventProducer(fx.db, defaultProjectors())
    seedProducer.emit('mcp.session_initialized', { mcp_session_id: 'm', harness: 'claude-code' }, sessionId)
    await seedR1ToolUse(fx, sessionId, [{ role: 'user', content: 'q' }], 'rewind_to', 'toolu_X')

    // Seed an active fork_anchors row that the proxy will splice off when
    // the body carries its token. v0.6's contract on 4xx: no fork.forked,
    // anchor stays active for claude's retry path.
    const anchorToken = 'tok_aabbccddee01'
    fx.db.prepare(
      'INSERT OR IGNORE INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)',
    ).run(sessionId, 'task-fail', 'default', Date.now(), 'claude-code')
    fx.db.prepare(`
      INSERT INTO fork_anchors (
        anchor_token, session_id, target_messages_json, target_messages_top_cid,
        fork_point_revision_id, source_view_id, synthetic_metadata_json,
        state, state_reason, acknowledged_at, created_at, released_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'active', NULL, NULL, ?, NULL)
    `).run(
      anchorToken,
      sessionId,
      JSON.stringify([{ role: 'user', content: 'rewritten' }]),
      'ver-fp',
      'view-src',
      JSON.stringify({
        kind: 'rewind',
        target_view_id: 'tv',
        synthetic_revision_id: 'rev-should-not-exist',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        parent_revision_id: 'r1',
        back_requested_at: 1,
      }),
      Date.now(),
    )

    await driveTurn(fx, sessionId, [
      { role: 'user', content: 'orig' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_X', name: 'rewind_to', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_X',
          content: `Rewind scheduled.\n<retcon-anchor token="${anchorToken}" />`,
        }],
      },
    ])

    // No SR materialized.
    const sr = fx.db.prepare(
      'SELECT id FROM revisions WHERE id = ?',
    ).get('rev-should-not-exist')
    expect(sr).toBeUndefined()
    // Anchor still active — 4xx (rate limit) doesn't auto-release. The
    // upstream_4xx state transition is reserved for true splice-induced
    // 400s, not for retryable upstream errors like 429.
    const row = fx.db.prepare(
      'SELECT state FROM fork_anchors WHERE anchor_token=?',
    ).get(anchorToken) as { state: string }
    expect(row.state).toBe('active')
  })

  it('synthesis_failed audit: emitted when R1 is missing the operation tool_use', async () => {
    // v0.6 buildSyntheticAsset reads the pre-splice body's last assistant
    // turn and looks for a tool_use named `rewind_to` (or `mcp__retcon__
    // rewind_to`) to pair the synthetic tool_result with. When the
    // assistant turn has NO matching tool_use, buildSyntheticAsset returns
    // null and proxy-handler emits fork.synthesis_failed instead of
    // fork.forked. This protects cascade rewinds: an unpaired tool_use in
    // a future synthetic body would 400 from Anthropic.
    fx = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }))
    })
    const sessionId = 'sess-e2e-synthfail'

    const seedProducer = createEventProducer(fx.db, defaultProjectors())
    seedProducer.emit('mcp.session_initialized', { mcp_session_id: 'm', harness: 'claude-code' }, sessionId)

    // Seed an active fork_anchors row directly. The synthetic_metadata
    // carries the SR fields buildSyntheticAsset will try to use; the body
    // we drive below WON'T have a matching tool_use, so the build fails.
    // Token must be 12 hex chars to match ANCHOR_TAG_RE (`tok_[0-9a-f]{12}`).
    const anchorToken = 'tok_aabbccddeeff'
    fx.db.prepare(
      'INSERT OR IGNORE INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)',
    ).run(sessionId, 'task-orphan', 'default', Date.now(), 'claude-code')
    fx.db.prepare(`
      INSERT INTO fork_anchors (
        anchor_token, session_id, target_messages_json, target_messages_top_cid,
        fork_point_revision_id, source_view_id, synthetic_metadata_json,
        state, state_reason, acknowledged_at, created_at, released_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'active', NULL, NULL, ?, NULL)
    `).run(
      anchorToken,
      sessionId,
      JSON.stringify([{ role: 'user', content: 'rewritten' }]),
      'ver-fp',
      'view-src',
      JSON.stringify({
        kind: 'rewind',
        target_view_id: 'tv',
        synthetic_revision_id: 'rev-orphan-sr',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        parent_revision_id: 'rev-does-not-exist',
        back_requested_at: 1,
      }),
      Date.now(),
    )

    // Body shape: assistant turn carries only TEXT (no tool_use), then a
    // user turn with the anchor-bearing tool_result. The splice scan still
    // finds the anchor (it only inspects tool_result blocks, not tool_use
    // pairing). buildSyntheticAsset then walks back to the assistant turn,
    // finds no rewind_to tool_use, returns null.
    await driveTurn(fx, sessionId, [
      { role: 'user', content: 'orig' },
      { role: 'assistant', content: [{ type: 'text', text: 'just text, no tool_use' }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_OOPS',
          content: `Rewind scheduled.\n<retcon-anchor token="${anchorToken}" />`,
        }],
      },
    ])

    const consumer = createEventConsumer(fx.db)
    let attempts = 0
    let synthFailed: { error_message?: string } | undefined
    while (attempts < 100) {
      const evts = consumer.poll('_probe_sf', ['fork.synthesis_failed'], 1)
      if (evts.length > 0) {
        synthFailed = evts[0]!.payload as { error_message?: string }
        break
      }
      await new Promise(r => setTimeout(r, 10))
      attempts++
    }
    expect(synthFailed).toBeDefined()
    expect(synthFailed!.error_message).toMatch(/buildSyntheticAsset returned null/i)
    // No SR row created.
    const sr = fx.db.prepare(
      'SELECT id FROM revisions WHERE id = ?',
    ).get('rev-orphan-sr')
    expect(sr).toBeUndefined()
  })
})
