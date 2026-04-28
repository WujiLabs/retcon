// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// ForkAwaiter — correlates a fork_back MCP tool invocation with the outcome
// of the next TOBE-applied /v1/messages call for the same session.
//
// Why this exists (A-R8 resolution): the user-visible question "did the fork
// actually succeed?" can't be answered synchronously from fork_back because
// Claude Code's tool_use loop blocks until fork_back returns. So the
// outcome has to surface via one of:
//   (a) the next fork_back call for this session (query the event log), or
//   (b) an explicit awaitable future that fork_back can hold on to in
//       non-blocking usage (e.g. a CLI tool, a batch scripter).
//
// This module provides both the waiter primitive (b) and the helper for (a).

import type { DB } from './db.js'

export type ForkOutcomeStatus =
  | 'completed'        // proxy.response_completed with status < 500
  | 'http_error'       // proxy.response_completed with status >= 500
  | 'aborted'          // proxy.response_aborted (client disconnect, upstream stream error)
  | 'upstream_error'   // proxy.upstream_error (couldn't connect)
  | 'in_flight'        // request emitted, no terminal event yet (lastForkOutcome only)
  | 'timeout'          // awaiter timed out before any terminal event fired
  | 'superseded'       // another fork_back replaced this waiter

export interface ForkOutcome {
  status: ForkOutcomeStatus
  /** The Revision id (= request_event_id) that was forked. */
  revision_id?: string
  /** Raw stop_reason from the LLM, if the call completed. */
  stop_reason?: string | null
  /** HTTP status code, for completed or http_error. */
  http_status?: number
  /** Error message, if any terminal carried one. */
  error_message?: string
  /** Fork context (carried from the tobe_applied_from payload). */
  fork_point_revision_id?: string
  source_view_id?: string
}

type Resolver = (outcome: ForkOutcome) => void

export class ForkAwaiter {
  private readonly waiters = new Map<string, { resolve: Resolver, timer: NodeJS.Timeout }>()

  /**
   * Register a waiter for sessionId. Resolves when notify() fires, or after
   * timeoutMs. If another wait() is registered for the same session before
   * the first resolves, the prior waiter resolves with status="superseded".
   */
  wait(sessionId: string, timeoutMs: number): Promise<ForkOutcome> {
    return new Promise<ForkOutcome>((resolve) => {
      const prior = this.waiters.get(sessionId)
      if (prior) {
        clearTimeout(prior.timer)
        this.waiters.delete(sessionId)
        prior.resolve({ status: 'superseded' })
      }
      const timer = setTimeout(() => {
        if (this.waiters.get(sessionId)?.resolve === resolve) {
          this.waiters.delete(sessionId)
          resolve({ status: 'timeout' })
        }
      }, timeoutMs)
      this.waiters.set(sessionId, { resolve, timer })
    })
  }

  /**
   * Deliver an outcome to any current waiter for sessionId. No-op if none.
   * The proxy-handler calls this after emitting a terminal event whose
   * corresponding request_received carried a `tobe_applied_from` field.
   */
  notify(sessionId: string, outcome: ForkOutcome): void {
    const w = this.waiters.get(sessionId)
    if (!w) return
    clearTimeout(w.timer)
    this.waiters.delete(sessionId)
    w.resolve(outcome)
  }

  /** Test helper: is there a waiter registered for this session? */
  hasWaiter(sessionId: string): boolean {
    return this.waiters.has(sessionId)
  }
}

/**
 * Query the event log for the outcome of the most recent TOBE-applied
 * /v1/messages for sessionId. Used by fork_back's "report prior outcome"
 * pattern: when a fresh fork_back arrives, include the prior attempt's
 * result in the tool response so the LLM sees that the last fork failed.
 *
 * Returns null if no TOBE-applied request is found for this session.
 */
export function lastForkOutcome(db: DB, sessionId: string): ForkOutcome | null {
  // Find the most recent request_received event for this session that had
  // a tobe_applied_from field in its payload. Use a LIKE probe on the JSON
  // string; fast enough and avoids a JSON1 dependency.
  const reqRow = db
    .prepare(
      `SELECT event_id, payload FROM events
       WHERE session_id = ? AND topic = 'proxy.request_received'
         AND payload LIKE '%"tobe_applied_from"%'
       ORDER BY event_id DESC LIMIT 1`,
    )
    .get(sessionId) as { event_id: string, payload: string } | undefined
  if (!reqRow) return null

  const reqPayload = JSON.parse(reqRow.payload) as {
    tobe_applied_from?: { fork_point_revision_id: string, source_view_id: string }
  }
  const fork = reqPayload.tobe_applied_from
  const baseOutcome: Pick<ForkOutcome, 'revision_id' | 'fork_point_revision_id' | 'source_view_id'> = {
    revision_id: reqRow.event_id,
    fork_point_revision_id: fork?.fork_point_revision_id,
    source_view_id: fork?.source_view_id,
  }

  // Find the terminal event that references this request_event_id.
  const termRow = db
    .prepare(
      `SELECT topic, payload FROM events
       WHERE session_id = ?
         AND topic IN ('proxy.response_completed','proxy.response_aborted','proxy.upstream_error')
         AND payload LIKE ?
       ORDER BY event_id DESC LIMIT 1`,
    )
    .get(sessionId, `%"request_event_id":"${reqRow.event_id}"%`) as
      | { topic: string, payload: string }
      | undefined

  if (!termRow) {
    // Request emitted but no terminal yet — still in-flight. Callers can
    // distinguish this from `timeout` (awaiter gave up) and decide whether
    // to wait or treat as "prior fork not yet resolved."
    return { ...baseOutcome, status: 'in_flight' }
  }

  const termPayload = JSON.parse(termRow.payload) as {
    status?: number
    stop_reason?: string | null
    reason?: string
    error_message?: string
  }

  if (termRow.topic === 'proxy.response_completed') {
    const s = termPayload.status ?? 0
    return {
      ...baseOutcome,
      status: s >= 500 ? 'http_error' : 'completed',
      http_status: s,
      stop_reason: termPayload.stop_reason ?? null,
    }
  }
  if (termRow.topic === 'proxy.response_aborted') {
    return {
      ...baseOutcome,
      status: 'aborted',
      error_message: termPayload.reason,
    }
  }
  return {
    ...baseOutcome,
    status: 'upstream_error',
    http_status: termPayload.status,
    error_message: termPayload.error_message,
  }
}
