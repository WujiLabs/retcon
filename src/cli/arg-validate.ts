// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Validate user-supplied claude args for *unmergeable* collisions with the
// things retcon injects. Two collision classes today:
//
//   --mcp-config with mcpServers.retcon
//     claude unions mcpServers keys across multiple --mcp-config flags. Two
//     entries under the same key (`retcon`) is ambiguous — claude doesn't
//     know which to use, and the binding mechanism breaks if it picks the
//     user's. ERROR.
//
// Mergeable cases (handled in run.ts, not here):
//
//   --session-id <T>  : if the user supplies one (only legal in non-resume
//                       mode anyway), retcon adopts it as the binding token
//                       instead of minting its own.
//
//   --settings + hooks.SessionStart : claude allows multiple SessionStart
//                       hook entries; we inline-merge our hook into the
//                       user's settings JSON.
//
// This file does not look at env vars — those are handled in run.ts where
// merging is the right move (e.g. ANTHROPIC_CUSTOM_HEADERS).

import fs from 'node:fs'

/**
 * Parse a `--flag value` or `--flag=value` from args, returning the raw value.
 * Returns undefined if the flag isn't present. If the flag appears multiple
 * times, returns the last occurrence (matches claude's last-wins precedence).
 */
export function readFlag(args: readonly string[], flag: string): string | undefined {
  let last: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === flag && i + 1 < args.length) {
      last = args[i + 1]
    }
    else if (a.startsWith(`${flag}=`)) {
      last = a.slice(flag.length + 1)
    }
  }
  return last
}

/**
 * Return `args` with all occurrences of `flag` (and the value following it)
 * removed. Handles both `--flag value` and `--flag=value` forms. Used when
 * retcon needs to replace a user-supplied flag with a merged version.
 */
export function removeFlag(args: readonly string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++  // also consume the value
      continue
    }
    if (args[i].startsWith(`${flag}=`)) continue
    out.push(args[i])
  }
  return out
}

/**
 * Resolve a --mcp-config / --settings argument value to its parsed JSON.
 * Claude accepts either inline JSON or a file path; we try JSON first and
 * fall back to reading the file. Returns null if neither works (caller
 * decides whether to skip silently or surface).
 */
export function loadJsonArg(value: string): unknown | null {
  // Inline JSON: starts with '{' or '['
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed) }
    catch { /* fall through to file attempt */ }
  }
  try { return JSON.parse(fs.readFileSync(value, 'utf8')) }
  catch { return null }
}

/**
 * Throw if user args collide unmergeably with retcon's injected args. Today
 * the only such case is `--mcp-config` defining its own `mcpServers.retcon`.
 * Mergeable cases (--session-id, hooks.SessionStart) are handled in run.ts.
 */
export function validateUserArgs(args: readonly string[]): void {
  validateMcpConfigNoRetconKey(args)
}

function validateMcpConfigNoRetconKey(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    let value: string | undefined
    if (args[i] === '--mcp-config' && i + 1 < args.length) value = args[i + 1]
    else if (args[i].startsWith('--mcp-config=')) value = args[i].slice('--mcp-config='.length)
    if (!value) continue
    const parsed = loadJsonArg(value)
    if (!isRecord(parsed)) continue  // unparseable → let claude surface its own error
    const servers = parsed.mcpServers
    if (isRecord(servers) && 'retcon' in servers) {
      throw new Error(
        `Your --mcp-config defines mcpServers.retcon, which collides with the `
        + `MCP server retcon auto-registers. Rename your entry or drop it.`,
      )
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
