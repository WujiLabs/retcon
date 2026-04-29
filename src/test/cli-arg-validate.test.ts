// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { readFlag, removeFlag, validateUserArgs } from '../cli/arg-validate.js'

describe('validateUserArgs — --mcp-config', () => {
  it('errors when user defines mcpServers.retcon (collides with our auto-registration)', () => {
    const cfg = JSON.stringify({ mcpServers: { retcon: { type: 'http', url: 'http://example' } } })
    expect(() => validateUserArgs(['--mcp-config', cfg]))
      .toThrow(/mcpServers\.retcon/)
  })

  it('passes when user defines other servers (claude unions across multiple --mcp-config flags)', () => {
    const cfg = JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'mcp-fs' } } })
    expect(() => validateUserArgs(['--mcp-config', cfg])).not.toThrow()
  })

  it('handles --mcp-config=value form', () => {
    const cfg = JSON.stringify({ mcpServers: { retcon: {} } })
    expect(() => validateUserArgs([`--mcp-config=${cfg}`]))
      .toThrow(/mcpServers\.retcon/)
  })

  it('reads JSON from a file path argument', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'retcon-mcp-cfg-'))
    try {
      const file = path.join(dir, 'cfg.json')
      writeFileSync(file, JSON.stringify({ mcpServers: { retcon: {} } }))
      expect(() => validateUserArgs(['--mcp-config', file]))
        .toThrow(/mcpServers\.retcon/)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('silently skips unparseable values (claude will surface its own error)', () => {
    expect(() => validateUserArgs(['--mcp-config', 'not-json-and-not-a-file'])).not.toThrow()
  })

  it('does NOT error on user --session-id (run.ts adopts it as the binding token)', () => {
    expect(() => validateUserArgs(['--session-id', '11111111-2222-3333-4444-555555555555']))
      .not.toThrow()
  })

  it('does NOT error on user hooks.SessionStart (run.ts inline-merges it)', () => {
    const settings = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo' }] }] },
    })
    expect(() => validateUserArgs(['--settings', settings])).not.toThrow()
  })
})

describe('readFlag', () => {
  it('returns last value when flag appears multiple times', () => {
    expect(readFlag(['--effort', 'low', '--effort', 'high'], '--effort')).toBe('high')
  })
  it('parses --flag=value form', () => {
    expect(readFlag(['--effort=high'], '--effort')).toBe('high')
  })
  it('returns undefined when flag absent', () => {
    expect(readFlag(['--other', 'x'], '--effort')).toBeUndefined()
  })
})

describe('removeFlag', () => {
  it('removes flag and its value (space-separated)', () => {
    expect(removeFlag(['--effort', 'low', '--keep'], '--effort')).toEqual(['--keep'])
  })
  it('removes --flag=value form', () => {
    expect(removeFlag(['--effort=low', '--keep'], '--effort')).toEqual(['--keep'])
  })
  it('removes all occurrences', () => {
    expect(removeFlag(['--x', '1', '--y', '--x', '2', '--z'], '--x')).toEqual(['--y', '--z'])
  })
})
