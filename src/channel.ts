// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// In-tree Channel facade — Step 1 of the @playtiss/core/channel extraction.
//
// Wraps retcon's existing event log with the Task-shaped API the channel
// package will expose in Step 2. Tasks register with declarative TaskRef
// dependencies; the runner topo-sorts and dispatches synchronously inside
// emit's BEGIN IMMEDIATE.
//
// Channel API surface (final v0.3 shape):
//   - emit(topic, payload, sessionId, blobs?)        — atomic write
//   - storage: StorageProvider                        — re-exposed
//   - registerTask(task)                              — record + topo-sort
//   - taskMetadata(taskId): KV<string, string>        — per-Task K/V
//   - db: DB                                          — direct SQL for Tasks
//
// What Channel does NOT have (deferred to v0.4 when arianna lands):
//   - subscribe(target, opts): AsyncIterable          — pull-based reads
//   - propose / resolve / setResolver                 — non-trivial Resolution
//   - ref(name): Reference                            — L2.3 binding history
//
// Why Step 1 keeps the EventProducer shape internally: existing retcon code
// (proxy-handler, mcp-tools, etc.) imports `producer.emit(...)`. The Channel
// produces the same EventProducer surface so callers don't need rewrites.
// Step 3 will swap them to import from `@playtiss/core/channel` directly.

import type { StorageProvider } from '@playtiss/core'

import {
  type KV,
  type Task,
  type TaskId,
} from './channel-types.js'
import type { DB } from './db.js'
import {
  type BlobRef,
  createEventProducer,
  type Event,
  type EventProducer,
  type Projection,
} from './events.js'
import { topoSort } from './projector-runner.js'
import { SqliteStorageProvider } from './storage.js'

/**
 * Adapt a {@link Task} as a legacy {@link Projection}. The producer's
 * array-order dispatch becomes our dep-order dispatch when the array is
 * topo-sorted. `subscribedTopics` mirrors `input.topics`; projection `id`
 * mirrors `task.id` (so `projection_offsets` indexes by TaskId — what
 * `taskMetadata.get('events_offset')` reads).
 */
function taskToProjection(task: Task): Projection {
  const topics = (task.input.topics ?? []) as string[]
  return {
    id: task.id,
    subscribedTopics: topics,
    apply: (event, tx) => task.apply(event, tx),
  }
}

export interface Channel {
  /**
   * Append an event to the log (atomic + monotonic). Synchronously dispatches
   * to every registered Task whose `input.topics` includes this topic, in
   * dependency order, inside the same BEGIN IMMEDIATE transaction.
   *
   * Same shape as {@link EventProducer.emit} — preserved for back-compat.
   */
  emit<P>(
    topic: string,
    payload: P,
    sessionId: string | null,
    referencedBlobs?: ReadonlyArray<BlobRef>,
  ): Event<P>

  /** Content-addressed blob storage. Re-exposed from the underlying DB. */
  readonly storage: StorageProvider

  /**
   * Register a Task. Idempotent (same TaskId → no-op). Throws on cycles or
   * unregistered TaskRef dependencies (see {@link topoSort}).
   *
   * Re-runs topo-sort on every registration. For v0.3 Tasks register at boot,
   * so the cost is paid once. If future code adds per-request Task
   * registration, batch registration via a separate API.
   */
  registerTask(task: Task): void

  /**
   * Per-Task key/value metadata. Backed by retcon's `projection_offsets`
   * table in Step 1: `taskMetadata(id).get('events_offset')` reads
   * `projection_offsets.last_processed_event_id WHERE projection_id = id`.
   * Step 2 introduces a dedicated `task_metadata` table.
   *
   * Operations are synchronous and respect the DB's transactional context
   * — calls inside an emit's transaction see uncommitted writes from
   * earlier dispatches.
   */
  taskMetadata(taskId: TaskId): KV<string, string>

  /**
   * Direct DB handle — Tasks query the events table via SQL for catch-up,
   * filtered reads, etc. v0.4 may hide this when `subscribe()` ships with
   * AsyncIterable cursor semantics.
   */
  readonly db: DB

  /**
   * Underlying EventProducer interface. Code that already imports
   * `producer.emit(...)` continues to work without rewrites.
   */
  readonly producer: EventProducer
}

export interface ChannelOptions {
  /** SQLite handle. Channel does not open or migrate; caller manages lifecycle. */
  db: DB
  /**
   * Initial Tasks to register at construction. Equivalent to calling
   * {@link Channel.registerTask} once per Task after construction; provided
   * here for ergonomic single-call wiring.
   */
  tasks?: ReadonlyArray<Task>
}

