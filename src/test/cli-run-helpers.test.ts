// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unit tests for the cli/run.ts pure helpers: pickTransportId,
// buildSettingsAndArgs, mergeCustomHeaders, detectResumeMode, resolveUpstream.

import { describe, expect, it } from 'vitest'

import {
  buildSettingsAndArgs,
  detectResumeMode,
  mergeCustomHeaders,
  pickTransportId,
  resolveUpstream,
  retconAllowEntries,
} from '../cli/run.js'
import { ANTHROPIC_UPSTREAM } from '../proxy-handler.js'

/**
 * Fixed allow entries used in tests so they don't depend on the test
 * runner's home directory. Real callers pass `retconAllowEntries(os.homedir())`.
 */
const TEST_ALLOW_ENTRIES = retconAllowEntries('/home/test')

describe('pickTransportId', () => {
  const VALID = '11111111-2222-3333-4444-555555555555'

  it('mints a fresh UUID when user supplies no --session-id', () => {
    const id = pickTransportId([], false)
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  })

  it('adopts a user-supplied --session-id (new session)', () => {
    expect(pickTransportId(['--session-id', VALID], false)).toBe(VALID)
  })

  it('adopts user --session-id=value form', () => {
    expect(pickTransportId([`--session-id=${VALID}`], false)).toBe(VALID)
  })

  it('throws on a malformed user --session-id (must be a valid UUID)', () => {
    expect(() => pickTransportId(['--session-id', 'not-a-uuid'], false))
      .toThrow(/not a valid UUID/)
  })

  it('ignores user --session-id in resume mode (claude rejects that combo anyway)', () => {
    const id = pickTransportId(['--session-id', VALID, '--resume'], true)
    // Resume mode → mint a fresh binding token, don't adopt the user's id.
    expect(id).not.toBe(VALID)
  })
})

describe('buildSettingsAndArgs', () => {
  const HOOK_CMD = 'curl http://x/hooks/session-start'

  it('builds settings with our SessionStart hook when the user supplied none', () => {
    const result = buildSettingsAndArgs(['--effort', 'low'], HOOK_CMD, TEST_ALLOW_ENTRIES)
    expect(result.argsWithoutSettings).toEqual(['--effort', 'low'])
    const parsed = JSON.parse(result.settings)
    expect(parsed.hooks.SessionStart).toHaveLength(1)
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe(HOOK_CMD)
  })

  it('injects retcon dumps allowlist when user supplied no settings', () => {
    const result = buildSettingsAndArgs(['--effort', 'low'], HOOK_CMD, TEST_ALLOW_ENTRIES)
    const parsed = JSON.parse(result.settings)
    expect(parsed.permissions.allow).toEqual(TEST_ALLOW_ENTRIES)
  })

  it('appends our hook AND merges allow entries with the user\'s', () => {
    const userSettings = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'user-hook-1' }] },
        ],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'pre' }] }],
      },
      permissions: { allowedTools: ['Bash'], allow: ['Bash(npm test)'] },
    })
    const result = buildSettingsAndArgs(['--settings', userSettings, '--effort', 'low'], HOOK_CMD, TEST_ALLOW_ENTRIES)
    // User's --settings flag is removed; we'll add our merged version back in run.ts.
    expect(result.argsWithoutSettings).toEqual(['--effort', 'low'])
    const parsed = JSON.parse(result.settings)
    expect(parsed.hooks.SessionStart).toHaveLength(2)
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('user-hook-1')
    expect(parsed.hooks.SessionStart[1].hooks[0].command).toBe(HOOK_CMD)
    // Other hook events and unrelated settings preserved.
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('pre')
    expect(parsed.permissions.allowedTools).toEqual(['Bash'])
    // allow entries: user's first, then ours appended.
    expect(parsed.permissions.allow).toEqual(['Bash(npm test)', ...TEST_ALLOW_ENTRIES])
  })

  it('dedupes allow entries: user-supplied retcon entries are not duplicated', () => {
    const userSettings = JSON.stringify({
      permissions: { allow: [TEST_ALLOW_ENTRIES[0]!, 'Bash(other)'] },
    })
    const result = buildSettingsAndArgs(['--settings', userSettings], HOOK_CMD, TEST_ALLOW_ENTRIES)
    const parsed = JSON.parse(result.settings)
    // First entry is preserved (user-supplied); 'Bash(other)' kept; remaining
    // 4 retcon entries appended; the first retcon entry is NOT re-added.
    expect(parsed.permissions.allow).toEqual([
      TEST_ALLOW_ENTRIES[0],
      'Bash(other)',
      ...TEST_ALLOW_ENTRIES.slice(1),
    ])
  })

  it('creates SessionStart array when user has hooks but no SessionStart', () => {
    const userSettings = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] },
    })
    const result = buildSettingsAndArgs(['--settings', userSettings], HOOK_CMD, TEST_ALLOW_ENTRIES)
    const parsed = JSON.parse(result.settings)
    expect(parsed.hooks.SessionStart).toHaveLength(1)
    expect(parsed.hooks.PreToolUse).toBeDefined()
    // permissions key gets created with our entries even though user had none.
    expect(parsed.permissions.allow).toEqual(TEST_ALLOW_ENTRIES)
  })

  it('handles --settings=value form and merges into empty permissions', () => {
    const userSettings = JSON.stringify({ permissions: {} })
    const result = buildSettingsAndArgs([`--settings=${userSettings}`, '--effort', 'low'], HOOK_CMD, TEST_ALLOW_ENTRIES)
    expect(result.argsWithoutSettings).toEqual(['--effort', 'low'])
    const parsed = JSON.parse(result.settings)
    // User had permissions:{} — we add allow without disturbing other keys.
    expect(parsed.permissions.allow).toEqual(TEST_ALLOW_ENTRIES)
    expect(parsed.hooks.SessionStart).toHaveLength(1)
  })

  it('drops unparseable user --settings and installs our hook + allowlist standalone', () => {
    const result = buildSettingsAndArgs(['--settings', 'not-json', '--keep'], HOOK_CMD, TEST_ALLOW_ENTRIES)
    expect(result.argsWithoutSettings).toEqual(['--keep'])
    const parsed = JSON.parse(result.settings)
    expect(parsed.hooks.SessionStart).toHaveLength(1)
    expect(parsed.permissions.allow).toEqual(TEST_ALLOW_ENTRIES)
  })
})

