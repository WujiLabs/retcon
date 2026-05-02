// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// rewind_marker_v1 projector — materializes synthetic departure Revisions (SR)
// from `fork.forked` events.
//
// Phase 2 of the SR plan. proxy-handler (in async context) precomputes the
// synthetic body's content-addressed top CID + per-message blobs, hands them
// off via the fork.forked event payload + referencedBlobs. This sync projector
// reads the payload and INSERTs the SR row into `revisions`.
//
// Idempotency: ON CONFLICT(id) DO NOTHING — re-applying a fork.forked event
// (e.g., projector replay) is a no-op once the SR row exists.
//
// Failure mode: when proxy-handler can't load R1's bytes to build the
// synthetic body, it emits `fork.synthesis_failed` instead. This projector
// no-ops on that topic; the audit event captures the gap for the operator.

import type { AssetId, StorageProvider } from '@playtiss/core'

import { blobRefFromMessagesBody, loadHydratedMessagesBody } from './body-blob.js'
import type { DB } from './db.js'
import type { BlobRef, Event, Projection } from './events.js'

/** Payload of fork.forked. Mirrors what proxy-handler emits. */
export interface ForkForkedPayload {
  kind: 'rewind' | 'submit'
  synthetic_revision_id: string
  /** R1.id — the assistant turn that emitted tool_use(rewind_to|submit_file). */
  parent_revision_id: string
  /** The fork target. Same field shape as fork.back_requested.fork_point_revision_id. */
  target_revision_id: string
  /** R_new.id — the just-committed Revision created by the splice/submit. */
  to_revision_id: string
  synthetic_tool_result_text: string
  synthetic_assistant_text: string
  synthetic_user_message: string
  /** R1's tool_use id; pairs with the synthetic R2'-tool_result. */
  tool_use_id: string
  /** target_view_id from fork.back_requested correlation. */
  target_view_id: string
  /** SR.sealed_at — captured at MCP-call time. */
  sealed_at: number
  /** Top CID of the synthetic messages body (precomputed by proxy-handler). */
  synthetic_asset_cid: string
}

/** Payload of fork.synthesis_failed. Audit-only; projector ignores. */
export interface ForkSynthesisFailedPayload {
  parent_revision_id: string
  target_revision_id: string
  error_message: string
}

/**
 * Build the synthetic SR body: history-through-R1 + R2' (synthetic
 * tool_result paired with R1's tool_use_id) + R3' (synthetic assistant text).
 *
 * Pulls R1's request body messages and R1's response content from the
 * StorageProvider; concatenates them with the synthetic suffix; stores the
 * result via blobRefFromMessagesBody so SR's asset_cid is in the same
 * link-walked format as real Revision bodies (downstream consumers like
 * loadHydratedMessagesBody work transparently).
 *
 * Returns null on any failure (R1 not found, body unparseable, etc.).
 * Caller should emit `fork.synthesis_failed` on null and skip SR creation.
 */
export async function buildSyntheticAsset(
  deps: {
    db: DB
    storageProvider: StorageProvider
  },
  args: {
    parentRevisionId: string
    syntheticToolResultText: string
    syntheticAssistantText: string
    toolUseId: string
  },
): Promise<{ topCid: string, refs: BlobRef[] } | null> {
  // Look up R1's request_received body_cid + response_completed body_cid.
  // Direct DB queries keep this synchronous up front; the async work below
  // is just hashing and link-walking.
  const reqRow = deps.db.prepare(
    'SELECT payload FROM events WHERE event_id = ? AND topic = \'proxy.request_received\'',
  ).get(args.parentRevisionId) as { payload: string } | undefined
  if (!reqRow) return null

  const respRow = deps.db.prepare(`
    SELECT payload FROM events
     WHERE topic = 'proxy.response_completed'
           AND json_extract(payload, '$.request_event_id') = ?
  `).get(args.parentRevisionId) as { payload: string } | undefined
  if (!respRow) return null

  let reqBodyCid: string
  let respBodyCid: string
  try {
    reqBodyCid = (JSON.parse(reqRow.payload) as { body_cid?: string }).body_cid ?? ''
    respBodyCid = (JSON.parse(respRow.payload) as { body_cid?: string }).body_cid ?? ''
  }
  catch {
    return null
  }
  if (!reqBodyCid || !respBodyCid) return null

  // Hydrate R1's request body to extract its messages array.
  const hydrated = await loadHydratedMessagesBody(deps.storageProvider, reqBodyCid as AssetId)
  if (!hydrated || !Array.isArray(hydrated.messages)) return null
  const historyMessages = hydrated.messages

  // Load R1's response body and pull its assistant content[].
  let respContent: unknown[] | null = null
  try {
    const respBytes = await deps.storageProvider.fetchBuffer(respBodyCid as AssetId)
    const parsed = JSON.parse(Buffer.from(respBytes).toString('utf8')) as {
      content?: unknown[]
    }
    if (Array.isArray(parsed.content)) respContent = parsed.content
  }
  catch {
    return null
  }
  if (!respContent) return null

  // Compose the synthetic messages array. The shape is critical — Anthropic's
  // /v1/messages requires every tool_use to be paired with a tool_result; the
  // R2' message provides that pairing using R1's tool_use_id.
  const syntheticMessages: unknown[] = [
    ...historyMessages,
    { role: 'assistant', content: respContent },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: args.toolUseId,
          content: [{ type: 'text', text: args.syntheticToolResultText }],
        },
      ],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: args.syntheticAssistantText }],
    },
  ]

  // Wrap as a /v1/messages-shaped body so blobRefFromMessagesBody splits
  // each message into its own dedup-friendly blob.
  const bodyBytes = Buffer.from(
    JSON.stringify({ messages: syntheticMessages }),
    'utf8',
  )
  const split = await blobRefFromMessagesBody(bodyBytes)
  return { topCid: split.topCid, refs: split.refs }
}

/**
 * Map fork.forked.kind → revisions.stop_reason. The custom values let recall's
 * list mode discriminate SR rows from real closed_forkable Revisions cheaply
 * via WHERE clause, without joining the events table.
 */
function stopReasonFor(kind: 'rewind' | 'submit'): string {
  return kind === 'rewind' ? 'rewind_synthetic' : 'submit_synthetic'
}

export class RewindMarkerV1Projector implements Projection {
  readonly id = 'rewind_marker_v1'
  readonly subscribedTopics: ReadonlyArray<string> = ['fork.forked']

  apply(event: Event, tx: DB): void {
    if (event.topic !== 'fork.forked') return
    const p = event.payload as ForkForkedPayload

    // Look up parent (R1) to inherit task_id. Without R1, the SR has no home;
    // skip insertion. The matching audit event was already emitted by
    // proxy-handler (fork.forked itself), so the gap is observable.
    const parent = tx.prepare(
      'SELECT task_id FROM revisions WHERE id = ?',
    ).get(p.parent_revision_id) as { task_id: string } | undefined
    if (!parent) return

    tx.prepare(`
      INSERT OR IGNORE INTO revisions
        (id, task_id, asset_cid, parent_revision_id, classification, stop_reason, sealed_at, created_at)
      VALUES (?, ?, ?, ?, 'closed_forkable', ?, ?, ?)
    `).run(
      p.synthetic_revision_id,
      parent.task_id,
      p.synthetic_asset_cid,
      p.parent_revision_id,
      stopReasonFor(p.kind),
      p.sealed_at,
      event.createdAt,
    )
  }
}