/**
 * Build a Channel. Tasks dispatched synchronously on emit, in dep order,
 * inside the producer's BEGIN IMMEDIATE — preserving event/projection
 * atomicity from the legacy code path.
 *
 * Internally adapts each Task to the existing {@link Projection} interface:
 * the producer's array-order dispatch, when fed topo-sorted Tasks, IS the
 * dep-order dispatch we want. The producer's projection_offsets bookkeeping
 * matches exactly what we want for taskMetadata's `events_offset` key. Zero
 * new transactional code; zero atomicity gap.
 *
 * Step 2 will move this into `@playtiss/core/channel` and the EventProducer
 * abstraction goes away.
 */
export function createChannel(opts: ChannelOptions): Channel {
  const { db } = opts

  // Mutable Task registry. Topo-sort is LAZY — deferred until first emit so
  // out-of-order registerTask() calls work (e.g. register B then A where B
  // has TaskRef(A.id), TaskRef resolution happens at emit time once both
  // are registered).
  const registered: Task[] = []
  let producer: EventProducer | null = null

  function rebuildDispatch(): void {
    // Topo-sort registered Tasks; adapt each as a Projection so the
    // producer's array-order dispatch becomes our dep-order dispatch.
    // projection_offsets row keyed by Task id == projection id; the
    // producer's existing offset-bump is exactly what taskMetadata's
    // 'events_offset' get/set semantics expect.
    const sortedTasks = topoSort(registered)
    const adaptedProjections: Projection[] = sortedTasks.map(taskToProjection)
    producer = createEventProducer(db, adaptedProjections)
  }

  function ensureProducer(): EventProducer {
    if (!producer) rebuildDispatch()
    return producer!
  }

  if (opts.tasks) {
    for (const t of opts.tasks) {
      if (!registered.find(r => r.id === t.id)) registered.push(t)
    }
    rebuildDispatch()
  }

  function registerTask(task: Task): void {
    if (registered.find(r => r.id === task.id)) return
    registered.push(task)
    // Invalidate cached producer; rebuild lazily on next emit.
    producer = null
  }

  function emit<P>(
    topic: string,
    payload: P,
    sessionId: string | null,
    referencedBlobs?: ReadonlyArray<BlobRef>,
  ): Event<P> {
    // Producer dispatch is atomic with event write — same BEGIN IMMEDIATE
    // wraps blobs + event row + each adapted Projection's apply() + each
    // projection_offsets bump. Tasks see uncommitted projection writes
    // from upstream Tasks in the same emit (e.g. branch_views_v1 reads
    // revisions_v1's parent_revision_id write), as today.
    return ensureProducer().emit(topic, payload, sessionId, referencedBlobs)
  }

  function taskMetadata(taskId: TaskId): KV<string, string> {
    // Step 1: back the K/V with retcon's existing projection_offsets table.
    // Convention: only the 'events_offset' key is used today; other keys are
    // valid but currently unused. Step 2 introduces a generic task_metadata
    // table with composite (task_id, key) PK so multiple keys per Task work
    // without stretching projection_offsets' single-column schema.
    return {
      get(key) {
        if (key !== 'events_offset') {
          // Other keys aren't representable in projection_offsets's single-
          // column schema. Treat as absent for v0.3 — Step 2 fixes when
          // task_metadata lands.
          return null
        }
        const row = db
          .prepare('SELECT last_processed_event_id FROM projection_offsets WHERE projection_id = ?')
          .get(taskId) as { last_processed_event_id: string } | undefined
        return row?.last_processed_event_id ?? null
      },
      set(key, value) {
        if (key !== 'events_offset') return
        db.prepare(
          'INSERT INTO projection_offsets (projection_id, last_processed_event_id) VALUES (?, ?)'
          + ' ON CONFLICT(projection_id) DO UPDATE SET last_processed_event_id = excluded.last_processed_event_id',
        ).run(taskId, value)
      },
      delete(key) {
        if (key !== 'events_offset') return
        db.prepare('DELETE FROM projection_offsets WHERE projection_id = ?').run(taskId)
      },
    }
  }

  return {
    emit,
    get storage(): StorageProvider {
      // Construct on access; cheap (just wraps the DB handle).
      return new SqliteStorageProvider(db)
    },
    registerTask,
    taskMetadata,
    db,
    get producer(): EventProducer {
      // Expose so existing code that imports `producer` keeps working.
      // Routes through Channel's emit (which lazy-builds the topo-sorted
      // dispatching producer on first call).
      return { emit }
    },
  }
}
