// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest'

import { DEFAULT_ACTOR, extractActor } from '../cli/arg-parse.js'

describe('extractActor', () => {
  it('returns undefined when --actor is not present', () => {
    const r = extractActor(['--effort', 'low'])
    expect(r.actor).toBeUndefined()
    expect(r.remaining).toEqual(['--effort', 'low'])
  })

  it('parses --actor <value> form and strips it from args', () => {
    const r = extractActor(['--effort', 'low', '--actor', 'test', '-r'])
    expect(r.actor).toBe('test')
    expect(r.remaining).toEqual(['--effort', 'low', '-r'])
  })

  it('parses --actor=value form and strips it from args', () => {
    const r = extractActor(['--actor=ci-smoke', '--effort', 'low'])
    expect(r.actor).toBe('ci-smoke')
    expect(r.remaining).toEqual(['--effort', 'low'])
  })

  it('throws on a name with whitespace or punctuation', () => {
    expect(() => extractActor(['--actor', 'bad name'])).toThrow(/not a valid name/)
    expect(() => extractActor(['--actor', 'has;semicolon'])).toThrow(/not a valid name/)
    expect(() => extractActor(['--actor', '/etc/passwd'])).toThrow(/not a valid name/)
  })

  it('throws on empty value', () => {
    expect(() => extractActor(['--actor='])).toThrow(/not a valid name/)
    expect(() => extractActor(['--actor', ''])).toThrow(/not a valid name/)
  })

  it('accepts up to 64 chars but rejects 65+', () => {
    const ok = 'a'.repeat(64)
    const tooLong = 'a'.repeat(65)
    expect(extractActor(['--actor', ok]).actor).toBe(ok)
    expect(() => extractActor(['--actor', tooLong])).toThrow(/not a valid name/)
  })

  it('exposes DEFAULT_ACTOR as "default"', () => {
    expect(DEFAULT_ACTOR).toBe('default')
  })
})
