// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Tool-adoption A/B harness — verifies that claude (Sonnet AND Opus)
// reaches for retcon's MCP tools when asked to do natural-language
// rewind-style operations, WITHOUT explicit "Call mcp__retcon__X with
// arguments..." instructions.
//
// Phase 4 of the v0.4 plan. The empirical signal that drove the v0.4
// rename + USE WHEN descriptions + dual-secret guardrail was: Sonnet
// silently skipped fork_back even when the user explicitly asked to
// rewind, while Opus complied. This suite turns that signal into a
// regression guard: if a future surface change drops the adoption rate,
// this test fails LOUDLY before users notice.
//
// Prompts here are intentionally natural-language. They mention "rewind"
// and "bookmark" as user-intent words, not as mcp__retcon__* tool names.
// The AI has to recognize the intent and reach for the tool itself.
//
// Heavily gated:
//   - RETCON_TEST_INTEGRATION=1 (existing integration gate — provides
//     tmux + claude + sqlite3 + ANTHROPIC_API_KEY)
//   - RETCON_TEST_TOOL_ADOPTION=1 (new — keeps this suite OUT of routine
//     CI; intended for weekly/release cadence with the assumption suite)
//
// Cost: ~3-5 min wall clock, ~10 real Anthropic API calls per model
// tested (warmup + adoption scenario). Two models = ~20 calls total.
//
// What we measure:
//   - rewind_to adoption: warmup conversation, then "rewind to <earlier
//     state>" — assert fork.back_requested event fires.
//   - bookmark adoption: warmup, then "save this spot" — assert
//     fork.bookmark_created event fires.
//   - dump_to_file adoption: warmup, then "let me edit our recent
//     messages" — assert a file appears in ~/.retcon/dumps/.
//
// Source of truth is the event log + filesystem, never claude's UI text
// (UI wrapping varies and tmux capture timing is flaky). The event log
// records ONLY successful tool invocations (failures don't emit), so a
// passing assertion proves the AI called the right tool with valid args.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const integrationEnabled = process.env.RETCON_TEST_INTEGRATION === '1'
const adoptionEnabled = process.env.RETCON_TEST_TOOL_ADOPTION === '1'
const tmuxAvailable = spawnSync('which', ['tmux']).status === 0
const claudeAvailable = spawnSync('which', ['claude']).status === 0
const sqliteAvailable = spawnSync('which', ['sqlite3']).status === 0

const SHOULD_RUN = integrationEnabled
  && adoptionEnabled
  && tmuxAvailable
  && claudeAvailable
  && sqliteAvailable

const CLI_ENTRY = path.resolve(__dirname, '..', '..', 'dist', 'cli.js')
const PROXY_DB = path.join(os.homedir(), '.retcon', 'proxy.db')
const DUMPS_DIR = path.join(os.homedir(), '.retcon', 'dumps')
const ADOPTION_ACTOR = 'adopt'

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8' })
}

function pane(session: string): string {
  return tmux('capture-pane', '-t', session, '-p')
}

function sql(query: string): string {
  return execFileSync('sqlite3', [PROXY_DB, query], { encoding: 'utf8' }).trim()
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  hint: string,
  paneSession?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(500)
  }
  const tail = paneSession ? `\n--- last pane ---\n${pane(paneSession)}\n--- end ---` : ''
  throw new Error(`timed out waiting ${timeoutMs}ms for: ${hint}${tail}`)
}

const describeIfRunnable = SHOULD_RUN ? describe : describe.skip

// Every (scenario × model) combination uses a unique actor suffix. The set
// is enumerated explicitly so cleanup hits all of them (retcon clean uses
// exact-match WHERE actor = ?, not prefix). Add a new scenario? Add it here.
const SCENARIO_SUFFIXES = ['rewind', 'bookmark', 'dump']
const MODELS = ['sonnet', 'opus'] as const
const ALL_ACTORS = SCENARIO_SUFFIXES.flatMap(s => MODELS.map(m => `${ADOPTION_ACTOR}-${s}-${m}`))

function cleanAdoptionState(): void {
  // Wipe every actor combo this suite uses. Without iterating, a stale
  // session from a prior run's `adopt-rewind-sonnet` would persist and
  // make waitForReady's `ORDER BY created_at DESC LIMIT 1` return the
  // OLD session id — every subsequent SQL targets the wrong row.
  for (const actor of ALL_ACTORS) {
    try {
      execFileSync('retcon', ['clean', '--actor', actor, '--yes'], { stdio: 'ignore' })
    }
    catch { /* fine */ }
  }
  try {
    if (fs.existsSync(DUMPS_DIR)) {
      // Sweep stale dumps so a previous run's files don't satisfy the
      // assertion. The daemon's 24h GC would also clear them eventually.
      for (const f of fs.readdirSync(DUMPS_DIR)) {
        try {
          fs.unlinkSync(path.join(DUMPS_DIR, f))
        }
        catch { /* fine */ }
      }
    }
  }
  catch { /* fine */ }
}

