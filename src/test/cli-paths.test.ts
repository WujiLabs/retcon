// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Tests for retcon's filesystem layout helpers. RETCON_HOME env var override
// is the test isolation mechanism — it lets us point the helpers at a tmpdir.

import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let tmpHome: string
let savedEnv: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'retcon-paths-test-'))
  savedEnv = process.env.RETCON_HOME
  process.env.RETCON_HOME = tmpHome
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.RETCON_HOME
  else process.env.RETCON_HOME = savedEnv
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('retcon paths', () => {
  it('respects RETCON_HOME override', async () => {
    const { retconHome, retconDbPath, retconTobeDir, retconPidFile, retconLogFile } = await import('../cli/paths.js')
    expect(retconHome()).toBe(tmpHome)
    expect(retconDbPath()).toBe(path.join(tmpHome, 'proxy.db'))
    expect(retconTobeDir()).toBe(path.join(tmpHome, 'tobe'))
    expect(retconPidFile()).toBe(path.join(tmpHome, 'proxy.pid'))
    expect(retconLogFile()).toBe(path.join(tmpHome, 'daemon.log'))
  })

  it('ensureRetconDirs creates home + tobe subdirs (idempotent)', async () => {
    const { ensureRetconDirs, retconHome, retconTobeDir } = await import('../cli/paths.js')
    ensureRetconDirs()
    expect(fs.existsSync(retconHome())).toBe(true)
    expect(fs.existsSync(retconTobeDir())).toBe(true)
    // Calling twice is a no-op (no throw).
    expect(() => ensureRetconDirs()).not.toThrow()
  })
})
