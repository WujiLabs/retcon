// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Append-only event log for the proxy.
//
// Producer emits events in one transaction alongside referenced blobs and
// subscribed-projector view updates (the "event-emit invariant"). Consumer
// polls by (projection_id, topics) with offset-based resume. Projections
// are pure state machines keyed on topics; dispatch order is declared.
//
// This is a clean-room implementation; pattern inspiration from the
// Kafka-style EventLog/ProjectionOffsets design, but no source is imported
// from the unsanitized playtiss graphql-server.

import { generateOperationId, type TraceId, TraceIdGenerator } from '@playtiss/core'

import type { DB } from './db.js'

export interface Event<Payload = unknown> {
  id: TraceId
  topic: string
  payload: Payload
  sessionId: string | null
  createdAt: number
}

export interface BlobRef {
  cid: string
  bytes: Uint8Array
}

export interface Projection {
  readonly id: string
  readonly subscribedTopics: ReadonlyArray<string>
  apply(event: Event, tx: DB): void
}

export interface EventProducer {
  emit<P>(
    topic: string,
    payload: P,
    sessionId: string | null,
    referencedBlobs?: ReadonlyArray<BlobRef>,
  ): Event<P>
}

export interface EventConsumer {
  poll(projectionId: string, topics: ReadonlyArray<string>, batchSize: number): Event[]
  commit(projectionId: string, eventId: TraceId): void
  currentOffset(projectionId: string): TraceId | ''
}

// --- SQLite implementations ------------------------------------------------

/**
 * Creates an EventProducer bound to the DB and a set of Projections.
 *
 * Every emit wraps the following in a BEGIN IMMEDIATE transaction:
 *   1. Save referenced blobs (INSERT OR IGNORE)
 *   2. INSERT the event row
 *   3. Dispatch to subscribed projectors, in declared order, passing the DB
 *      as the transaction handle. Projectors do their own upserts.
 *   4. UPDATE projection_offsets for each dispatched projector.
 *
 * On any exception, the whole transaction rolls back.
 *
 * `projections` is declared dispatch order; projectors are invoked in array
 * order for each event.
 */
export function createEventProducer(
  db: DB,
  projections: ReadonlyArray<Projection>,
): EventProducer {
  // A single TraceIdGenerator per producer ensures event_id is strictly
  // monotonic within this process. The generator's internal timestamp is
  // frozen at construction; use the explicit `created_at` column for any
  // wallclock-time queries.
  const idGen = new TraceIdGenerator(generateOperationId())

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

  // Pre-bucket projectors by topic for fast dispatch.
  const byTopic = new Map<string, Projection[]>()
  for (const proj of projections) {
    for (const topic of proj.subscribedTopics) {
      const list = byTopic.get(topic) ?? []
      list.push(proj)
      byTopic.set(topic, list)
    }
  }

  return {
    emit<P>(
      topic: string,
      payload: P,
      sessionId: string | null,
      referencedBlobs: ReadonlyArray<BlobRef> = [],
    ): Event<P> {
      const now = Date.now()
      const event: Event<P> = {
        id: idGen.generate(),
        topic,
        payload,
        sessionId,
        createdAt: now,
      }
      const payloadStr = JSON.stringify(payload)

      const tx = db.transaction(() => {
        for (const blob of referencedBlobs) {
          insertBlob.run(blob.cid, blob.bytes, blob.bytes.byteLength, now)
        }
        insertEvent.run(event.id, event.topic, payloadStr, event.sessionId, event.createdAt)
        const subscribers = byTopic.get(topic) ?? []
        for (const proj of subscribers) {
          proj.apply(event, db)
          upsertOffset.run(proj.id, event.id)
        }
      })
      tx.immediate()
      return event
    },
  }
}

/**
 * Consumer for ad-hoc projection rebuilds and tests. In steady state, the
 * producer's synchronous dispatch keeps projections up to date, so the
 * consumer is only used when we wipe a view and replay.
 */
export function createEventConsumer(db: DB): EventConsumer {
  const readOffset = db.prepare(
    'SELECT last_processed_event_id FROM projection_offsets WHERE projection_id = ?',
  )
  const upsertOffset = db.prepare(
    'INSERT INTO projection_offsets (projection_id, last_processed_event_id) VALUES (?, ?)'
    + ' ON CONFLICT(projection_id) DO UPDATE SET last_processed_event_id = excluded.last_processed_event_id',
  )

  return {
    poll(projectionId: string, topics: ReadonlyArray<string>, batchSize: number): Event[] {
      const offsetRow = readOffset.get(projectionId) as
        | { last_processed_event_id: string }
        | undefined
      const offset = offsetRow?.last_processed_event_id ?? ''
      const placeholders = topics.map(() => '?').join(',')
      const sql
        = 'SELECT event_id, topic, payload, session_id, created_at FROM events'
          + ` WHERE topic IN (${placeholders}) AND event_id > ?`
          + ' ORDER BY event_id ASC LIMIT ?'
      const rows = db.prepare(sql).all(...topics, offset, batchSize) as Array<{
        event_id: string
        topic: string
        payload: string
        session_id: string | null
        created_at: number
      }>
      return rows.map(row => ({
        id: row.event_id as TraceId,
        topic: row.topic,
        payload: JSON.parse(row.payload) as unknown,
        sessionId: row.session_id,
        createdAt: row.created_at,
      }))
    },
    commit(projectionId: string, eventId: TraceId): void {
      upsertOffset.run(projectionId, eventId)
    },
    currentOffset(projectionId: string): TraceId | '' {
      const row = readOffset.get(projectionId) as { last_processed_event_id: string } | undefined
      return (row?.last_processed_event_id ?? '') as TraceId | ''
    },
  }
}
