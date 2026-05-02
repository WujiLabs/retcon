// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unit tests for rewind_marker_v1 (Phase 2).
//
// Two surfaces under test:
//   - buildSyntheticAsset: async helper that loads R1's bodies and composes
//     the synthetic SR body (history-through-R1 + R2'/R3').
//   - RewindMarkerV1Projector: sync projector that INSERTs an SR row from
//     fork.forked.
//
// We don't run the full server here — we drive the producer directly, the
// way revisions_v1 / branch_views_v1 tests do. Keeps the tests fast and
// focused on the projector's own state machine.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { blobRefFromBytes, blobRefFromMessagesBody, loadHydratedMessagesBody } from '../body-blob.js'
import type { DB } from '../db.js'
import { migrate, openDb } from '../db.js'
import { createEventConsumer, createEventProducer, type EventProducer } from '../events.js'
import { RevisionsV1Projector } from '../revisions-v1.js'
import { buildSyntheticAsset, type ForkForkedPayload, RewindMarkerV1Projector } from '../rewind-marker-v1.js'
import { SessionsV1Projector } from '../sessions-v1.js'
import { SqliteStorageProvider } from '../storage.js'

interface TestFixture {
  db: DB
  producer: EventProducer
  storage: SqliteStorageProvider
  cleanup: () => void
}

