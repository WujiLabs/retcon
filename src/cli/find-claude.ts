// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Locate the real `claude` binary on PATH while skipping wrappers that would
// re-invoke retcon recursively.
//
// Why this matters: a common user setup is to wrap claude with retcon, e.g.
// a script `~/.local/bin/claude` that contains `exec retcon "$@"`. When
// retcon spawns "claude" via PATH lookup, it finds that wrapper and a fork
// bomb is one process away. Shell aliases (`alias claude='retcon ...'`) are
// safe — they only apply in interactive shells and don't affect Node's
// spawn — but PATH-resolved scripts are real.
//
// Detection strategy (in order):
//   1. RETCON_REAL_CLAUDE env override — explicit user opt-out for everything
//      below.
//   2. Walk PATH directories. For each `claude` candidate:
//      a. realpath equals retcon's own argv[1] realpath → symlink back to us;
//         skip.
//      b. file is a small text shebang script that contains "retcon" → wrapper;
//         skip.
//      c. otherwise → take it.
//   3. Fall back to the literal string "claude" so spawn produces a clear
//      ENOENT message if there's no real claude installed at all.

import fs from 'node:fs'
import path from 'node:path'

/** Cap for the wrapper-detection content read. Real claude ships as a multi-MB JS bundle; small scripts are wrappers. */
const WRAPPER_MAX_SIZE_BYTES = 64 * 1024

export interface FindClaudeOptions {
  /** Override PATH. Defaults to process.env.PATH. */
  pathEnv?: string
  /** Override the env-var escape hatch. Defaults to process.env.RETCON_REAL_CLAUDE. */
  override?: string
  /**
   * Path that would indicate "this candidate is retcon itself" if a candidate's
   * realpath matches it. Defaults to realpath(process.argv[1]).
   */
  selfRealPath?: string
}

/**
 * Find a claude binary on PATH that isn't a retcon wrapper. Returns the
 * candidate path, or the literal string "claude" if nothing usable is found
 * (in which case spawn will fall through to its own PATH lookup and emit
 * the standard ENOENT error if claude isn't installed).
 */
export function findClaudeBinary(opts: FindClaudeOptions = {}): string {
  const override = opts.override ?? process.env.RETCON_REAL_CLAUDE
  if (override) return override

  const selfRealPath = opts.selfRealPath ?? safeRealPath(process.argv[1])
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? ''
  const dirs = pathEnv.split(path.delimiter).filter(d => d.length > 0)

  for (const dir of dirs) {
    const candidate = path.join(dir, 'claude')
    const realCandidate = safeRealPath(candidate)
    if (realCandidate === null) continue
    // Same physical file as retcon → would recurse.
    if (selfRealPath !== null && realCandidate === selfRealPath) continue
    if (looksLikeRetconWrapper(realCandidate)) continue
    return candidate
  }

  return 'claude'
}

function safeRealPath(p: string): string | null {
  try { return fs.realpathSync(p) }
  catch { return null }
}

/**
 * Heuristic for "this is a shell-script wrapper that re-invokes retcon".
 * True if the file is small, starts with a shebang, and references "retcon".
 * We deliberately avoid running it or parsing it more deeply — false negatives
 * (real claude installs that happen to mention "retcon" somewhere) just make
 * us pick a different candidate, never break it.
 */
function looksLikeRetconWrapper(file: string): boolean {
  let stat: fs.Stats
  try { stat = fs.statSync(file) }
  catch { return false }
  if (!stat.isFile()) return false
  if (stat.size === 0 || stat.size > WRAPPER_MAX_SIZE_BYTES) return false
  let head: string
  try { head = fs.readFileSync(file, 'utf8') }
  catch { return false }
  if (!head.startsWith('#!')) return false
  return /\bretcon\b/.test(head)
}
