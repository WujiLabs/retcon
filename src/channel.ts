// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// In-tree Channel facade — Step 1 v3 of the @playtiss/core/channel extraction.
//
// PROTOCOL ALIGNMENT (the v2 → v3 fix):
//
// v2's `channel.emit()` delegated to createEventProducer, which ran event row
// insertion + projector apply() in one outer BEGIN IMMEDIATE. If a projector
// threw, the whole tx rolled back — including the event row. That violated
// L1.2 (No Errors), L1.8 (Sovereign Ownership of Outcomes), L1.10 (Explicit
// Discarding), and L2.4 (Resolution mediation): the event commit became
// contingent on every downstream projector's resolver accepting, which is
// backwards. The event append IS a Resolution outcome (the channel's
// event-log Reference, trivially auto-accepted); each projector's apply()
// is a SEPARATE Resolution outcome on a different Reference
// (`revisions_of(projector_task)`).
//
// v3 corrects this:
//
//   1. submit() is async (returns Promise<SubmitResult>) — the L4 verb
//      shape. Local sqlite resolves on the same microtask (effectively
//      sync) but the SHAPE is async so future cross-process channels swap
//      in without breaking callers.
//
//   2. Per-projector SAVEPOINTs. The outer BEGIN IMMEDIATE stays as a
//      retcon-local optimization (one fsync per submit), but each projector
//      gets its own savepoint. Exceptions roll back the projector's partial
//      writes without voiding the event row or earlier accepted projectors.
//
//   3. Outcomes are recorded. Each projector's accept/exception goes into
//      SubmitResult.outcomes for callers that care. Exception outcomes are
//      additionally recorded as substrate events (topic:
//      'projection.exception') per L1.10 Explicit Discarding. Accept
//      outcomes stay implicit in projection_offsets for v0.3 (Q1=c);
//      v0.4 can add 'projection.accept' events additively.
//
//   4. submit() naming follows L4 verb vocabulary. Reference implementation
//      naming matters; consumers reading retcon's source learn protocol
//      verbs by exposure.
//
// What this file does NOT do (the substrate package owns these):
//   - subscribe() AsyncIterable (deferred to v0.4 when arianna lands)
//   - propose / resolve / setResolver beyond trivial auto-accept (v0.4)
//   - ref(name) Reference primitive (v0.4)
//   - save() as separate verb from submit() (v0.4 if needed)
//
// What retcon's caller code does NOT need to know:
//   - The SAVEPOINT machinery — that's an impl detail of the local channel.
//   - The 'projection.exception' topic — readers query the outcomes array
//     via SubmitResult, not via substrate events directly.

import {
  generateOperationId,
  type StorageProvider,
  type TraceId,
  TraceIdGenerator,
} from '@playtiss/core'

import {
  type KV,
  type Outcome,
  type SubmitResult,
  type Task,
  type TaskId,
} from './channel-types.js'
import type { DB } from './db.js'
import {
  type BlobRef,
  type Event,
} from './events.js'
import { buildTopicIndex, dispatchOrderForTopic, topoSort } from './projector-runner.js'
import { SqliteStorageProvider } from './storage.js'

/**
 * The Channel interface — substrate primitives (L2) shaped as L4 verbs.
 *
 * v0.3 ships ONLY submit() (and the Task-registration / metadata helpers).
 * Other L4 verbs (save / resolve / subscribe / mount / exit) deferred until
 * a consumer needs them. Adding them later is purely additive.
 */
export interface Channel {
  /**
   * L4 Submit — record an event in the substrate, dispatch to subscribed
   * Tasks, return the per-Task outcomes.
   *
   * Async by shape — local sqlite resolves on the same microtask. The
   * caller doesn't get a usable affordance for parallelism inside the
   * submit (it's atomic per the outer BEGIN IMMEDIATE), but the SHAPE
   * is async so future cross-process channels swap in without breaking
   * callers.
   *
   * The event row lands UNCONDITIONALLY. Projector exceptions do not
   * void the event. They're captured as Outcome.exception entries in
   * SubmitResult.outcomes AND recorded as substrate events with
   * topic 'projection.exception' (L1.10 Explicit Discarding).
   *
   * Channel-level failures (DB I/O, constraint violations on the event
   * itself) propagate as Promise rejection — distinct from projector
   * exceptions, which are part of the resolved outcome.
   */
  submit<P>(
    topic: string,
    payload: P,
    sessionId: string | null,
    referencedBlobs?: ReadonlyArray<BlobRef>,
  ): Promise<SubmitResult<P>>

