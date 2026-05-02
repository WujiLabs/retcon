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

import { blobRefFromMessagesBody } from './body-blob.js'
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
  /** target_view_id from fork.back_requested correlation. */
  target_view_id: string
  /** SR.sealed_at — captured at MCP-call time. */
  sealed_at: number
  /** Top CID of the synthetic messages body (precomputed by proxy-handler). */
  synthetic_asset_cid: string
}

/** Payload of fork.synthesis_failed. Audit-only; projector ignores. */
export interface ForkSynthesisFailedPayload {
  parent_revision_id?: string
  target_revision_id: string
  error_message: string
  /** When the failure is "R1 had parallel tool_uses" we name the siblings. */
  parallel_tool_names?: string[]
}

/**
 * Build the synthetic SR body: history-through-R1 + R2' (synthetic
 * tool_result paired with R1's tool_use_id) + R3' (synthetic assistant text).
 *
 * Reads R1's parsed content from `originalBody` — the pre-splice JSON body
 * claude actually sent for R2 (= the next /v1/messages after the
 * rewind_to/submit_file MCP call). Claude packs R1's assistant turn back
 * into that body's messages array as the next-to-last entry; the last
 * entry is the user turn with tool_results that we're discarding via
 * splice. So R1's content lives in `messages[messages.length - 2]`
 * provided the tail is the expected user/assistant alternation.
 *
 * This avoids parsing R1's actual response body, which is gzip-encoded
 * SSE and would need a stream reconstructor. Same pattern
 * `reconstructForkMessages` uses to read parsed assistant turns.
 *
 * Returns null on any structural failure (no last assistant, no operation
 * tool_use in last assistant). Caller emits `fork.synthesis_failed` on null.
 */
export async function buildSyntheticAsset(
  args: {
    /** claude's pre-splice JSON body. Must contain { messages: [...] }. */
    originalBody: Uint8Array
    /** Discriminates which operation tool's tool_use_id we extract. */
    kind: 'rewind' | 'submit'
    /** R2' display content. */
    syntheticToolResultText: string
    /** R3' display content. */
    syntheticAssistantText: string
  },
): Promise<{ topCid: string, refs: BlobRef[], toolUseId: string } | null> {
  let parsed: { messages?: unknown[] }
  try {
    parsed = JSON.parse(Buffer.from(args.originalBody).toString('utf8'))
  }
  catch {
    return null
  }
  if (!parsed || !Array.isArray(parsed.messages)) return null
  const messages = parsed.messages as Array<{ role?: string, content?: unknown }>

  // Walk backwards to find the last assistant message — that's R1's parsed
  // content. content[] inside it has the tool_use blocks (including the
  // operation we care about) plus any sibling text/thinking blocks.
  let r1Idx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') {
      r1Idx = i
      break
    }
  }
  if (r1Idx === -1) return null
  const r1 = messages[r1Idx]
  if (!Array.isArray(r1.content)) return null

  // Find the operation tool's tool_use block — R2's synthetic tool_result
  // pairs to its id so Anthropic's tool_use/tool_result invariant holds.
  const operationToolName = args.kind === 'rewind' ? 'rewind_to' : 'submit_file'
  let toolUseId: string | null = null
  for (const block of r1.content as Array<{ type?: string, name?: string, id?: string }>) {
    if (block.type === 'tool_use' && block.name === operationToolName && typeof block.id === 'string') {
      toolUseId = block.id
      break
    }
  }
  if (!toolUseId) return null

  // historyThroughR1 = everything up to and including R1. We drop the
  // trailing user turn (which carries the discarded tool_results).
  const historyThroughR1 = messages.slice(0, r1Idx + 1)

  // Compose the synthetic messages array. R2' provides the tool_result
  // pairing for R1's operation tool_use; R3' is the assistant wrap-up.
  const syntheticMessages: unknown[] = [
    ...historyThroughR1,
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
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
  return { topCid: split.topCid, refs: split.refs, toolUseId }
}

/**
 * Detect parallel tool_uses on R1 from claude's pre-splice body. Returns
 * the names of any tool_use blocks in R1's content beyond the operation
 * tool itself. Empty array means clean.
 *
 * Used by proxy-handler to abort the splice when the rewound history
 * would discard sibling tool results. Fail-loud: emit fork.synthesis_failed
 * with the names so the operator/AI can see what was rejected.
 */
export function detectParallelTools(
  originalBody: Uint8Array,
  kind: 'rewind' | 'submit',
): { ok: true, parallel: string[] } | { ok: false } {
  let parsed: { messages?: unknown[] }
  try {
    parsed = JSON.parse(Buffer.from(originalBody).toString('utf8'))
  }
  catch {
    return { ok: false }
  }
  if (!parsed || !Array.isArray(parsed.messages)) return { ok: false }
  const messages = parsed.messages as Array<{ role?: string, content?: unknown }>
  let r1: { content?: unknown } | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') {
      r1 = messages[i]
      break
    }
  }
  if (!r1 || !Array.isArray(r1.content)) return { ok: false }

  const operationToolName = kind === 'rewind' ? 'rewind_to' : 'submit_file'
  const parallel: string[] = []
  for (const block of r1.content as Array<{ type?: string, name?: string }>) {
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name !== operationToolName) {
      parallel.push(block.name)
    }
  }
  return { ok: true, parallel }
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
