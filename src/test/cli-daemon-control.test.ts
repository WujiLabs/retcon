// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Integration tests for daemon-control. Exercises the full lifecycle:
// ensureDaemon (spawn detached) → /health probe → stopDaemon (SIGTERM →
// process exit → PID cleanup). Uses RETCON_HOME tmpdir so we don't touch
// the user's real ~/.retcon/.

import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureDaemon, statusDaemon, stopDaemon } from '../cli/daemon-control.js'
import { retconPidFile } from '../cli/paths.js'

let tmpHome: string
let savedHome: string | undefined
let savedPort: string | undefined
let savedEntry: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'retcon-control-test-'))
  savedHome = process.env.RETCON_HOME
  savedPort = process.env.RETCON_PORT
  savedEntry = process.env.RETCON_CLI_ENTRY
  process.env.RETCON_HOME = tmpHome
  // Point the detached daemon spawn at our built dist/cli.js. The repo root
  // is two levels up from src/test/ — keep that resolution explicit so this
  // test fails loudly if the layout changes.
  const entry = path.resolve(__dirname, '..', '..', 'dist', 'cli.js')
  process.env.RETCON_CLI_ENTRY = entry
})

afterEach(async () => {
  // Best-effort: stop any daemon left running from a failed test.
  try { await stopDaemon() }
  catch { /* ignore */ }
  if (savedHome === undefined) delete process.env.RETCON_HOME
  else process.env.RETCON_HOME = savedHome
  if (savedPort === undefined) delete process.env.RETCON_PORT
  else process.env.RETCON_PORT = savedPort
  if (savedEntry === undefined) delete process.env.RETCON_CLI_ENTRY
  else process.env.RETCON_CLI_ENTRY = savedEntry
  rmSync(tmpHome, { recursive: true, force: true })
})

function pickRandomPort(): number {
  // Range chosen to avoid common dev ports (3000, 4000, 5000, 8080).
  return 14000 + Math.floor(Math.random() * 1000)
}

// The two ensureDaemon-spawns-a-real-daemon tests need a built dist/cli.js
// to exec; under vitest, process.argv[1] is the vitest runner, not retcon's
// entrypoint. Gate them behind RETCON_TEST_INTEGRATION so they run after a
// real `pnpm build` (or in CI). The unit tests below still cover the logic
// branches that don't require a live spawn.
const integration = process.env.RETCON_TEST_INTEGRATION === '1' ? it : it.skip

describe('ensureDaemon + stopDaemon', () => {
  integration('spawns a fresh daemon when none is running, then stops it cleanly', async () => {
    const port = pickRandomPort()
    process.env.RETCON_PORT = String(port)

    const r = await ensureDaemon(port)
    expect(r.spawnedNew).toBe(true)
    expect(r.port).toBe(port)
    // PID file should be written by the spawned daemon process.
    const pidPath = retconPidFile()
    expect(fs.existsSync(pidPath)).toBe(true)

    const status = await statusDaemon(port)
    expect(status.kind).toBe('running')
    if (status.kind === 'running') {
      expect(status.snapshot.name).toBe('retcon')
      expect(status.snapshot.port).toBe(port)
      expect(status.diskBytes).toBeGreaterThanOrEqual(0)
    }

    const stopped = await stopDaemon()
    expect(stopped.kind).toBe('stopped')
    expect(fs.existsSync(pidPath)).toBe(false)
  }, 15000)

  integration('reuses an existing daemon on a second ensureDaemon call', async () => {
    const port = pickRandomPort()
    process.env.RETCON_PORT = String(port)

    const first = await ensureDaemon(port)
    expect(first.spawnedNew).toBe(true)

    const second = await ensureDaemon(port)
    expect(second.spawnedNew).toBe(false)
    expect(second.reusedSnapshot).not.toBeNull()
    if (second.reusedSnapshot) {
      expect(second.reusedSnapshot.name).toBe('retcon')
    }

    await stopDaemon()
  }, 15000)

  it('stopDaemon with no daemon running reports not_running', async () => {
    const r = await stopDaemon()
    expect(r.kind).toBe('not_running')
  })

  it('cleans up a stale PID file (pid points at a dead process)', async () => {
    fs.mkdirSync(tmpHome, { recursive: true })
    // PID 999999 is overwhelmingly likely to not exist on any system.
    fs.writeFileSync(retconPidFile(), '999999\n')
    const r = await stopDaemon()
    expect(r.kind).toBe('cleaned_stale')
    expect(fs.existsSync(retconPidFile())).toBe(false)
  })

  it('throws when port is occupied by a foreign HTTP server', async () => {
    // Bring up a foreign server on a fixed port, then try to ensureDaemon there.
    const port = pickRandomPort()
    const http = await import('node:http')
    const foreign = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"name":"not-retcon","version":"0.0.0"}')
    })
    await new Promise<void>(resolve => foreign.listen(port, '127.0.0.1', () => resolve()))
    try {
      await expect(ensureDaemon(port)).rejects.toThrow(/foreign|non-retcon/)
    }
    finally {
      await new Promise<void>(resolve => foreign.close(() => resolve()))
    }
  }, 10000)

  it('statusDaemon reports not_running when no PID file', async () => {
    const port = pickRandomPort()
    const s = await statusDaemon(port)
    expect(s.kind).toBe('not_running')
  })
})
