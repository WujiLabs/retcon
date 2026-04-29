// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Direct tests for the bounded-body reader. Two HTTP handlers consume it
// (actor-register and hook-handler), so a regression here would manifest
// as a slow-loris vulnerability that's only obvious under real network
// load. Drive each branch (data/end/error/overflow) via a fake
// IncomingMessage built on EventEmitter.

import { EventEmitter } from 'node:events'
import type http from 'node:http'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readBoundedBody } from '../util/http-body.js'

interface FakeReq extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>
}

function fakeReq(): FakeReq {
  const ee = new EventEmitter() as FakeReq
  ee.setMaxListeners(20)
  ee.destroy = vi.fn()
  return ee
}

describe('readBoundedBody', () => {
  let req: FakeReq
  beforeEach(() => {
    req = fakeReq()
  })
  afterEach(() => {
    req.removeAllListeners()
  })

  it('resolves with concatenated chunks on end', async () => {
    const p = readBoundedBody(req as unknown as http.IncomingMessage, 1024)
    req.emit('data', Buffer.from('hel'))
    req.emit('data', Buffer.from('lo'))
    req.emit('end')
    expect((await p).toString()).toBe('hello')
  })

  it('returns an empty buffer on immediate end', async () => {
    const p = readBoundedBody(req as unknown as http.IncomingMessage, 1024)
    req.emit('end')
    expect((await p).length).toBe(0)
  })

  it('rejects with overflow + destroys the socket past the cap', async () => {
    const p = readBoundedBody(req as unknown as http.IncomingMessage, 4)
    req.emit('data', Buffer.from('toolong'))
    await expect(p).rejects.toThrow(/overflow/)
    expect(req.destroy).toHaveBeenCalled()
  })

  it('overflow on the second chunk: total > cap (slow-loris guard)', async () => {
    const p = readBoundedBody(req as unknown as http.IncomingMessage, 6)
    req.emit('data', Buffer.from('abc')) // total=3, ok
    req.emit('data', Buffer.from('defx')) // total=7, > 6 → overflow
    await expect(p).rejects.toThrow(/overflow/)
    expect(req.destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects with the underlying error on socket error', async () => {
    const p = readBoundedBody(req as unknown as http.IncomingMessage, 1024)
    const err = new Error('econnreset')
    req.emit('error', err)
    await expect(p).rejects.toBe(err)
  })

  it('boundary: total === maxBytes is accepted (the guard is `>` not `>=`)', async () => {
    const p = readBoundedBody(req as unknown as http.IncomingMessage, 4)
    req.emit('data', Buffer.from('abcd'))
    req.emit('end')
    expect((await p).toString()).toBe('abcd')
  })

  it('ignores data + end events that arrive after overflow has settled', async () => {
    const p = readBoundedBody(req as unknown as http.IncomingMessage, 2)
    req.emit('data', Buffer.from('xxx')) // overflow
    await expect(p).rejects.toThrow(/overflow/)
    // Late events shouldn't double-resolve or throw.
    req.emit('data', Buffer.from('zzz'))
    req.emit('end')
    req.emit('error', new Error('after-settle'))
    expect(req.destroy).toHaveBeenCalledTimes(1)
  })
})
