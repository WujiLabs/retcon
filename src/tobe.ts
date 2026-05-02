// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Per-session TOBE (To-Be-Executed) context swap.
//
// When the `/fork back` MCP tool is invoked, it writes a pending swap file
// for the relevant session. The next `/v1/messages` request the proxy sees
// for that session reads the file, replaces the request body's `messages`
// array with the pending one, and consumes the file (one-shot).
//
// Fold-in (per G2 in the plan review): when a TOBE is applied, the proxy
// passes the fork_point_revision_id / source_view_id / original_body_cid
// into `proxy.request_received.payload.tobe_applied_from` so projectors
// can resolve the parent at request-time without a separate event.

import fs from 'node:fs'
import path from 'node:path'

/**
 * SR-construction metadata carried via TOBE pending file from the MCP handler
 * (rewind_to or submit_file) to the proxy-handler that consumes the file. The
 * MCP handler computes synthetic display content + R1.id at MCP-call time.
 * proxy-handler emits `fork.forked` after response_completed, deriving
 * tool_use_id from claude's actual sent body (the pre-splice originalBody)
 * which is JSON, not SSE. The RewindMarkerV1 projector then INSERTs the SR
 * row with `synthetic_revision_id`.
 *
 * Optional for backward compat: a TOBE pending file written by an older daemon
 * lacks these fields. proxy-handler logs a warning and skips fork.forked
 * emission — the rewind/submit still applies, just no synthetic departure
 * row materializes for that operation. Pre-1.0 alpha policy.
 *
 * History note: v0.5.0-alpha.0 also stashed `tool_use_id` here, computed at
 * MCP-call time by parsing R1's response body. That was broken because
 * Anthropic responses are SSE+gzip and the parse always failed silently.
 * v0.5.0-alpha.1 derives tool_use_id at proxy-handler time from the
 * originalBody (claude's parsed JSON), which is the same pattern
 * `reconstructForkMessages` uses to read parsed assistant turns.
 */
export interface SyntheticDepartureMeta {
  /** Discriminates which operation produced this TOBE. */
  kind: 'rewind' | 'submit'
  /** target_view_id from fork.back_requested (correlation). */
  target_view_id: string
  /** Pre-generated SR id; same value used for both fork.forked emit and INSERT. */
  synthetic_revision_id: string
  /** R2' display content (varies by kind). */
  synthetic_tool_result_text: string
  /** R3' display content (varies by kind). */
  synthetic_assistant_text: string
  /** The user's `message` arg from rewind_to OR submit_file. */
  synthetic_user_message: string
  /** R1.id — the assistant turn that emitted tool_use(rewind_to | submit_file).
   *  SR.parent_revision_id will be set to this. */
  parent_revision_id: string
  /** Timestamp at MCP-call time. SR.sealed_at uses this. */
  back_requested_at: number
}

export interface TobePending {
  messages: unknown[]
  fork_point_revision_id: string
  source_view_id: string
  /** Optional hint: the TraceId of the fork.back_requested event that wrote this file. */
  fork_back_event_id?: string
  /** SR-construction metadata. Optional for backward compat with v0.4.x TOBE files
   *  written before v0.5.0. Missing → proxy-handler skips fork.forked emit. */
  synthetic?: SyntheticDepartureMeta
}

export interface TobeStore {
  readonly dir: string
  fileFor(sessionId: string): string
  write(sessionId: string, pending: TobePending): void
  /**
   * Read the pending file WITHOUT deleting it. Returns null if none pending
   * or if the file is malformed (caller treats this as no TOBE).
   * The proxy uses peek on dispatch; only commit() after a successful 2xx
   * response so 5xx / abort outcomes keep the fork intent alive for retry.
   */
  peek(sessionId: string): TobePending | null
  /** Delete the pending file. Idempotent. */
  commit(sessionId: string): void
}

export function createTobeStore(dir: string): TobeStore {
  fs.mkdirSync(dir, { recursive: true })

  // Keep session_ids filesystem-safe. In practice these are TraceIds (hex/
  // dashes) but accept any string and strip anything that could traverse.
  function safeName(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_\-.]/g, '_')
  }

  function fileFor(sessionId: string): string {
    return path.join(dir, `tobe_pending-${safeName(sessionId)}.json`)
  }

  function write(sessionId: string, pending: TobePending): void {
    // Atomic write: staging file + rename. Otherwise a concurrent consume()
    // could read a partially flushed file, parse fails silently, and the
    // fork intent is lost.
    const target = fileFor(sessionId)
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(pending))
    fs.renameSync(tmp, target)
  }

  function peek(sessionId: string): TobePending | null {
    const p = fileFor(sessionId)
    let raw: string
    try {
      raw = fs.readFileSync(p, 'utf8')
    }
    catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return null
      throw err
    }
    try {
      return JSON.parse(raw) as TobePending
    }
    catch {
      // Malformed file — delete so it doesn't pin the session. Fork intent
      // is lost, but the user can re-issue fork_back.
      try {
        fs.unlinkSync(p)
      }
      catch {
        /* ignore */
      }
      return null
    }
  }

  function commit(sessionId: string): void {
    try {
      fs.unlinkSync(fileFor(sessionId))
    }
    catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw err
    }
  }

  return { dir, fileFor, write, peek, commit }
}
