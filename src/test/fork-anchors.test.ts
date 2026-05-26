// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Focused regression coverage for v0.6 fork-anchors bugs that already
// shipped during the cutover. These tests pin behavior the production
// flow depends on but that no other test exercises directly.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type DB, migrate, openDb } from '../db.js'
import {
  acknowledgeRelease,
  findLatestAnchorTokenInToolResults,
  getMostRecentUnacknowledgedRelease,
  insertActiveAnchor,
  markReleased,
} from '../fork-anchors.js'

describe('findLatestAnchorTokenInToolResults — escaped-quote serialization', () => {
  // Regression for commit 15b722e: claude code JSON-stringifies MCP
  // responses into tool_result.content, escaping the inner quotes around
  // the anchor token. The regex must match BOTH raw and backslash-escaped
  // quote forms. A future regex simplification back to plain `="..."`
  // would silently break production splicing — only this test catches it.

  it('matches the raw-quote form (in-process MCP response shape)', () => {
    const messages = [
      { role: 'user', content: 'first' },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'Rewind scheduled. <retcon-anchor token="tok_aaaaaaaaaaaa" />',
          },
        ],
      },
    ]
    const match = findLatestAnchorTokenInToolResults(messages)
    expect(match).not.toBeNull()
    expect(match!.token).toBe('tok_aaaaaaaaaaaa')
  })

  it('matches the escaped-quote form (claude code JSON serialization)', () => {
    // Real production shape — claude code wraps the tool_result content
    // as JSON, escaping inner quotes to \"
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: 'Rewind scheduled. <retcon-anchor token=\\"tok_bbbbbbbbbbbb\\" />',
          },
        ],
      },
    ]
    const match = findLatestAnchorTokenInToolResults(messages)
    expect(match).not.toBeNull()
    expect(match!.token).toBe('tok_bbbbbbbbbbbb')
  })

  it('matches when tool_result.content is an array of content blocks', () => {
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_3',
            content: [
              { type: 'text', text: 'Submit scheduled. <retcon-anchor token="tok_cccccccccccc" />' },
            ],
          },
        ],
      },
    ]
    const match = findLatestAnchorTokenInToolResults(messages)
    expect(match).not.toBeNull()
    expect(match!.token).toBe('tok_cccccccccccc')
  })

  it('ignores anchor-like text in plain user content (not tool_result)', () => {
    // Anti-false-positive: a user pasting "<retcon-anchor token=tok_..." into
    // their own message must NOT trigger splice.
    const messages = [
      {
        role: 'user',
        content: 'I saw <retcon-anchor token="tok_dddddddddddd" /> in the logs',
      },
    ]
    expect(findLatestAnchorTokenInToolResults(messages)).toBeNull()
  })

  it('returns the LATEST anchor when multiple tool_results carry tokens', () => {
    // Cascade fork: nested rewinds leave older anchors in body too. The
    // most-recent wins (semantics required by the splice).
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_4', content: '<retcon-anchor token="tok_111111111111" />' },
        ],
      },
      { role: 'assistant', content: 'ok' },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_5', content: '<retcon-anchor token="tok_222222222222" />' },
        ],
      },
    ]
    const match = findLatestAnchorTokenInToolResults(messages)
    expect(match!.token).toBe('tok_222222222222')
  })
})

describe('acknowledgeRelease — ack mutes persistent reminder', () => {
  // Regression: the <retcon-released> reminder text promises that
  // calling recall(turn_id=...) silences it. acknowledgeRelease() was
  // exported but unwired before commit 362d468. This test pins the
  // ack behavior at the DB layer; cross-module wiring (mcp-tools.ts's
  // recall handler) is exercised by integration tests but the unit-
  // level behavior we own here is "ack flips acknowledged_at from
  // NULL to a timestamp, and getMostRecentUnacknowledgedRelease
  // stops returning the row."
  let db: DB
  beforeEach(() => {
    db = openDb({ path: ':memory:' })
    migrate(db)
    // Seed a session so the FK conceptually holds (no FK in the schema
    // today but matches production shape).
    db.prepare(
      'INSERT INTO sessions (id, task_id, actor, created_at, harness) VALUES (?, ?, ?, ?, ?)',
    ).run('sess-1', 'task-1', 'default', Date.now(), 'claude-code')
    db.prepare('INSERT INTO tasks (id, session_id, created_at) VALUES (?, ?, ?)')
      .run('task-1', 'sess-1', Date.now())
  })
  afterEach(() => db.close())

  it('sets acknowledged_at and removes the row from the unack lookup', async () => {
    insertActiveAnchor(db, {
      anchor_token: 'tok_ackeeeeeeeee',
      session_id: 'sess-1',
      target_messages_json: JSON.stringify([]),
      fork_point_revision_id: 'rev-1',
      source_view_id: 'view-1',
    })
    await markReleased(db, 'tok_ackeeeeeeeee', 'divergence')

    const before = getMostRecentUnacknowledgedRelease(db, 'sess-1')
    expect(before?.anchor_token).toBe('tok_ackeeeeeeeee')

    acknowledgeRelease(db, 'tok_ackeeeeeeeee')

    const after = getMostRecentUnacknowledgedRelease(db, 'sess-1')
    expect(after).toBeNull()

    const row = db
      .prepare('SELECT acknowledged_at FROM fork_anchors WHERE anchor_token=?')
      .get('tok_ackeeeeeeeee') as { acknowledged_at: number | null }
    expect(row.acknowledged_at).toBeTypeOf('number')
  })

  it('is idempotent — re-ack does not throw or overwrite the timestamp', async () => {
    insertActiveAnchor(db, {
      anchor_token: 'tok_idempackack',
      session_id: 'sess-1',
      target_messages_json: JSON.stringify([]),
      fork_point_revision_id: 'rev-1',
      source_view_id: 'view-1',
    })
    await markReleased(db, 'tok_idempackack', 'clear')
    acknowledgeRelease(db, 'tok_idempackack')
    const first = (
      db.prepare('SELECT acknowledged_at FROM fork_anchors WHERE anchor_token=?')
        .get('tok_idempackack') as { acknowledged_at: number }
    ).acknowledged_at
    // Second call is a no-op (WHERE clause guards on acknowledged_at IS NULL).
    acknowledgeRelease(db, 'tok_idempackack')
    const second = (
      db.prepare('SELECT acknowledged_at FROM fork_anchors WHERE anchor_token=?')
        .get('tok_idempackack') as { acknowledged_at: number }
    ).acknowledged_at
    expect(second).toBe(first)
  })
})
