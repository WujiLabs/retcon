// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Stop-reason classifier.
//
// Maps raw Anthropic `stop_reason` strings to the proxy's three forkability
// buckets. Pure function, deliberately permissive about unknown values —
// any new stop_reason the API introduces lands in `dangling_unforkable`
// with a console warning (not an error). Matches the plan's "never fail
// pass-through because of recording logic" invariant.

export type Classification =
  | 'closed_forkable'      // legal fork anchor — end_turn, stop_sequence
  | 'open'                 // chain continues — tool_use, pause_turn
  | 'dangling_unforkable'  // terminal but not forkable — max_tokens, refusal, null, unknown
  | 'in_flight'            // transient projector state: request_received but no terminal yet

const KNOWN_CLOSED_FORKABLE: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence'])
const KNOWN_OPEN: ReadonlySet<string> = new Set(['tool_use', 'pause_turn'])
const KNOWN_DANGLING: ReadonlySet<string> = new Set(['max_tokens', 'refusal'])

export function classify(stopReason: string | null | undefined): Classification {
  if (stopReason === null || stopReason === undefined) return 'dangling_unforkable'
  if (KNOWN_CLOSED_FORKABLE.has(stopReason)) return 'closed_forkable'
  if (KNOWN_OPEN.has(stopReason)) return 'open'
  if (KNOWN_DANGLING.has(stopReason)) return 'dangling_unforkable'
  // Unknown value — log once per value, then default to dangling to preserve
  // the pass-through invariant. Projection rebuild is cheap; users can update
  // this classifier and replay.
  warnUnknownOnce(stopReason)
  return 'dangling_unforkable'
}

const warned = new Set<string>()
function warnUnknownOnce(stopReason: string): void {
  if (warned.has(stopReason)) return
  warned.add(stopReason)
  // eslint-disable-next-line no-console
  console.warn(`[playtiss-proxy] unknown stop_reason="${stopReason}" — classified as dangling_unforkable`)
}

/** Test helper: reset the once-per-value warning cache. */
export function _resetClassifierWarnings(): void {
  warned.clear()
}
