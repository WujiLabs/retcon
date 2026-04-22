// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db.js'
import { migrate, openDb } from '../db.js'
import {
  createEventConsumer,
  createEventProducer,
  type Event,
  type Projection,
} from '../events.js'

describe('event log', () => {
  let db: DB

  beforeEach(() => {
    db = openDb({ path: ':memory:' })
    migrate(db)
  })

  it('emits events and consumer replays them in order', () => {
    const producer = createEventProducer(db, [])
    const consumer = createEventConsumer(db)

    producer.emit('test.topic', { n: 1 }, null)
    producer.emit('test.topic', { n: 2 }, null)
    producer.emit('test.topic', { n: 3 }, null)

    const batch = consumer.poll('reader', ['test.topic'], 10)
    expect(batch.length).toBe(3)
    expect(batch.map(e => (e.payload as { n: number }).n)).toEqual([1, 2, 3])
  })

  it('consumer offset persists across poll calls', () => {
    const producer = createEventProducer(db, [])
    const consumer = createEventConsumer(db)
    const e1 = producer.emit('t', { n: 1 }, null)
    producer.emit('t', { n: 2 }, null)

    consumer.commit('reader', e1.id)
    const remaining = consumer.poll('reader', ['t'], 10)
    expect(remaining.length).toBe(1)
    expect((remaining[0].payload as { n: number }).n).toBe(2)
  })

  it('stores referenced blobs in same transaction as event', () => {
    const producer = createEventProducer(db, [])
    const blob = { cid: 'bafy-test-1', bytes: new Uint8Array([1, 2, 3, 4]) }
    producer.emit('t', { ref: 'bafy-test-1' }, null, [blob])

    const row = db
      .prepare('SELECT size FROM blobs WHERE cid=?')
      .get('bafy-test-1') as { size: number } | undefined
    expect(row?.size).toBe(4)
  })

  it('dispatches events to subscribed projectors in declared order', () => {
    const trace: string[] = []
    const makeProj = (id: string, topic: string): Projection => ({
      id,
      subscribedTopics: [topic],
      apply: (e: Event) => {
        trace.push(`${id}:${(e.payload as { tag: string }).tag}`)
      },
    })

    const producer = createEventProducer(db, [
      makeProj('first', 't'),
      makeProj('second', 't'),
    ])

    producer.emit('t', { tag: 'a' }, null)
    producer.emit('t', { tag: 'b' }, null)

    expect(trace).toEqual(['first:a', 'second:a', 'first:b', 'second:b'])
  })

  it('advances each projector offset to the emitted event id', () => {
    const proj: Projection = {
      id: 'demo',
      subscribedTopics: ['t'],
      apply: () => {},
    }
    const producer = createEventProducer(db, [proj])
    const consumer = createEventConsumer(db)

    const e = producer.emit('t', { n: 1 }, null)
    expect(consumer.currentOffset('demo')).toBe(e.id)
  })

  it('rolls back event AND blob AND projector update if a projector throws', () => {
    const boom: Projection = {
      id: 'boom',
      subscribedTopics: ['t'],
      apply: () => {
        throw new Error('boom')
      },
    }
    const producer = createEventProducer(db, [boom])
    const consumer = createEventConsumer(db)

    expect(() =>
      producer.emit('t', { n: 1 }, null, [
        { cid: 'bafy-rollback', bytes: new Uint8Array([9, 9]) },
      ]),
    ).toThrow('boom')

    const events = consumer.poll('reader', ['t'], 10)
    expect(events.length).toBe(0)
    const blob = db.prepare('SELECT 1 FROM blobs WHERE cid=?').get('bafy-rollback')
    expect(blob).toBeUndefined()
  })

  it('filters by topic in poll', () => {
    const producer = createEventProducer(db, [])
    const consumer = createEventConsumer(db)
    producer.emit('topic.a', { n: 1 }, null)
    producer.emit('topic.b', { n: 2 }, null)
    producer.emit('topic.a', { n: 3 }, null)

    const onlyA = consumer.poll('reader', ['topic.a'], 10)
    expect(onlyA.length).toBe(2)
    expect(onlyA.map(e => (e.payload as { n: number }).n)).toEqual([1, 3])
  })
})
