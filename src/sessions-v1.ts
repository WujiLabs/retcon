// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// sessions_v1 projector — maintains the `sessions` + `tasks` views.
//
// Each session owns exactly one Task (per SDK convention: Tasks have stable
// identity, don't fork). Fork branches are presented via branch_views, not
// by forking the Task.
//
// Orphan sessions: when a /v1/* request arrives with a session id that was
// not bootstrapped by an MCP initialize (e.g. a non-MCP-aware harness), we
// still record it. harness='orphan' flags it for the MCP tools which will
// skip fork operations on orphan sessions.

import crypto from 'node:crypto'
import type { DB } from './db.js'
import type { Event, Projection } from './events.js'

interface McpSessionInitializedPayload {
  mcp_session_id: string
  pid?: number
  harness?: string
}

export class SessionsV1Projector implements Projection {
  readonly id = 'sessions_v1'
  readonly subscribedTopics: ReadonlyArray<string> = [
    'mcp.session_initialized',
    'mcp.session_closed',
    'proxy.request_received',
  ]

  apply(event: Event, tx: DB): void {
    switch (event.topic) {
      case 'mcp.session_initialized':
        this.onMcpInitialized(event as Event<McpSessionInitializedPayload>, tx)
        return
      case 'mcp.session_closed':
        this.onMcpClosed(event, tx)
        return
      case 'proxy.request_received':
        this.onOrphanFallback(event, tx)
    }
  }

  private onMcpInitialized(event: Event<McpSessionInitializedPayload>, tx: DB): void {
    if (!event.sessionId) return
    // Insert session + task as a pair. INSERT OR IGNORE makes the projector
    // idempotent on replay: if sessions_v1's offset gets rewound and the
    // same event replays, we don't create duplicate rows.
    const taskId = this.getOrMintTaskId(event.sessionId, tx)
    tx.prepare(`
      INSERT OR IGNORE INTO sessions (id, task_id, pid, harness, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      event.sessionId,
      taskId,
      event.payload.pid ?? null,
      event.payload.harness ?? 'unknown',
      event.createdAt,
    )
    tx.prepare(`
      INSERT OR IGNORE INTO tasks (id, session_id, name, description, created_at)
      VALUES (?, ?, NULL, NULL, ?)
    `).run(taskId, event.sessionId, event.createdAt)
  }

  private onMcpClosed(event: Event, tx: DB): void {
    if (!event.sessionId) return
    tx.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`)
      .run(event.createdAt, event.sessionId)
  }

  private onOrphanFallback(event: Event, tx: DB): void {
    if (!event.sessionId) return
    const existing = tx.prepare('SELECT 1 FROM sessions WHERE id = ?').get(event.sessionId)
    if (existing) return
    // No MCP initialize saw this session id — bootstrap an orphan row. The
    // fork MCP tools use harness='orphan' to skip features that require an
    // MCP connection.
    const taskId = this.getOrMintTaskId(event.sessionId, tx)
    tx.prepare(`
      INSERT OR IGNORE INTO sessions (id, task_id, harness, created_at)
      VALUES (?, ?, 'orphan', ?)
    `).run(event.sessionId, taskId, event.createdAt)
    tx.prepare(`
      INSERT OR IGNORE INTO tasks (id, session_id, created_at) VALUES (?, ?, ?)
    `).run(taskId, event.sessionId, event.createdAt)
  }

  /**
   * Deterministic task_id for a session id. Using a UUIDv5-style derivation
   * means replay is idempotent: running this projector with the same event
   * sequence produces the same task_id each time, so INSERT OR IGNORE on
   * `tasks(id)` does the right thing.
   */
  private getOrMintTaskId(sessionId: string, tx: DB): string {
    const existing = tx.prepare('SELECT task_id FROM sessions WHERE id = ?').get(sessionId) as
      | { task_id: string }
      | undefined
    if (existing) return existing.task_id
    // Derive deterministically from session id. Hash avoids collision worry
    // across sessions while keeping the value stable across projection rebuilds.
    const hash = crypto.createHash('sha256').update(`task:${sessionId}`).digest('hex')
    return `t_${hash.slice(0, 32)}`
  }
}
