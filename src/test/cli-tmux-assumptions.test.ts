// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// "Provable assumptions" suite — codifies the Claude Code behaviors that
// retcon's design depends on. If a future claude update changes one of
// these, this suite fails LOUDLY and we adjust before the change reaches
// users in the form of mysterious silent breakage.
//
// Heavily gated: requires both RETCON_TEST_INTEGRATION=1 AND
// RETCON_TEST_ASSUMPTIONS=1. The integration gate is the existing one
// (provides tmux, claude, real Anthropic API key). The extra
// RETCON_TEST_ASSUMPTIONS gate keeps this suite OUT of every dev cycle —
// run on a weekly cadence or before each release.
//
// Cost: ~2-3 minutes wall clock, a handful of real Anthropic API calls,
// real `/clear` and `/compact` triggers in claude.
//
// ─── ASSUMPTIONS WE DEPEND ON ─────────────────────────────────────────────
//
// HOOKS:
//   H1. SessionStart hook fires on every session lifecycle event:
//       source ∈ {"startup", "resume", "clear", "compact"}.
//   H2. Hook payload format is `{session_id: string, source: string, ...}`.
//   H3. command-type hooks receive the JSON payload on stdin.
//   H4. type:"http" hooks are rejected for SessionStart specifically;
//       command type works.
//   H5. Hook command env includes whatever the spawning process set on
//       the child claude (so process.env.RETCON_BINDING reaches us).
//
// CLI ARGS:
//   A1. `--session-id <not-a-valid-uuid>` is rejected with non-zero exit.
//   A2. `--session-id <uuid> --resume <id>` is rejected (without
//       --fork-session). Error mentions one of the three flags.
//   A3. `--resume <uuid>` accepts a positional id and skips the picker.
//   A4. `--mcp-config <json>` accepts inline JSON.
//   A5. `--settings <json>` accepts inline JSON.
//
// ENV / TRANSPORT:
//   E1. `ANTHROPIC_BASE_URL` redirects /v1/* to the configured upstream.
//   E2. `ANTHROPIC_CUSTOM_HEADERS` adds custom headers (newline-separated
//       `Header: value` pairs).
//
// MCP:
//   M1. tools/list entries with `inputSchema` are exposed to the LLM.
//       Without `inputSchema` they're silently dropped (we discovered
//       this empirically; the integration test catches regressions).
//   M2. claude echoes `Mcp-Session-Id` header on every /mcp request when
//       configured via --mcp-config "headers".
//
// CONVERSATION STRUCTURE:
//   C1. claude's outgoing /v1/messages body has `messages: [...]` array.
//   C2. Tool round-trip pattern: between two consecutive /v1/messages
//       claude appends `[..., asst_tool_use, user_tool_result]` to its
//       body. The penultimate-user-suffix algorithm depends on this.
//   C3. claude's body always ends with the most recent user-side entry
//       (a plain text user message OR a tool_result-content user msg).
//
// RESPONSE FORMAT:
//   R1. stop_reason values in scope: end_turn, tool_use, max_tokens,
//       stop_sequence, refusal. New values default to dangling.
//
// ─── COVERAGE ────────────────────────────────────────────────────────────
//
// Tested below:
//   - A1, A2: direct claude exit-code probes (no retcon involved)
//   - H1 + H2 (clear, compact): real /clear and /compact triggers
//
// Tested in cli-tmux-integration.test.ts (the implementation suite):
//   - H1 (startup, resume), H2 (startup, resume), H3, H5
//   - A3, A4, A5
//   - E2, M1, M2, C1, C2, C3, R1
//
// Not yet tested but worth adding:
//   - H4 (HTTP hook rejection — visible in claude debug log only)
//   - E1 (mismatched upstream — covered by manual smoke, no scripted test)

import { execFileSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const integrationEnabled = process.env.RETCON_TEST_INTEGRATION === '1'
const assumptionsEnabled = process.env.RETCON_TEST_ASSUMPTIONS === '1'
const tmuxAvailable = spawnSync('which', ['tmux']).status === 0
const claudeAvailable = spawnSync('which', ['claude']).status === 0
const sqliteAvailable = spawnSync('which', ['sqlite3']).status === 0

const SHOULD_RUN
  = integrationEnabled && assumptionsEnabled && tmuxAvailable && claudeAvailable && sqliteAvailable
const describeIfRunnable = SHOULD_RUN ? describe : describe.skip

const CLI_ENTRY = path.resolve(__dirname, '..', '..', 'dist', 'cli.js')
const PROXY_DB = path.join(os.homedir(), '.retcon', 'proxy.db')

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' })
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
  throw new Error(`timed out waiting ${timeoutMs}ms for: ${hint}`)
}

