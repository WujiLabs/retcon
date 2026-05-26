// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Legacy TobeStore shape for test fixtures that haven't been migrated off the
// v0.5.x TOBE flow. The v0.6 cutover deleted production tobe.ts; this stub
// keeps the type alive so test fixtures still compile. Tests that ACTUALLY
// depend on TOBE-store behavior (write, peek, commit moving files around)
// are marked .skip — they exercise v0.5-specific paths the v0.6 anchor design
// supersedes. Rewriting them to seed fork_anchors directly is a follow-up.
//
// Removal: once all .skip'd tests are either rewritten or pruned, delete this
// file along with the test-side references to it.

import fs from 'node:fs'
import path from 'node:path'

import type { SyntheticDepartureMeta } from '../fork-anchors.js'

export interface TobePending {
  messages: unknown[]
  fork_point_revision_id: string
  source_view_id: string
  fork_back_event_id?: string
  synthetic?: SyntheticDepartureMeta
}

export interface TobeStore {
  readonly dir: string
  fileFor(sessionId: string): string
  write(sessionId: string, pending: TobePending): void
  peek(sessionId: string): TobePending | null
  commit(sessionId: string): void
}

/** In-memory + filesystem-backed stub matching v0.5's TobeStore contract. The
 *  v0.6 proxy-handler does NOT consult this store (uses fork_anchors); the
 *  stub exists purely so legacy test fixtures still compile. */
export function createTobeStore(dir: string): TobeStore {
  fs.mkdirSync(dir, { recursive: true })
  function safeName(sid: string): string {
    return sid.replace(/[^a-zA-Z0-9_-]/g, '_')
  }
  function fileFor(sessionId: string): string {
    return path.join(dir, `tobe_pending-${safeName(sessionId)}.json`)
  }
  return {
    dir,
    fileFor,
    write(sessionId: string, pending: TobePending): void {
      const target = fileFor(sessionId)
      const tmp = `${target}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(pending))
      fs.renameSync(tmp, target)
    },
    peek(sessionId: string): TobePending | null {
      try {
        const data = fs.readFileSync(fileFor(sessionId), 'utf8')
        return JSON.parse(data) as TobePending
      }
      catch {
        return null
      }
    },
    commit(sessionId: string): void {
      try {
        fs.unlinkSync(fileFor(sessionId))
      }
      catch { /* not present, fine */ }
    },
  }
}
