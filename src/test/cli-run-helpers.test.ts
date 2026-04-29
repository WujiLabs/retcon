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
} from '../cli/run.js'
import { ANTHROPIC_UPSTREAM } from '../proxy-handler.js'

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

  it('rejects malformed user --session-id and mints a fresh one instead', () => {
    const id = pickTransportId(['--session-id', 'not-a-uuid'], false)
    expect(id).not.toBe('not-a-uuid')
    expect(id).toMatch(/^[a-f0-9]{8}-/)
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
    const result = buildSettingsAndArgs(['--effort', 'low'], HOOK_CMD)
    expect(result.argsWithoutSettings).toEqual(['--effort', 'low'])
    const parsed = JSON.parse(result.settings)
    expect(parsed.hooks.SessionStart).toHaveLength(1)
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe(HOOK_CMD)
  })

  it('appends our hook to the user\'s existing SessionStart array', () => {
    const userSettings = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'user-hook-1' }] },
        ],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'pre' }] }],
      },
      permissions: { allowedTools: ['Bash'] },
    })
    const result = buildSettingsAndArgs(['--settings', userSettings, '--effort', 'low'], HOOK_CMD)
    // User's --settings flag is removed; we'll add our merged version back in run.ts.
    expect(result.argsWithoutSettings).toEqual(['--effort', 'low'])
    const parsed = JSON.parse(result.settings)
    expect(parsed.hooks.SessionStart).toHaveLength(2)
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('user-hook-1')
    expect(parsed.hooks.SessionStart[1].hooks[0].command).toBe(HOOK_CMD)
    // Other hook events and unrelated settings preserved.
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('pre')
    expect(parsed.permissions.allowedTools).toEqual(['Bash'])
  })

  it('creates SessionStart array when user has hooks but no SessionStart', () => {
    const userSettings = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] },
    })
    const result = buildSettingsAndArgs(['--settings', userSettings], HOOK_CMD)
    const parsed = JSON.parse(result.settings)
    expect(parsed.hooks.SessionStart).toHaveLength(1)
    expect(parsed.hooks.PreToolUse).toBeDefined()
  })

  it('handles --settings=value form', () => {
    const userSettings = JSON.stringify({ permissions: {} })
    const result = buildSettingsAndArgs([`--settings=${userSettings}`, '--effort', 'low'], HOOK_CMD)
    expect(result.argsWithoutSettings).toEqual(['--effort', 'low'])
    const parsed = JSON.parse(result.settings)
    expect(parsed.permissions).toEqual({})
    expect(parsed.hooks.SessionStart).toHaveLength(1)
  })

  it('drops unparseable user --settings and installs our hook standalone', () => {
    const result = buildSettingsAndArgs(['--settings', 'not-json', '--keep'], HOOK_CMD)
    expect(result.argsWithoutSettings).toEqual(['--keep'])
    const parsed = JSON.parse(result.settings)
    expect(parsed.hooks.SessionStart).toHaveLength(1)
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
