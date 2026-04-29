// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'

import { SessionQueue } from '../session-queue.js'

function defer<T>(): { promise: Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SessionQueue', () => {
  it('serializes tasks for the same session', async () => {
    const q = new SessionQueue()
    const order: string[] = []
    const gate = defer<void>()

    const t1 = q.run('s1', async () => {
      order.push('t1:start')
      await gate.promise
      order.push('t1:end')
    })
    const t2 = q.run('s1', async () => {
      order.push('t2:start')
      order.push('t2:end')
    })

    // t2 must not start until t1 has ended
    await Promise.resolve()
    expect(order).toEqual(['t1:start'])
    gate.resolve()
    await Promise.all([t1, t2])
    expect(order).toEqual(['t1:start', 't1:end', 't2:start', 't2:end'])
  })

  it('runs different sessions concurrently', async () => {
    const q = new SessionQueue()
    const order: string[] = []
    const gate = defer<void>()

    const t1 = q.run('sA', async () => {
      order.push('A:start')
      await gate.promise
      order.push('A:end')
    })
    const t2 = q.run('sB', async () => {
      order.push('B:start')
      order.push('B:end')
    })

    await Promise.resolve()
    await Promise.resolve()
    // sB should have run independently — no blocking on sA
    expect(order).toContain('B:start')
    expect(order).toContain('B:end')
    expect(order).toContain('A:start')
    expect(order).not.toContain('A:end')
    gate.resolve()
    await Promise.all([t1, t2])
  })

  it('keeps the chain alive after a task throws', async () => {
    const q = new SessionQueue()
    const order: string[] = []

    const failing = q.run('s', async () => {
      order.push('boom:start')
      throw new Error('boom')
    })
    const next = q.run('s', async () => {
      order.push('next:ran')
    })

    await expect(failing).rejects.toThrow('boom')
    await next
    expect(order).toEqual(['boom:start', 'next:ran'])
  })

  it('returns the task result', async () => {
    const q = new SessionQueue()
    const v = await q.run('s', async () => 42)
    expect(v).toBe(42)
  })
})
