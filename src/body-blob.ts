// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Helpers for turning request/response bodies into CIDs + BlobRefs.
//
// All content-addressing goes through `@playtiss/core`'s primitives so the
// proxy can never drift from core's CID convention silently. No direct
// `@ipld/dag-json` or `multiformats` imports live in this file (or
// anywhere in this package post-Phase-2 of the asset-store migration).
//
// Two storage modes:
//
// 1. blobRefFromBytes(bytes): single raw-codec blob. Used for response
//    bodies, redacted header blobs, and other opaque byte streams.
//
// 2. blobRefFromMessagesBody(body): content-addressed split of an
//    Anthropic /v1/messages request body. Each entry in `messages[]`
//    and `tools[]` is encoded as its own dag-json blob (via core's
//    `computeStorageBlock`); the top body is then re-encoded with those
//    entries replaced by CID links. Same logical message across turns
//    produces the same CID (Merkle hash + canonical key ordering), so
//    storage scales linearly with NEW content rather than O(N²) with
//    conversation length.
//
// Reading: `loadHydratedMessagesBody(provider, topCid)` calls core's
// `load()` to fetch the top blob (returning AssetValue with AssetLinks
// inline), then `resolve()` for each `messages[]` and `tools[]` entry to
// materialize them. Comparison-only callers can compare CIDs directly
// without resolving — equivalence is the CID itself.
//
// CID format note: per-message CIDs use core's Merkle hash via
// computeStorageBlock. Pre-Phase-2 retcon used a flat-hash variant. The
// two are NOT interchangeable for nested objects (every Anthropic
// message has a nested `content` array). Existing v0.2/v0.3 alpha DBs
// continue to read fine — old leaf CIDs still resolve via the blobs
// table — but new writes use the new CID values. Per the alpha
// nuke-and-reinit policy, this isn't a migration; old + new can coexist.

import {
  type AssetId,
  type AssetValue,
  CID,
  computeStorageBlock,
  load,
  resolve,
  type StorageProvider,
} from '@playtiss/core'

import type { BlobRef } from './events.js'

/**
 * Compute the CID of a raw byte buffer and return a BlobRef ready for emit.
 * For Uint8Array input, computeStorageBlock uses core's raw codec (sha256),
 * matching the @playtiss/core storage convention.
 */
export async function blobRefFromBytes(bytes: Uint8Array): Promise<{
  cid: AssetId
  ref: BlobRef
}> {
  const { cid, bytes: storedBytes } = await computeStorageBlock(bytes)
  return {
    cid,
    ref: { cid, bytes: storedBytes },
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
  let parsedRaw: unknown
  try {
    parsedRaw = JSON.parse(Buffer.from(body).toString('utf8'))
  }
  catch {
    // Fallback: store the raw body as a single blob.
    const flat = await blobRefFromBytes(body)
    return { topCid: flat.cid, refs: [flat.ref] }
  }
  // Only plain object bodies are recognised; null, primitives, or arrays
  // (valid JSON but not the /v1/messages shape) get the single-blob path.
  // Without this guard, `{...parsedRaw}` of an array would copy index keys
  // into the linkified top blob.
  if (parsedRaw === null || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
    const flat = await blobRefFromBytes(body)
    return { topCid: flat.cid, refs: [flat.ref] }
  }
  const parsed = parsedRaw as { messages?: unknown[], tools?: unknown[], [k: string]: unknown }

  const refs: BlobRef[] = []
  const linkified: typeof parsed = { ...parsed }

  if (Array.isArray(parsed.messages)) {
    const messageLinks: CID[] = []
    for (const msg of parsed.messages) {
      const block = await computeStorageBlock(msg as AssetValue)
      refs.push({ cid: block.cid, bytes: block.bytes })
      messageLinks.push(CID.parse(block.cid))
    }
    linkified.messages = messageLinks as unknown[]
  }

  if (Array.isArray(parsed.tools)) {
    const toolLinks: CID[] = []
    for (const tool of parsed.tools) {
      const block = await computeStorageBlock(tool as AssetValue)
      refs.push({ cid: block.cid, bytes: block.bytes })
      toolLinks.push(CID.parse(block.cid))
    }
    linkified.tools = toolLinks as unknown[]
  }

  // Encode the top body with messages/tools replaced by CID links.
  const top = await computeStorageBlock(linkified as AssetValue)
  refs.push({ cid: top.cid, bytes: top.bytes })

  return { topCid: top.cid, refs }
}

/**
 * Hydrate a messages-body blob: load the top blob via the StorageProvider,
 * resolve each `messages[]` and `tools[]` link, return a fully-expanded JS
 * object suitable for callers that need the original request body (e.g.
 * fork_back's reconstruction).
 *
 * Returns null if:
 *   - the top CID isn't in the provider (fetchBuffer threw)
 *   - the top blob's decoded value isn't an object (raw codec / array /
 *     primitive — caller should fall back to the legacy raw-JSON path)
 *
 * Tolerates partially-missing leaves: if a single message blob is gone
 * for some reason, that entry is dropped from the result rather than
 * aborting the whole hydration. The reconstruction is "best effort" by
 * design.
 *
 * Format detection is sniff-based: any top blob whose decoded value is
 * an object with `messages: CID[]` (and/or `tools: CID[]`) is treated as
 * the link-walk format. That works as long as nuke-and-reinit is the
 * schema-bump policy. When real migrations land, add a magic version
 * field, e.g. `{__retcon_split: 1, messages: [...], tools: [...]}`.
 */
export async function loadHydratedMessagesBody(
  provider: StorageProvider,
  topCid: AssetId,
): Promise<Record<string, unknown> | null> {
  let topValue: AssetValue
  try {
    topValue = await load(topCid, provider)
  }
  catch {
    return null
  }
  if (topValue instanceof Uint8Array) return null
  if (topValue === null || typeof topValue !== 'object' || Array.isArray(topValue)) {
    return null
  }

  const top = topValue as Record<string, AssetValue>
  const result: Record<string, unknown> = { ...top }

  if (Array.isArray(top.messages)) {
    result.messages = await materializeEntries(top.messages, provider)
  }
  if (Array.isArray(top.tools)) {
    result.tools = await materializeEntries(top.tools, provider)
  }
  return result
}

async function materializeEntries(
  entries: unknown[],
  provider: StorageProvider,
): Promise<unknown[]> {
  const materialized = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await resolve(entry as AssetValue, provider)
      }
      catch {
        return undefined
      }
    }),
  )
  return materialized.filter((m): m is AssetValue => m !== undefined)
}
