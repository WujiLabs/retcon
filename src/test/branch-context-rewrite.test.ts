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

function setBranchContext(db: DB, ctx: unknown[] | null, forkId: string | null = null): void {
  db.prepare('UPDATE sessions SET branch_context_json = ?, branch_context_fork_id = ? WHERE id = ?')
    .run(ctx === null ? null : JSON.stringify(ctx), forkId, SID)
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
    // The release injects per-directive `<retcon-released>` reminder blocks
    // beside the user's message — header + propagation (no LAST FORK-APPLIED
    // since no revisions seeded) + user text. Block ordering: reminder blocks
    // first, user verbatim last.
    const sent = JSON.parse(r!.body.toString('utf8')) as { messages: Array<{ role: string, content: unknown }> }
    expect(sent.messages.length).toBe(1)
    const last = sent.messages[0]
    expect(last.role).toBe('user')
    expect(Array.isArray(last.content)).toBe(true)
    const blocks = last.content as Array<{ type: string, text: string }>
    // First block: the activation header.
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('<retcon-released>')
    expect(blocks[0].text).toContain('A retcon fork that was active has just been released')
    // The user's verbatim text is preserved as the LAST block (unwrapped).
    expect(blocks[blocks.length - 1]).toEqual({ type: 'text', text: 'NEW prompt the human just typed after /rewind' })
    // Combined reminder text covers all directives across the per-directive blocks.
    const allReminder = blocks.filter(b => b.text.includes('<retcon-released')).map(b => b.text).join('\n')
    expect(allReminder).toContain('PROPAGATION')
    // branch_context_json must be cleared so subsequent turns are pass-through.
    expect(getBranchContext(db)).toBeNull()
  })

  it('release path: also fires when claude sends a single-message system-reminder probe', () => {
    // Empirically observed shape after /rewind: claude's first follow-up
    // /v1/messages carries just a `<system-reminder>...</system-reminder>`
    // probe (msgs=1, role=user, body just the reminder). Same release path
    // applies — branch_context can't survive this state divergence, and the
    // `<retcon-released>` reminder gets injected beside the probe text.
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
    const sent = JSON.parse(r!.body.toString('utf8')) as { messages: Array<{ content: unknown }> }
    const blocks = sent.messages[0].content as Array<{ type: string, text: string }>
    expect(blocks[0].text).toContain('<retcon-released>')
  })

  // Fresh-fork skip: the FIRST post-rewind /v1/messages call. branch_context's
  // tail is still the synthetic_user_message (identifiable by the per-fork
  // random token in the `<retcon-active fork-id="tok_...">` opening tag).
  // No extension has happened yet, so branch_context's last asst is the
  // rewound target's response — which may be absent from claude's local view
  // (e.g., post-/compact). The continuity check would false-positive-release;
  // detect the fresh-synthetic tail and skip the check, letting the splice
  // extend branch_context using claude's body as the source of truth.
  //
  // This is the b17275fb pattern (3 healthy rewinds released within 4 minutes
  // each, 5/6/2026): rewind to 4/13 turn, claude /compacted on 5/1 so 4/13
  // asst text isn't in its jsonl, divergence guard misfires.
  it('does NOT release on the first turn after rewind_to even when target asst is absent from claude\'s body', () => {
    // Rewound target's response — NOT in claude's body (simulating post-compact).
    const REWOUND_TARGET_ASST = 'rewound target response from 4/13 (compacted out of claude jsonl)'
    // Synthetic_user_message has the same shape produced by
    // mcp-tools.ts:synthesizeUserMessageWithReminder. The leading text block
    // carries the `<retcon-active fork-id="tok_...">` marker; the matching
    // token is also seeded into branch_context_fork_id below for the
    // exact-equality detection.
    const FORK_ID = 'tok_a3f2c1d4e5b6'
    const SYNTHETIC_USER = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<retcon-active fork-id="${FORK_ID}">\n[system note from retcon proxy — NOT from the user]\nA retcon fork is now active.\n</retcon-active>`,
        },
        { type: 'text', text: 'the user\'s actual prompt' },
      ],
    }
    setBranchContext(db, [
      { role: 'user', content: 'pre-fork u' },
      { role: 'assistant', content: REWOUND_TARGET_ASST },
      SYNTHETIC_USER,
    ], FORK_ID)
    // Claude's body: pre-fork view + the ai_response (the splice's letter
    // answer) + new user prompt. Crucially does NOT contain
    // REWOUND_TARGET_ASST — that text was compacted out of claude's jsonl.
    const claudeBody = [
      { role: 'user', content: 'claude local pre-fork u' },
      { role: 'assistant', content: 'splice response (the AI answered the rewind\'s synthetic user)' },
      { role: 'user', content: 'next real user prompt' },
    ]
    const r = applyBranchContextRewrite(bodyOf(claudeBody), SID, db)
    expect(r).not.toBeNull()
    expect(r!.releasedReason).toBeUndefined() // KEY: no release, fork survives
    expect(getBranchContext(db)).not.toBeNull()
    // Splice extended branch_context with claude's tail
    // [splice_response, next_user] (penultimate-user pivot picks
    // 'claude local pre-fork u' as the pivot, so claude's tail is
    // [splice_response, next_user]).
    const extended = getBranchContext(db)!
    expect(extended.length).toBe(5) // 3 original + 2 appended
    // Tail is no longer the synthetic — subsequent calls' continuity check
    // anchors on claude's own version of the splice response.
    const newTail = extended[extended.length - 1] as { content?: unknown }
    expect((newTail.content as string | undefined) ?? '').toBe('next real user prompt')
  })

  // Collision guard: user content might quote a token-shaped string
  // (e.g., when documenting retcon's design). branch_context_fork_id
  // is the only authoritative source — comparison must be exact-equality
  // against the DB column, not pattern-match over the message text.
  it('fresh-fork detection requires exact match against branch_context_fork_id (not pattern match)', () => {
    const STORED = 'tok_aaaaaaaaaaaa' // this is what retcon issued for this fork
    const QUOTED = 'tok_bbbbbbbbbbbb' // user happens to quote a different token-shaped string
    setBranchContext(db, [
      { role: 'user', content: 'fork u1' },
      { role: 'assistant', content: 'fork asst' },
      // User-content tail quoting <retcon-active fork-id="DIFFERENT_TOKEN">.
      // Pattern-only check would false-match; exact-equality against
      // branch_context_fork_id (which is STORED) means QUOTED ≠ STORED →
      // not detected as synthetic, continuity check runs, divergence found,
      // release fires.
      {
        role: 'user',
        content: [
          { type: 'text', text: `Discussing retcon design: <retcon-active fork-id="${QUOTED}"> example...` },
        ],
      },
    ], STORED)
    const claudeBody = [
      { role: 'user', content: 'unrelated' },
      { role: 'assistant', content: 'unrelated asst' },
      { role: 'user', content: 'next' },
    ]
    const r = applyBranchContextRewrite(bodyOf(claudeBody), SID, db)
    // 'fork asst' is NOT in claude's body → check fires → release.
    // Confirms the user's quoted token didn't false-match the stored one.
    expect(r!.releasedReason).toBe('rewind_or_state_divergence')
  })

  it('release reminder names the last fork-applied turn so the AI can guide the user back', () => {
    // Seed a closed_forkable revision in the same task — this represents the
    // turn where the splice successfully landed and advanced the conversation.
    // findLastForkAppliedTurn picks it up; the reminder text must include
    // the id so the AI can suggest recall/rewind_to/dump_to_file on it.
    const FORK_APPLIED_REV_ID = 'rev-last-fork-applied-1'
    const now = Date.now()
    db.prepare(`
      INSERT INTO revisions (id, task_id, asset_cid, parent_revision_id, classification, stop_reason, sealed_at, created_at)
      VALUES (?, 'task-1', NULL, NULL, 'closed_forkable', 'end_turn', ?, ?)
    `).run(FORK_APPLIED_REV_ID, now, now)

    setBranchContext(db, [
      { role: 'user', content: 'fork u1' },
      { role: 'assistant', content: 'fork asst that won\'t be in claude body' },
      { role: 'user', content: 'fork u2 (synthetic)' },
    ])
    const r = applyBranchContextRewrite(
      bodyOf([{ role: 'user', content: 'NEW prompt after divergence' }]),
      SID,
      db,
    )
    expect(r!.releasedReason).toBe('rewind_or_state_divergence')
    const sent = JSON.parse(r!.body.toString('utf8')) as { messages: Array<{ content: unknown }> }
    const blocks = sent.messages.at(-1)!.content as Array<{ type: string, text: string }>
    // Per-directive split: LAST-FORK-APPLIED-TURN is its own block; check
    // across all `<retcon-released>` blocks (concat).
    const reminder = blocks.filter(b => b.text?.includes('<retcon-released')).map(b => b.text).join('\n')
    expect(reminder).toContain('LAST FORK-APPLIED TURN')
    expect(reminder).toContain(FORK_APPLIED_REV_ID)
    expect(reminder).toContain(`recall(turn_id="${FORK_APPLIED_REV_ID}")`)
    expect(reminder).toContain(`rewind_to(turn_id="${FORK_APPLIED_REV_ID}"`)
  })

  it('release reminder omits LAST FORK-APPLIED TURN section when no forkable revision exists', () => {
    // No revisions seeded in the task — findLastForkAppliedTurn returns null,
    // and the reminder falls back to the generic recall/rewind_to wording.
    setBranchContext(db, [
      { role: 'user', content: 'fork u1' },
      { role: 'assistant', content: 'fork asst' },
      { role: 'user', content: 'fork u2 (synthetic)' },
    ])
    const r = applyBranchContextRewrite(
      bodyOf([{ role: 'user', content: 'NEW prompt' }]),
      SID,
      db,
    )
    expect(r!.releasedReason).toBe('rewind_or_state_divergence')
    const sent = JSON.parse(r!.body.toString('utf8')) as { messages: Array<{ content: unknown }> }
    const blocks = sent.messages.at(-1)!.content as Array<{ type: string, text: string }>
    const reminder = blocks.filter(b => b.text?.includes('<retcon-released')).map(b => b.text).join('\n')
    expect(reminder).not.toContain('LAST FORK-APPLIED TURN')
    expect(reminder).toContain('refork if needed')
  })

  it('release path: array-form user content gets the reminder unshifted, not replaced', () => {
    // claude sometimes sends user content as an array of blocks (e.g.,
    // tool_result + text). Injection must prepend the reminder blocks
    // (one per directive), not overwrite the existing blocks.
    setBranchContext(db, [
      { role: 'user', content: 'forked u' },
      { role: 'assistant', content: 'distinctive forked asst' },
      { role: 'user', content: 'forked u2' },
    ])
    const userContentBlocks = [
      { type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'result' },
      { type: 'text', text: 'follow-up text' },
    ]
    const r = applyBranchContextRewrite(
      bodyOf([{ role: 'user', content: 'unrelated' }, { role: 'user', content: userContentBlocks }]),
      SID,
      db,
    )
    expect(r!.releasedReason).toBe('rewind_or_state_divergence')
    const sent = JSON.parse(r!.body.toString('utf8')) as { messages: Array<{ content: unknown }> }
    const blocks = sent.messages.at(-1)!.content as Array<{ type: string, text?: string, tool_use_id?: string }>
    // No fork applied turn seeded → 2 reminder blocks (header + propagation)
    // unshifted, then the original 2 content blocks (tool_result + text) =
    // 4 total.
    expect(blocks).toHaveLength(4)
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('<retcon-released>')
    expect(blocks[1].type).toBe('text')
    expect(blocks[1].text).toContain('<retcon-released>')
    expect(blocks[1].text).toContain('PROPAGATION')
    // Original blocks preserved at the end.
    expect(blocks[2].type).toBe('tool_result')
    expect(blocks[2].tool_use_id).toBe('toolu_xyz')
    expect(blocks[3].type).toBe('text')
    expect(blocks[3].text).toBe('follow-up text')
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