function fixture(): TestFixture {
  const db = openDb({ path: ':memory:' })
  migrate(db)
  // Wire the full projector chain so revisions get rows built from the
  // request_received + response_completed pair we seed for R1.
  const producer = createEventProducer(db, [
    new SessionsV1Projector(),
    new RevisionsV1Projector(),
    new RewindMarkerV1Projector(),
  ])
  const tmp = mkdtempSync(path.join(tmpdir(), 'rewind-marker-test-'))
  // Bootstrap the session so revisions_v1 doesn't bail on missing FK.
  producer.emit('mcp.session_initialized', { mcp_session_id: 'm', harness: 'claude-code' }, 'sess-rm')
  return {
    db,
    producer,
    storage: new SqliteStorageProvider(db),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

/**
 * Seed R1: emit request_received + response_completed with real body blobs.
 * Returns the request event id (= R1.id) and the response body's tool_use_id.
 */
async function seedR1(
  fx: TestFixture,
  history: unknown[],
  toolUseId: string,
): Promise<{ r1Id: string }> {
  const reqBytes = Buffer.from(JSON.stringify({ messages: history }), 'utf8')
  const reqSplit = await blobRefFromMessagesBody(reqBytes)
  const r1 = fx.producer.emit(
    'proxy.request_received',
    { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: reqSplit.topCid },
    'sess-rm',
    reqSplit.refs,
  )
  const respBytes = Buffer.from(
    JSON.stringify({
      content: [
        { type: 'text', text: 'thinking...' },
        { type: 'tool_use', id: toolUseId, name: 'rewind_to', input: {} },
      ],
    }),
    'utf8',
  )
  const respBlob = await blobRefFromBytes(respBytes)
  fx.producer.emit(
    'proxy.response_completed',
    {
      request_event_id: r1.id,
      status: 200,
      headers_cid: 'h',
      body_cid: respBlob.cid,
      stop_reason: 'tool_use',
      asset_cid: 'asset-r1',
    },
    'sess-rm',
    [respBlob.ref],
  )
  return { r1Id: r1.id }
}

describe('buildSyntheticAsset', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  it('returns null when R1 has no request_received event', async () => {
    const built = await buildSyntheticAsset(
      { db: fx.db, storageProvider: fx.storage },
      {
        parentRevisionId: 'no-such-revision',
        syntheticToolResultText: 't',
        syntheticAssistantText: 'a',
        toolUseId: 'toolu',
      },
    )
    expect(built).toBeNull()
  })

  it('returns null when R1 has request_received but no response_completed', async () => {
    const reqBytes = Buffer.from(JSON.stringify({ messages: [] }), 'utf8')
    const reqSplit = await blobRefFromMessagesBody(reqBytes)
    const r1 = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: reqSplit.topCid },
      'sess-rm',
      reqSplit.refs,
    )
    const built = await buildSyntheticAsset(
      { db: fx.db, storageProvider: fx.storage },
      {
        parentRevisionId: r1.id,
        syntheticToolResultText: 't',
        syntheticAssistantText: 'a',
        toolUseId: 'toolu',
      },
    )
    expect(built).toBeNull()
  })

  it('builds a synthetic body that hydrates back to history + R1.assistant + R2 + R3', async () => {
    const history = [
      { role: 'user', content: 'first user turn' },
      { role: 'assistant', content: 'first assistant reply' },
      { role: 'user', content: 'second user turn' },
    ]
    const { r1Id } = await seedR1(fx, history, 'toolu_42')
    const built = await buildSyntheticAsset(
      { db: fx.db, storageProvider: fx.storage },
      {
        parentRevisionId: r1Id,
        syntheticToolResultText: 'TOOL_RESULT_TEXT',
        syntheticAssistantText: 'ASSISTANT_TEXT',
        toolUseId: 'toolu_42',
      },
    )
    expect(built).not.toBeNull()
    expect(built!.topCid).toMatch(/.+/)
    expect(built!.refs.length).toBeGreaterThan(0)

    // Persist the built blobs so loadHydratedMessagesBody can resolve them.
    for (const r of built!.refs) {
      fx.db.prepare(
        'INSERT OR IGNORE INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)',
      ).run(r.cid, r.bytes, r.bytes.byteLength, Date.now())
    }
    const hydrated = await loadHydratedMessagesBody(fx.storage, built!.topCid as never)
    expect(hydrated).not.toBeNull()
    const messages = hydrated!.messages as Array<{ role: string, content: unknown }>
    // 3 history + 1 R1-assistant-wrap + 1 R2'-tool_result + 1 R3'-assistant
    expect(messages.length).toBe(6)
    expect(messages[0].role).toBe('user')
    expect((messages[0] as { content: string }).content).toBe('first user turn')
    expect(messages[3].role).toBe('assistant')
    expect(messages[4].role).toBe('user')
    const r2Content = messages[4].content as Array<{ type: string, tool_use_id: string }>
    expect(r2Content[0].type).toBe('tool_result')
    expect(r2Content[0].tool_use_id).toBe('toolu_42')
    expect(messages[5].role).toBe('assistant')
    const r3Content = messages[5].content as Array<{ type: string, text: string }>
    expect(r3Content[0].type).toBe('text')
    expect(r3Content[0].text).toBe('ASSISTANT_TEXT')
  })

  it('returns null when R1 response body is not parseable JSON', async () => {
    // Emit R1 with a request body but a response body that's malformed JSON.
    const reqBytes = Buffer.from(JSON.stringify({ messages: [] }), 'utf8')
    const reqSplit = await blobRefFromMessagesBody(reqBytes)
    const r1 = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: reqSplit.topCid },
      'sess-rm',
      reqSplit.refs,
    )
    const garbage = Buffer.from('{not valid json', 'utf8')
    const respBlob = await blobRefFromBytes(garbage)
    fx.producer.emit(
      'proxy.response_completed',
      {
        request_event_id: r1.id,
        status: 200,
        headers_cid: 'h',
        body_cid: respBlob.cid,
        stop_reason: 'end_turn',
        asset_cid: 'a',
      },
      'sess-rm',
      [respBlob.ref],
    )
    const built = await buildSyntheticAsset(
      { db: fx.db, storageProvider: fx.storage },
      {
        parentRevisionId: r1.id,
        syntheticToolResultText: 't',
        syntheticAssistantText: 'a',
        toolUseId: 'toolu',
      },
    )
    expect(built).toBeNull()
  })
})

