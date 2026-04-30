// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Filesystem layout for retcon's local state.
//
//   ~/.retcon/
//   ├── proxy.db           SQLite event log + projected views
//   ├── proxy.db-wal       SQLite write-ahead log (auto-managed by sqlite)
//   ├── proxy.db-shm       SQLite shared memory (auto-managed by sqlite)
//   ├── proxy.pid          daemon PID (written on start, removed on clean exit)
//   ├── daemon.log         daemon stdout+stderr (append-only; rotation deferred to v1.1)
//   ├── tobe/              per-session TOBE pending JSON files
//   └── dumps/             AI-edited conversation dumps (dump_to_file output)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function retconHome(): string {
  return process.env.RETCON_HOME ?? path.join(os.homedir(), '.retcon')
}

export function retconDbPath(): string {
  return path.join(retconHome(), 'proxy.db')
}

export function retconTobeDir(): string {
  return path.join(retconHome(), 'tobe')
}

export function retconDumpsDir(): string {
  return path.join(retconHome(), 'dumps')
}

export function retconPidFile(): string {
  return path.join(retconHome(), 'proxy.pid')
}

export function retconLogFile(): string {
  return path.join(retconHome(), 'daemon.log')
}

/**
 * Create ~/.retcon/, ~/.retcon/tobe/, and ~/.retcon/dumps/ if missing.
 * Idempotent.
 *
 * Throws if the path is unwritable (e.g. read-only HOME, permission denied).
 * Caller is expected to surface the error to the user since retcon can't
 * function without local state.
 */
export function ensureRetconDirs(): void {
  fs.mkdirSync(retconHome(), { recursive: true })
  fs.mkdirSync(retconTobeDir(), { recursive: true })
  fs.mkdirSync(retconDumpsDir(), { recursive: true })
}