/**
 * Spawn a fresh retcon-wrapped claude in a tmux session. Returns the
 * tmux session name (caller is responsible for kill-session in afterEach
 * via cleanup). Each test gets its own session name + actor suffix so
 * they don't interfere when the suite runs in parallel.
 */
function spawnClaude(suffix: string, model: 'sonnet' | 'opus'): string {
  const sessionName = `adopt-${suffix}-${model}`
  try {
    tmux('kill-session', '-t', sessionName)
  }
  catch { /* none */ }
  // --effort low keeps warmup turns from burning thinking budget on
  // trivial prompts. The model's reasoning capability isn't what we're
  // testing — we're testing whether it picks the right tool.
  // claude resolves --model to the latest of that family; this avoids
  // pinning to a specific model id that goes stale.
  //
  // --allowedTools pre-approves the retcon MCP tools + Read/Edit/Write so
  // the interactive permission prompt ("Do you want to proceed?") doesn't
  // block the test. tmux send-keys can't dismiss that UI cleanly. The
  // adoption signal we measure is "did the model REACH for the tool" —
  // approval friction is orthogonal.
  const allowed = [
    'mcp__retcon__recall',
    'mcp__retcon__rewind_to',
    'mcp__retcon__bookmark',
    'mcp__retcon__dump_to_file',
    'mcp__retcon__submit_file',
    'Read', 'Edit', 'Write', 'Glob', 'Grep',
  ].join(',')
  tmux(
    'new-session', '-d', '-s', sessionName, '-x', '200', '-y', '50',
    `RETCON_CLI_ENTRY=${CLI_ENTRY} retcon --actor ${ADOPTION_ACTOR}-${suffix}-${model} --model ${model} --effort low --allowedTools "${allowed}"`,
  )
  return sessionName
}

/** Wait for claude to register an MCP session row (proves the harness is up
 *  AND the daemon is reachable). The earlier `auto mode` regex falsely
 *  matched "auto mode unavailable for this model" on Sonnet, so we drop
 *  the UI text check entirely and rely on the database signal instead. */
async function waitForReady(sessionName: string, actor: string): Promise<{ sessionId: string, taskId: string }> {
  await waitFor(
    () => parseInt(sql(`SELECT COUNT(*) FROM sessions WHERE actor='${actor}'`), 10) > 0,
    45_000,
    `MCP session row for actor=${actor}`,
    sessionName,
  )
  const sessionId = sql(
    `SELECT id FROM sessions WHERE actor='${actor}' ORDER BY created_at DESC LIMIT 1`,
  )
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
    throw new Error(`waitForReady got malformed session_id: ${JSON.stringify(sessionId)}`)
  }
  const taskId = sql(`SELECT task_id FROM sessions WHERE id='${sessionId}'`)
  if (!taskId.startsWith('t_')) {
    throw new Error(`waitForReady got malformed task_id: ${JSON.stringify(taskId)} for session ${sessionId}`)
  }
  return { sessionId, taskId }
}

/** Send a turn through tmux and wait for a NEW closed_forkable revision —
 *  the signal that claude completed a clean conversational reply (stop_
 *  reason=end_turn). We deliberately count `closed_forkable` revisions, not
 *  any `proxy.response_completed`, because claude makes its OWN internal
 *  /v1 calls during startup (max_tokens probe, system-reminder fetches,
 *  context-management edits) that fire response_completed events without
 *  consuming the user's keystrokes. Waiting on those would let `userTurn`
 *  return prematurely; the next send-keys would arrive while claude was
 *  still buffering the current user input, and claude would bundle both
 *  into a single user message — corrupting the test's setup.
 *
 *  Snapshots the closed_forkable count for this session's task BEFORE
 *  send-keys and waits for it to grow. */
async function userTurn(
  sessionName: string,
  taskId: string,
  msg: string,
): Promise<void> {
  const before = parseInt(
    sql(`SELECT COUNT(*) FROM revisions WHERE task_id='${taskId}' AND classification='closed_forkable'`),
    10,
  )
  tmux('send-keys', '-t', sessionName, msg)
  tmux('send-keys', '-t', sessionName, 'C-m')
  await waitFor(
    () => {
      const after = parseInt(
        sql(`SELECT COUNT(*) FROM revisions WHERE task_id='${taskId}' AND classification='closed_forkable'`),
        10,
      )
      return after > before
    },
    90_000,
    `closed_forkable revision for task=${taskId.slice(0, 12)}... after "${msg.slice(0, 40)}..."`,
    sessionName,
  )
}

