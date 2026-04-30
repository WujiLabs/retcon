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
//   C4. /compact's summarization is a regular /v1/messages call to
//       ANTHROPIC_BASE_URL whose `messages[]` is the existing
//       conversation with a user-role "summarize..." instruction
//       APPENDED at the tail. Empirically verified 2026-04-29: 5
//       entries, last is a 5.7KB user message starting "CRITICAL:
//       Respond with TEXT ONLY... create a detailed summary...".
//       This is what makes /compact's summary represent the forked
//       branch (our branch_context_json applies to it like any other
//       /v1/messages). See ARCHITECTURE.md §6.
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
//   - C4: /compact summarization shape (proxied + appended-user)
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

    // Two warmup turns, then rewind_to. Same shape as the persistence test.
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
      'Call mcp__retcon__rewind_to with arguments {"turn_back_n":1, "message":"What is the secret word?"}. '
      + 'It will return status:rules_returned + a confirm_clean token. '
      + 'Re-call mcp__retcon__rewind_to with the SAME arguments PLUS '
      + 'confirm=<the confirm_clean value from the first response>. '
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
      'Call mcp__retcon__rewind_to with arguments {"turn_back_n":1, "message":"What is the secret word?"}. '
      + 'It will return status:rules_returned + a confirm_clean token. '
      + 'Re-call mcp__retcon__rewind_to with the SAME arguments PLUS '
      + 'confirm=<the confirm_clean value from the first response>. '
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

  // ─── /compact summarization ROUTES THROUGH ANTHROPIC_BASE_URL ───────────
  // ─── and uses the existing messages[] + appended "summarize" user msg ──
  //
  // Two halves to this assumption (both load-bearing for the persistent
  // fork story per ARCHITECTURE.md §6):
  //   (a) /compact's summarization is a regular /v1/messages call to
  //       ANTHROPIC_BASE_URL (not a side-channel endpoint). Our proxy
  //       sees it.
  //   (b) The shape of that call is the existing conversation `messages[]`
  //       with a "summarize..." user-role message APPENDED to the tail.
  //       Not a one-shot prompt built from scratch.
  //
  // (a) is what makes our branch_context_json override apply to the
  // summarization call. (b) is what makes the splice algorithm produce
  // the right thing — the appended user instruction becomes the new
  // last-user message, the existing tail becomes everything-after-
  // penultimate-user, and our branch_context replaces the conversation
  // prefix that gets summarized. Together they're why post-compact
  // claude's local view is aligned with our forked branch (see
  // ARCHITECTURE.md §6).
  //
  // Empirically verified 2026-04-29: the compact request body had 5
  // entries, the last being a 5.7KB user-role "CRITICAL: Respond with
  // TEXT ONLY... create a detailed summary..." instruction.
  it('compaction is messages[]+appended-user-summarize, NOT a side-channel call', async () => {
    const sessionName = 'asmp-compact-shape'
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
      'claude UI render (compact-shape case)',
    )
    await waitFor(
      () => parseInt(sql(`SELECT COUNT(*) FROM sessions WHERE actor='${ASSUMPTION_ACTOR}'`), 10) > 0,
      20_000,
      'session row (compact-shape case)',
    )
    const sid = sql(
      `SELECT id FROM sessions WHERE actor='${ASSUMPTION_ACTOR}' ORDER BY created_at DESC LIMIT 1`,
    )
    const taskId = sql(`SELECT task_id FROM sessions WHERE id='${sid}'`)

    // Two warmup turns to give the compactor something to work with.
    const warmup = async (msg: string, count: number): Promise<void> => {
      tmux('send-keys', '-t', sessionName, msg)
      tmux('send-keys', '-t', sessionName, 'C-m')
      await waitFor(
        () => parseInt(sql(`SELECT COUNT(*) FROM revisions WHERE task_id='${taskId}' AND classification='closed_forkable'`), 10) >= count,
        45_000,
        `closed_forkable >= ${count}`,
      )
    }
    await warmup('Say only the word ALPHA, nothing else.', 1)
    await warmup('Say only the word BETA, nothing else.', 2)

    // Snapshot the current request count so we can identify the compact call.
    const beforeCount = parseInt(
      sql(`SELECT COUNT(*) FROM events WHERE topic='proxy.request_received' AND session_id='${sid}'`),
      10,
    )

    // Trigger /compact.
    tmux('send-keys', '-t', sessionName, '/compact')
    tmux('send-keys', '-t', sessionName, 'C-m')

    // Half (a): wait for AT LEAST ONE additional /v1/messages event under
    // this session. If claude starts using a side-channel endpoint, our
    // event count won't grow and we'll time out here.
    //
    // We deliberately don't wait for `session.branch_context_cleared` —
    // that event only fires when branch_context_json was non-NULL at
    // hook time, and this test doesn't run a rewind_to. The H1 (compact)
    // test above covers the cleared-event side; this one isolates the
    // summarization-shape assumption.
    await waitFor(
      () => parseInt(sql(
        `SELECT COUNT(*) FROM events WHERE topic='proxy.request_received' AND session_id='${sid}'`,
      ), 10) > beforeCount,
      120_000,
      'compact summarization /v1/messages routed through proxy',
    )
    // Give the body's blob row time to land (events.emit writes blob +
    // event in one tx, so this is usually instant, but the projection
    // dispatch sometimes follows a beat behind).
    await sleep(500)

    // Half (b): inspect the body of the compact request. Pull the LAST
    // request_received event from this session (which is the compact call,
    // since the warmups happened before our beforeCount snapshot). Its
    // body_cid points at a top blob whose `messages[]` is an array of
    // CID-typed link entries. The LAST link should resolve to a user-role
    // message containing "summary" / "summarize" in the content.
    //
    // We use raw sqlite3 on the blobs table here — sniffing the dag-json
    // shape via JSON-shaped substrings, since the test runs in a node
    // process that doesn't have @ipld/dag-json transitively available.
    const compactBodyCid = sql(
      `SELECT json_extract(payload, '$.body_cid') FROM events `
      + `WHERE topic='proxy.request_received' AND session_id='${sid}' `
      + `ORDER BY event_id DESC LIMIT 1`,
    )
    expect(compactBodyCid).toBeTruthy()

    // dag-json bytes are valid JSON at the text level — links are
    // {"/":"cidstring"} objects which JSON.parse can read directly. Pull
    // the top blob, parse, navigate to messages[], take the LAST entry's
    // CID (that's the summarize instruction; everything before it is the
    // existing conversation prefix).
    const tmpTop = `/tmp/asmp-compact-top-${process.pid}.bin`
    sql(`SELECT writefile('${tmpTop}', bytes) FROM blobs WHERE cid='${compactBodyCid}'`)
    const topBytes = execFileSync('cat', [tmpTop], { encoding: 'utf8' })
    const topParsed = JSON.parse(topBytes) as {
      messages?: Array<{ '/'?: string }>
    }
    expect(Array.isArray(topParsed.messages)).toBe(true)
    expect(topParsed.messages!.length).toBeGreaterThan(0)
    const lastEntry = topParsed.messages![topParsed.messages!.length - 1]
    const lastLeafCid = lastEntry['/']
    expect(lastLeafCid).toBeTruthy()

    const tmpLeaf = `/tmp/asmp-compact-leaf-${process.pid}.bin`
    sql(`SELECT writefile('${tmpLeaf}', bytes) FROM blobs WHERE cid='${lastLeafCid}'`)
    const leafBytes = execFileSync('cat', [tmpLeaf], { encoding: 'utf8' })

    // The summarize instruction's text varies by claude version, so
    // match LOOSELY: it's a user-role message and contains either
    // "summarize" or "summary" or "<analysis>" markers.
    expect(leafBytes).toMatch(/"role":"user"/)
    expect(leafBytes).toMatch(/summar(y|ize|isation)|<analysis>/i)

    try {
      execFileSync('rm', ['-f', tmpTop, tmpLeaf])
    }
    catch { /* fine */ }
    try {
      tmux('kill-session', '-t', sessionName)
    }
    catch { /* fine */ }
  }, 360_000)
})
