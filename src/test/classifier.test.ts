// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetClassifierWarnings, classify } from '../classifier.js'

describe('classify', () => {
  beforeEach(() => {
    _resetClassifierWarnings()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('classifies end_turn as closed_forkable', () => {
    expect(classify('end_turn')).toBe('closed_forkable')
  })

  it('classifies stop_sequence as closed_forkable', () => {
    expect(classify('stop_sequence')).toBe('closed_forkable')
  })

  it('classifies tool_use as open', () => {
    expect(classify('tool_use')).toBe('open')
  })

  it('classifies pause_turn as open', () => {
    expect(classify('pause_turn')).toBe('open')
  })

  it('classifies max_tokens as dangling_unforkable', () => {
    expect(classify('max_tokens')).toBe('dangling_unforkable')
  })

  it('classifies refusal as dangling_unforkable', () => {
    expect(classify('refusal')).toBe('dangling_unforkable')
  })

  it('classifies null as dangling_unforkable', () => {
    expect(classify(null)).toBe('dangling_unforkable')
    expect(classify(undefined)).toBe('dangling_unforkable')
  })

  it('classifies unknown stop_reason as dangling_unforkable and warns once', () => {
    expect(classify('some_new_reason')).toBe('dangling_unforkable')
    expect(classify('some_new_reason')).toBe('dangling_unforkable')
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('warns separately for distinct unknown values', () => {
    classify('novel_one')
    classify('novel_two')
    expect(console.warn).toHaveBeenCalledTimes(2)
  })
})
