// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT

import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findClaudeBinary } from '../cli/find-claude.js'

describe('findClaudeBinary', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'retcon-find-claude-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('honors RETCON_REAL_CLAUDE override unconditionally', () => {
    expect(findClaudeBinary({ override: '/opt/foo/claude', pathEnv: '' }))
      .toBe('/opt/foo/claude')
  })

  it('returns the literal "claude" when PATH has nothing matching', () => {
    expect(findClaudeBinary({ pathEnv: dir })).toBe('claude')
  })

  it('skips a candidate that resolves to retcon itself (symlink wrapper)', () => {
    const realRetcon = path.join(dir, 'retcon-actual')
    writeFileSync(realRetcon, '#!/bin/sh\necho retcon\n')
    chmodSync(realRetcon, 0o755)

    const wrapperDir = path.join(dir, 'wrapper')
    const realDir = path.join(dir, 'real')
    require('node:fs').mkdirSync(wrapperDir)
    require('node:fs').mkdirSync(realDir)

    // wrapper/claude is a symlink to retcon
    symlinkSync(realRetcon, path.join(wrapperDir, 'claude'))
    // real/claude is a real binary (we just write a non-shebang non-retcon file)
    const realClaude = path.join(realDir, 'claude')
    writeFileSync(realClaude, 'this-pretends-to-be-claude-binary'.repeat(10000))
    chmodSync(realClaude, 0o755)

    const found = findClaudeBinary({
      pathEnv: `${wrapperDir}${path.delimiter}${realDir}`,
      selfRealPath: realRetcon,
    })
    // Must be the one in `real/`, not the symlink in `wrapper/`.
    expect(found).toBe(path.join(realDir, 'claude'))
  })

  it('skips a small shebang script that mentions retcon', () => {
    const wrapperDir = path.join(dir, 'wrapper')
    const realDir = path.join(dir, 'real')
    require('node:fs').mkdirSync(wrapperDir)
    require('node:fs').mkdirSync(realDir)

    // Wrapper script — small, shebang, contains "retcon"
    const wrapperClaude = path.join(wrapperDir, 'claude')
    writeFileSync(wrapperClaude, '#!/bin/sh\nexec retcon "$@"\n')
    chmodSync(wrapperClaude, 0o755)

    // "Real" claude — large enough to bypass the wrapper heuristic
    const realClaude = path.join(realDir, 'claude')
    writeFileSync(realClaude, 'x'.repeat(200_000))
    chmodSync(realClaude, 0o755)

    const found = findClaudeBinary({
      pathEnv: `${wrapperDir}${path.delimiter}${realDir}`,
      selfRealPath: '/some/unrelated/path',
    })
    expect(found).toBe(realClaude)
  })

  it('takes the first candidate when no wrapper signal is present', () => {
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    require('node:fs').mkdirSync(a)
    require('node:fs').mkdirSync(b)
    const aClaude = path.join(a, 'claude')
    const bClaude = path.join(b, 'claude')
    writeFileSync(aClaude, 'x'.repeat(200_000))
    writeFileSync(bClaude, 'x'.repeat(200_000))
    chmodSync(aClaude, 0o755)
    chmodSync(bClaude, 0o755)

    const found = findClaudeBinary({
      pathEnv: `${a}${path.delimiter}${b}`,
      selfRealPath: '/unrelated',
    })
    expect(found).toBe(aClaude)
  })

  it('does NOT treat a real (large) claude install as a wrapper, even if "retcon" appears somewhere', () => {
    const dirA = path.join(dir, 'a')
    require('node:fs').mkdirSync(dirA)
    const claudeBin = path.join(dirA, 'claude')
    // 100KB+: above WRAPPER_MAX_SIZE_BYTES, so the heuristic skips reading.
    writeFileSync(claudeBin, `${'x'.repeat(100_000)}retcon${'y'.repeat(100_000)}`)
    chmodSync(claudeBin, 0o755)

    const found = findClaudeBinary({
      pathEnv: dirA,
      selfRealPath: '/unrelated',
    })
    expect(found).toBe(claudeBin)
  })
})
