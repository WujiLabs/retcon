// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unit coverage for applyBranchContextRewrite — the penultimate-user
// suffix-splice algorithm that powers persistent fork. Previously this
// was only exercised by the gated tmux integration suite (needs claude +
// API key); subtle regressions in user-index calculation or idempotent
// writeback would pass every PR test and only break in production.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type DB, migrate, openDb } from '../db.js'
import {
  applyBranchContextRewrite,
  BRANCH_CONTEXT_MAX_BYTES,
} from '../proxy-handler.js'

const SID = 'sess-1'

function bodyOf(messages: unknown[], extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ model: 'm', ...extra, messages }), 'utf8')
}

function setBranchContext(db: DB, ctx: unknown[] | null): void {
  db.prepare('UPDATE sessions SET branch_context_json = ? WHERE id = ?')
    .run(ctx === null ? null : JSON.stringify(ctx), SID)
}

function getBranchContext(db: DB): unknown[] | null {
  const row = db.prepare('SELECT branch_context_json FROM sessions WHERE id = ?')
    .get(SID) as { branch_context_json: string | null } | undefined
  if (!row?.branch_context_json) return null
  return JSON.parse(row.branch_context_json) as unknown[]
}

describe('applyBranchContextRewrite', () => {
  let db: DB
  beforeEach(() => {
    db = openDb({ path: ':memory:' })
    migrate(db)
    db.prepare(
      'INSERT INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)',
    ).run(SID, 'task-1', 'default', Date.now(), 'claude-code')
  })
  afterEach(() => db.close())

  it('returns null passthrough when branch_context_json is unset', () => {
    const r = applyBranchContextRewrite(
      bodyOf([{ role: 'user', content: 'hi' }]),
      SID,
      db,
    )
    expect(r).toBeNull()
  })

  it('returns null when branch_context_json is malformed', () => {
    db.prepare('UPDATE sessions SET branch_context_json = ? WHERE id = ?')
      .run('not-json', SID)
    const r = applyBranchContextRewrite(
      bodyOf([{ role: 'user', content: 'q' }]),
      SID,
      db,
    )
    expect(r).toBeNull()
  })

  it('returns null when claude\'s body is unparseable', () => {
    setBranchContext(db, [{ role: 'user', content: 'forked' }])
    const r = applyBranchContextRewrite(
      Buffer.from('not-json', 'utf8'),
      SID,
      db,
    )
    expect(r).toBeNull()
  })

  it('splices the suffix after penultimate-user (single-assistant case)', () => {
    setBranchContext(db, [{ role: 'user', content: 'forked-q' }])
    const claudeMessages = [
      { role: 'user', content: 'forked-q' },
      { role: 'assistant', content: 'forked-a' },
      { role: 'user', content: 'follow-up' },
    ]
    const r = applyBranchContextRewrite(bodyOf(claudeMessages), SID, db)
    expect(r).not.toBeNull()
    expect(r!.overflow).toBe(false)
    const sent = JSON.parse(r!.body.toString('utf8')) as { messages: unknown[] }
    expect(sent.messages).toEqual([
      { role: 'user', content: 'forked-q' },
      { role: 'assistant', content: 'forked-a' },
      { role: 'user', content: 'follow-up' },
    ])
    expect(getBranchContext(db)).toEqual(sent.messages)
  })

  it('handles tool round-trip mid-turn (penultimate-user is the tool_result)', () => {
    // After the first /v1/messages post-fork, branch_context has been
    // extended to include the asst tool_use + user tool_result pair.
    setBranchContext(db, [
      { role: 'user', content: 'forked-q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'X' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
    ])
    // Claude now sends the body for the next turn: the model's final_text
    // response landed locally and the user typed something new.
    const claudeMessages = [
      { role: 'user', content: 'forked-q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'X' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
      { role: 'assistant', content: 'final' },
      { role: 'user', content: 'next' },
    ]
    const r = applyBranchContextRewrite(bodyOf(claudeMessages), SID, db)
    expect(r).not.toBeNull()
    expect(r!.overflow).toBe(false)
    const sent = JSON.parse(r!.body.toString('utf8')) as { messages: unknown[] }
    // Penultimate user is the tool_result (index 2). Suffix is
    // [final, next], appended to the 3-entry branchContext.
    expect(sent.messages).toEqual(claudeMessages)
    expect(getBranchContext(db)).toEqual(claudeMessages)
  })

  it('releases the fork when claude\'s body has fewer than 2 user messages', () => {
    // The "<2 users" path used to send branch_context as-is, which broke
    // claude code's `/rewind` slash command: claude truncates its local
    // jsonl without notifying retcon, the next /v1/messages has just the
    // user's new prompt, and retcon would dump branch_context (ending in
    // user) as the upstream payload — the AI would respond to the OLD
    // synthetic user message instead of what the human actually typed,
    // silently. New behavior: NULL branch_context_json, signal the caller
    // to pass-through claude's body unchanged, and emit an audit row.
    setBranchContext(db, [
      { role: 'user', content: 'old fork user prompt' },
      { role: 'assistant', content: 'old assistant response' },
      { role: 'user', content: 'old synthetic user from prior rewind' },
    ])
    const r = applyBranchContextRewrite(
      bodyOf([{ role: 'user', content: 'NEW prompt the human just typed after /rewind' }]),
      SID,
      db,
    )
    expect(r).not.toBeNull()
    expect(r!.overflow).toBe(false)
    expect(r!.releasedReason).toBe('rewind_or_state_divergence')
    // body should be the empty-buffer signal — caller forwards claude's body
    // unchanged (we don't rewrite when releasing).
    expect(r!.body.length).toBe(0)
    // branch_context_json must be cleared so subsequent turns are pass-through.
    expect(getBranchContext(db)).toBeNull()
  })

  it('release path: also fires when claude sends a single-message system-reminder probe', () => {
    // Empirically observed shape after /rewind: claude's first follow-up
    // /v1/messages carries just a `<system-reminder>...</system-reminder>`
    // probe (msgs=1, role=user, body just the reminder). Same release path
    // applies — branch_context can't survive this state divergence.
    setBranchContext(db, [
      { role: 'user', content: 'fork user prompt' },
      { role: 'assistant', content: 'fork asst' },
      { role: 'user', content: 'fork user 2' },
    ])
    const r = applyBranchContextRewrite(
      bodyOf([{ role: 'user', content: '<system-reminder>\n## Auto Mode Active\n</system-reminder>\n' }]),
      SID,
      db,
    )
    expect(r!.releasedReason).toBe('rewind_or_state_divergence')
    expect(getBranchContext(db)).toBeNull()
  })

  // Sanity: in normal post-rewind operation, branch_context's last
  // assistant message text appears in claude's body (claude assembles
  // every upstream response into its local jsonl as an assistant turn).
  // The asst-text continuity check passes; the splice proceeds via the
  // penultimate-user pivot. Note that branch_context's tail USER (the
  // synthetic_user_message) does NOT appear in claude's body — that's
  // expected and the check intentionally pivots on assistant, not user.
  it('does NOT release when branch_context\'s last asst text appears in claude\'s body (normal post-rewind)', () => {
    const FORK_ASST_TEXT = 'distinctive forked assistant response that anchors continuity'
    setBranchContext(db, [
      { role: 'user', content: 'fork u1' },
      { role: 'assistant', content: FORK_ASST_TEXT },
      { role: 'user', content: 'SYNTHETIC_USER (invisible to claude)' },
    ])
    // claude's body has the FORK_ASST_TEXT in it (claude received that
    // text as a response to a prior splice and added it to its jsonl).
    const claudeBody = [
      { role: 'user', content: 'claude_user_1' },
      { role: 'assistant', content: FORK_ASST_TEXT },
      { role: 'user', content: 'claude_user_LATEST' },
      { role: 'assistant', content: 'asst_response_to_synthetic' },
      { role: 'user', content: 'human types this next' },
    ]
    const r = applyBranchContextRewrite(bodyOf(claudeBody), SID, db)
    expect(r).not.toBeNull()
    expect(r!.releasedReason).toBeUndefined()
    expect(getBranchContext(db)).not.toBeNull()
    // Splice extends branch_context by [asst_response_to_synthetic, new_user].
    expect(getBranchContext(db)!.length).toBe(5)
  })

  // The general /rewind detection: branch_context's last asst text is
  // missing from claude's body. Catches both early-conversation /rewinds
  // (claude's body too short) AND long-conversation /rewinds (claude's
  // body still has plenty of users but the post-fork asst content got
  // truncated).
  it('releases the fork when branch_context\'s last asst text is missing from claude\'s body (long-conv /rewind)', () => {
    const FORK_ASST_TEXT = 'an assistant response that the fork carries forward'
    setBranchContext(db, [
      { role: 'user', content: 'pre-fork user' },
      { role: 'assistant', content: 'pre-fork asst' },
      { role: 'user', content: 'fork user 1' },
      { role: 'assistant', content: FORK_ASST_TEXT },
      { role: 'user', content: 'fork user 2 (synthetic)' },
    ])
    // After /rewind, claude's body has many user messages (long conversation
    // pre-fork) but FORK_ASST_TEXT is gone — truncated past it.
    const claudeBody = [
      { role: 'user', content: 'pre-fork user' },
      { role: 'assistant', content: 'pre-fork asst' },
      { role: 'user', content: 'old user 2' },
      { role: 'assistant', content: 'old asst 2' },
      { role: 'user', content: 'old user 3' },
      { role: 'assistant', content: 'old asst 3' },
      { role: 'user', content: 'NEW prompt after /rewind' },
    ]
    const r = applyBranchContextRewrite(bodyOf(claudeBody), SID, db)
    expect(r!.releasedReason).toBe('rewind_or_state_divergence')
    expect(getBranchContext(db)).toBeNull()
  })

  // Edge case: branch_context has no assistant message at all (rare —
  // happens only when reconstructForkMessages falls back to target's
  // own body, which doesn't include the target's asst response). No
  // continuity to check; we trust the fork and don't release.
  it('skips the asst-text check when branch_context has no assistant message', () => {
    setBranchContext(db, [
      { role: 'user', content: 'only user, no asst here' },
    ])
    const claudeBody = [
      { role: 'user', content: 'pre' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'newest' },
    ]
    const r = applyBranchContextRewrite(bodyOf(claudeBody), SID, db)
    expect(r).not.toBeNull()
    expect(r!.releasedReason).toBeUndefined()
  })

  // Edge case: claude's body has < 2 user messages but the asst-text check
  // PASSED (or no asst in branch_context to check). This is a probe-shaped
  // turn (e.g., resumed-session startup probe). Pass through claude's body
  // unchanged; don't release. branch_context preserved for the next real turn.
  it('passes through (does NOT release) when claude\'s body has only 1 user and no continuity divergence', () => {
    setBranchContext(db, [
      // No assistant — skips the divergence check entirely.
      { role: 'user', content: 'only user' },
    ])
    const claudeBody = [
      { role: 'user', content: 'startup probe' },
    ]
    const r = applyBranchContextRewrite(bodyOf(claudeBody), SID, db)
    // null = pass-through (no rewrite, no release)
    expect(r).toBeNull()
    expect(getBranchContext(db)).not.toBeNull()
  })

  it('overflow at the 8 MiB cap: NULLs the column and returns overflow=true', () => {
    // Build a branch context whose JSON encoding alone is at the cap.
    // The function reads it back fine (no read-time check), but the
    // concat with claude's suffix pushes the new JSON well past the cap.
    const bigStr = 'x'.repeat(BRANCH_CONTEXT_MAX_BYTES)
    setBranchContext(db, [{ role: 'user', content: bigStr }])

    const claudeMessages = [
      { role: 'user', content: bigStr },
      { role: 'assistant', content: 'a-response' },
      { role: 'user', content: 'follow-up' },
    ]
    const r = applyBranchContextRewrite(bodyOf(claudeMessages), SID, db)
    expect(r).not.toBeNull()
    expect(r!.overflow).toBe(true)
    expect(getBranchContext(db)).toBeNull()
  })
})
