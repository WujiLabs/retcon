// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// End-to-end tmux-driven integration test. Spawns the retcon CLI inside a
// detached tmux session, drives interactive Claude Code via send-keys, and
// asserts the LLM actually sees + invokes our `mcp__retcon__*` tools.
//
// Why this exists: a unit test that hits /mcp tools/list with curl gives
// false confidence — Claude Code can connect to an MCP server and STILL
// not expose its tools to the LLM if the response shape doesn't match the
// MCP spec (e.g. a missing `inputSchema` field, which is exactly the bug
// this test was written to catch). The only way to validate "the user can
// actually use fork_list from inside claude" is to drive interactive claude.
//
// Heavily gated. Requires:
//   - RETCON_TEST_INTEGRATION=1 (gates all integration tests in the suite)
//   - tmux on PATH
//   - claude (Claude Code CLI) on PATH
//   - a built dist/cli.js (RETCON_CLI_ENTRY)
//   - a working ANTHROPIC_API_KEY in env (real LLM traffic)
//
// Cost: ~30s wall clock + a few real Claude API calls. Not for unit-test
// speed. Run before tagging a release or after touching anything in cli/
// or mcp-handler.ts / mcp-tools.ts.

import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Probe: is tmux + claude + integration env all set up? If not, skip the
// whole describe block so this test doesn't break local `pnpm test` runs
// for contributors who don't have the full toolchain.
const integrationEnabled = process.env.RETCON_TEST_INTEGRATION === '1'
const tmuxAvailable = (() => {
  const r = spawnSync('which', ['tmux'])
  return r.status === 0
})()
const claudeAvailable = (() => {
  const r = spawnSync('which', ['claude'])
  return r.status === 0
})()

const SHOULD_RUN = integrationEnabled && tmuxAvailable && claudeAvailable
const SESSION = 'retcon-vitest-itest'
const CLI_ENTRY = path.resolve(__dirname, '..', '..', 'dist', 'cli.js')

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' })
}

function pane(): string {
  return tmux('capture-pane', '-t', SESSION, '-p')
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs: number, hint: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(250)
  }
  throw new Error(`timed out waiting ${timeoutMs}ms for: ${hint}\n--- last pane ---\n${pane()}\n--- end ---`)
}

const describeIfRunnable = SHOULD_RUN ? describe : describe.skip

describeIfRunnable('retcon CLI ↔ Claude Code interactive integration (tmux)', () => {
  beforeAll(() => {
    // Make sure no leftover daemon is squatting on 4099 before we start.
    try { execFileSync('retcon', ['stop'], { stdio: 'ignore' }) } catch { /* not running, fine */ }
    // Kill any leftover tmux session from a prior failed run.
    try { tmux('kill-session', '-t', SESSION) } catch { /* none, fine */ }
  })

  afterAll(() => {
    try { tmux('kill-session', '-t', SESSION) } catch { /* fine */ }
    // Leave the daemon running — the user invoked `retcon` for real before
    // running tests; we don't want to take it down. If you want a hermetic
    // teardown, call `retcon stop` here.
  })

  it('claude through retcon → mcp__retcon__* tools exposed AND fork_list invokable', async () => {
    // Launch retcon in a detached tmux session. Wide pane so wrapping doesn't
    // break our pattern matching.
    tmux(
      'new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50',
      `RETCON_CLI_ENTRY=${CLI_ENTRY} retcon`,
    )

    // Wait for claude's interactive UI to render (the "auto mode" status line
    // appears once claude is ready for input).
    await waitFor(
      () => /auto mode/.test(pane()),
      20000,
      'claude interactive UI to render',
    )

    // Single combined prompt: list the tools AND invoke fork_list. We do this
    // in one prompt so we don't fight pane state between two send-keys turns
    // (claude's UI keeps prior responses on screen, which makes "wait for new
    // output" pattern matching brittle when split across tests).
    tmux('send-keys', '-t', SESSION,
      'Do exactly two things in one reply, separated by a blank line: '
      + '(1) list every MCP tool whose name starts with mcp__retcon — one per line, names only; '
      + '(2) call mcp__retcon__fork_list with no arguments and quote the JSON it returned, raw. '
      + 'No other commentary.',
    )
    tmux('send-keys', '-t', SESSION, 'C-m')

    // Wait for both signals: at least one mcp__retcon__ reference AND the
    // fork_list JSON shape.
    await waitFor(
      () => {
        const p = pane()
        return /mcp__retcon__/.test(p)
          && /"total":\s*\d+/.test(p)
          && /"revisions":/.test(p)
      },
      75000,
      'tools list AND fork_list JSON in pane',
    )

    const result = pane()
    // All four fork tools should be referenced.
    expect(result).toMatch(/mcp__retcon__fork_list/)
    expect(result).toMatch(/mcp__retcon__fork_show/)
    expect(result).toMatch(/mcp__retcon__fork_bookmark/)
    expect(result).toMatch(/mcp__retcon__fork_back/)
    // fork_list JSON shape (total is a number, revisions is an array).
    expect(result).toMatch(/"total":\s*\d+/)
    expect(result).toMatch(/"revisions":\s*\[/)
  }, 120000)
})
