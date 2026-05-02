// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// End-to-end tmux-driven integration test. Spawns the retcon CLI inside a
// detached tmux session, drives interactive Claude Code via send-keys, and
// asserts the LLM actually invokes our `mcp__retcon__*` tools AND rewind_to
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
// only when rewind_to actually succeeded end-to-end.
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

const RESUME_SESSION = `${SESSION}-resume`

// Tag every session this test creates so cleanup is targeted. The same actor
// label is used across both `it` blocks so the resume test can find the
// session created by the new-session test.
const TEST_ACTOR = 'itest'

function cleanItestSessions(): void {
  // The CLI's clean command opens proxy.db directly, so it works whether or
  // not the daemon is running. Best-effort: ignore failures (e.g. proxy.db
  // doesn't exist yet on a fresh dev box).
  try {
    execFileSync('retcon', ['clean', '--actor', TEST_ACTOR, '--yes'], { stdio: 'ignore' })
  }
  catch {
    /* fine */
  }
}

describeIfRunnable('retcon CLI ↔ Claude Code interactive integration (tmux)', () => {
  beforeAll(() => {
    try {
      execFileSync('retcon', ['stop'], { stdio: 'ignore' })
    }
    catch {
      /* not running */
    }
    try {
      tmux('kill-session', '-t', SESSION)
    }
    catch {
      /* none */
    }
    try {
      tmux('kill-session', '-t', RESUME_SESSION)
    }
    catch {
      /* none */
    }
    // Wipe any leftover itest data from a prior killed run so this run starts
    // clean (no spurious counts that mask real assertion regressions).
    cleanItestSessions()
  })

  afterAll(() => {
    try {
      tmux('kill-session', '-t', SESSION)
    }
    catch {
      /* fine */
    }
    try {
      tmux('kill-session', '-t', RESUME_SESSION)
    }
    catch {
      /* fine */
    }
    // Stop the daemon so retcon clean can open the DB without contention,
    // then wipe everything this test created.
    try {
      execFileSync('retcon', ['stop'], { stdio: 'ignore' })
    }
    catch {
      /* fine */
    }
    cleanItestSessions()
  })

  it('claude through retcon → rewind_to actually walks the revision DAG end-to-end', async () => {
    // --effort low for the warmup model: the default (high) burns thinking
    // budget on trivial prompts and the responses come back as max_tokens
    // (classifier marks them dangling_unforkable, rewind_to has nothing to
    // target). Low effort still uses the same model but skips deep thinking.
    tmux(
      'new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50',
      `RETCON_CLI_ENTRY=${CLI_ENTRY} retcon --actor ${TEST_ACTOR} --effort low`,
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
      `SELECT id FROM sessions WHERE harness='claude-code' AND actor='${TEST_ACTOR}' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(sessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
    const taskId = sql(`SELECT task_id FROM sessions WHERE id='${sessionId}'`)
    // Verify --actor flowed through: the session row should be tagged.
    const recordedActor = sql(`SELECT actor FROM sessions WHERE id='${sessionId}'`)
    expect(recordedActor).toBe(TEST_ACTOR)

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

    // Now ask claude to invoke rewind_to. Source of truth is the event log:
    // fork.back_requested fires only on successful rewind_to (all guards
    // passed, target found, TOBE written). Note: rewind_to is two-step —
    // first call returns rules + a confirm token, second call (with the
    // clean_token) does the work. We instruct claude to do both.
    tmux('send-keys', '-t', SESSION,
      'Call mcp__retcon__rewind_to with arguments {"turn_back_n":1, "message":"CHERRY"}. '
      + 'It will return status:rules_returned + a confirm_clean token. '
      + 'Re-call mcp__retcon__rewind_to with the SAME arguments PLUS '
      + 'confirm=<the confirm_clean value from the first response>. '
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

    // v0.5.0-alpha.1: also assert the synthetic departure Revision (SR)
    // pipeline ran end-to-end against real Anthropic SSE+gzip traffic.
    // fork.forked fires after claude's wrap-up /v1/messages closes with
    // stop_reason=end_turn (post-splice). Assertion catches the SSE+gzip
    // blindness bug that v0.5.0-alpha.0 shipped: alpha.0 silently failed to
    // parse R1's response body, never wrote synthetic to TOBE, never
    // emitted fork.forked, never materialized SR rows. alpha.0 unit tests
    // passed because they used uncompressed JSON fixtures.
    try {
      await waitFor(
        () => parseInt(sql(`SELECT COUNT(*) FROM events WHERE session_id='${sessionId}' AND topic='fork.forked'`), 10) >= 1,
        90000,
        'fork.forked event in proxy.db (SR pipeline ran end-to-end against real Anthropic traffic)',
      )
    }
    catch (err) {
      // Surface a richer diagnostic before re-throwing — the default
      // waitFor message captures the pane but not the event log, and the
      // test cleanup wipes the events table on afterAll, so post-mortem
      // SQLite queries can't see what happened.
      const recentForks = sql(
        `SELECT topic || '|' || COALESCE(json_extract(payload, '$.error_message'), '-') `
        + `FROM events WHERE session_id='${sessionId}' AND topic LIKE 'fork.%' ORDER BY event_id`,
      )
      const tobeApplied = sql(
        `SELECT events.event_id || '|cid=' || json_extract(events.payload, '$.tobe_applied_from.original_body_cid') `
        + `|| '|sr=' || COALESCE((SELECT json_extract(rc.payload, '$.stop_reason') FROM events rc `
        + `WHERE rc.topic='proxy.response_completed' AND json_extract(rc.payload, '$.request_event_id')=events.event_id), '?') `
        + `|| '|status=' || COALESCE((SELECT json_extract(rc.payload, '$.status') FROM events rc `
        + `WHERE rc.topic='proxy.response_completed' AND json_extract(rc.payload, '$.request_event_id')=events.event_id), '?') `
        + `FROM events WHERE session_id='${sessionId}' AND topic='proxy.request_received' `
        + `AND json_extract(payload, '$.tobe_applied_from') IS NOT NULL`,
      )
      const recentResponses = sql(
        `SELECT json_extract(payload, '$.status') || '|' || COALESCE(json_extract(payload, '$.stop_reason'), 'null') `
        + `FROM events WHERE session_id='${sessionId}' AND topic='proxy.response_completed' `
        + `ORDER BY event_id DESC LIMIT 5`,
      )
      throw new Error(
        `${(err as Error).message}\n--- diagnostic ---\n`
        + `fork.* events:\n${recentForks || '(none)'}\n`
        + `tobe-applied requests (req_id|cid|stop_reason|status):\n${tobeApplied || '(none — TOBE never consumed)'}\n`
        + `last 5 response_completed (status|stop_reason):\n${recentResponses}\n`
        + `--- end ---`,
      )
    }
    const synthCount = parseInt(
      sql(`SELECT COUNT(*) FROM revisions WHERE task_id='${taskId}' AND stop_reason='rewind_synthetic'`),
      10,
    )
    expect(synthCount).toBeGreaterThanOrEqual(1)
  }, 240000)

  // ─────────────────────────────────────────────────────────────────────────
  // Resume: the test that catches the late-binding bug.
  //
  // claude --resume can't accept --session-id, so retcon mints a binding_token
  // T, hands it to claude via x-playtiss-session header / Mcp-Session-Id, and
  // installs a SessionStart command hook. The hook fires post-pick and posts
  // claude's actual session_id S to the daemon, which rebinds T → S in the
  // DB (merging the binding-token's task into S's pre-existing task and
  // reconnecting the DAG).
  //
  // Failure modes this catches:
  //   - retcon doesn't detect --resume → injects --session-id → claude errors
  //     "--session-id can only be used with --continue or --resume if
  //      --fork-session is also specified"
  //   - SessionStart hook config rejected by claude (we tripped on this once:
  //     v2.1.122 silently drops type:"http" hooks for SessionStart)
  //   - Hook fires but the daemon endpoint doesn't rebind correctly → resumed
  //     session ends up under T, rewind_to can't see the original session's
  //     revisions
  //   - Rebind happens but DAG isn't reconnected → rewind_to targets land
  //     under the binding-token's sub-DAG instead of the original tail
  //
  // We use `--resume <sessionId>` (positional) to bypass the picker UI; the
  // picker is interactive and tmux-driving it is brittle. Picker behavior is
  // covered manually.
  it('claude --resume binds late + rewind_to walks across the resume boundary', async () => {
    // Capture the session created by the prior test. If that test ran first,
    // we have a valid claude-code session row with closed_forkable revisions
    // we can fork back into.
    const originalSessionId = sql(
      `SELECT id FROM sessions WHERE harness='claude-code' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(originalSessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
    const originalTaskId = sql(`SELECT task_id FROM sessions WHERE id='${originalSessionId}'`)

    const preResumeForkable = parseInt(
      sql(`SELECT COUNT(*) FROM revisions WHERE task_id='${originalTaskId}' AND classification='closed_forkable'`),
      10,
    )
    expect(preResumeForkable).toBeGreaterThanOrEqual(2)

    // Kill the prior test's tmux session — its claude process is still
    // running with the original sessionId and would conflict with the
    // resumed claude trying to attach to the same id. Manual reproduction
    // confirmed: leaving SESSION alive while spawning RESUME_SESSION makes
    // the resumed claude swallow user input silently (no error, no prompt
    // delivered). Killing SESSION first matches what a real user would do
    // ("close the original window before resuming elsewhere").
    try {
      tmux('kill-session', '-t', SESSION)
    }
    catch { /* fine if already gone */ }

    // Spawn retcon --resume <id>. Positional id avoids the picker.
    tmux(
      'new-session', '-d', '-s', RESUME_SESSION, '-x', '200', '-y', '50',
      `RETCON_CLI_ENTRY=${CLI_ENTRY} retcon --resume ${originalSessionId} --effort low`,
    )

    await waitFor(
      () => /auto mode/.test(tmux('capture-pane', '-t', RESUME_SESSION, '-p')),
      30000,
      'resumed claude UI render',
    )

    // The SessionStart hook should fire post-resume and emit session.rebound
    // whose payload references our originalSessionId. This is the key invariant:
    // claude's actual session_id (post-resume) equals our pre-resume session_id,
    // and the daemon learned of it via the hook.
    await waitFor(
      () => parseInt(sql(
        `SELECT COUNT(*) FROM events WHERE topic='session.rebound' `
        + `AND json_extract(payload, '$.session_id')='${originalSessionId}'`,
      ), 10) >= 1,
      45000,
      `session.rebound event with session_id=${originalSessionId}`,
    )

    // Sanity: only one row should exist for originalSessionId in sessions
    // (the binding-token row got merged + deleted by rebindSession).
    const sessionRows = parseInt(
      sql(`SELECT COUNT(*) FROM sessions WHERE id='${originalSessionId}'`), 10,
    )
    expect(sessionRows).toBe(1)
    const taskAfterRebind = sql(`SELECT task_id FROM sessions WHERE id='${originalSessionId}'`)
    expect(taskAfterRebind).toBe(originalTaskId)
    // Resume without --actor must inherit the session's existing tag.
    const actorAfterRebind = sql(`SELECT actor FROM sessions WHERE id='${originalSessionId}'`)
    expect(actorAfterRebind).toBe(TEST_ACTOR)

    // Now ask claude to rewind_to. The fork_point_revision_id MUST be a
    // revision from the original task (proves DAG reconnection worked: the
    // resumed session's revisions land under originalTaskId, and the most
    // recent closed_forkable in that task is reachable as a fork target).
    //
    // The first test in this file already left one fork.back_requested event
    // under originalSessionId, so we have to track the delta — assert the
    // count grew after sending our request, not just that it's >= 1.
    const baselineForkBackCount = parseInt(sql(
      `SELECT COUNT(*) FROM events WHERE session_id='${originalSessionId}' `
      + `AND topic='fork.back_requested'`,
    ), 10)

    tmux('send-keys', '-t', RESUME_SESSION,
      'Call mcp__retcon__rewind_to with arguments {"turn_back_n":1, "message":"DURIAN"}. '
      + 'It will return status:rules_returned + a confirm_clean token. '
      + 'Re-call mcp__retcon__rewind_to with the SAME arguments PLUS '
      + 'confirm=<the confirm_clean value from the first response>. '
      + 'Then in your reply, just say DONE.',
    )
    tmux('send-keys', '-t', RESUME_SESSION, 'C-m')

    await waitFor(
      () => parseInt(sql(
        `SELECT COUNT(*) FROM events WHERE session_id='${originalSessionId}' `
        + `AND topic='fork.back_requested'`,
      ), 10) > baselineForkBackCount,
      90000,
      'NEW fork.back_requested event under originalSessionId post-resume',
    )

    const forkPayload = sql(
      `SELECT payload FROM events WHERE session_id='${originalSessionId}' `
      + `AND topic='fork.back_requested' ORDER BY event_id DESC LIMIT 1`,
    )
    const parsed = JSON.parse(forkPayload) as {
      fork_point_revision_id: string
      task_id: string
    }
    expect(parsed.task_id).toBe(originalTaskId)
    // The fork point must be one of the revisions present in the task. This
    // is the assertion that catches "rebind worked but DAG wasn't merged" —
    // if the binding-token's revisions live in a different task, the fork
    // point would not be findable here.
    const forkPointTaskId = sql(
      `SELECT task_id FROM revisions WHERE id='${parsed.fork_point_revision_id}'`,
    )
    expect(forkPointTaskId).toBe(originalTaskId)
  }, 240000)

  // ─────────────────────────────────────────────────────────────────────────
  // Persistent fork: messages AFTER rewind_to continue building on the
  // forked branch instead of reverting to claude's local jsonl history.
  //
  // What this catches: an earlier implementation of rewind_to was one-shot —
  // TOBE swap on the immediate-next /v1/messages, then claude's subsequent
  // turns sent its own (un-forked) history upstream. The forked context
  // disappeared after one turn. With branch_context_json on the session row,
  // every /v1/messages while the branch is active gets rewritten to use the
  // forked context, and each successful response appends back into the
  // context so the conversation persistently continues on the branch.
  //
  // Test design:
  //   1. Start retcon, run two warmup turns introducing TWO different
  //      "secret words" (ZEBRA first, then AARDVARK).
  //   2. Call rewind_to(turn_back_n=1) which rolls back the AARDVARK turn
  //      and asks "What is the secret word?" — model should answer ZEBRA,
  //      the only word in the forked branch's context.
  //   3. Send a follow-up "Tell me again, what is the secret word?" — model
  //      should STILL answer ZEBRA (this is the persistence check; without
  //      branch_context_json it would see AARDVARK in claude's local jsonl
  //      and answer AARDVARK).
  //   4. Kill the tmux session and re-launch with `retcon --resume <id>`.
  //      Ask one more time — should still answer ZEBRA (proves
  //      branch_context_json survives daemon restart and resume binding).
  //
  // We assert via the branch_context_json column on the session row, which
  // accumulates each (user, assistant) pair as turns happen. Counting
  // assistant messages and checking each contains "ZEBRA" but never
  // "AARDVARK" is reliable across model variation in exact wording.
  it('rewind_to persists across multiple turns AND across --resume', async () => {
    const FORK_ACTOR = `${TEST_ACTOR}-persist`
    const FORK_SESSION = 'retcon-vitest-itest-fork'
    const FORK_RESUME_SESSION = 'retcon-vitest-itest-fork-resume'

    // Pre-clean any leftover state from a prior run.
    try {
      execFileSync('retcon', ['clean', '--actor', FORK_ACTOR, '--yes'], { stdio: 'ignore' })
    }
    catch { /* fine */ }
    try {
      tmux('kill-session', '-t', FORK_SESSION)
    }
    catch { /* none */ }
    try {
      tmux('kill-session', '-t', FORK_RESUME_SESSION)
    }
    catch { /* none */ }

    try {
      tmux(
        'new-session', '-d', '-s', FORK_SESSION, '-x', '200', '-y', '50',
        `RETCON_CLI_ENTRY=${CLI_ENTRY} retcon --actor ${FORK_ACTOR} --effort low`,
      )
      await waitFor(
        () => /auto mode/.test(tmux('capture-pane', '-t', FORK_SESSION, '-p')),
        20000,
        'fork-test claude UI render',
      )
      await waitFor(
        () => sql(`SELECT COUNT(*) FROM sessions WHERE actor='${FORK_ACTOR}'`).length > 0,
        20000,
        `${FORK_ACTOR} session row to exist`,
      )
      const sessId = sql(
        `SELECT id FROM sessions WHERE actor='${FORK_ACTOR}' ORDER BY created_at DESC LIMIT 1`,
      )
      expect(sessId).toMatch(/^[a-f0-9-]{36}$/)
      const taskId = sql(`SELECT task_id FROM sessions WHERE id='${sessId}'`)

      // Two warmup turns introducing distinguishable secret words. We assert
      // closed_forkable revision count grows so the fork target exists.
      const warmup = async (msg: string, expectedRevCount: number): Promise<void> => {
        tmux('send-keys', '-t', FORK_SESSION, msg)
        tmux('send-keys', '-t', FORK_SESSION, 'C-m')
        await waitFor(
          () => parseInt(sql(`SELECT COUNT(*) FROM revisions WHERE task_id='${taskId}' AND classification='closed_forkable'`), 10) >= expectedRevCount,
          45000,
          `closed_forkable revisions >= ${expectedRevCount}`,
        )
      }
      await warmup('Remember the secret word ZEBRA. Reply with just OK.', 1)
      await warmup('Remember the secret word AARDVARK. Reply with just OK.', 2)

      // Trigger rewind_to. This:
      //   - rolls back to before AARDVARK was introduced
      //   - sends the new question through the TOBE swap
      //   - sets sessions.branch_context_json so subsequent turns continue
      //     on the forked branch
      tmux('send-keys', '-t', FORK_SESSION,
        'Call mcp__retcon__rewind_to with arguments {"turn_back_n":1, '
        + '"message":"What is the secret word? Reply EXACTLY ONE WORD, no punctuation."}. '
        + 'It will return status:rules_returned + a confirm_clean token. '
        + 'Re-call mcp__retcon__rewind_to with the SAME arguments PLUS '
        + 'confirm=<the confirm_clean value from the first response>. '
        + 'Then in your reply, just say DONE.',
      )
      tmux('send-keys', '-t', FORK_SESSION, 'C-m')

      await waitFor(
        () => parseInt(sql(`SELECT COUNT(*) FROM events WHERE session_id='${sessId}' AND topic='fork.back_requested'`), 10) >= 1,
        90000,
        'fork.back_requested event',
      )
      // After rewind_to fires, sessions.branch_context_json must be populated.
      await waitFor(
        () => parseInt(sql(`SELECT length(branch_context_json) FROM sessions WHERE id='${sessId}'`), 10) > 0,
        10000,
        'branch_context_json populated after rewind_to',
      )

      // Wait for the TOBE-applied response to land (this is the immediate
      // next /v1/messages, where upstream sees the forked context and
      // responds with ZEBRA).
      const ctxAfterTurn1 = parseInt(
        sql(`SELECT length(branch_context_json) FROM sessions WHERE id='${sessId}'`), 10,
      )

      // Persistence check #1: send a follow-up turn. With persistent fork,
      // the daemon rewrites this /v1/messages using branch_context_json,
      // so the model still sees the forked context and answers ZEBRA.
      tmux('send-keys', '-t', FORK_SESSION,
        'Tell me again, what is the secret word? Reply EXACTLY ONE WORD.')
      tmux('send-keys', '-t', FORK_SESSION, 'C-m')

      await waitFor(
        () => {
          const len = parseInt(sql(`SELECT length(branch_context_json) FROM sessions WHERE id='${sessId}'`), 10)
          return len > ctxAfterTurn1
        },
        45000,
        'branch_context_json grows after follow-up turn',
      )

      // The branch_context_json should contain "ZEBRA" in its assistant
      // messages and never "AARDVARK". Use SQLite's instr() — testing JSON
      // shape from shell is awkward.
      const hasZebra = parseInt(
        sql(`SELECT instr(branch_context_json, 'ZEBRA') FROM sessions WHERE id='${sessId}'`), 10,
      )
      const hasAardvark = parseInt(
        sql(`SELECT instr(branch_context_json, 'AARDVARK') FROM sessions WHERE id='${sessId}'`), 10,
      )
      expect(hasZebra).toBeGreaterThan(0)
      // Note: branch_context_json may contain "AARDVARK" if the model
      // happens to mention it in some response (unlikely with our prompts
      // but possible). The key invariant we test below is that the model's
      // ANSWER matches the forked context — which is what proxy-handler
      // sends upstream. We rely on the model + prompt to be consistent.
      expect(hasAardvark).toBe(0)

      // Persistence check #2: kill the tmux session and resume the same
      // session id. branch_context_json is on the DB so it should survive.
      try {
        tmux('kill-session', '-t', FORK_SESSION)
      }
      catch { /* fine */ }
      // Brief pause so the kill propagates before we relaunch.
      await sleep(1500)

      const ctxAfterTurn2 = parseInt(
        sql(`SELECT length(branch_context_json) FROM sessions WHERE id='${sessId}'`), 10,
      )
      tmux(
        'new-session', '-d', '-s', FORK_RESUME_SESSION, '-x', '200', '-y', '50',
        `RETCON_CLI_ENTRY=${CLI_ENTRY} retcon --resume ${sessId} --effort low`,
      )
      await waitFor(
        () => /auto mode/.test(tmux('capture-pane', '-t', FORK_RESUME_SESSION, '-p')),
        30000,
        'resumed claude UI render (fork test)',
      )

      tmux('send-keys', '-t', FORK_RESUME_SESSION,
        'One more time: what is the secret word? Reply EXACTLY ONE WORD.')
      tmux('send-keys', '-t', FORK_RESUME_SESSION, 'C-m')

      await waitFor(
        () => {
          const len = parseInt(sql(`SELECT length(branch_context_json) FROM sessions WHERE id='${sessId}'`), 10)
          return len > ctxAfterTurn2
        },
        60000,
        'branch_context_json grows after post-resume turn',
      )

      // Final assertion: still has ZEBRA, still no AARDVARK.
      const hasZebraFinal = parseInt(
        sql(`SELECT instr(branch_context_json, 'ZEBRA') FROM sessions WHERE id='${sessId}'`), 10,
      )
      const hasAardvarkFinal = parseInt(
        sql(`SELECT instr(branch_context_json, 'AARDVARK') FROM sessions WHERE id='${sessId}'`), 10,
      )
      expect(hasZebraFinal).toBeGreaterThan(0)
      expect(hasAardvarkFinal).toBe(0)
    }
    finally {
      try {
        tmux('kill-session', '-t', FORK_SESSION)
      }
      catch { /* fine */ }
      try {
        tmux('kill-session', '-t', FORK_RESUME_SESSION)
      }
      catch { /* fine */ }
      // Self-clean test data so re-runs start fresh.
      try {
        execFileSync('retcon', ['stop'], { stdio: 'ignore' })
      }
      catch { /* fine */ }
      try {
        execFileSync('retcon', ['clean', '--actor', FORK_ACTOR, '--yes'], { stdio: 'ignore' })
      }
      catch { /* fine */ }
    }
  }, 360000)
})
