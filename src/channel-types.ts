// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// In-tree facade types for the v0.3 `@playtiss/core/channel` extraction.
// These types live in retcon for Step 1 (validation step). Step 2 moves them
// under `@playtiss/core/channel`; consumers re-import from the published
// package without behavior change.
//
// Protocol mapping (collaboration-protocol L2 + L3):
//   - L3.5 Task: `apply(Action, Input)` produces a content-hashed reference.
//                Same (action, input) → same TaskId, deterministically.
//   - L3.6 Revision: Tasks own their Revision streams. retcon's projector
//                output (rows in sessions/revisions/branch_views) is the
//                Task's Revision stream content. Channel doesn't model the
//                stream shape — Tasks own their projection tables.
//   - L2.4 Resolution: trivial auto-accept for v0.3. Tasks decide internally
//                whether to apply or skip an event; Channel does no resolver
//                mediation.
//
// Kafka analogy: Channel is the broker (writes the log + storage primitives);
// Tasks are consumers (own their offset, run their own apply()). retcon's
// `ProjectorRunner` (separate file) is the in-process synchronous-dispatch
// pattern that hooks emit() to call each Task's apply() inside the same
// transaction. arianna or other consumers would write their own runner.

import { computeHash } from '@playtiss/core'
import type { AssetId } from '@playtiss/core'

import type { DB } from './db.js'
import type { BlobRef, Event } from './events.js'

/**
 * Opaque action identifier for v0.3. Full L3.4 form (Action-as-Task) deferred.
 * Convention: namespace.dotted.name, e.g. `"playtiss.proxy.project-revisions"`.
 */
export type ActionId = string

/**
 * Content-hashed Task identity. Computed via {@link applyTask} as
 * `computeHash({ action, input })`. Same logical inputs produce the same
 * TaskId across processes / machines (L2.1 referential transparency).
 *
 * Reused as `AssetId` since it's the same shape — a CIDv1 string. Future v1.0
 * may brand it separately if Task identities need a distinct namespace.
 */
export type TaskId = AssetId

/**
 * Runtime-discriminated reference to another Task in this channel. Embed
 * inside a {@link TaskInput} dict to declare a topological dependency:
 *
 * ```ts
 * const input: TaskInput = {
 *   topics: ['proxy.request_received'],
 *   session_index: { kind: 'task_ref', id: sessionsTaskId },
 * }
 * ```
 *
 * The runner walks Input recursively and harvests every `kind === 'task_ref'`
 * value. Order of registration becomes irrelevant; dispatch follows
 * dependency order.
 *
 * The shape `{ kind, id }` (vs. a compile-time-only branded TaskId) is
 * deliberately runtime-visible so it survives JSON serialization / hashing —
 * the L2.1 Naming Grammar's compositional structure stays explicit in data.
 */
export interface TaskRef {
  readonly kind: 'task_ref'
  readonly id: TaskId
}

/** Type guard for {@link TaskRef} discrimination at runtime. */
export function isTaskRef(value: unknown): value is TaskRef {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'task_ref'
    && typeof (value as { id?: unknown }).id === 'string'
  )
}

/** Construct a {@link TaskRef} for embedding in a Task's Input dict. */
export function taskRef(id: TaskId): TaskRef {
  return { kind: 'task_ref', id }
}

/**
 * The `input` half of L3.5's `apply(Action, Input)`. Free-form dict keyed
 * by semantic field name (e.g. `topics`, `session_index`, `upstream`). Any
 * value of shape {@link TaskRef} declares a topological dependency.
 *
 * `topics` is a special-cased convention for retcon's projection-style
 * Tasks: the runner uses it as the topic-filter for dispatch. Other Tasks
 * (e.g. arianna's eventual sync archive) may omit `topics` entirely.
 */
export interface TaskInput {
  readonly topics?: ReadonlyArray<string>
  readonly [key: string]: unknown
}

