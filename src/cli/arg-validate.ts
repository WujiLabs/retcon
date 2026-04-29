// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Validate user-supplied claude args for collisions with the things retcon
// injects. Three retcon injections can collide with user input:
//
//   --session-id <T>  : binding requires our id; user-supplied is incompatible.
//                       ERROR if the user passes their own.
//
//   --mcp-config      : claude allows multiple --mcp-config flags and unions
//                       their `mcpServers` keys. Coexistence is fine UNLESS
//                       the user defines `mcpServers.retcon`, which would
//                       collide with our auto-registered server.
//                       ERROR on collision; pass-through otherwise.
//
//   --settings        : claude merges multiple --settings. The conflict point
//                       is `hooks.SessionStart` — retcon installs a binding
//                       hook there, and a user-defined SessionStart hook
//                       would either get overridden or break our binding.
//                       ERROR if user has hooks.SessionStart; pass-through
//                       otherwise.
//
// This file does not look at env vars — those are handled in run.ts where
// merging (rather than rejecting) is the right move for ANTHROPIC_CUSTOM_HEADERS.

import fs from 'node:fs'

/**
 * Parse a `--flag value` or `--flag=value` from args, returning the raw value.
 * Returns undefined if the flag isn't present. If the flag appears multiple
 * times, returns the last occurrence (matches claude's last-wins precedence).
 */
function readFlag(args: readonly string[], flag: string): string | undefined {
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
 * Resolve a --mcp-config / --settings argument value to its parsed JSON.
 * Claude accepts either inline JSON or a file path; we try JSON first and
 * fall back to reading the file. Returns null if neither works (caller
 * decides whether to skip silently or surface).
 */
function loadJsonArg(value: string): unknown | null {
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
 * Throw if user args collide with retcon's injected args. Run BEFORE we
 * append our own --session-id / --mcp-config / --settings — surfacing the
 * conflict to the user is more useful than letting claude error with a
 * cryptic message about duplicate flags.
 *
 * `isResume` flips the --session-id check off, since in resume mode we don't
 * inject one and the user can pass their own (subject to claude's own rule
 * that --session-id requires --fork-session when used with --resume).
 */
export function validateUserArgs(args: readonly string[], isResume: boolean): void {
  if (!isResume) validateNoSessionId(args)
  validateMcpConfigNoRetconKey(args)
  validateSettingsNoSessionStart(args)
}

function validateNoSessionId(args: readonly string[]): void {
  const value = readFlag(args, '--session-id')
  if (value !== undefined) {
    throw new Error(
      `--session-id was passed to retcon. retcon manages claude's session id `
      + `internally so the proxy can correlate /v1/* and MCP traffic for fork `
      + `tracking — pass-through is unsupported. Drop the flag, or run claude `
      + `directly without retcon if you need a specific session id.`,
    )
  }
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
        + `MCP server retcon auto-registers. Rename your entry, drop it, or `
        + `point your config at retcon's own URL via the --mcp-config that `
        + `retcon already injects.`,
      )
    }
  }
}

function validateSettingsNoSessionStart(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    let value: string | undefined
    if (args[i] === '--settings' && i + 1 < args.length) value = args[i + 1]
    else if (args[i].startsWith('--settings=')) value = args[i].slice('--settings='.length)
    if (!value) continue
    const parsed = loadJsonArg(value)
    if (!isRecord(parsed)) continue
    const hooks = parsed.hooks
    if (isRecord(hooks) && hooks.SessionStart !== undefined) {
      throw new Error(
        `Your --settings declares hooks.SessionStart, which collides with `
        + `retcon's binding hook (used to learn claude's session_id post-resume). `
        + `Move your SessionStart logic into a different hook event, or remove `
        + `it from --settings.`,
      )
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
