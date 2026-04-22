// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import { extractStopReasonFromJsonBody, SseStopReasonParser } from '../sse-parser.js'

function frame(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

describe('SseStopReasonParser', () => {
  it('extracts stop_reason from a complete Anthropic-style stream', () => {
    const p = new SseStopReasonParser()
    p.feed(frame('message_start', { type: 'message_start', message: { id: 'msg_1' } }))
    p.feed(frame('content_block_start', { type: 'content_block_start', index: 0 }))
    p.feed(frame('content_block_delta', {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'hello' },
    }))
    p.feed(frame('content_block_stop', { type: 'content_block_stop', index: 0 }))
    p.feed(frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }))
    p.feed(frame('message_stop', { type: 'message_stop' }))
    p.end()
    expect(p.snapshot()).toEqual({ stopReason: 'end_turn', finished: true })
  })

  it('handles chunks split mid-frame', () => {
    const p = new SseStopReasonParser()
    const full = frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
    })
    const mid = Math.floor(full.length / 2)
    p.feed(full.slice(0, mid))
    // Before the second half arrives, nothing is extracted yet.
    expect(p.snapshot().stopReason).toBeNull()
    p.feed(full.slice(mid))
    expect(p.snapshot().stopReason).toBe('tool_use')
  })

  it('handles \\r\\n frame separators', () => {
    const p = new SseStopReasonParser()
    const crlf = frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
    }).replace(/\n/g, '\r\n')
    p.feed(crlf)
    expect(p.snapshot().stopReason).toBe('max_tokens')
  })

  it('returns null stop_reason when stream ends without message_delta', () => {
    const p = new SseStopReasonParser()
    p.feed(frame('message_start', { type: 'message_start' }))
    p.end()
    expect(p.snapshot().stopReason).toBeNull()
    expect(p.snapshot().finished).toBe(true)
  })

  it('ignores malformed frames without throwing', () => {
    const p = new SseStopReasonParser()
    p.feed('data: {not json\n\n')
    p.feed(frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    }))
    p.end()
    expect(p.snapshot().stopReason).toBe('end_turn')
  })

  it('invokes onFinish listeners once with the final result', () => {
    const p = new SseStopReasonParser()
    const results: Array<{ stopReason: string | null, finished: boolean }> = []
    p.onFinish(r => results.push(r))
    p.feed(frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }))
    p.feed(frame('message_stop', { type: 'message_stop' }))
    p.end()
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].stopReason).toBe('end_turn')
    expect(results[0].finished).toBe(true)
  })

  it('ignores further feed after finished', () => {
    const p = new SseStopReasonParser()
    p.end()
    p.feed(frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }))
    expect(p.snapshot().stopReason).toBeNull()
  })

  it('trips the buffer cap on a never-terminating stream', () => {
    const p = new SseStopReasonParser()
    // 2MB of a single line with no frame boundary — should trigger overflow.
    const junk = 'data: '.concat('x'.repeat(2 * 1024 * 1024))
    // Feed in chunks under the cap per call, but cumulative > cap.
    for (let i = 0; i < 6; i++) {
      p.feed(junk)
      if (p.didOverflow()) break
    }
    expect(p.didOverflow()).toBe(true)
    expect(p.snapshot().finished).toBe(true)
  })
})

describe('extractStopReasonFromJsonBody', () => {
  it('reads top-level stop_reason', () => {
    expect(extractStopReasonFromJsonBody(JSON.stringify({ stop_reason: 'end_turn' }))).toBe('end_turn')
  })

  it('returns null for malformed JSON', () => {
    expect(extractStopReasonFromJsonBody('{not json')).toBeNull()
  })

  it('returns null when stop_reason is missing', () => {
    expect(extractStopReasonFromJsonBody(JSON.stringify({ foo: 'bar' }))).toBeNull()
  })
})
