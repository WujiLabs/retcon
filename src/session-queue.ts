// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Per-session in-flight queue (session sequencing invariant from G2).
//
// Serializes /v1/messages per session id: at most one in-flight request per
// Mcp-Session-Id at any time. Additional requests wait on an async chain.
//
// The queue is in-memory only — if the proxy restarts, it forgets any pending
// work. That's acceptable because the client's HTTP call fails on restart
// anyway; the client re-sends on reconnect.

type Task<T> = () => Promise<T>

export class SessionQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  /**
   * Run `task` after any prior task for `sessionId` completes.
   * Returns a promise that resolves/rejects with `task`'s outcome.
   */
  run<T>(sessionId: string, task: Task<T>): Promise<T> {
    const prior = this.tails.get(sessionId) ?? Promise.resolve()
    const next = prior.then(() => task(), () => task())
    // Keep the chain alive even if a task throws — subsequent queued tasks
    // should still execute; we swallow errors at the chain level but surface
    // them via the returned promise to the caller.
    const settled = next.catch(() => {})
    this.tails.set(sessionId, settled)
    // Clean up the map entry when nothing is pending behind us.
    settled.then(() => {
      if (this.tails.get(sessionId) === settled) this.tails.delete(sessionId)
    })
    return next
  }

  /** Test-only: is any task still queued for this session? */
  hasPending(sessionId: string): boolean {
    return this.tails.has(sessionId)
  }
}
