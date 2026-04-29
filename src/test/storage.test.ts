// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import type { AssetId } from '@playtiss/core'
import { beforeEach, describe, expect, it } from 'vitest'

import type { DB } from '../db.js'
import { migrate, openDb } from '../db.js'
import { SqliteStorageProvider } from '../storage.js'

describe('SqliteStorageProvider', () => {
  let db: DB
  let store: SqliteStorageProvider

  beforeEach(() => {
    db = openDb({ path: ':memory:' })
    migrate(db)
    store = new SqliteStorageProvider(db)
  })

  it('round-trips a buffer', async () => {
    const id = 'bafy-round-trip' as AssetId
    const data = new Uint8Array([1, 2, 3, 4, 5])
    await store.saveBuffer(data, id)
    expect(await store.hasBuffer(id)).toBe(true)
    const fetched = await store.fetchBuffer(id)
    expect(Array.from(fetched)).toEqual([1, 2, 3, 4, 5])
  })

  it('returns false from hasBuffer for an unknown id', async () => {
    expect(await store.hasBuffer('bafy-missing' as AssetId)).toBe(false)
  })

  it('throws on fetchBuffer for an unknown id', async () => {
    await expect(store.fetchBuffer('bafy-missing' as AssetId)).rejects.toThrow(/Blob not found/)
  })

  it('saveBuffer is idempotent on duplicate cid', async () => {
    const id = 'bafy-dup' as AssetId
    await store.saveBuffer(new Uint8Array([1, 2]), id)
    // No throw on second save; row stays as-is (INSERT OR IGNORE).
    await store.saveBuffer(new Uint8Array([9, 9]), id)
    const row = db.prepare('SELECT size FROM blobs WHERE cid=?').get(id) as { size: number }
    expect(row.size).toBe(2)
  })

  it('accepts optional references arg for interface conformance', async () => {
    const id = 'bafy-ref' as AssetId
    await store.saveBuffer(new Uint8Array([7]), id, { assetReferences: ['bafy-other' as AssetId] })
    expect(await store.hasBuffer(id)).toBe(true)
  })
})
