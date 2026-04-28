// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Idempotent registration of retcon as a Claude Code MCP server.
//
// The Claude CLI exposes:
//   - `claude mcp get <name>`         exit 0 if entry exists (even if unhealthy);
//                                     exit 1 with "No MCP server found" stderr if missing
//   - `claude mcp add <name> <url>`   exit 0 if added;
//                                     exit 1 with "already exists" stderr on duplicate
//   - `claude mcp remove <name>`      exit 0 on remove
//   - `--scope user`                  registers globally (not per-project, which is
//                                     the default and would break `alias claude='retcon'`)
//
// All failures here are non-fatal: if claude isn't on PATH or the registration
// fails for any reason, retcon still starts the daemon and runs the agent —
// the user just won't have fork tools available in claude until they configure
// MCP themselves.

import { execFile, type ExecFileOptions } from 'node:child_process'

interface ExecResult { stdout: string, stderr: string }

/**
 * Manual promise wrapper around execFile. We don't use util.promisify because
 * Node attaches a `util.promisify.custom` symbol to child_process.execFile
 * that returns a different shape; that symbol is awkward to mock in tests.
 * This shim is a few lines and works with vanilla execFile mocks.
 */
function execFileP(file: string, args: readonly string[], opts: ExecFileOptions): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    execFile(file, args as string[], { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string, stderr?: string }
        e.stdout = stdout
        e.stderr = stderr
        reject(e)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export const MCP_SERVER_NAME = 'retcon'

export type EnsureMcpResult =
  | { kind: 'skipped', reason: 'claude_not_installed' }
  | { kind: 'noop', reason: 'already_correct' }
  | { kind: 'added' }
  | { kind: 'replaced' }
  | { kind: 'failed', reason: string }

/**
 * Ensure the retcon MCP entry is registered at user scope and points at the
 * given port. Idempotent: a second call with the same port is a no-op.
 *
 * Returns the operation that was performed so the caller can log meaningful
 * status. Never throws.
 */
export async function ensureMcpEntry(port: number, host = '127.0.0.1'): Promise<EnsureMcpResult> {
  const expectedUrl = `http://${host}:${port}/mcp`

  // Probe existence + URL.
  const got = await tryClaudeMcpGet(MCP_SERVER_NAME)
  if (got.kind === 'claude_not_installed') {
    return { kind: 'skipped', reason: 'claude_not_installed' }
  }
  if (got.kind === 'found' && got.url === expectedUrl) {
    return { kind: 'noop', reason: 'already_correct' }
  }
  if (got.kind === 'found') {
    // URL mismatch (different port or stale entry). Replace it.
    const removed = await tryClaudeMcpRemove(MCP_SERVER_NAME)
    if (removed.kind === 'failed') {
      return { kind: 'failed', reason: `mcp remove failed: ${removed.reason}` }
    }
    const added = await tryClaudeMcpAdd(MCP_SERVER_NAME, expectedUrl)
    if (added.kind === 'failed') {
      return { kind: 'failed', reason: `mcp add (after remove) failed: ${added.reason}` }
    }
    return { kind: 'replaced' }
  }
  // Not found: add fresh.
  const added = await tryClaudeMcpAdd(MCP_SERVER_NAME, expectedUrl)
  if (added.kind === 'failed') {
    return { kind: 'failed', reason: `mcp add failed: ${added.reason}` }
  }
  return { kind: 'added' }
}

type GetResult =
  | { kind: 'claude_not_installed' }
  | { kind: 'not_found' }
  | { kind: 'found', url: string | null }
  | { kind: 'error', reason: string }

async function tryClaudeMcpGet(name: string): Promise<GetResult> {
  try {
    const { stdout } = await execFileP('claude', ['mcp', 'get', name], { timeout: 5000 })
    // stdout for an existing entry contains a "URL: <url>" line. Parse it.
    const m = /^\s*URL:\s*(\S+)/m.exec(stdout)
    return { kind: 'found', url: m ? m[1] : null }
  }
  catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string, stdout?: string }
    if (e.code === 'ENOENT') return { kind: 'claude_not_installed' }
    const text = `${e.stderr ?? ''}${e.stdout ?? ''}`
    if (/no mcp server found/i.test(text)) return { kind: 'not_found' }
    return { kind: 'error', reason: e.message }
  }
}

async function tryClaudeMcpAdd(name: string, url: string): Promise<{ kind: 'ok' } | { kind: 'failed', reason: string }> {
  try {
    await execFileP(
      'claude',
      ['mcp', 'add', '--scope', 'user', '--transport', 'http', name, url],
      { timeout: 5000 },
    )
    return { kind: 'ok' }
  }
  catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    return { kind: 'failed', reason: (e.stderr ?? e.message).trim().split('\n')[0] }
  }
}

async function tryClaudeMcpRemove(name: string): Promise<{ kind: 'ok' } | { kind: 'failed', reason: string }> {
  try {
    await execFileP('claude', ['mcp', 'remove', name], { timeout: 5000 })
    return { kind: 'ok' }
  }
  catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    return { kind: 'failed', reason: (e.stderr ?? e.message).trim().split('\n')[0] }
  }
}
