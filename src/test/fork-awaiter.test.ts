// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db.js'
import { migrate, openDb } from '../db.js'
import { createEventProducer } from '../events.js'
import { ForkAwaiter, lastForkOutcome } from '../fork-awaiter.js'

describe('ForkAwaiter', () => {
  it('resolves when notify() fires', async () => {
    const a = new ForkAwaiter()
    const p = a.wait('s1', 5000)
    a.notify('s1', { status: 'completed', version_id: 'v-1' })
    const o = await p
    expect(o.status).toBe('completed')
    expect(o.version_id).toBe('v-1')
    expect(a.hasWaiter('s1')).toBe(false)
  })

  it('times out with status=timeout if notify never fires', async () => {
    const a = new ForkAwaiter()
    const o = await a.wait('s2', 50)
    expect(o.status).toBe('timeout')
  })

  it('supersedes a prior waiter when a new one is registered', async () => {
    const a = new ForkAwaiter()
    const first = a.wait('s3', 5000)
    const second = a.wait('s3', 5000)
    a.notify('s3', { status: 'completed', version_id: 'v-new' })
    const [r1, r2] = await Promise.all([first, second])
    expect(r1.status).toBe('superseded')
    expect(r2.status).toBe('completed')
  })

  it('notify without a waiter is a no-op', () => {
    const a = new ForkAwaiter()
    expect(() => a.notify('nobody', { status: 'completed' })).not.toThrow()
  })
})

describe('lastForkOutcome', () => {
  let db: DB

  beforeEach(() => {
    db = openDb({ path: ':memory:' })
    migrate(db)
  })

  it('returns null when the session has no TOBE-applied requests', () => {
    const producer = createEventProducer(db, [])
    producer.emit('proxy.request_received', { path: '/v1/messages' }, 's-no-fork')
    expect(lastForkOutcome(db, 's-no-fork')).toBeNull()
  })

  it('reports completed + stop_reason for a successful TOBE call', () => {
    const producer = createEventProducer(db, [])
    const reqEvt = producer.emit(
      'proxy.request_received',
      {
        path: '/v1/messages',
        tobe_applied_from: {
          fork_point_version_id: 'v-fp',
          source_view_id: 'view-s',
          original_body_cid: 'bafy-orig',
        },
      },
      'sess-ok',
    )
    producer.emit(
      'proxy.response_completed',
      { request_event_id: reqEvt.id, status: 200, stop_reason: 'end_turn' },
      'sess-ok',
    )
    const outcome = lastForkOutcome(db, 'sess-ok')
    expect(outcome?.status).toBe('completed')
    expect(outcome?.version_id).toBe(reqEvt.id)
    expect(outcome?.http_status).toBe(200)
    expect(outcome?.stop_reason).toBe('end_turn')
    expect(outcome?.fork_point_version_id).toBe('v-fp')
    expect(outcome?.source_view_id).toBe('view-s')
  })

  it('reports http_error for a 5xx response', () => {
    const producer = createEventProducer(db, [])
    const reqEvt = producer.emit(
      'proxy.request_received',
      { path: '/v1/messages', tobe_applied_from: { fork_point_version_id: 'v-fp', source_view_id: 'v-s', original_body_cid: 'b' } },
      'sess-5xx',
    )
    producer.emit(
      'proxy.response_completed',
      { request_event_id: reqEvt.id, status: 503, stop_reason: null },
      'sess-5xx',
    )
    const outcome = lastForkOutcome(db, 'sess-5xx')
    expect(outcome?.status).toBe('http_error')
    expect(outcome?.http_status).toBe(503)
  })

  it('reports aborted when the response was cut short', () => {
    const producer = createEventProducer(db, [])
    const reqEvt = producer.emit(
      'proxy.request_received',
      { path: '/v1/messages', tobe_applied_from: { fork_point_version_id: 'v-fp', source_view_id: 'v-s', original_body_cid: 'b' } },
      'sess-ab',
    )
    producer.emit(
      'proxy.response_aborted',
      { request_event_id: reqEvt.id, reason: 'client_disconnect' },
      'sess-ab',
    )
    const outcome = lastForkOutcome(db, 'sess-ab')
    expect(outcome?.status).toBe('aborted')
    expect(outcome?.error_message).toBe('client_disconnect')
  })

  it('reports upstream_error when the proxy could not reach upstream', () => {
    const producer = createEventProducer(db, [])
    const reqEvt = producer.emit(
      'proxy.request_received',
      { path: '/v1/messages', tobe_applied_from: { fork_point_version_id: 'v-fp', source_view_id: 'v-s', original_body_cid: 'b' } },
      'sess-ue',
    )
    producer.emit(
      'proxy.upstream_error',
      { request_event_id: reqEvt.id, status: 502, error_message: 'ECONNREFUSED' },
      'sess-ue',
    )
    const outcome = lastForkOutcome(db, 'sess-ue')
    expect(outcome?.status).toBe('upstream_error')
    expect(outcome?.http_status).toBe(502)
    expect(outcome?.error_message).toBe('ECONNREFUSED')
  })

  it('returns in_flight when the TOBE-applied request has no terminal event yet', () => {
    const producer = createEventProducer(db, [])
    producer.emit(
      'proxy.request_received',
      { path: '/v1/messages', tobe_applied_from: { fork_point_version_id: 'v-fp', source_view_id: 'v-s', original_body_cid: 'b' } },
      'sess-inflight',
    )
    // No terminal event emitted — request is still in-flight.
    const outcome = lastForkOutcome(db, 'sess-inflight')
    expect(outcome?.status).toBe('in_flight')
    expect(outcome?.fork_point_version_id).toBe('v-fp')
  })

  it('returns the MOST RECENT TOBE-applied request when there are multiple', () => {
    const producer = createEventProducer(db, [])
    // Older: failed.
    const r1 = producer.emit(
      'proxy.request_received',
      { path: '/v1/messages', tobe_applied_from: { fork_point_version_id: 'v-old', source_view_id: 'view-old', original_body_cid: 'b' } },
      'sess-multi',
    )
    producer.emit(
      'proxy.response_completed',
      { request_event_id: r1.id, status: 502, stop_reason: null },
      'sess-multi',
    )
    // Newer: succeeded.
    const r2 = producer.emit(
      'proxy.request_received',
      { path: '/v1/messages', tobe_applied_from: { fork_point_version_id: 'v-new', source_view_id: 'view-new', original_body_cid: 'b' } },
      'sess-multi',
    )
    producer.emit(
      'proxy.response_completed',
      { request_event_id: r2.id, status: 200, stop_reason: 'end_turn' },
      'sess-multi',
    )
    const outcome = lastForkOutcome(db, 'sess-multi')
    expect(outcome?.status).toBe('completed')
    expect(outcome?.fork_point_version_id).toBe('v-new')
  })
})
