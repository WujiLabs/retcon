// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// End-to-end tmux-driven integration test. Spawns the retcon CLI inside a
// detached tmux session, drives interactive Claude Code via send-keys, and
// asserts the LLM actually invokes our `mcp__retcon__*` tools AND fork_back
// reaches the daemon's event log (proves the session-correlation binding
// works).
//
// Why this exists: a unit test that hits /mcp tools/list with curl gives
// false confidence — Claude Code can connect to an MCP server with the wire
// returning data and STILL silently fail because:
//   - tools/list response is missing inputSchema (Apr 28 commit 69f54c1)
//   - /v1/* and /mcp don't share session_id (Apr 28 commit see this commit)
// Both bugs only surface when a real LLM is on the other end + actually
// invokes a fork tool. This test catches both classes.
//
// We assert by querying the daemon's event log directly rather than parsing
// claude's UI: claude's response wrapping varies and tmux capture timing is
// flaky. The event log is the source of truth — fork.back_requested fires
// only when fork_back actually succeeded end-to-end.
//
// Heavily gated. Requires:
//   - RETCON_TEST_INTEGRATION=1 (gates all integration tests in the suite)
//   - tmux on PATH
//   - claude (Claude Code CLI) on PATH
//   - sqlite3 on PATH (for direct DB query)
//   - a built dist/cli.js (RETCON_CLI_ENTRY)
//   - a working ANTHROPIC_API_KEY in env (real LLM traffic)
//
// Cost: ~60-90s wall clock + a handful of real Anthropic API calls.

import { execFileSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const integrationEnabled = process.env.RETCON_TEST_INTEGRATION === '1'
const tmuxAvailable = spawnSync('which', ['tmux']).status === 0
const claudeAvailable = spawnSync('which', ['claude']).status === 0
const sqliteAvailable = spawnSync('which', ['sqlite3']).status === 0

const SHOULD_RUN = integrationEnabled && tmuxAvailable && claudeAvailable && sqliteAvailable
const SESSION = 'retcon-vitest-itest'
const CLI_ENTRY = path.resolve(__dirname, '..', '..', 'dist', 'cli.js')
const PROXY_DB = path.join(os.homedir(), '.retcon', 'proxy.db')

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' })
}

function pane(): string {
  return tmux('capture-pane', '-t', SESSION, '-p')
}

function sql(query: string): string {
  return execFileSync('sqlite3', [PROXY_DB, query], { encoding: 'utf8' }).trim()
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs: number, hint: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(500)
  }
  throw new Error(
    `timed out waiting ${timeoutMs}ms for: ${hint}\n--- last pane ---\n${pane()}\n--- end ---`,
  )
}

const describeIfRunnable = SHOULD_RUN ? describe : describe.skip

describeIfRunnable('retcon CLI ↔ Claude Code interactive integration (tmux)', () => {
  beforeAll(() => {
    try { execFileSync('retcon', ['stop'], { stdio: 'ignore' }) } catch { /* not running */ }
    try { tmux('kill-session', '-t', SESSION) } catch { /* none */ }
  })

  afterAll(() => {
    try { tmux('kill-session', '-t', SESSION) } catch { /* fine */ }
    // Leave the daemon running — caller may have an existing session.
  })

  it('claude through retcon → fork_back actually walks the revision DAG end-to-end', async () => {
    // --effort low for the warmup model: the default (high) burns thinking
    // budget on trivial prompts and the responses come back as max_tokens
    // (classifier marks them dangling_unforkable, fork_back has nothing to
    // target). Low effort still uses the same model but skips deep thinking.
    tmux(
      'new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50',
      `RETCON_CLI_ENTRY=${CLI_ENTRY} retcon --effort low`,
    )

    await waitFor(() => /auto mode/.test(pane()), 20000, 'claude UI render')

    // Wait for the daemon to have minted a session id for this claude.
    // We poll the sessions table rather than parse claude's UI — the UI's
    // text wrapping makes regex matches against the assistant's response
    // brittle (user-prompt text and assistant-response text can match the
    // same regex, producing false positives).
    await waitFor(
      () => sql(`SELECT COUNT(*) FROM sessions WHERE harness='claude-code'`).length > 0,
      20000,
      'claude-code session row to exist',
    )
    const sessionId = sql(
      `SELECT id FROM sessions WHERE harness='claude-code' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(sessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
    const taskId = sql(`SELECT task_id FROM sessions WHERE id='${sessionId}'`)

    // Two warmup turns produce closed_forkable revisions. We wait for the
    // revision count to grow (proves /v1/* traffic landed AND was correlated
    // back to this session — the binding bug this test catches manifests as
    // session.task_id having ZERO associated revisions).
    const warmup = async (msg: string, expectedRevCount: number): Promise<void> => {
      tmux('send-keys', '-t', SESSION, `Reply with EXACTLY one word: ${msg}`)
      tmux('send-keys', '-t', SESSION, 'C-m')
      await waitFor(
        () => parseInt(sql(`SELECT COUNT(*) FROM revisions WHERE task_id='${taskId}' AND classification='closed_forkable'`), 10) >= expectedRevCount,
        45000,
        `closed_forkable revisions >= ${expectedRevCount} after "${msg}"`,
      )
    }
    await warmup('APPLE', 1)
    await warmup('BANANA', 2)

    // Now ask claude to invoke fork_back. Source of truth is the event log:
    // fork.back_requested fires only on successful fork_back (all guards
    // passed, target found, TOBE written).
    tmux('send-keys', '-t', SESSION,
      'Call mcp__retcon__fork_back with arguments {"n":1, "message":"CHERRY"}. '
      + 'Then in your reply, just say DONE.',
    )
    tmux('send-keys', '-t', SESSION, 'C-m')

    await waitFor(
      () => parseInt(sql(`SELECT COUNT(*) FROM events WHERE session_id='${sessionId}' AND topic='fork.back_requested'`), 10) >= 1,
      90000,
      'fork.back_requested event in proxy.db',
    )

    // Verify: fork.back_requested fired AND its payload references our task.
    const forkPayload = sql(
      `SELECT payload FROM events WHERE session_id='${sessionId}' AND topic='fork.back_requested' ORDER BY event_id DESC LIMIT 1`,
    )
    const parsed = JSON.parse(forkPayload) as {
      fork_point_revision_id: string
      target_view_id: string
      task_id: string
    }
    expect(parsed.fork_point_revision_id).toMatch(/^[a-z0-9-]+$/)
    expect(parsed.task_id).toBe(taskId)
  }, 240000)
})