describe('retconAllowEntries', () => {
  it('returns MCP-tool entries + 5 dumps-directory FS entries', () => {
    const entries = retconAllowEntries('/home/alice')
    // 7 MCP tool names + 5 filesystem entries.
    expect(entries).toHaveLength(12)
    // retcon's MCP tools — auto-allowed so claude doesn't prompt the user.
    expect(entries).toContain('mcp__retcon__recall')
    expect(entries).toContain('mcp__retcon__rewind_to')
    expect(entries).toContain('mcp__retcon__bookmark')
    expect(entries).toContain('mcp__retcon__delete_bookmark')
    expect(entries).toContain('mcp__retcon__list_branches')
    expect(entries).toContain('mcp__retcon__dump_to_file')
    expect(entries).toContain('mcp__retcon__submit_file')
    // Dumps-directory filesystem access for dump_to_file / submit_file.
    expect(entries).toContain('Read(/home/alice/.retcon/dumps/**)')
    expect(entries).toContain('Edit(/home/alice/.retcon/dumps/**)')
    expect(entries).toContain('Write(/home/alice/.retcon/dumps/**)')
    expect(entries).toContain('Glob(/home/alice/.retcon/dumps/**)')
    expect(entries).toContain('Grep(/home/alice/.retcon/dumps/**)')
  })

  it('FS entries use ** so any depth under dumps/ matches', () => {
    const entries = retconAllowEntries('/h')
    const fsEntries = entries.filter(e => /^(Read|Edit|Write|Glob|Grep)\(/.test(e))
    for (const e of fsEntries) {
      expect(e).toMatch(/\.retcon\/dumps\/\*\*\)$/)
    }
  })
})

describe('mergeCustomHeaders', () => {
  it('returns our header alone when user has none', () => {
    expect(mergeCustomHeaders(undefined, 'x-foo: 1')).toBe('x-foo: 1')
  })
  it('appends our header to the user\'s value with a newline', () => {
    expect(mergeCustomHeaders('x-user: A', 'x-foo: 1')).toBe('x-user: A\nx-foo: 1')
  })
  it('strips trailing newlines from the user value before joining', () => {
    expect(mergeCustomHeaders('x-user: A\n\n', 'x-foo: 1')).toBe('x-user: A\nx-foo: 1')
  })
  it('drops pre-existing x-playtiss-session lines from the user value', () => {
    // A nested retcon (or a shell re-exporting prior CUSTOM_HEADERS) must not
    // produce stacked x-playtiss-session lines; we'd misroute events to a
    // stale transport id.
    const stacked = 'x-user: A\nx-playtiss-session: stale-uuid\nx-other: B'
    expect(mergeCustomHeaders(stacked, 'x-playtiss-session: fresh-uuid'))
      .toBe('x-user: A\nx-other: B\nx-playtiss-session: fresh-uuid')
  })
  it('handles case-insensitive matching on the header name', () => {
    expect(mergeCustomHeaders('X-Playtiss-Session: stale\nx-other: B', 'x-playtiss-session: fresh'))
      .toBe('x-other: B\nx-playtiss-session: fresh')
  })
  it('returns our header alone when user value contained ONLY a stale session header', () => {
    expect(mergeCustomHeaders('x-playtiss-session: stale', 'x-playtiss-session: fresh'))
      .toBe('x-playtiss-session: fresh')
  })
})

describe('detectResumeMode', () => {
  it('detects --resume', () => {
    expect(detectResumeMode(['--resume'])).toBe(true)
  })
  it('detects --continue', () => {
    expect(detectResumeMode(['--continue'])).toBe(true)
  })
  it('detects -r / -c short forms', () => {
    expect(detectResumeMode(['-r'])).toBe(true)
    expect(detectResumeMode(['-c'])).toBe(true)
  })
  it('detects --resume=value form', () => {
    expect(detectResumeMode(['--resume=abc'])).toBe(true)
  })
  it('returns false otherwise', () => {
    expect(detectResumeMode(['--effort', 'low'])).toBe(false)
  })
})

describe('resolveUpstream', () => {
  it('falls back to default when ANTHROPIC_BASE_URL is unset', () => {
    expect(resolveUpstream({}, 'http://127.0.0.1:4099')).toBe(ANTHROPIC_UPSTREAM)
  })
  it('uses the user-supplied non-loopback value', () => {
    expect(resolveUpstream({ ANTHROPIC_BASE_URL: 'https://or.ai/api' }, 'http://127.0.0.1:4099'))
      .toBe('https://or.ai/api')
  })
})