describe('RewindMarkerV1Projector', () => {
  let fx: TestFixture
  beforeEach(() => {
    fx = fixture()
  })
  afterEach(() => fx.cleanup())

  it('inserts an SR row on fork.forked, parented to R1, classified closed_forkable', async () => {
    const { r1Id } = await seedR1(fx, [{ role: 'user', content: 'q' }], 'toolu_a')

    const built = await buildSyntheticAsset(
      { db: fx.db, storageProvider: fx.storage },
      {
        parentRevisionId: r1Id,
        syntheticToolResultText: 'tr',
        syntheticAssistantText: 'as',
        toolUseId: 'toolu_a',
      },
    )
    expect(built).not.toBeNull()

    const payload: ForkForkedPayload = {
      kind: 'rewind',
      synthetic_revision_id: 'rev-synth-AAA',
      parent_revision_id: r1Id,
      target_revision_id: 'rev-target',
      to_revision_id: 'rev-new',
      synthetic_tool_result_text: 'tr',
      synthetic_assistant_text: 'as',
      synthetic_user_message: 'hi',
      tool_use_id: 'toolu_a',
      target_view_id: 'view-target',
      sealed_at: 9999,
      synthetic_asset_cid: built!.topCid,
    }
    fx.producer.emit('fork.forked', payload, 'sess-rm', built!.refs)

    const sr = fx.db.prepare(
      'SELECT id, task_id, asset_cid, parent_revision_id, classification, stop_reason, sealed_at FROM revisions WHERE id = ?',
    ).get('rev-synth-AAA') as
    | {
      id: string
      task_id: string
      asset_cid: string
      parent_revision_id: string
      classification: string
      stop_reason: string
      sealed_at: number
    }
    | undefined
    expect(sr).toBeTruthy()
    expect(sr!.parent_revision_id).toBe(r1Id)
    expect(sr!.classification).toBe('closed_forkable')
    expect(sr!.stop_reason).toBe('rewind_synthetic')
    expect(sr!.asset_cid).toBe(built!.topCid)
    expect(sr!.sealed_at).toBe(9999)
  })

  it('uses stop_reason="submit_synthetic" when payload.kind="submit"', async () => {
    const { r1Id } = await seedR1(fx, [{ role: 'user', content: 'q' }], 'toolu_b')
    const built = await buildSyntheticAsset(
      { db: fx.db, storageProvider: fx.storage },
      {
        parentRevisionId: r1Id,
        syntheticToolResultText: 'tr',
        syntheticAssistantText: 'as',
        toolUseId: 'toolu_b',
      },
    )
    fx.producer.emit('fork.forked', {
      kind: 'submit',
      synthetic_revision_id: 'rev-synth-SUB',
      parent_revision_id: r1Id,
      target_revision_id: 'rev-target',
      to_revision_id: 'rev-new',
      synthetic_tool_result_text: 'tr',
      synthetic_assistant_text: 'as',
      synthetic_user_message: 'apply',
      tool_use_id: 'toolu_b',
      target_view_id: 'view-target',
      sealed_at: 1,
      synthetic_asset_cid: built!.topCid,
    } satisfies ForkForkedPayload, 'sess-rm', built!.refs)

    const sr = fx.db.prepare(
      'SELECT stop_reason FROM revisions WHERE id = ?',
    ).get('rev-synth-SUB') as { stop_reason: string } | undefined
    expect(sr?.stop_reason).toBe('submit_synthetic')
  })

  it('idempotent: re-emitting the same fork.forked does NOT duplicate the SR row', async () => {
    const { r1Id } = await seedR1(fx, [{ role: 'user', content: 'q' }], 'toolu_c')
    const built = await buildSyntheticAsset(
      { db: fx.db, storageProvider: fx.storage },
      {
        parentRevisionId: r1Id,
        syntheticToolResultText: 'tr',
        syntheticAssistantText: 'as',
        toolUseId: 'toolu_c',
      },
    )
    const payload: ForkForkedPayload = {
      kind: 'rewind',
      synthetic_revision_id: 'rev-synth-IDEM',
      parent_revision_id: r1Id,
      target_revision_id: 'rev-target',
      to_revision_id: 'rev-new',
      synthetic_tool_result_text: 'tr',
      synthetic_assistant_text: 'as',
      synthetic_user_message: 'hi',
      tool_use_id: 'toolu_c',
      target_view_id: 'view-target',
      sealed_at: 1,
      synthetic_asset_cid: built!.topCid,
    }
    fx.producer.emit('fork.forked', payload, 'sess-rm', built!.refs)
    fx.producer.emit('fork.forked', payload, 'sess-rm', built!.refs)

    const count = fx.db.prepare(
      'SELECT COUNT(*) AS n FROM revisions WHERE id = ?',
    ).get('rev-synth-IDEM') as { n: number }
    expect(count.n).toBe(1)
  })

  it('skips insertion when parent_revision_id has no row in revisions', async () => {
    fx.producer.emit('fork.forked', {
      kind: 'rewind',
      synthetic_revision_id: 'rev-synth-ORPHAN',
      parent_revision_id: 'rev-does-not-exist',
      target_revision_id: 'rev-target',
      to_revision_id: 'rev-new',
      synthetic_tool_result_text: 'tr',
      synthetic_assistant_text: 'as',
      synthetic_user_message: 'hi',
      tool_use_id: 'toolu',
      target_view_id: 'view-target',
      sealed_at: 1,
      synthetic_asset_cid: 'cid-fake',
    } satisfies ForkForkedPayload, 'sess-rm')

    const sr = fx.db.prepare(
      'SELECT 1 FROM revisions WHERE id = ?',
    ).get('rev-synth-ORPHAN')
    expect(sr).toBeUndefined()
  })

  it('silently no-ops on unrelated event topics (does not insert spurious rows)', async () => {
    // Emit a few unrelated events; the projector should not insert any SR row.
    fx.producer.emit('proxy.request_received', {
      method: 'POST',
      path: '/v1/models',
      headers_cid: 'h',
      body_cid: 'b',
    }, 'sess-rm')
    const consumer = createEventConsumer(fx.db)
    const events = consumer.poll('_probe', ['fork.forked'], 100)
    expect(events.length).toBe(0)
    const rev = fx.db.prepare(
      'SELECT COUNT(*) AS n FROM revisions WHERE stop_reason IN (\'rewind_synthetic\', \'submit_synthetic\')',
    ).get() as { n: number }
    expect(rev.n).toBe(0)
  })

  it('SR is selectable by stop_reason, used by recall to discriminate kind', async () => {
    // Seed a real closed_forkable revision via a normal end_turn flow, then
    // an SR via fork.forked. Verify a query filtering by stop_reason finds
    // only the SR.
    const reqBytes = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }), 'utf8')
    const reqSplit = await blobRefFromMessagesBody(reqBytes)
    const realReq = fx.producer.emit(
      'proxy.request_received',
      { method: 'POST', path: '/v1/messages', headers_cid: 'h', body_cid: reqSplit.topCid },
      'sess-rm',
      reqSplit.refs,
    )
    fx.producer.emit('proxy.response_completed', {
      request_event_id: realReq.id,
      status: 200,
      headers_cid: 'h',
      body_cid: 'cid-resp',
      stop_reason: 'end_turn',
      asset_cid: 'asset-real',
    }, 'sess-rm')

    // Now emit an SR for that same R1.
    const built = await buildSyntheticAsset(
      { db: fx.db, storageProvider: fx.storage },
      {
        parentRevisionId: realReq.id,
        syntheticToolResultText: 'tr',
        syntheticAssistantText: 'as',
        toolUseId: 'toolu',
      },
    )
    // build returns null because the response body 'cid-resp' isn't a real blob.
    // For this test, fabricate the SR insert via the projector with a placeholder.
    expect(built).toBeNull()

    // Use a real synthetic CID via a tiny helper instead.
    const syntheticBytes = Buffer.from(JSON.stringify({ messages: [] }), 'utf8')
    const synBlob = await blobRefFromBytes(syntheticBytes)
    fx.producer.emit('fork.forked', {
      kind: 'rewind',
      synthetic_revision_id: 'rev-synth-SEL',
      parent_revision_id: realReq.id,
      target_revision_id: realReq.id,
      to_revision_id: realReq.id,
      synthetic_tool_result_text: 'tr',
      synthetic_assistant_text: 'as',
      synthetic_user_message: 'hi',
      tool_use_id: 'toolu',
      target_view_id: 'view-target',
      sealed_at: 1,
      synthetic_asset_cid: synBlob.cid,
    } satisfies ForkForkedPayload, 'sess-rm', [synBlob.ref])

    const synthCount = fx.db.prepare(
      'SELECT COUNT(*) AS n FROM revisions WHERE stop_reason = \'rewind_synthetic\'',
    ).get() as { n: number }
    expect(synthCount.n).toBe(1)
    const realCount = fx.db.prepare(
      'SELECT COUNT(*) AS n FROM revisions WHERE stop_reason = \'end_turn\'',
    ).get() as { n: number }
    expect(realCount.n).toBe(1)
  })
})
