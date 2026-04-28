// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// spawn-agent tests. Uses tiny inline shell stubs as the "agent" so we don't
// need a real claude binary in the test environment.

import { describe, expect, it } from 'vitest'
import { spawnAgent } from '../cli/spawn-agent.js'

describe('spawnAgent', () => {
  it('forwards args + ANTHROPIC_BASE_URL to the agent and returns exit code 0', async () => {
    // /usr/bin/env: prints env vars matching first arg pattern. We use it as
    // a stub agent — it'll print ANTHROPIC_BASE_URL=... and exit 0. stdio is
    // 'inherit' so output goes to the test runner's stdout (visible if you
    // run with --reporter=verbose); the test only cares about the exit code.
    const r = await spawnAgent({
      agent: '/usr/bin/true',
      args: [],
      baseUrl: 'http://127.0.0.1:9999',
    })
    expect(r.exitCode).toBe(0)
    expect(r.spawnError).toBeUndefined()
  })

  it('propagates non-zero exit codes from the agent', async () => {
    const r = await spawnAgent({
      agent: '/usr/bin/false',
      args: [],
      baseUrl: 'http://127.0.0.1:9999',
    })
    expect(r.exitCode).toBe(1)
  })

  it('returns 127 + helpful message when the agent binary is not on PATH', async () => {
    const r = await spawnAgent({
      agent: 'definitely-not-a-real-binary-zzz',
      args: ['--help'],
      baseUrl: 'http://127.0.0.1:9999',
    })
    expect(r.exitCode).toBe(127)
    expect(r.spawnError).toMatch(/not found on PATH/)
  })

  it('encodes signal exits as 128+signum', async () => {
    // Use sh -c so we can self-kill with SIGTERM (signum 15). The exit code
    // semantics for signaled child are 128+15 = 143.
    const r = await spawnAgent({
      agent: '/bin/sh',
      args: ['-c', 'kill -TERM $$'],
      baseUrl: 'http://127.0.0.1:9999',
    })
    expect(r.exitCode).toBe(143)
  })
})