  /** Content-addressed blob storage. Re-exposed from the underlying DB. */
  readonly storage: StorageProvider

  /**
   * Register a Task. Idempotent (same TaskId → no-op). Topo-sort is lazy
   * — deferred until first submit() so out-of-order registration works
   * (e.g. register B then A where B has TaskRef(A.id); both must be
   * registered before submit() resolves them).
   */
  registerTask(task: Task): void

  /**
   * Per-Task K/V metadata. Backed by retcon's `projection_offsets` table
   * in v0.3: `taskMetadata(id).get('events_offset')` reads
   * `projection_offsets.last_processed_event_id WHERE projection_id = id`.
   * Step 2 introduces a dedicated `task_metadata` table for multi-key
   * support.
   */
  taskMetadata(taskId: TaskId): KV<string, string>

  /**
   * Direct DB handle — Tasks query the events table via SQL for catch-up,
   * filtered reads, etc. v0.4 may hide this when subscribe() ships with
   * AsyncIterable cursor semantics.
   */
  readonly db: DB
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
 * Build a Channel. Tasks dispatched on submit, in dep order, inside an
 * outer BEGIN IMMEDIATE (retcon-local optimization). Per-projector
 * SAVEPOINTs isolate exceptions.
 */
export function createChannel(opts: ChannelOptions): Channel {
  const { db } = opts

  // One TraceIdGenerator per channel ensures monotonic event_id within
  // this process (matches the prior createEventProducer's contract).
  const idGen = new TraceIdGenerator(generateOperationId())

  // Mutable Task registry. Topo-sort is LAZY — deferred until first
  // submit() so registerTask() can be called in any order.
  const registered: Task[] = []
  let dispatchByTopic: ReadonlyMap<string, Task[]> | null = null

  function rebuildDispatch(): void {
    const sorted = topoSort(registered)
    dispatchByTopic = buildTopicIndex(sorted)
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
    // Invalidate cached dispatch; rebuild lazily on next submit.
    dispatchByTopic = null
  }

  function ensureDispatch(): ReadonlyMap<string, Task[]> {
    if (!dispatchByTopic) rebuildDispatch()
    return dispatchByTopic!
  }

  // Prepared statements — eager at channel construction. Matches the
  // pattern in events.ts; lets TS infer Statement.run's variadic signature.
  const insertBlob = db.prepare(
    'INSERT OR IGNORE INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)',
  )
  const insertEvent = db.prepare(
    'INSERT INTO events (event_id, topic, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  const upsertOffset = db.prepare(
    'INSERT INTO projection_offsets (projection_id, last_processed_event_id) VALUES (?, ?)'
    + ' ON CONFLICT(projection_id) DO UPDATE SET last_processed_event_id = excluded.last_processed_event_id',
  )

  function submit<P>(
    topic: string,
    payload: P,
    sessionId: string | null,
    referencedBlobs?: ReadonlyArray<BlobRef>,
  ): Promise<SubmitResult<P>> {
    const topicIndex = ensureDispatch()

    const now = Date.now()
    const event: Event<P> = {
      id: idGen.generate(),
      topic,
      payload,
      sessionId,
      createdAt: now,
    }
    const payloadStr = JSON.stringify(payload)
    const subscribers = dispatchOrderForTopic(topic, topicIndex)
    const outcomes: Outcome[] = []
    // Exception outcomes need to be inserted as substrate events. We collect
    // their (event id, payload) tuples during dispatch and insert AFTER the
    // for-loop completes — but still inside the outer BEGIN IMMEDIATE so
    // they land atomically with the source event. Each exception event gets
    // a fresh TraceId from the same generator.
    const exceptionEvents: Array<{ id: TraceId, payload: string }> = []

    const tx = db.transaction(() => {
      // 1. Blobs first — they're referenced by the event payload's body_cid.
      if (referencedBlobs) {
        for (const blob of referencedBlobs) {
          insertBlob.run(blob.cid, blob.bytes, blob.bytes.byteLength, now)
        }
      }

      // 2. Event row — lands FIRST and UNCONDITIONALLY. Projector exceptions
      // below do NOT void this. (L1.2 / L1.8 / L1.10 / L2.4.)
      insertEvent.run(event.id, event.topic, payloadStr, event.sessionId, event.createdAt)

      // 3. Dispatch to subscribed Tasks in dep order, each in its own
      // SAVEPOINT. Exceptions roll back the projector's partial writes
      // but leave the event row + earlier accepted projectors intact.
      // Outcomes recorded into the SubmitResult AND (for exceptions) as
      // substrate events.
      for (let i = 0; i < subscribers.length; i++) {
        const task = subscribers[i]!
        // SAVEPOINT name must be a valid SQL identifier. Use a sequence-tagged
        // prefix + a short slice of the TaskId hash to keep names unique-
        // per-dispatch + readable in logs.
        const spName = `sp_${i}_${task.id.slice(-8).replace(/[^a-zA-Z0-9]/g, '_')}`
        db.exec(`SAVEPOINT ${spName}`)
        try {
          task.apply(event, db)
          db.exec(`RELEASE ${spName}`)
          outcomes.push({ kind: 'accept', taskId: task.id })
          // Bump the projection_offsets row for this Task — the accept
          // outcome is implicit in this offset advancement (Q1=c).
          upsertOffset.run(task.id, event.id)
        }
        catch (err) {
          // Roll back this projector's partial writes to the savepoint.
          // The event row + previously accepted projectors stay.
          db.exec(`ROLLBACK TO ${spName}`)
          // RELEASE after ROLLBACK TO is required to consume the savepoint
          // (otherwise the savepoint stays open and subsequent SAVEPOINTs
          // accumulate). Per SQLite docs.
          db.exec(`RELEASE ${spName}`)
          const errStr = err instanceof Error ? err.message : String(err)
          outcomes.push({ kind: 'exception', taskId: task.id, error: errStr })
          // Defer the substrate-event INSERT until after the dispatch loop
          // completes. Doing it inline here would interleave projection.exception
          // event_ids with the dispatched Tasks' offset bumps, which is fine
          // but harder to reason about for monotonicity. We collect now,
          // insert after — still inside the outer tx so atomicity holds.
          exceptionEvents.push({
            id: idGen.generate(),
            payload: JSON.stringify({
              source_event_id: event.id,
              task_id: task.id,
              error: errStr,
            }),
          })
        }
      }

      // 4. Insert the projection.exception events recorded above. Still
      // inside the outer tx — they land atomically with the source event
      // and the accepted projectors' writes.
      for (const ee of exceptionEvents) {
        insertEvent.run(ee.id, 'projection.exception', ee.payload, event.sessionId, now)
      }
    })

    try {
      tx.immediate()
    }
    catch (err) {
      // Channel-level failure (DB I/O, primary-key violation on event row,
      // etc.). Distinct from projector exceptions — these surface as
      // Promise rejection because there's no Outcome shape for "the
      // channel itself failed."
      return Promise.reject(err)
    }

    return Promise.resolve({ event, outcomes })
  }

  function taskMetadata(taskId: TaskId): KV<string, string> {
    // v0.3: back the K/V with retcon's existing projection_offsets table.
    // Convention: only the 'events_offset' key is used today (the per-Task
    // event-log cursor that bumps on each accept outcome). Other keys are
    // valid but currently unused. Step 2 introduces a generic task_metadata
    // table with composite (task_id, key) PK so multiple keys per Task work
    // without stretching projection_offsets' single-column schema.
    return {
      get(key) {
        if (key !== 'events_offset') return null
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
    submit,
    get storage(): StorageProvider {
      return new SqliteStorageProvider(db)
    },
    registerTask,
    taskMetadata,
    db,
  }
}
