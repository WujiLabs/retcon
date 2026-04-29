// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'

import { VERSION } from '../version.js'

describe('VERSION', () => {
  it('matches package.json format', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/)
  })
})