/**
 * A registered Task. Carries its content-hashed identity, its (action, input)
 * pair (the protocol identity primitive), and its `apply()` function — the
 * resolver that processes events. Channel does not call `apply()`; the
 * runner does (in retcon's case, synchronously inside emit's transaction).
 */
export interface Task {
  readonly id: TaskId
  readonly action: ActionId
  readonly input: TaskInput
  apply(event: Event, tx: DB): void
}

/**
 * Per-Task key/value metadata. Backed by retcon's existing `projection_offsets`
 * table in Step 1 (key='events_offset' maps to last_processed_event_id). Step
 * 2 introduces a dedicated `task_metadata` table.
 *
 * Operations are synchronous; callers running inside a {@link DB.transaction}
 * see the writes atomically with their other tx work.
 */
export interface KV<K extends string = string, V = string> {
  get(key: K): V | null
  set(key: K, value: V): void
  delete(key: K): void
}

/**
 * The protocol L2.4 Resolution outcome produced by a Task's apply() when the
 * Channel dispatches an event. v0.3 ships two baseline sub-states (Q4 per
 * Cosimo); future channels extend `Outcome` additively with `reject`,
 * `partial`, `merge`, `defer`, `custom`, etc. — existing consumers ignore
 * unknown `kind` values.
 *
 * `accept` is the trivial-resolution case: apply() ran to completion. Accept
 * outcomes are also implicit in {@link KV} offset advancement, so v0.3 does
 * NOT emit a separate substrate event for them (Q1=c per Cosimo). v0.4 can
 * add `topic: 'projection.accept'` events additively when subscribe()-side
 * consumers need cursor-based read of all outcomes.
 *
 * `exception` is the protocol's "exception sub-state of a Revision" (L3.6.3)
 * — apply() threw before completing. The throw is data, not an error: the
 * Channel catches it, rolls back the projector's SAVEPOINT (its partial
 * writes are discarded), records the exception as a substrate event
 * (`topic: 'projection.exception'`, payload includes the source event id,
 * the task id, and the error message), AND continues dispatching downstream
 * Tasks. Downstream Tasks see whatever state upstream left and decide their
 * own outcome — possibly also exception, recorded the same way (L1.10
 * Explicit Discarding).
 */
export type Outcome =
  | { kind: 'accept', taskId: TaskId }
  | { kind: 'exception', taskId: TaskId, error: string }

/**
 * Returned from {@link Channel.submit}. Carries the recorded event row and
 * the per-Task Resolution outcomes from the dispatch round.
 *
 * The event ALWAYS lands as long as the Channel itself didn't fail
 * (DB I/O / constraint violation surfaces as Promise rejection). Projector
 * exceptions in `outcomes` do NOT void `event` — they're recorded data per
 * L1.2 (No Errors, only Exceptions).
 *
 * `outcomes` lists ONE entry per Task whose `input.topics` included this
 * event's topic, in dependency-derived dispatch order. Tasks not subscribed
 * to this topic do not appear here.
 */
export interface SubmitResult<P> {
  event: Event<P>
  outcomes: ReadonlyArray<Outcome>
}

/**
 * Compute the content-hashed {@link TaskId} for an (action, input) pair via
 * `@playtiss/core`'s `computeHash`. Same inputs → same TaskId across
 * processes / machines.
 *
 * Async because `computeHash` is async (Web Crypto / multiformats). Tasks
 * register at startup, so this is paid once at boot — never on the per-emit
 * hot path.
 *
 * Note: input ordering doesn't matter — `computeHash` uses dag-json
 * canonicalization which sorts object keys by UTF-8 byte order.
 */
export async function applyTask(
  action: ActionId,
  input: TaskInput,
): Promise<TaskId> {
  return computeHash({ action, input: input as Record<string, unknown> })
}

// Re-export Event/BlobRef so consumers can import everything channel-shaped
// from one place. Step 2 moves these definitions into `@playtiss/core/channel`
// and retcon's events.ts imports them back.
export type { BlobRef, Event } from './events.js'
