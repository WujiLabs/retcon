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
// passes the fork_point_version_id / source_view_id / original_body_cid
// into `proxy.request_received.payload.tobe_applied_from` so projectors
// can resolve the parent at request-time without a separate event.

import fs from 'node:fs'
import path from 'node:path'

export interface TobePending {
  messages: unknown[]
  fork_point_version_id: string
  source_view_id: string
  /** Optional hint: the TraceId of the fork.back_requested event that wrote this file. */
  fork_back_event_id?: string
}

export interface TobeStore {
  readonly dir: string
  fileFor(sessionId: string): string
  write(sessionId: string, pending: TobePending): void
  /** Read and delete the file in one shot. Returns null if none pending. */
  consume(sessionId: string): TobePending | null
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

  function consume(sessionId: string): TobePending | null {
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
    // Delete BEFORE parsing so a malformed file can't pin the session.
    try { fs.unlinkSync(p) }
    catch { /* already gone — race with a concurrent consume; fine */ }
    try {
      return JSON.parse(raw) as TobePending
    }
    catch {
      return null
    }
  }

  return { dir, fileFor, write, consume }
}
