// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Spawn a child agent process (claude in v1) with retcon's HTTP proxy URL
// injected via ANTHROPIC_BASE_URL. Inherits the user's stdio so claude is
// fully interactive.
//
// Lifecycle:
//   - retcon SIGINT/SIGTERM → forward to child, wait for child exit, then
//     return so the caller can finish cleanup.
//   - child exits naturally → return its exit code (or 128+sig if killed).
//   - child fails to spawn (ENOENT) → return a special exit code 127 + a
//     human-readable hint pointing at the install URL.

import { spawn } from 'node:child_process'

export interface SpawnAgentResult {
  /** Process exit code or 128+signal. Use as our own exit code. */
  exitCode: number
  /** Human-readable error if spawn failed (ENOENT). undefined on normal exit. */
  spawnError?: string
}

export interface SpawnAgentOptions {
  agent: string
  args: readonly string[]
  baseUrl: string
  /** Override env (defaults to process.env merged with ANTHROPIC_BASE_URL). */
  envOverrides?: Readonly<Record<string, string>>
}

/**
 * Run the agent and wait for it to exit. Forwards SIGINT/SIGTERM from the
 * parent to the child so Ctrl+C cleanly tears down both.
 */
export function spawnAgent(opts: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: opts.baseUrl,
    ...opts.envOverrides,
  }

  return new Promise<SpawnAgentResult>((resolve) => {
    const child = spawn(opts.agent, opts.args as string[], {
      stdio: 'inherit',
      env,
    })

    let settled = false
    const finish = (result: SpawnAgentResult): void => {
      if (settled) return
      settled = true
      // Stop listening to parent signals; we're done.
      process.off('SIGINT', forward)
      process.off('SIGTERM', forward)
      resolve(result)
    }

    // Forward Ctrl+C (and SIGTERM from `retcon stop` etc.) to the child. With
    // stdio:'inherit' the terminal already sends SIGINT to the child's process
    // group too; this is a belt-and-suspenders for the case where retcon got
    // a programmatic signal that wasn't from the terminal.
    const forward = (sig: NodeJS.Signals): void => {
      try { child.kill(sig) }
      catch { /* child may already be exiting */ }
    }
    process.on('SIGINT', forward)
    process.on('SIGTERM', forward)

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        finish({
          exitCode: 127,
          spawnError:
            `${opts.agent} not found on PATH. Install Claude Code: https://docs.anthropic.com/claude-code`,
        })
        return
      }
      finish({ exitCode: 1, spawnError: `failed to spawn ${opts.agent}: ${err.message}` })
    })

    child.on('exit', (code, signal) => {
      if (signal) {
        // Convention: exit 128+signum so callers can distinguish signal exits.
        const sigNum = signalToNumber(signal)
        finish({ exitCode: 128 + sigNum })
        return
      }
      finish({ exitCode: code ?? 0 })
    })
  })
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
}

function signalToNumber(sig: NodeJS.Signals): number {
  return SIGNAL_NUMBERS[sig] ?? 0
}
