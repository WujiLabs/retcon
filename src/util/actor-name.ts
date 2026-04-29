// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Single source of truth for the actor-name validation regex. Imported by
// `cli/arg-parse.ts` (extractActor), `actor-register.ts` (HTTP handler),
// and `cli/clean.ts` (parseCleanArgs). Keeping the regex + message in one
// place stops drift if we ever widen the character set or length cap.

export const ACTOR_RE = /^[A-Za-z0-9_-]{1,64}$/

export const DEFAULT_ACTOR = 'default'

export function validateActor(value: string): string {
  if (!ACTOR_RE.test(value)) {
    throw new Error(
      `actor "${value}" is not a valid name. `
      + `Allowed: 1–64 characters from [A-Za-z0-9_-].`,
    )
  }
  return value
}
