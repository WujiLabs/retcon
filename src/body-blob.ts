// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Helpers for turning request/response bodies into CIDs + BlobRefs.
//
// Two storage modes:
//
// 1. blobRefFromBytes(bytes): single raw blob. Used for response bodies,
//    redacted header blobs, and other opaque byte streams. CID is core's raw
//    codec (sha256).
//
// 2. blobRefFromMessagesBody(body): content-addressed split of an Anthropic
//    /v1/messages request body. Each entry in `messages[]` and `tools[]` is
//    encoded as its own dag-json blob. The top body is then re-encoded with
//    those entries replaced by CID links. Same logical message across
//    different turns produces the same CID so storage scales linearly with
//    NEW content rather than O(N²) with conversation length.
//
// Reading: `loadHydratedMessagesBody(db, topCid)` walks the link references
// in the top blob and reassembles a fully-expanded body (messages + tools
// inline). Falls back to a flat JSON parse for legacy / non-split blobs.

import * as dagJSON from '@ipld/dag-json'
import type { AssetId } from '@playtiss/core'
import { cidToAssetId, computeTopBlock } from '@playtiss/core'
import * as Block from 'multiformats/block'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

import type { DB } from './db.js'
import type { BlobRef } from './events.js'

/**
 * Compute the CID of a raw byte buffer and return a BlobRef ready for emit.
 * The CID is derived using core's raw codec (sha256) so it matches the
 * convention of `@playtiss/core` storage consumers.
 */
export async function blobRefFromBytes(bytes: Uint8Array): Promise<{
  cid: AssetId
  ref: BlobRef
}> {
  const { cid, bytes: storedBytes } = await computeTopBlock(bytes)
  const assetId = cidToAssetId(cid)
  return {
    cid: assetId,
    ref: { cid: assetId, bytes: storedBytes },
  }
}

/**
 * Encode a single value as a dag-json block. Returns the CID + bytes ready
 * to write to the blobs table. Unlike `computeTopBlock`, this does NOT
 * recurse into nested structures — the value is encoded as a single dag-json
 * payload. Use this for message and tool entries: same logical message
 * always produces the same CID (dag-json sorts keys canonically) so two
 * turns that re-include the same prior message dedupe perfectly.
 */
async function encodeDagJsonBlock(value: unknown): Promise<{ cid: AssetId, bytes: Uint8Array }> {
  const block = await Block.encode({
    value: value as never,
    codec: dagJSON,
    hasher: sha256,
  })
  return {
    cid: cidToAssetId(block.cid as unknown as CID),
    bytes: block.bytes,
  }
}

export interface MessagesBodySplit {
  /** CID of the top blob (the body with messages/tools replaced by CID links). */
  topCid: AssetId
  /** All blobs to write to the blobs table — top + leaves. */
  refs: BlobRef[]
}

/**
 * Split an Anthropic /v1/messages request body into per-message and per-tool
 * blobs, returning the top blob's CID plus every leaf blob ready for batch
 * write to the blobs table.
 *
 * If the body isn't valid JSON or doesn't have a recognizable shape, falls
 * back to single-blob storage (semantically equivalent to blobRefFromBytes).
 *
 * Dedupe semantics: two requests that share an identical message (e.g., the
 * same `system-reminder` user turn replayed across N turns) reference the
 * same leaf CID. Storage scales linearly with NEW message content, not with
 * conversation length.
 */
export async function blobRefFromMessagesBody(body: Uint8Array): Promise<MessagesBodySplit> {
  let parsed: { messages?: unknown[], tools?: unknown[], [k: string]: unknown }
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8')) as typeof parsed
  }
  catch {
    // Fallback: store the raw body as a single blob.
    const flat = await blobRefFromBytes(body)
    return { topCid: flat.cid, refs: [flat.ref] }
  }

  const refs: BlobRef[] = []
  const linkified: typeof parsed = { ...parsed }

  if (Array.isArray(parsed.messages)) {
    const messageLinks: CID[] = []
    for (const msg of parsed.messages) {
      const block = await encodeDagJsonBlock(msg)
      refs.push({ cid: block.cid, bytes: block.bytes })
      messageLinks.push(CID.parse(block.cid))
    }
    linkified.messages = messageLinks as unknown[]
  }

  if (Array.isArray(parsed.tools)) {
    const toolLinks: CID[] = []
    for (const tool of parsed.tools) {
      const block = await encodeDagJsonBlock(tool)
      refs.push({ cid: block.cid, bytes: block.bytes })
      toolLinks.push(CID.parse(block.cid))
    }
    linkified.tools = toolLinks as unknown[]
  }

  // Encode the top body with messages/tools replaced by CID links.
  const top = await encodeDagJsonBlock(linkified)
  refs.push({ cid: top.cid, bytes: top.bytes })

  return { topCid: top.cid, refs }
}

/**
 * Hydrate a messages-body blob: load the top blob, follow `messages[]` and
 * `tools[]` links, return a fully-expanded JS object suitable for callers
 * that need to read the original request body (e.g. fork_back's reconstruction).
 *
 * Returns null if:
 *   - the top CID isn't in the blobs table
 *   - the top blob isn't dag-json (likely a legacy raw blob — caller should
 *     fall back to the legacy path)
 *
 * Tolerates partially-missing leaves: if a single message blob is gone for
 * some reason, that entry is dropped from the result rather than aborting
 * the whole hydration. The reconstruction is "best effort" by design.
 */
export function loadHydratedMessagesBody(
  db: DB,
  topCid: AssetId,
): Record<string, unknown> | null {
  const topRow = db
    .prepare('SELECT bytes FROM blobs WHERE cid = ?')
    .get(topCid) as { bytes: Uint8Array } | undefined
  if (!topRow) return null

  let decoded: unknown
  try {
    decoded = dagJSON.decode(topRow.bytes)
  }
  catch {
    // Not a dag-json blob — caller can choose to retry as raw JSON.
    return null
  }
  if (typeof decoded !== 'object' || decoded === null) return null

  const top = decoded as Record<string, unknown>
  const result: Record<string, unknown> = { ...top }

  if (Array.isArray(top.messages)) {
    result.messages = top.messages
      .map(entry => resolveLink(db, entry))
      .filter((m): m is unknown => m !== undefined)
  }
  if (Array.isArray(top.tools)) {
    result.tools = top.tools
      .map(entry => resolveLink(db, entry))
      .filter((t): t is unknown => t !== undefined)
  }
  return result
}

function resolveLink(db: DB, entry: unknown): unknown | undefined {
  const cid = CID.asCID(entry)
  if (!cid) return entry // already inline (legacy / non-link entry)
  const row = db
    .prepare('SELECT bytes FROM blobs WHERE cid = ?')
    .get(cid.toString()) as { bytes: Uint8Array } | undefined
  if (!row) return undefined // missing leaf — skip
  try {
    return dagJSON.decode(row.bytes)
  }
  catch {
    return undefined
  }
}
