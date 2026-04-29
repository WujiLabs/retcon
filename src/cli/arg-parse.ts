// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// CLI argument extraction for retcon-only flags that aren't passed through
// to claude. Today: `--actor <name>`. Lives separately from arg-validate.ts
// because validate runs against the full args list (claude's flags too)
// while these helpers strip retcon's own flags before claude sees them.

import { DEFAULT_ACTOR, validateActor } from '../util/actor-name.js'

export { DEFAULT_ACTOR }

export interface ExtractActorResult {
  /** The actor the user typed, or undefined if `--actor` wasn't present. */
  actor: string | undefined
  /** `args` with all `--actor` / `--actor=value` pairs removed. */
  remaining: string[]
}

/**
 * Pull `--actor <name>` (or `--actor=<name>`) out of the args list and
 * validate the value. Throws on an empty or malformed name; returns
 * `{ actor: undefined }` if the flag wasn't present at all.
 *
 * Validation: 1–64 chars, alphanumeric + `_` + `-`. Rejects whitespace,
 * slashes, semicolons, quotes — anything that would be awkward in CLI
 * scripting or would let a typo silently produce an unintended actor.
 *
 * `--actor` with no following value (last arg in the list) throws rather
 * than silently passing through to claude. Otherwise the user's typo
 * surfaces as a confusing error from claude far downstream.
 */
export function extractActor(args: readonly string[]): ExtractActorResult {
  let actor: string | undefined
  const remaining: string[] = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--actor') {
      if (i + 1 >= args.length) {
        throw new Error('missing value for --actor')
      }
      actor = validateActor(args[i + 1])
      i++
      continue
    }
    if (a.startsWith('--actor=')) {
      actor = validateActor(a.slice('--actor='.length))
      continue
    }
    remaining.push(a)
  }

  return { actor, remaining }
}
