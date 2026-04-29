// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Tests for ensureMcpEntry. Mocks node:child_process.execFile so the test
// doesn't actually call `claude mcp` — we control the responses to cover all
// branches without depending on the user's real claude config.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface ExecCall { args: readonly string[] }
type ExecResponse
  = | { kind: 'ok', stdout: string, stderr?: string }
    | { kind: 'fail', code: string | number, stdout?: string, stderr?: string }

let calls: ExecCall[] = []
let responder: (args: readonly string[]) => ExecResponse = () => ({ kind: 'ok', stdout: '' })

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: readonly string[], _opts: unknown, cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void) => {
    calls.push({ args })
    void cmd
    const r = responder(args)
    if (r.kind === 'ok') {
      cb(null, r.stdout, r.stderr ?? '')
      return
    }
    const err = new Error(r.stderr ?? 'execFile failed') as NodeJS.ErrnoException & { stderr?: string, stdout?: string }
    err.code = String(r.code)
    err.stderr = r.stderr ?? ''
    err.stdout = r.stdout ?? ''
    cb(err, r.stdout ?? '', r.stderr ?? '')
  },
}))

// Import AFTER mocking so the SUT picks up the mock.
const { ensureMcpEntry } = await import('../cli/mcp-config.js')

beforeEach(() => {
  calls = []
})
afterEach(() => {
  responder = () => ({ kind: 'ok', stdout: '' })
})

describe('ensureMcpEntry', () => {
  it('skips when claude is not on PATH (execFile ENOENT)', async () => {
    responder = () => ({ kind: 'fail', code: 'ENOENT', stderr: 'spawn claude ENOENT' })
    const r = await ensureMcpEntry(4099)
    expect(r.kind).toBe('skipped')
    if (r.kind === 'skipped') expect(r.reason).toBe('claude_not_installed')
    // Only the initial `mcp get` should have been attempted.
    expect(calls).toHaveLength(1)
  })

  it('no-ops when entry exists and URL already matches', async () => {
    responder = (args) => {
      if (args[0] === 'mcp' && args[1] === 'get') {
        return {
          kind: 'ok',
          stdout: 'retcon:\n  Scope: User config\n  Type: http\n  URL: http://127.0.0.1:4099/mcp\n',
        }
      }
      return { kind: 'ok', stdout: '' }
    }
    const r = await ensureMcpEntry(4099)
    expect(r.kind).toBe('noop')
    expect(calls.map(c => c.args[1])).toEqual(['get'])
  })

  it('removes + adds when entry exists with a different URL', async () => {
    responder = (args) => {
      if (args[1] === 'get') {
        return {
          kind: 'ok',
          stdout: 'retcon:\n  URL: http://127.0.0.1:5000/mcp\n',
        }
      }
      return { kind: 'ok', stdout: '' }
    }
    const r = await ensureMcpEntry(4099)
    expect(r.kind).toBe('replaced')
    expect(calls.map(c => c.args[1])).toEqual(['get', 'remove', 'add'])
  })

  it('adds when entry is missing', async () => {
    responder = (args) => {
      if (args[1] === 'get') {
        return {
          kind: 'fail',
          code: 1,
          stderr: 'No MCP server found with name: "retcon".',
        }
      }
      return { kind: 'ok', stdout: '' }
    }
    const r = await ensureMcpEntry(4099)
    expect(r.kind).toBe('added')
    expect(calls.map(c => c.args[1])).toEqual(['get', 'add'])
    // verify --scope user got passed
    const addArgs = calls[1].args
    expect(addArgs).toContain('--scope')
    expect(addArgs).toContain('user')
    expect(addArgs).toContain('--transport')
    expect(addArgs).toContain('http')
    expect(addArgs).toContain('http://127.0.0.1:4099/mcp')
  })

  it('reports failed when add returns non-zero', async () => {
    responder = (args) => {
      if (args[1] === 'get') {
        return { kind: 'fail', code: 1, stderr: 'No MCP server found' }
      }
      return { kind: 'fail', code: 1, stderr: 'MCP server retcon already exists in user config' }
    }
    const r = await ensureMcpEntry(4099)
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') expect(r.reason).toMatch(/already exists/)
  })
})
