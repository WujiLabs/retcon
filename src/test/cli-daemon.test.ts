// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Integration test for the daemon body: boot the server in-process, hit
// /health, send SIGTERM, assert clean shutdown. Skips PID file management
// (writePidFile: false) so we can run multiple daemons in parallel test runs.

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDaemon } from '../cli/daemon.js'

interface HealthResponse {
  name: string
  version: string
  port: number
  pid: number
  uptime_s: number
  sessions: number
  db_size_bytes: number
}

async function fetchHealth(port: number): Promise<HealthResponse> {
  return await new Promise<HealthResponse>((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as HealthResponse)
        }
        catch (err) { reject(err) }
      })
    }).on('error', reject)
  })
}

let tmpHome: string
let savedHome: string | undefined
let savedPort: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'retcon-daemon-test-'))
  savedHome = process.env.RETCON_HOME
  savedPort = process.env.RETCON_PORT
  process.env.RETCON_HOME = tmpHome
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.RETCON_HOME
  else process.env.RETCON_HOME = savedHome
  if (savedPort === undefined) delete process.env.RETCON_PORT
  else process.env.RETCON_PORT = savedPort
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('runDaemon', () => {
  it('boots, serves /health with retcon identity, and shuts down on SIGTERM', async () => {
    // Use port 0 by NOT setting RETCON_PORT — daemon will bind to its default
    // 4099. To avoid collision we override via the port option with 0
    // (ephemeral). But runDaemon takes opts.port so we can pass it directly.
    // We need to know the port for /health probe. Pick a random ephemeral
    // port range and try a couple.
    const port = 14000 + Math.floor(Math.random() * 1000)

    // Kick off the daemon in the background. It resolves when shut down.
    const daemonExit = runDaemon({ port, writePidFile: false })

    // Poll /health until it answers (server is async to come up).
    let snap: HealthResponse | undefined
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try { snap = await fetchHealth(port); break }
      catch { await new Promise(r => setTimeout(r, 50)) }
    }
    expect(snap).toBeDefined()
    expect(snap!.name).toBe('retcon')
    expect(snap!.port).toBe(port)
    expect(snap!.pid).toBe(process.pid)

    // Trigger graceful shutdown.
    process.emit('SIGTERM')
    const code = await daemonExit
    expect(code).toBe(0)
  }, 10000)
})
