// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Tests for body-blob's content-addressed split + hydrate path.
// The bytes-blob path is exercised indirectly by every other test that
// emits a request_received event, so we don't repeat that here.

import { describe, expect, it } from 'vitest'

import {
  blobRefFromBytes,
  blobRefFromMessagesBody,
  loadHydratedMessagesBody,
} from '../body-blob.js'
import { type DB, migrate, openDb } from '../db.js'
import { SqliteStorageProvider } from '../storage.js'

function buildBody(messages: unknown[], tools?: unknown[]): Uint8Array {
  const body: Record<string, unknown> = { model: 'claude-test', messages }
  if (tools) body.tools = tools
  return new TextEncoder().encode(JSON.stringify(body))
}

function freshDb(): DB {
  const db = openDb({ path: ':memory:' })
  migrate(db)
  return db
}

function writeBlobs(db: DB, refs: Array<{ cid: string, bytes: Uint8Array }>): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)',
  )
  for (const r of refs) stmt.run(r.cid, Buffer.from(r.bytes), r.bytes.byteLength, Date.now())
}

describe('blobRefFromMessagesBody', () => {
  it('splits messages into one blob each plus a top blob', async () => {
    const body = buildBody([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'second' },
    ])
    const split = await blobRefFromMessagesBody(body)
    // 3 message leaves + 1 top blob = 4 refs.
    expect(split.refs).toHaveLength(4)
    // Top CID is distinct from any leaf.
    const leafCids = split.refs.slice(0, 3).map(r => r.cid)
    expect(leafCids).not.toContain(split.topCid)
  })

  it('produces identical CIDs for identical messages across two requests (dedup)', async () => {
    const sharedMessage = { role: 'user', content: 'remember ZEBRA' }
    const body1 = buildBody([sharedMessage, { role: 'assistant', content: 'OK' }])
    const body2 = buildBody([
      sharedMessage,
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'remember AARDVARK' },
    ])
    const split1 = await blobRefFromMessagesBody(body1)
    const split2 = await blobRefFromMessagesBody(body2)

    const cids1 = new Set(split1.refs.map(r => r.cid))
    const cids2 = new Set(split2.refs.map(r => r.cid))

    // Both bodies should share at least 2 leaf CIDs (the user + assistant
    // messages they have in common). Top CIDs differ because messages count
    // and tools differ at the top level.
    const shared = [...cids1].filter(c => cids2.has(c))
    expect(shared.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to a single raw blob when body is not parseable JSON', async () => {
    const garbage = new TextEncoder().encode('not-json-at-all')
    const split = await blobRefFromMessagesBody(garbage)
    expect(split.refs).toHaveLength(1)
    expect(split.refs[0].cid).toBe(split.topCid)
  })

  it('linkifies tools[] separately so identical tool definitions dedupe', async () => {
    const tools = [
      { name: 'fork_back', description: 'Roll back N turns', input_schema: { type: 'object' } },
    ]
    const body1 = buildBody([{ role: 'user', content: 'a' }], tools)
    const body2 = buildBody([{ role: 'user', content: 'b' }], tools)
    const split1 = await blobRefFromMessagesBody(body1)
    const split2 = await blobRefFromMessagesBody(body2)
    const cids1 = new Set(split1.refs.map(r => r.cid))
    const cids2 = new Set(split2.refs.map(r => r.cid))
    const shared = [...cids1].filter(c => cids2.has(c))
    // The tool definition is the only thing both bodies share; expect at
    // least that one CID in common.
    expect(shared.length).toBeGreaterThanOrEqual(1)
  })
})

describe('loadHydratedMessagesBody', () => {
  it('round-trips: split → write → load reconstructs the original messages', async () => {
    const db = freshDb()
    const messages = [
      { role: 'user', content: 'remember ZEBRA' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'what is the secret?' },
    ]
    const split = await blobRefFromMessagesBody(buildBody(messages))
    writeBlobs(db, split.refs)
    const provider = new SqliteStorageProvider(db)
    const hydrated = await loadHydratedMessagesBody(provider, split.topCid)
    expect(hydrated).not.toBeNull()
    expect(hydrated!.messages).toEqual(messages)
    db.close()
  })

  it('returns null when the top blob is missing', async () => {
    const db = freshDb()
    const provider = new SqliteStorageProvider(db)
    // CID.parse needs a syntactically-valid CID string; use a real CID
    // for a value we never persisted so fetchBuffer throws "Blob not found".
    const orphan = await blobRefFromBytes(new TextEncoder().encode('orphan'))
    const result = await loadHydratedMessagesBody(provider, orphan.cid)
    expect(result).toBeNull()
    db.close()
  })

  it('drops missing leaf entries without aborting the whole hydration', async () => {
    const db = freshDb()
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]
    const split = await blobRefFromMessagesBody(buildBody(messages))
    // Write everything except the SECOND leaf.
    writeBlobs(db, [split.refs[0], split.refs[2], split.refs[3]])
    const provider = new SqliteStorageProvider(db)
    const hydrated = await loadHydratedMessagesBody(provider, split.topCid)
    expect(hydrated).not.toBeNull()
    expect(hydrated!.messages).toHaveLength(2)
    db.close()
  })

  it('returns null when top blob is raw bytes (legacy fallback path)', async () => {
    const db = freshDb()
    const blob = await blobRefFromBytes(new TextEncoder().encode('not-dag-json'))
    writeBlobs(db, [blob.ref])
    const provider = new SqliteStorageProvider(db)
    // loadHydratedMessagesBody should refuse a raw-codec blob; caller
    // handles the legacy path elsewhere.
    const result = await loadHydratedMessagesBody(provider, blob.cid)
    expect(result).toBeNull()
    db.close()
  })
})
