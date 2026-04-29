// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Unit tests for the upstream-resolution helpers used by retcon to support
// non-Anthropic providers (OpenRouter, Bedrock-proxy, Vertex shim).

import { describe, expect, it } from 'vitest'

import { normalizeUpstream } from '../cli/daemon-control.js'
import { resolveUpstream } from '../cli/run.js'
import { ANTHROPIC_UPSTREAM, buildUpstreamUrl } from '../proxy-handler.js'

describe('buildUpstreamUrl', () => {
  it('preserves a non-empty upstream pathname when joining with /v1/messages', () => {
    // The pure `new URL(path, base)` form would drop "/api" here; this is the
    // reason buildUpstreamUrl exists as a separate helper.
    const u = buildUpstreamUrl('https://openrouter.ai/api', '/v1/messages')
    expect(u.toString()).toBe('https://openrouter.ai/api/v1/messages')
  })

  it('handles upstream with a trailing slash', () => {
    const u = buildUpstreamUrl('https://openrouter.ai/api/', '/v1/messages')
    expect(u.toString()).toBe('https://openrouter.ai/api/v1/messages')
  })

  it('works for the default Anthropic upstream', () => {
    const u = buildUpstreamUrl('https://api.anthropic.com', '/v1/messages')
    expect(u.toString()).toBe('https://api.anthropic.com/v1/messages')
  })

  it('preserves query strings on the path', () => {
    const u = buildUpstreamUrl('https://api.anthropic.com', '/v1/messages?stream=true')
    expect(u.toString()).toBe('https://api.anthropic.com/v1/messages?stream=true')
  })
})

describe('normalizeUpstream', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeUpstream('https://api.anthropic.com/')).toBe('https://api.anthropic.com')
  })

  it('lowercases the host but not the path', () => {
    expect(normalizeUpstream('https://OpenRouter.AI/Api')).toBe('https://openrouter.ai/Api')
  })

  it('treats unparseable input as a string with trailing-slash trim', () => {
    expect(normalizeUpstream('not a url//')).toBe('not a url')
  })

  it('treats trailing-slash and no-trailing-slash as equivalent', () => {
    // Root-only path collapses cleanly; equality lets a daemon spawned
    // without `/` match a CLI invocation that included it.
    expect(normalizeUpstream('https://api.anthropic.com'))
      .toBe(normalizeUpstream('https://api.anthropic.com/'))
  })
})

describe('resolveUpstream', () => {
  const RETCON_BASE = 'http://127.0.0.1:4099'

  it('returns the default Anthropic upstream when ANTHROPIC_BASE_URL is unset', () => {
    expect(resolveUpstream({}, RETCON_BASE)).toBe(ANTHROPIC_UPSTREAM)
  })

  it('returns the user\'s ANTHROPIC_BASE_URL when set to a different provider', () => {
    expect(resolveUpstream({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' }, RETCON_BASE))
      .toBe('https://openrouter.ai/api')
  })

  it('does not recurse if ANTHROPIC_BASE_URL exactly equals retcon', () => {
    // Defends against the user `export ANTHROPIC_BASE_URL=http://127.0.0.1:4099`
    // in a long-lived shell — without this guard, retcon would proxy to itself.
    expect(resolveUpstream({ ANTHROPIC_BASE_URL: RETCON_BASE }, RETCON_BASE))
      .toBe(ANTHROPIC_UPSTREAM)
  })

  it('treats trailing-slash variants as equivalent to retcon', () => {
    expect(resolveUpstream({ ANTHROPIC_BASE_URL: `${RETCON_BASE}/` }, RETCON_BASE))
      .toBe(ANTHROPIC_UPSTREAM)
  })

  it('does NOT clobber a non-retcon loopback upstream (LiteLLM, devstack, etc.)', () => {
    // The previous version of this function broadly swallowed any 127.0.0.1:*
    // or localhost:* URL as a self-reference. That silently misrouted users
    // running a separate local proxy on a different port — their auth tokens
    // ended up at api.anthropic.com instead of their intended relay.
    expect(resolveUpstream({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000' }, RETCON_BASE))
      .toBe('http://127.0.0.1:5000')
    expect(resolveUpstream({ ANTHROPIC_BASE_URL: 'http://localhost:9999' }, RETCON_BASE))
      .toBe('http://localhost:9999')
  })
})
