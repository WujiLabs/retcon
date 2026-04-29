// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateUserArgs } from '../cli/arg-validate.js'

describe('validateUserArgs — --session-id', () => {
  it('errors when user passes --session-id and we are NOT in resume mode', () => {
    expect(() => validateUserArgs(['--session-id', 'abc-123'], false))
      .toThrow(/--session-id/)
  })

  it('errors on --session-id=value form', () => {
    expect(() => validateUserArgs(['--session-id=abc-123'], false))
      .toThrow(/--session-id/)
  })

  it('allows --session-id when in resume mode (claude does its own validation there)', () => {
    expect(() => validateUserArgs(['--session-id', 'abc'], true)).not.toThrow()
  })

  it('passes when no --session-id is present', () => {
    expect(() => validateUserArgs(['--effort', 'low'], false)).not.toThrow()
  })
})

describe('validateUserArgs — --mcp-config', () => {
  it('errors when user defines mcpServers.retcon (collides with our auto-registration)', () => {
    const cfg = JSON.stringify({ mcpServers: { retcon: { type: 'http', url: 'http://example' } } })
    expect(() => validateUserArgs(['--mcp-config', cfg], false))
      .toThrow(/mcpServers\.retcon/)
  })

  it('passes when user defines other servers', () => {
    const cfg = JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'mcp-fs' } } })
    expect(() => validateUserArgs(['--mcp-config', cfg], false)).not.toThrow()
  })

  it('handles --mcp-config=value form', () => {
    const cfg = JSON.stringify({ mcpServers: { retcon: {} } })
    expect(() => validateUserArgs([`--mcp-config=${cfg}`], false))
      .toThrow(/mcpServers\.retcon/)
  })

  it('reads JSON from a file path argument', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'retcon-mcp-cfg-'))
    try {
      const file = path.join(dir, 'cfg.json')
      writeFileSync(file, JSON.stringify({ mcpServers: { retcon: {} } }))
      expect(() => validateUserArgs(['--mcp-config', file], false))
        .toThrow(/mcpServers\.retcon/)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('silently skips unparseable values (claude will surface its own error)', () => {
    expect(() => validateUserArgs(['--mcp-config', 'not-json-and-not-a-file'], false)).not.toThrow()
  })
})

describe('validateUserArgs — --settings', () => {
  it('errors when user defines hooks.SessionStart', () => {
    const settings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo' }] }] } })
    expect(() => validateUserArgs(['--settings', settings], false))
      .toThrow(/SessionStart/)
  })

  it('passes when user defines other hooks', () => {
    const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }] } })
    expect(() => validateUserArgs(['--settings', settings], false)).not.toThrow()
  })

  it('passes when settings have no hooks at all', () => {
    const settings = JSON.stringify({ permissions: { allowedTools: ['Bash'] } })
    expect(() => validateUserArgs(['--settings', settings], false)).not.toThrow()
  })

  it('reads settings from a file path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'retcon-settings-'))
    try {
      const file = path.join(dir, 'settings.json')
      writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{}] } }))
      expect(() => validateUserArgs(['--settings', file], false))
        .toThrow(/SessionStart/)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