const ASSUMPTION_ACTOR = 'asmp'

function cleanAssumptionState(): void {
  try {
    execFileSync('retcon', ['clean', '--actor', ASSUMPTION_ACTOR, '--yes'], { stdio: 'ignore' })
  }
  catch { /* fine */ }
}

describeIfRunnable('Claude Code behavior assumptions (run weekly)', () => {
  beforeAll(() => {
    try {
      execFileSync('retcon', ['stop'], { stdio: 'ignore' })
    }
    catch { /* fine */ }
    cleanAssumptionState()
  })

  afterAll(() => {
    try {
      execFileSync('retcon', ['stop'], { stdio: 'ignore' })
    }
    catch { /* fine */ }
    cleanAssumptionState()
  })

  // ─── A1: --session-id requires UUID format ──────────────────────────────
  it('A1: claude rejects --session-id with a non-UUID value', () => {
    const r = spawnSync('claude', ['--session-id', 'not-a-uuid', '-p', 'hi'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    // Either the exit code is non-zero OR stderr/stdout mentions UUID.
    // We accept "either" because claude's surfacing might shift between
    // exit code and stderr, but never both should be silent.
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const looksRejected = (r.status !== null && r.status !== 0) || /uuid/i.test(output)
    expect(looksRejected).toBe(true)
  }, 15_000)

  // ─── A2: --session-id rejected with --resume ────────────────────────────
  it('A2: claude rejects --session-id together with --resume', () => {
    const validUuid = '11111111-2222-3333-4444-555555555555'
    const r = spawnSync('claude', [
      '--session-id', validUuid,
      '--resume', validUuid,
      '-p', 'hi',
    ], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const exitNonZero = r.status !== null && r.status !== 0
    const errMentionsFlags = /session-id|resume|fork-session/i.test(output)
    expect(exitNonZero).toBe(true)
    expect(errMentionsFlags).toBe(true)
  }, 15_000)

  // ─── H1+H2 (/clear): SessionStart fires with source="clear" ─────────────
  // ─── persistent fork override is cleared on /clear ──────────────────────
  it('H1 (clear) + persistence cleanup: branch_context_json drops to NULL after /clear', async () => {
    const sessionName = 'asmp-clear'
    try {
      tmux('kill-session', '-t', sessionName)
    }
    catch { /* fine */ }

    tmux(
      'new-session', '-d', '-s', sessionName, '-x', '200', '-y', '50',
      `RETCON_CLI_ENTRY=${CLI_ENTRY} retcon --actor ${ASSUMPTION_ACTOR} --effort low`,
    )
    await waitFor(
      () => /auto mode/.test(tmux('capture-pane', '-t', sessionName, '-p')),
      20_000,
      'claude UI render',
    )
    await waitFor(
      () => parseInt(sql(`SELECT COUNT(*) FROM sessions WHERE actor='${ASSUMPTION_ACTOR}'`), 10) > 0,
      20_000,
      'session row',
    )
    const sid = sql(
      `SELECT id FROM sessions WHERE actor='${ASSUMPTION_ACTOR}' ORDER BY created_at DESC LIMIT 1`,
    )
    const taskId = sql(`SELECT task_id FROM sessions WHERE id='${sid}'`)

    // Two warmup turns, then fork_back. Same shape as the persistence test.
    const warmup = async (msg: string, count: number): Promise<void> => {
      tmux('send-keys', '-t', sessionName, msg)
      tmux('send-keys', '-t', sessionName, 'C-m')
      await waitFor(
        () => parseInt(sql(`SELECT COUNT(*) FROM revisions WHERE task_id='${taskId}' AND classification='closed_forkable'`), 10) >= count,
        45_000,
        `closed_forkable >= ${count}`,
      )
    }
    await warmup('Remember the secret word ZEBRA. Reply with just OK.', 1)
    await warmup('Remember the secret word AARDVARK. Reply with just OK.', 2)

    tmux('send-keys', '-t', sessionName,
      'Call mcp__retcon__fork_back with arguments {"n":1, "message":"What is the secret word?"}. '
      + 'Then in your reply, just say DONE.')
    tmux('send-keys', '-t', sessionName, 'C-m')

    await waitFor(
      () => parseInt(sql(`SELECT length(branch_context_json) FROM sessions WHERE id='${sid}'`), 10) > 0,
      90_000,
      'branch_context_json populated',
    )
    const lenBefore = parseInt(
      sql(`SELECT length(branch_context_json) FROM sessions WHERE id='${sid}'`), 10,
    )
    expect(lenBefore).toBeGreaterThan(0)

    // Fire /clear. claude mints a fresh session_id; SessionStart hook fires
    // with source="clear" and our handler clears branch_context_json on the
    // (rebound) session row. Scope the assertion to events tagged by THIS
    // actor — earlier manual runs may have left global events behind.
    tmux('send-keys', '-t', sessionName, '/clear')
    tmux('send-keys', '-t', sessionName, 'C-m')

    await waitFor(
      () => parseInt(sql(
        `SELECT COUNT(*) FROM events `
        + `WHERE topic='session.branch_context_cleared' `
        + `AND json_extract(payload, '$.source') = 'clear' `
        + `AND session_id IN (SELECT id FROM sessions WHERE actor='${ASSUMPTION_ACTOR}')`,
      ), 10) >= 1,
      30_000,
      'session.branch_context_cleared with source=clear (scoped to actor=asmp)',
    )

    // Verify the row's branch_context_json is NULL (whichever row exists
    // for this actor — /clear may have re-keyed the session id).
    const remaining = sql(
      `SELECT IFNULL(branch_context_json, '__NULL__') FROM sessions WHERE actor='${ASSUMPTION_ACTOR}' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(remaining).toBe('__NULL__')

    try {
      tmux('kill-session', '-t', sessionName)
    }
    catch { /* fine */ }
  }, 240_000)

  // ─── H1+H2 (/compact): SessionStart fires with source="compact" ─────────
  // ─── persistent fork override is cleared on /compact ────────────────────
  it('H1 (compact) + persistence cleanup: branch_context_json drops to NULL after /compact', async () => {
    const sessionName = 'asmp-compact'
    try {
      tmux('kill-session', '-t', sessionName)
    }
    catch { /* fine */ }
    cleanAssumptionState()

    tmux(
      'new-session', '-d', '-s', sessionName, '-x', '200', '-y', '50',
      `RETCON_CLI_ENTRY=${CLI_ENTRY} retcon --actor ${ASSUMPTION_ACTOR} --effort low`,
    )
    await waitFor(
      () => /auto mode/.test(tmux('capture-pane', '-t', sessionName, '-p')),
      20_000,
      'claude UI render (compact case)',
    )
    await waitFor(
      () => parseInt(sql(`SELECT COUNT(*) FROM sessions WHERE actor='${ASSUMPTION_ACTOR}'`), 10) > 0,
      20_000,
      'session row (compact case)',
    )
    const sid = sql(
      `SELECT id FROM sessions WHERE actor='${ASSUMPTION_ACTOR}' ORDER BY created_at DESC LIMIT 1`,
    )
    const taskId = sql(`SELECT task_id FROM sessions WHERE id='${sid}'`)

    const warmup = async (msg: string, count: number): Promise<void> => {
      tmux('send-keys', '-t', sessionName, msg)
      tmux('send-keys', '-t', sessionName, 'C-m')
      await waitFor(
        () => parseInt(sql(`SELECT COUNT(*) FROM revisions WHERE task_id='${taskId}' AND classification='closed_forkable'`), 10) >= count,
        45_000,
        `closed_forkable >= ${count}`,
      )
    }
    await warmup('Remember the secret word ZEBRA. Reply with just OK.', 1)
    await warmup('Remember the secret word AARDVARK. Reply with just OK.', 2)

    tmux('send-keys', '-t', sessionName,
      'Call mcp__retcon__fork_back with arguments {"n":1, "message":"What is the secret word?"}. '
      + 'Then in your reply, just say DONE.')
    tmux('send-keys', '-t', sessionName, 'C-m')

    await waitFor(
      () => parseInt(sql(`SELECT length(branch_context_json) FROM sessions WHERE id='${sid}'`), 10) > 0,
      90_000,
      'branch_context_json populated (compact case)',
    )

    // /compact summarizes the conversation locally then fires SessionStart
    // with source="compact". Wall-clock cost: claude needs ~15-25s to
    // produce the summary.
    tmux('send-keys', '-t', sessionName, '/compact')
    tmux('send-keys', '-t', sessionName, 'C-m')

    await waitFor(
      () => parseInt(sql(
        `SELECT COUNT(*) FROM events `
        + `WHERE topic='session.branch_context_cleared' `
        + `AND json_extract(payload, '$.source') = 'compact' `
        + `AND session_id IN (SELECT id FROM sessions WHERE actor='${ASSUMPTION_ACTOR}')`,
      ), 10) >= 1,
      120_000,
      'session.branch_context_cleared with source=compact (scoped to actor=asmp)',
    )

    const remaining = sql(
      `SELECT IFNULL(branch_context_json, '__NULL__') FROM sessions WHERE actor='${ASSUMPTION_ACTOR}' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(remaining).toBe('__NULL__')

    try {
      tmux('kill-session', '-t', sessionName)
    }
    catch { /* fine */ }
  }, 360_000)
})
