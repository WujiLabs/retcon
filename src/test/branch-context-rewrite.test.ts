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

  it('falls back to branch_context as-is when claude has only one user message', () => {
    setBranchContext(db, [{ role: 'user', content: 'forked-q' }])
    const r = applyBranchContextRewrite(
      bodyOf([{ role: 'user', content: 'forked-q' }]),
      SID,
      db,
    )
    expect(r).not.toBeNull()
    expect(r!.overflow).toBe(false)
    const sent = JSON.parse(r!.body.toString('utf8')) as { messages: unknown[] }
    expect(sent.messages).toEqual([{ role: 'user', content: 'forked-q' }])
  })

  it('does not write when single-user fallback hits (suffix is empty)', () => {
    // userIndices.length < 2 path. messagesToSend = branchContext (no
    // suffix to append), so messagesToSend.length === prev. The
    // `length > prev` guard skips the write.
    setBranchContext(db, [
      { role: 'user', content: 'forked-q' },
      { role: 'assistant', content: 'a' },
    ])
    applyBranchContextRewrite(
      bodyOf([{ role: 'user', content: 'forked-q' }]),
      SID,
      db,
    )
    expect(getBranchContext(db)).toHaveLength(2)
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
