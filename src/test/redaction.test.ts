// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REDACTED_HEADERS,
  redactHeaders,
  REDACTED_VALUE,
  resolveRedactedHeaderSet,
} from '../redaction.js'

describe('redactHeaders', () => {
  it('replaces default-redacted headers with REDACTED', () => {
    const out = redactHeaders({
      authorization: 'Bearer sk-ant-actualsecret',
      'x-api-key': 'sk-xxx',
      'user-agent': 'claude-code/1.0',
    })
    expect(out.authorization).toBe(REDACTED_VALUE)
    expect(out['x-api-key']).toBe(REDACTED_VALUE)
    expect(out['user-agent']).toBe('claude-code/1.0')
  })

  it('handles case-insensitive header names', () => {
    const out = redactHeaders({ Authorization: 'Bearer leak' })
    expect(out.Authorization).toBe(REDACTED_VALUE)
  })

  it('redacts array-valued headers element-wise', () => {
    const out = redactHeaders({ 'set-cookie': ['a=1', 'b=2'] })
    expect(out['set-cookie']).toEqual([REDACTED_VALUE, REDACTED_VALUE])
  })

  it('drops undefined values', () => {
    const out = redactHeaders({ authorization: undefined, 'x-api-key': 'x' })
    expect('authorization' in out).toBe(false)
    expect(out['x-api-key']).toBe(REDACTED_VALUE)
  })

  it('respects a custom redact set', () => {
    const custom = new Set<string>(['x-custom-key'])
    const out = redactHeaders(
      { authorization: 'keep-me', 'x-custom-key': 'hide-me' },
      custom,
    )
    expect(out.authorization).toBe('keep-me')
    expect(out['x-custom-key']).toBe(REDACTED_VALUE)
  })
})

describe('resolveRedactedHeaderSet', () => {
  it('returns the defaults when env is empty', () => {
    const set = resolveRedactedHeaderSet(undefined)
    for (const name of DEFAULT_REDACTED_HEADERS) {
      expect(set.has(name)).toBe(true)
    }
  })

  it('extends the defaults with env-provided names', () => {
    const set = resolveRedactedHeaderSet('x-trace-id, X-Custom-Key')
    expect(set.has('x-trace-id')).toBe(true)
    expect(set.has('x-custom-key')).toBe(true)
    expect(set.has('authorization')).toBe(true)
  })
})
