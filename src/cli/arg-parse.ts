// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// CLI argument extraction for retcon-only flags that aren't passed through
// to claude. Today: `--actor <name>`. Lives separately from arg-validate.ts
// because validate runs against the full args list (claude's flags too)
// while these helpers strip retcon's own flags before claude sees them.

const ACTOR_RE = /^[A-Za-z0-9_-]{1,64}$/

export const DEFAULT_ACTOR = 'default'

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
 */
export function extractActor(args: readonly string[]): ExtractActorResult {
  let actor: string | undefined
  const remaining: string[] = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--actor' && i + 1 < args.length) {
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

function validateActor(value: string): string {
  if (!ACTOR_RE.test(value)) {
    throw new Error(
      `--actor "${value}" is not a valid name. `
      + `Allowed: 1–64 characters from [A-Za-z0-9_-].`,
    )
  }
  return value
}
