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

import { createChannel } from '@playtiss/core/channel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type DB, migrate, openDb } from '../db.js'
import { createEventConsumer } from '../events.js'
import type { SyntheticDepartureMeta } from '../fork-anchors.js'
import { capCacheControlBlocks, MAX_CACHE_CONTROL_BLOCKS, SESSION_HEADER, stripTtlViolations } from '../proxy-handler.js'
import { REDACTED_VALUE } from '../redaction.js'
import { defaultTasks, type ServerHandle, startServer } from '../server.js'

/** Seed an active fork_anchors row for a session — the v0.6 replacement for
 *  the v0.5 `tobeStore.write(...)` pattern. Inserts the session row too
 *  (idempotent on the session). Returns the anchor token the test should
 *  embed in the body's tool_result. */
function seedActiveAnchor(
  db: DB,
  sessionId: string,
  opts: {
    anchor_token?: string
    target_messages: unknown[]
    fork_point_revision_id?: string | null
    source_view_id?: string | null
    synthetic?: SyntheticDepartureMeta
  },
): string {
  const token = opts.anchor_token ?? `tok_${Math.random().toString(16).slice(2, 14).padStart(12, '0')}`
  db.prepare(
    'INSERT OR IGNORE INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, `task-${sessionId}`, 'default', Date.now(), 'claude-code')
  db.prepare(
    'INSERT OR IGNORE INTO tasks (id, session_id, created_at) VALUES (?, ?, ?)',
  ).run(`task-${sessionId}`, sessionId, Date.now())
  db.prepare(`
    INSERT INTO fork_anchors (
      anchor_token, session_id, target_messages_json, target_messages_top_cid,
      fork_point_revision_id, source_view_id, synthetic_metadata_json,
      state, state_reason, acknowledged_at, created_at, released_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'active', NULL, NULL, ?, NULL)
  `).run(
    token,
    sessionId,
    JSON.stringify(opts.target_messages),
    opts.fork_point_revision_id ?? null,
    opts.source_view_id ?? null,
    opts.synthetic ? JSON.stringify(opts.synthetic) : null,
    Date.now(),
  )
  return token
}

/** Build a claude-shaped /v1/messages body where the latest user-role turn
 *  carries the rewind_to/submit_file anchor inside a tool_result block. The
 *  `priorAssistantToolUse` lets a test inject sibling tool_uses (parallel-
 *  tool guard). */
function bodyWithAnchor(opts: {
  history: unknown[]
  toolUseId: string
  toolName: 'rewind_to' | 'submit_file'
  anchorToken: string
  parallelToolUses?: Array<{ id: string, name: string, input?: unknown }>
}): string {
  const r1Content: unknown[] = [
    { type: 'tool_use', id: opts.toolUseId, name: opts.toolName, input: { turn_back_n: 1, message: 'hi' } },
    ...(opts.parallelToolUses?.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input ?? {} })) ?? []),
  ]
  return JSON.stringify({
    model: 'claude-sonnet-4-6',
    messages: [
      ...opts.history,
      { role: 'assistant', content: r1Content },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: opts.toolUseId,
          content: `Rewind scheduled.\n<retcon-anchor token="${opts.anchorToken}" />`,
        }],
      },
    ],
  })
}

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
  const channel = createChannel({ db })
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'proxy-ph-test-'))
  return {
    db,
    channel,
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
      channel: fx.channel,
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
      channel: fx.channel,
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

  it('applies an active anchor splice and carries tobe_applied_from in the event payload', async () => {
    // v0.6: the anchor splice REPLACES the body's pre-anchor turns with
    // target_messages_json from the active fork_anchors row. The request
    // event payload's `tobe_applied_from` field carries the row's
    // fork_point_revision_id + source_view_id + the pre-splice body's CID.
    mock = await startMock((_req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        echoed_messages: JSON.parse(body.toString('utf8')).messages,
        stop_reason: 'end_turn',
      }))
    })
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: fx.db,
    })

    const sessionId = 'sess-anchor-applied'
    const token = seedActiveAnchor(fx.db, sessionId, {
      target_messages: [{ role: 'user', content: 'rewritten' }],
      fork_point_revision_id: 'ver-fork-point-xyz',
      source_view_id: 'view-origin',
    })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: bodyWithAnchor({
        history: [{ role: 'user', content: 'ORIGINAL' }],
        toolUseId: 'toolu_anchor_1',
        toolName: 'rewind_to',
        anchorToken: token,
      }),
    })
    const body = await res.json() as { echoed_messages: Array<{ role: string, content: unknown }> }
    // Splice replaced the pre-anchor turns with target_messages. Body upstream
    // sees the trailing user content from target_messages (`rewritten`).
    expect(body.echoed_messages[0].content).toBe('rewritten')

    const reqPayload = await waitForEvent(fx.db, 'proxy.request_received') as {
      tobe_applied_from?: { fork_point_revision_id: string, source_view_id: string, original_body_cid: string }
    }
    expect(reqPayload.tobe_applied_from).toBeDefined()
    expect(reqPayload.tobe_applied_from!.fork_point_revision_id).toBe('ver-fork-point-xyz')
    expect(reqPayload.tobe_applied_from!.source_view_id).toBe('view-origin')
    expect(typeof reqPayload.tobe_applied_from!.original_body_cid).toBe('string')

    // Anchor row stays active after a 2xx — the v0.6 equivalent of "TOBE
    // commit on success" is "row keeps splicing future turns". Compare to
    // v0.5.x where success deleted the pending file.
    const stillActive = fx.db.prepare(
      'SELECT state FROM fork_anchors WHERE anchor_token = ?',
    ).get(token) as { state: string }
    expect(stillActive.state).toBe('active')
  })

  // ── Phase 1 (v0.5.0): fork.forked emission ───────────────────────────────
  // SR is born only when (a) TOBE was consumed, (b) HTTP status is 2xx,
  // (c) stop_reason is 'end_turn', (d) the TOBE pending file carried the
  // synthetic SR-construction metadata. Each test below pins one of those
  // gates.

  it('fork.forked: emitted when anchor spliced + 2xx + end_turn + synthetic_metadata present', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }))
    })
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: fx.db,
    })

    const sessionId = 'sess-forked-happy'
    const token = seedActiveAnchor(fx.db, sessionId, {
      target_messages: [{ role: 'user', content: 'rewritten' }],
      fork_point_revision_id: 'ver-fork-x',
      source_view_id: 'view-x',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'view-target',
        synthetic_revision_id: 'rev-synth-1',
        synthetic_tool_result_text: 'Rewind initiated. Target: rev_abcd1234. Synthetic message: hi.',
        synthetic_assistant_text: 'Rewind initiated. Jumping to rev_abcd1234.',
        synthetic_user_message: 'hi',
        parent_revision_id: 'rev-r1-id',
        back_requested_at: 1234567890,
      },
    })

    // claude's pre-splice body: R1 is the assistant turn that called
    // rewind_to; the trailing user turn carries the anchor-bearing
    // tool_result. proxy-handler reads R1 to derive the tool_use_id for SR
    // construction, then fires fork.forked on the 2xx+end_turn response.
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: bodyWithAnchor({
        history: [{ role: 'user', content: 'q1' }],
        toolUseId: 'toolu_42',
        toolName: 'rewind_to',
        anchorToken: token,
      }),
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
      target_view_id?: string
      sealed_at?: number
      synthetic_asset_cid?: string
    }
    expect(forkedPayload.kind).toBe('rewind')
    expect(forkedPayload.synthetic_revision_id).toBe('rev-synth-1')
    expect(forkedPayload.parent_revision_id).toBe('rev-r1-id')
    expect(forkedPayload.target_revision_id).toBe('ver-fork-x')
    expect(forkedPayload.to_revision_id).toMatch(/.+/)
    expect(forkedPayload.synthetic_tool_result_text).toContain('rev_abcd1234')
    expect(forkedPayload.synthetic_user_message).toBe('hi')
    expect(forkedPayload.target_view_id).toBe('view-target')
    expect(forkedPayload.sealed_at).toBe(1234567890)
    expect(forkedPayload.synthetic_asset_cid).toMatch(/.+/)

    // After fork.forked fires, synthetic_metadata_json is cleared on the
    // anchor row so a future end_turn (e.g., on a follow-up turn that still
    // splices off this anchor) doesn't re-fire fork.forked.
    const cleared = fx.db.prepare(
      'SELECT synthetic_metadata_json FROM fork_anchors WHERE anchor_token = ?',
    ).get(token) as { synthetic_metadata_json: string | null }
    expect(cleared.synthetic_metadata_json).toBeNull()
  })

  it('parallel tool_uses: splice aborted, anchor released, fork.synthesis_failed emitted', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }))
    })
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: fx.db,
    })

    const sessionId = 'sess-parallel'
    const token = seedActiveAnchor(fx.db, sessionId, {
      target_messages: [{ role: 'user', content: 'rewritten' }],
      fork_point_revision_id: 'ver-fork-p',
      source_view_id: 'view-p',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'tv',
        synthetic_revision_id: 'rev-not-born',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        parent_revision_id: 'r1',
        back_requested_at: 1,
      },
    })

    // R1 has parallel tool_uses: rewind_to + read_file. The splice would
    // discard read_file's tool_result (it lives in the same user-role turn
    // as the anchor's tool_result, which the splice replaces), and upstream
    // would 400 on the unpaired tool_use. proxy-handler aborts the splice,
    // marks the anchor row released with reason=parallel_tools, and emits
    // fork.synthesis_failed with the offending tool names.
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: bodyWithAnchor({
        history: [{ role: 'user', content: 'q' }],
        toolUseId: 'toolu_R',
        toolName: 'rewind_to',
        anchorToken: token,
        parallelToolUses: [{ id: 'toolu_F', name: 'read_file' }],
      }),
    })

    const synthFail = await waitForEvent(fx.db, 'fork.synthesis_failed') as {
      error_message?: string
      parallel_tool_names?: string[]
    }
    expect(synthFail.error_message).toMatch(/splice aborted/i)
    expect(synthFail.parallel_tool_names).toEqual(['read_file'])

    // No fork.forked.
    const consumer = createEventConsumer(fx.db)
    const found = consumer.poll('_probe_no_forked_par', ['fork.forked'], 1)
    expect(found.length).toBe(0)

    // Anchor row is now released with the parallel_tools reason.
    const row = fx.db.prepare(
      'SELECT state, state_reason FROM fork_anchors WHERE anchor_token = ?',
    ).get(token) as { state: string, state_reason: string }
    expect(row.state).toBe('released')
    expect(row.state_reason).toBe('parallel_tools')
  })

  it('fork.forked: NOT emitted when stop_reason is not end_turn', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '...' }] }))
    })
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const sessionId = 'sess-no-end-turn'
    const token = seedActiveAnchor(fx.db, sessionId, {
      target_messages: [{ role: 'user', content: 'r' }],
      fork_point_revision_id: 'ver-fork-y',
      source_view_id: 'view-y',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'tv',
        synthetic_revision_id: 'rev-skip',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        parent_revision_id: 'r1',
        back_requested_at: 1,
      },
    })
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: bodyWithAnchor({
        history: [{ role: 'user', content: 'orig' }],
        toolUseId: 'toolu_dangle',
        toolName: 'rewind_to',
        anchorToken: token,
      }),
    })

    // max_tokens is dangling-unforkable: anchor splice ran, but no SR
    // materializes. Instead the dispatch fires fork.synthesis_failed and
    // fork.forked stays absent.
    await waitForEvent(fx.db, 'proxy.response_completed')
    const consumer = createEventConsumer(fx.db)
    const found = consumer.poll('_probe_no_forked', ['fork.forked'], 1)
    expect(found.length).toBe(0)
  })

  // ── Phase 2 (v0.5.1): deferred fork.forked across tool_use chains ─────────
  // Empirical signal from dogfooding: post-rewind AI commonly chains tool
  // calls (Read, Bash, recall) before answering, so the first post-rewind
  // turn closes with stop_reason=tool_use, not end_turn. The naive gate
  // (only emit on end_turn) drops the SR silently in those cases.
  // Defer-and-fire-on-eventual-end_turn pins the recovery.

  it('fork.forked: deferred when first post-rewind turn is tool_use, fires on a later end_turn', async () => {
    // Three /v1/messages calls. T1: anchor spliced, response=tool_use →
    // setPendingSynthetic stashes the SR-construction state on
    // fork_anchors.synthetic_metadata_json. T2: same anchor still in body,
    // response=tool_use → still deferred. T3: anchor still in body,
    // response=end_turn → fork.forked fires with the original SR metadata
    // and to_revision_id pointing at T1's request event.
    const localDb = openDb({ path: ':memory:' })
    migrate(localDb)
    const localChannel = createChannel({ db: localDb, tasks: await defaultTasks() })

    let callCount = 0
    mock = await startMock((_req, res) => {
      callCount += 1
      const stopReason = callCount < 3 ? 'tool_use' : 'end_turn'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: stopReason, content: [{ type: 'text', text: 'ok' }] }))
    })
    proxy = await startServer({
      port: 0,
      channel: localChannel,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: localDb,
    })

    const sessionId = 'sess-deferred-happy'
    const token = seedActiveAnchor(localDb, sessionId, {
      target_messages: [{ role: 'user', content: 'rewritten' }],
      fork_point_revision_id: 'ver-fork-deferred',
      source_view_id: 'view-deferred',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'view-target-deferred',
        synthetic_revision_id: 'rev-synth-deferred',
        synthetic_tool_result_text: 'Rewind initiated. Target: rev_deferred.',
        synthetic_assistant_text: 'Rewind initiated. Jumping to rev_deferred.',
        synthetic_user_message: 'go',
        parent_revision_id: 'rev-r1-deferred',
        back_requested_at: 9999,
      },
    })

    // The same anchor stays in the body across all 3 turns (claude carries
    // the rewind_to tool_result through its local jsonl until /compact or
    // /clear wipes it). Each turn uses a unique R1 tool_use_id so the parsed
    // assistant blocks aren't duplicates.
    const body = (turn: number) => bodyWithAnchor({
      history: [{ role: 'user', content: `q${turn}` }],
      toolUseId: `toolu_${turn}`,
      toolName: 'rewind_to',
      anchorToken: token,
    })

    // T1: splice runs, response=tool_use → defer.
    await (await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: body(1),
    })).text()
    await waitForEvent(localDb, 'proxy.response_completed')
    let consumer = createEventConsumer(localDb)
    expect(consumer.poll('_probe_defer_t1', ['fork.forked'], 1).length).toBe(0)
    const meta1 = (localDb
      .prepare('SELECT synthetic_metadata_json FROM fork_anchors WHERE anchor_token=?')
      .get(token) as { synthetic_metadata_json: string | null }).synthetic_metadata_json
    expect(meta1).toBeTruthy()
    expect(JSON.parse(meta1!).synthetic.synthetic_revision_id).toBe('rev-synth-deferred')

    // T2: anchor still in body, response=tool_use → still deferred.
    await (await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: body(2),
    })).text()
    consumer = createEventConsumer(localDb)
    expect(consumer.poll('_probe_defer_t2', ['fork.forked'], 1).length).toBe(0)
    // Anchor must still be active — deferred state shouldn't release.
    const stateAfterT2 = (localDb
      .prepare('SELECT state FROM fork_anchors WHERE anchor_token=?')
      .get(token) as { state: string }).state
    expect(stateAfterT2).toBe('active')

    // T3: anchor still in body, response=end_turn → fork.forked fires.
    await (await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: body(3),
    })).text()

    const forkedPayload = await waitForEvent(localDb, 'fork.forked') as {
      synthetic_revision_id?: string
      target_view_id?: string
      to_revision_id?: string
      sealed_at?: number
    }
    expect(forkedPayload.synthetic_revision_id).toBe('rev-synth-deferred')
    expect(forkedPayload.target_view_id).toBe('view-target-deferred')
    expect(forkedPayload.sealed_at).toBe(9999)
    expect(forkedPayload.to_revision_id).toMatch(/.+/)

    // synthetic_metadata_json cleared on fire so a subsequent end_turn (e.g.,
    // a follow-up turn that still carries the same anchor) doesn't re-fire.
    const cleared = (localDb
      .prepare('SELECT synthetic_metadata_json FROM fork_anchors WHERE anchor_token=?')
      .get(token) as { synthetic_metadata_json: string | null }).synthetic_metadata_json
    expect(cleared).toBeNull()
  })

  it('fork.synthesis_failed: deferred SR abandoned when chain ends on max_tokens', async () => {
    // T1: splice runs, response=tool_use → defer.
    // T2: same anchor in body, response=max_tokens (dangling_unforkable) →
    //     fork.synthesis_failed + synthetic_metadata cleared.
    const localDb = openDb({ path: ':memory:' })
    migrate(localDb)
    const localChannel = createChannel({ db: localDb, tasks: await defaultTasks() })

    let callCount = 0
    mock = await startMock((_req, res) => {
      callCount += 1
      const stopReason = callCount === 1 ? 'tool_use' : 'max_tokens'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: stopReason, content: [{ type: 'text', text: '...' }] }))
    })
    proxy = await startServer({
      port: 0,
      channel: localChannel,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: localDb,
    })

    const sessionId = 'sess-deferred-abandon'
    const token = seedActiveAnchor(localDb, sessionId, {
      target_messages: [{ role: 'user', content: 'r' }],
      fork_point_revision_id: 'ver-fork-abandon',
      source_view_id: 'view-abandon',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'tv-abandon',
        synthetic_revision_id: 'rev-abandon',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        parent_revision_id: 'r1-abandon',
        back_requested_at: 1,
      },
    })

    const body = (n: number) => bodyWithAnchor({
      history: [{ role: 'user', content: 'q' }],
      toolUseId: `t${n}`,
      toolName: 'rewind_to',
      anchorToken: token,
    })

    await (await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: body(1),
    })).text()
    await (await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: body(2),
    })).text()

    await waitForEvent(localDb, 'fork.synthesis_failed')
    const consumer = createEventConsumer(localDb)
    expect(consumer.poll('_probe_abandon_no_forked', ['fork.forked'], 1).length).toBe(0)

    // synthetic_metadata_json cleared after the abandon.
    const cleared = (localDb
      .prepare('SELECT synthetic_metadata_json FROM fork_anchors WHERE anchor_token=?')
      .get(token) as { synthetic_metadata_json: string | null }).synthetic_metadata_json
    expect(cleared).toBeNull()
  })

  it('fork.forked: NOT emitted on 4xx upstream (not 2xx)', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit' } }))
    })
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: fx.db,
    })

    const sessionId = 'sess-4xx'
    const token = seedActiveAnchor(fx.db, sessionId, {
      target_messages: [{ role: 'user', content: 'r' }],
      fork_point_revision_id: 'ver-fork-z',
      source_view_id: 'view-z',
      synthetic: {
        kind: 'rewind',
        target_view_id: 'tv',
        synthetic_revision_id: 'rev-4xx',
        synthetic_tool_result_text: 't',
        synthetic_assistant_text: 'a',
        synthetic_user_message: 'u',
        parent_revision_id: 'r1',
        back_requested_at: 1,
      },
    })
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: bodyWithAnchor({
        history: [{ role: 'user', content: 'orig' }],
        toolUseId: 'toolu_4xx',
        toolName: 'rewind_to',
        anchorToken: token,
      }),
    })

    await waitForEvent(fx.db, 'proxy.response_completed')
    const consumer = createEventConsumer(fx.db)
    const found = consumer.poll('_probe_no_forked_4xx', ['fork.forked'], 1)
    expect(found.length).toBe(0)
  })

  it('fork.forked: NOT emitted when fork_anchors row has no synthetic_metadata', async () => {
    // An anchor without synthetic_metadata (e.g., a cascade-fork SR that
    // was already materialized in a prior session) still splices, but
    // there's no SR construction to perform. Verifies the splice runs
    // unconditionally for active rows but fork.forked is gated on the
    // presence of synthetic_metadata.
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }))
    })
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: fx.db,
    })

    const sessionId = 'sess-no-synth'
    const token = seedActiveAnchor(fx.db, sessionId, {
      target_messages: [{ role: 'user', content: 'r' }],
      fork_point_revision_id: 'ver-old',
      source_view_id: 'view-old',
      // no synthetic_metadata — the row was created via a different code
      // path or had its metadata cleared post-fork.forked.
    })
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: bodyWithAnchor({
        history: [{ role: 'user', content: 'orig' }],
        toolUseId: 'toolu_nosynth',
        toolName: 'rewind_to',
        anchorToken: token,
      }),
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
      channel: fx.channel,
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
    const channel = createChannel({ db, tasks: await defaultTasks() })

    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hi' }],
      }))
    })
    proxy = await startServer({
      port: 0,
      channel,
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
      channel: fx.channel,
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
      channel: fx.channel,
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
      channel: fx.channel,
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
      channel: fx.channel,
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

  it('anchor stays active on upstream 5xx so claude\'s retry re-splices (A-R8)', async () => {
    // v0.6 contract: an anchor's lifecycle is decoupled from per-request
    // outcome. Unlike v0.5's TOBE pending file (which got deleted on the
    // first 2xx and survived 5xx so claude's retry would re-apply), the
    // anchor row stays `active` regardless of HTTP status. Claude's retry
    // produces the same body with the same anchor token; applyAnchorSplice
    // runs again. The anchor only transitions on explicit signals: /clear,
    // /compact, divergence, supersession, parallel_tools, or upstream_4xx.
    // 5xx is none of those — pure infrastructure transient — so the row
    // sits and waits.
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
      channel: fx.channel,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: fx.db,
    })
    const sessionId = 'sess-retry'
    const token = seedActiveAnchor(fx.db, sessionId, {
      target_messages: [{ role: 'user', content: 'retry-me' }],
      fork_point_revision_id: 'v-retry-fp',
      source_view_id: 'view-retry',
    })

    const body = bodyWithAnchor({
      history: [{ role: 'user', content: 'ORIG' }],
      toolUseId: 'toolu_retry',
      toolName: 'rewind_to',
      anchorToken: token,
    })

    // First call — upstream 5xx. Anchor stays active.
    const r1 = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body,
    })
    expect(r1.status).toBe(502)
    const after1 = fx.db.prepare(
      'SELECT state FROM fork_anchors WHERE anchor_token=?',
    ).get(token) as { state: string }
    expect(after1.state).toBe('active')

    // Second call — upstream 2xx. Anchor still active (no transition on success).
    const r2 = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body,
    })
    expect(r2.status).toBe(200)
    const after2 = fx.db.prepare(
      'SELECT state FROM fork_anchors WHERE anchor_token=?',
    ).get(token) as { state: string }
    expect(after2.state).toBe('active')
  })

  it('notifies ForkAwaiter on a completed anchor-spliced request (A-R8 scaffolding)', async () => {
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ stop_reason: 'end_turn' }))
    })
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: fx.db,
    })
    const sessionId = 'sess-await'
    const token = seedActiveAnchor(fx.db, sessionId, {
      target_messages: [{ role: 'user', content: 'forked' }],
      fork_point_revision_id: 'v-await-fp',
      source_view_id: 'view-await',
    })
    // Register the waiter BEFORE the HTTP call so the awaiter is primed.
    const outcomeP = proxy.forkAwaiter.wait(sessionId, 5000)
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: bodyWithAnchor({
        history: [{ role: 'user', content: 'ORIG' }],
        toolUseId: 'toolu_await',
        toolName: 'rewind_to',
        anchorToken: token,
      }),
    })
    await res.text()
    const outcome = await outcomeP
    expect(outcome.status).toBe('completed')
    expect(outcome.http_status).toBe(200)
    expect(outcome.stop_reason).toBe('end_turn')
    expect(outcome.fork_point_revision_id).toBe('v-await-fp')
    expect(outcome.source_view_id).toBe('view-await')
  })

  it('notifies ForkAwaiter with upstream_error on connect failure', async () => {
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      upstream: 'http://127.0.0.1:1', // unreachable
      db: fx.db,
    })
    const sessionId = 'sess-await-err'
    const token = seedActiveAnchor(fx.db, sessionId, {
      target_messages: [{ role: 'user', content: 'forked' }],
      fork_point_revision_id: 'v-fp',
      source_view_id: 'view-err',
    })
    const outcomeP = proxy.forkAwaiter.wait(sessionId, 5000)
    await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: bodyWithAnchor({
        history: [{ role: 'user', content: 'q' }],
        toolUseId: 'toolu_err',
        toolName: 'rewind_to',
        anchorToken: token,
      }),
    })
    const outcome = await outcomeP
    expect(outcome.status).toBe('upstream_error')
    expect(outcome.http_status).toBe(502)
    // Anchor row stays active — upstream failure is transient. Claude's
    // retry produces the same body with the same anchor; splice re-runs.
    const row = fx.db.prepare(
      'SELECT state FROM fork_anchors WHERE anchor_token=?',
    ).get(token) as { state: string }
    expect(row.state).toBe('active')
  })

  it('does NOT touch fork_anchors for non-messages /v1/* paths', async () => {
    // v0.6: applyAnchorSplice only runs when isMessagesEndpoint is true.
    // A /v1/models probe (or any non-messages path) must NOT release the
    // active anchor on divergence even though the probe body lacks the
    // anchor token. Mirrors the count_tokens skip but for non-/messages
    // routes generally.
    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
    })
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      upstream: `http://127.0.0.1:${mock.port}`,
      db: fx.db,
    })
    const sessionId = 'sess-nontarget'
    const token = seedActiveAnchor(fx.db, sessionId, {
      target_messages: [{ role: 'user', content: 'only-apply-to-messages' }],
      fork_point_revision_id: 'v-keep',
      source_view_id: 'view-keep',
    })
    // Hit /v1/models — must NOT touch fork_anchors.
    await fetch(`http://127.0.0.1:${proxy.port}/v1/models`, {
      method: 'GET',
      headers: { [SESSION_HEADER]: sessionId },
    })
    // Anchor row still active for the next /v1/messages.
    const row = fx.db.prepare(
      'SELECT state, state_reason FROM fork_anchors WHERE anchor_token=?',
    ).get(token) as { state: string, state_reason: string | null }
    expect(row.state).toBe('active')
    expect(row.state_reason).toBeNull()
  })

  it('count_tokens skips applyAnchorSplice — no splice, no release on tiny body', async () => {
    // Forensic: b17275fb 2026-05-08 11:55:25. claude code's count_tokens
    // probe (121-byte body, no anchor from active fork) was hitting the
    // divergence guard and false-triggering session.fork_anchor_released
    // because `isMessagesPath = url.includes('/messages')` matched both
    // /v1/messages and /v1/messages/count_tokens. The fix splits into
    // isMessagesEndpoint (the real conversation endpoint) and isMessagesPath
    // (any /messages-shaped path). count_tokens is now a pass-through.
    const sessionId = 'sess-count-tokens'
    fx.db.prepare(
      'INSERT INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)',
    ).run(sessionId, 'task-ct', 'default', Date.now(), 'claude-code')
    // Seed an active fork_anchors row — if the anchor scan ran on count_tokens
    // with a body lacking the anchor token, divergence would mark this row
    // released. The skip prevents that.
    const targetMessages = [
      { role: 'user', content: 'fork user' },
      { role: 'assistant', content: 'distinctive forked asst response' },
      { role: 'user', content: 'fork synthetic user' },
    ]
    fx.db.prepare(`
      INSERT INTO fork_anchors (
        anchor_token, session_id, target_messages_json, target_messages_top_cid,
        fork_point_revision_id, source_view_id, synthetic_metadata_json,
        state, state_reason, acknowledged_at, created_at, released_at
      ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 'active', NULL, NULL, ?, NULL)
    `).run('tok_aaaabbbbcccc', sessionId, JSON.stringify(targetMessages), Date.now())

    mock = await startMock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 1234 }))
    })
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      db: fx.db,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages/count_tokens?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'a' }],
      }),
    })
    expect(res.status).toBe(200)
    await res.text()

    // No release event fired (splice didn't run on count_tokens).
    const releaseRow = fx.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id=? AND topic=?')
      .get(sessionId, 'session.fork_anchor_released') as { n: number }
    expect(releaseRow.n).toBe(0)

    // Active anchor row still active (not released by count_tokens probe).
    const anchorRow = fx.db
      .prepare('SELECT state FROM fork_anchors WHERE anchor_token=?')
      .get('tok_aaaabbbbcccc') as { state: string }
    expect(anchorRow.state).toBe('active')
  })

  it('count_tokens passes through unchanged when no fork active', async () => {
    // Sanity: count_tokens with no branch_context_json should also pass
    // through with no body manipulation. (Existing behavior preserved.)
    const sessionId = 'sess-count-tokens-no-fork'
    fx.db.prepare(
      'INSERT INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)',
    ).run(sessionId, 'task-ct2', 'default', Date.now(), 'claude-code')

    let receivedBody: string | undefined
    mock = await startMock((_req, res, body) => {
      receivedBody = body.toString('utf8')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 42 }))
    })
    proxy = await startServer({
      port: 0,
      channel: fx.channel,
      db: fx.db,
      upstream: `http://127.0.0.1:${mock.port}`,
    })

    const sentBody = JSON.stringify({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'count this' }],
    })
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages/count_tokens?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body: sentBody,
    })
    expect(res.status).toBe(200)
    await res.text()

    // Body forwarded byte-equal (no manipulation).
    expect(receivedBody).toBe(sentBody)
  })

  // v0.5.5 had a session.branch_context_overflow event when the per-turn
  // splice grew branch_context_json past 8 MiB. v0.6 removes that overflow
  // path entirely: target_messages is set ONCE at rewind_to MCP-call time
  // and never grows. The 8 MiB cap (TARGET_MESSAGES_MAX_BYTES) is enforced
  // in mcp-tools.ts:rewind_to / submit_file and rejects oversized targets
  // synchronously. No proxy-handler-time overflow event possible.
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