describeIfRunnable('tool-adoption A/B harness (Sonnet + Opus)', () => {
  beforeAll(() => {
    try {
      execFileSync('retcon', ['stop'], { stdio: 'ignore' })
    }
    catch { /* not running */ }
    cleanAdoptionState()
  })

  afterAll(() => {
    try {
      execFileSync('retcon', ['stop'], { stdio: 'ignore' })
    }
    catch { /* fine */ }
    // RETCON_TEST_KEEP_DATA=1 leaves the proxy.db rows + dumps in place so
    // a developer can sqlite3 the file and verify what actually happened.
    // The next run's beforeAll wipes the state anyway, so this is a one-
    // way debug switch.
    if (process.env.RETCON_TEST_KEEP_DATA !== '1') {
      cleanAdoptionState()
    }
    else {
      process.stderr.write('[adoption-test] RETCON_TEST_KEEP_DATA=1 — preserving DB state\n')
    }
  })

  // The same scenario runs against both models. Failure on either is a
  // regression — adoption parity is the bar. If sonnet starts skipping a
  // tool the next claude release ships, this test catches it.
  for (const model of MODELS) {
    describe(`model=${model}`, () => {
      it('rewind_to: natural-language "rewind" prompt invokes the tool', async () => {
        const session = spawnClaude('rewind', model)
        const actor = `${ADOPTION_ACTOR}-rewind-${model}`
        try {
          const { sessionId, taskId } = await waitForReady(session, actor)
          // Two warmup turns introducing distinguishable secret words.
          await userTurn(session, taskId, 'Remember the secret word ZEBRA. Reply with just OK.')
          await userTurn(session, taskId, 'Remember the secret word AARDVARK. Reply with just OK.')

          // Natural-language rewind. NO mention of mcp__retcon__rewind_to.
          // The AI must recognize "rewind" as the intent and pick the tool.
          tmux('send-keys', '-t', session,
            'I want to rewind back to before I told you the second secret word, '
            + 'and instead ask you to confirm the first secret word. Use whatever '
            + 'tool you have available to make that happen.',
          )
          tmux('send-keys', '-t', session, 'C-m')

          // Source of truth: the fork.back_requested event. The dual-secret
          // flow means the AI has to do TWO calls (rules-return then clean-
          // token submit). Allow generous time for that round-trip + thinking.
          await waitFor(
            () => parseInt(sql(
              `SELECT COUNT(*) FROM events WHERE session_id='${sessionId}' AND topic='fork.back_requested'`,
            ), 10) >= 1,
            120_000,
            `${model} called rewind_to (fork.back_requested event)`,
            session,
          )
          // Belt-and-suspenders: explicit assertion that the count actually
          // grew. If for any reason waitFor returns truthy without the event
          // (e.g. SQL string parse confused, daemon DB swapped mid-test),
          // this expect catches it loudly instead of a silent pass.
          const eventCount = parseInt(
            sql(`SELECT COUNT(*) FROM events WHERE session_id='${sessionId}' AND topic='fork.back_requested'`),
            10,
          )
          process.stderr.write(`[adoption-test ${model}] fork.back_requested count = ${eventCount}\n`)
          expect(eventCount).toBeGreaterThanOrEqual(1)
          // Sanity check: the event payload references this session's task.
          const payload = sql(
            `SELECT payload FROM events WHERE session_id='${sessionId}' AND topic='fork.back_requested' ORDER BY event_id DESC LIMIT 1`,
          )
          const parsed = JSON.parse(payload) as { task_id: string, fork_point_revision_id: string }
          expect(parsed.task_id).toBe(taskId)
          expect(parsed.fork_point_revision_id).toMatch(/^[a-z0-9-]+$/)
        }
        finally {
          // Capture pane content to a file BEFORE killing the tmux session.
          // Lets us inspect what claude actually did (which tools it called,
          // any errors visible in the UI) for a failing run. The file is
          // written under /tmp/ keyed by session name.
          try {
            const captured = pane(session)
            const dumpPath = `/tmp/p4-pane-${session}.txt`
            fs.writeFileSync(dumpPath, captured, { encoding: 'utf8' })
            process.stderr.write(`[adoption-test ${model}] pane → ${dumpPath}\n`)
          }
          catch { /* fine */ }
          try {
            tmux('kill-session', '-t', session)
          }
          catch { /* fine */ }
        }
      }, 240_000)

      it('bookmark: natural-language "save this spot" prompt invokes the tool', async () => {
        const session = spawnClaude('bookmark', model)
        const actor = `${ADOPTION_ACTOR}-bookmark-${model}`
        try {
          const { sessionId, taskId } = await waitForReady(session, actor)
          await userTurn(session, taskId, 'Reply with just OK.')

          tmux('send-keys', '-t', session,
            'Save this spot in our conversation as a bookmark labeled "v1 baseline" '
            + 'so I can return here later. Use the tool you have available.',
          )
          tmux('send-keys', '-t', session, 'C-m')

          await waitFor(
            () => parseInt(sql(
              `SELECT COUNT(*) FROM events WHERE session_id='${sessionId}' AND topic='fork.bookmark_created'`,
            ), 10) >= 1,
            90_000,
            `${model} called bookmark (fork.bookmark_created event)`,
            session,
          )
          const bookmarkCount = parseInt(
            sql(`SELECT COUNT(*) FROM events WHERE session_id='${sessionId}' AND topic='fork.bookmark_created'`),
            10,
          )
          process.stderr.write(`[adoption-test ${model}] fork.bookmark_created count = ${bookmarkCount}\n`)
          expect(bookmarkCount).toBeGreaterThanOrEqual(1)
          const payload = sql(
            `SELECT payload FROM events WHERE session_id='${sessionId}' AND topic='fork.bookmark_created' ORDER BY event_id DESC LIMIT 1`,
          )
          const parsed = JSON.parse(payload) as { label: string | null }
          expect(parsed.label === null || typeof parsed.label === 'string').toBe(true)
        }
        finally {
          // Capture pane content to a file BEFORE killing the tmux session.
          // Lets us inspect what claude actually did (which tools it called,
          // any errors visible in the UI) for a failing run. The file is
          // written under /tmp/ keyed by session name.
          try {
            const captured = pane(session)
            const dumpPath = `/tmp/p4-pane-${session}.txt`
            fs.writeFileSync(dumpPath, captured, { encoding: 'utf8' })
            process.stderr.write(`[adoption-test ${model}] pane → ${dumpPath}\n`)
          }
          catch { /* fine */ }
          try {
            tmux('kill-session', '-t', session)
          }
          catch { /* fine */ }
        }
      }, 180_000)

      it('dump_to_file: "let me edit our messages" prompt produces a dump file', async () => {
        const session = spawnClaude('dump', model)
        const actor = `${ADOPTION_ACTOR}-dump-${model}`
        try {
          const { taskId } = await waitForReady(session, actor)
          // Need >= 2 forkable turns so dump_to_file's no-args default works.
          await userTurn(session, taskId, 'My favorite color is BLUE. Reply with OK.')
          await userTurn(session, taskId, 'Now my favorite is GREEN. Reply with OK.')

          // Snapshot dumps dir size BEFORE the prompt so we detect new files.
          const before = fs.existsSync(DUMPS_DIR)
            ? fs.readdirSync(DUMPS_DIR).filter(f => f.endsWith('.jsonl')).length
            : 0

          tmux('send-keys', '-t', session,
            'I want to inspect our recent messages and possibly edit them before continuing. '
            + 'Use whatever tool you have to dump the conversation to a file. After dumping, '
            + 'just confirm the file path and stop.',
          )
          tmux('send-keys', '-t', session, 'C-m')

          await waitFor(
            () => {
              if (!fs.existsSync(DUMPS_DIR)) return false
              const after = fs.readdirSync(DUMPS_DIR).filter(f => f.endsWith('.jsonl')).length
              return after > before
            },
            120_000,
            `${model} called dump_to_file (new file in ~/.retcon/dumps/)`,
            session,
          )
          const finalDumps = fs.existsSync(DUMPS_DIR)
            ? fs.readdirSync(DUMPS_DIR).filter(f => f.endsWith('.jsonl')).length
            : 0
          process.stderr.write(`[adoption-test ${model}] dumps before=${before} after=${finalDumps}\n`)
          expect(finalDumps).toBeGreaterThan(before)
        }
        finally {
          // Capture pane content to a file BEFORE killing the tmux session.
          // Lets us inspect what claude actually did (which tools it called,
          // any errors visible in the UI) for a failing run. The file is
          // written under /tmp/ keyed by session name.
          try {
            const captured = pane(session)
            const dumpPath = `/tmp/p4-pane-${session}.txt`
            fs.writeFileSync(dumpPath, captured, { encoding: 'utf8' })
            process.stderr.write(`[adoption-test ${model}] pane → ${dumpPath}\n`)
          }
          catch { /* fine */ }
          try {
            tmux('kill-session', '-t', session)
          }
          catch { /* fine */ }
        }
      }, 180_000)
    })
  }
})
