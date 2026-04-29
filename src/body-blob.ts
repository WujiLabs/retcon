// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Helpers for turning a raw Uint8Array (request or response body, headers)
// into a CID + BlobRef suitable for EventProducer.emit's `referencedBlobs`.
//
// We wrap `@playtiss/core`'s `computeTopBlock` so the proxy never hashes
// anything by itself — the CID scheme is core's responsibility.

import type { AssetId } from '@playtiss/core'
import { cidToAssetId, computeTopBlock } from '@playtiss/core'

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
