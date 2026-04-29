// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Daemon lifecycle control: start (detached spawn), stop (SIGTERM with SIGKILL
// fallback), status (uptime + disk usage), and the ensureDaemon entrypoint
// used by `retcon` on every invocation.
//
// State machine for ensureDaemon(version):
//
//   ┌──────────────────────────────┐
//   │     read PID file            │
//   └────────────┬─────────────────┘
//                │
//      ┌─────────┴────────┐
//      ▼                  ▼
//   missing           exists
//      │                  │
//      │           ┌──────┴──────┐
//      │           ▼             ▼
//      │       kill(pid,0)    /health probe
//      │       ESRCH (stale)  on saved port
//      │           │             │
//      │           ▼          ┌──┴───────────┐
//      │       cleanup        ▼              ▼
//      │           │       match           foreign / mismatch
//      │           │          │                 │
//      │           │       reuse           SIGTERM old + cleanup
//      │           │       (return)              │
//      │           ▼                             ▼
//      └────► spawn detached daemon ◄────────────┘
//                │
//                ▼
//             wait for /health up to ~5s
//                │
//             return { port }
//

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { ANTHROPIC_UPSTREAM } from '../proxy-handler.js'
import { DEFAULT_PORT } from '../server.js'
import { VERSION } from '../version.js'
import { probeHealth, type HealthSnapshotShape } from './health-probe.js'
import { ensureRetconDirs, retconHome, retconLogFile, retconPidFile } from './paths.js'

const SPAWN_READY_TIMEOUT_MS = 5000
const STOP_SIGTERM_GRACE_MS = 5000

export interface EnsureDaemonResult {
  port: number
  /** True if this invocation spawned the daemon; false if reusing existing. */
  spawnedNew: boolean
  /** Status snapshot if reusing; null if just spawned (caller can probe again). */
  reusedSnapshot: HealthSnapshotShape | null
}

export interface EnsureDaemonOptions {
  /** Upstream to proxy /v1/* to. Defaults to api.anthropic.com. */
  upstream?: string
}

/**
 * Make sure a retcon daemon is running on `port`. Returns once /health
 * confirms a matching version + upstream is up. Throws if the port is held
 * by a foreign process, the daemon refused to come up, or an existing daemon
 * is configured for a different upstream than `opts.upstream`.
 *
 * Upstream mismatch is treated like a version mismatch from the user's POV:
 * one daemon owns the port, and proxying traffic to a different provider
 * silently would route credentials to the wrong place. Caller is asked to
 * `retcon stop` or pick a different `RETCON_PORT`.
 */
export async function ensureDaemon(
  port: number = resolvedDefaultPort(),
  opts: EnsureDaemonOptions = {},
): Promise<EnsureDaemonResult> {
  ensureRetconDirs()
  const wantUpstream = normalizeUpstream(opts.upstream ?? ANTHROPIC_UPSTREAM)

  // Stale PID file? Clean up first so the probe path is the only signal.
  const stalePid = readPidIfStale()
  if (stalePid !== null) {
    cleanupPidFile()
  }

  const probe = await probeHealth(port, VERSION)

  if (probe.kind === 'match') {
    // Version matches; verify upstream too. A daemon proxying to
    // api.anthropic.com cannot be silently reused by a user pointing at
    // OpenRouter — credentials would land at the wrong provider.
    const haveUpstream = normalizeUpstream(probe.snapshot.upstream ?? ANTHROPIC_UPSTREAM)
    if (haveUpstream !== wantUpstream) {
      throw new Error(
        `retcon daemon on port ${port} is configured for upstream ${haveUpstream}, `
        + `but this invocation wants ${wantUpstream}. `
        + `Run \`retcon stop\` to restart it, or set RETCON_PORT=<other> to use a different port.`,
      )
    }
    return { port, spawnedNew: false, reusedSnapshot: probe.snapshot }
  }

  if (probe.kind === 'mismatch') {
    // A retcon daemon at a different version is on the port. Replace it.
    await stopExistingDaemon('mismatched-version')
    return spawnAndWait(port, wantUpstream)
  }

  if (probe.kind === 'foreign') {
    throw new Error(
      `port ${port} is owned by a non-retcon process (${probe.reason}). `
      + `Set RETCON_PORT to a free port, or stop the conflicting process.`,
    )
  }

  // free → spawn
  return spawnAndWait(port, wantUpstream)
}

/**
 * Normalize an upstream URL for equality comparison. Strips trailing slashes
 * and lowercases the host. Path is preserved (case-sensitive — providers may
 * mount their API at /api or /api/v1).
 */
export function normalizeUpstream(url: string): string {
  try {
    const u = new URL(url)
    u.hostname = u.hostname.toLowerCase()
    let pathname = u.pathname
    // Drop a trailing `/` so `host` and `host/` normalize to the same thing.
    // For root paths this collapses to the empty string ("https://host"),
    // which matches what a user typically types in ANTHROPIC_BASE_URL.
    if (pathname.endsWith('/')) pathname = pathname.slice(0, -1)
    return `${u.protocol}//${u.host}${pathname}${u.search}`
  }
  catch {
    return url.replace(/\/+$/, '')
  }
}

export interface StopResult {
  kind: 'stopped' | 'not_running' | 'cleaned_stale'
  pid?: number
}

/** Stop the running daemon. Idempotent — no-ops if not running. */
export async function stopDaemon(): Promise<StopResult> {
  const pid = readPidFile()
  if (pid === null) return { kind: 'not_running' }
  if (!isAlive(pid)) {
    cleanupPidFile()
    return { kind: 'cleaned_stale', pid }
  }
  try { process.kill(pid, 'SIGTERM') }
  catch { /* race: died between alive check and signal */ }

  // Poll for exit up to STOP_SIGTERM_GRACE_MS, then SIGKILL.
  const deadline = Date.now() + STOP_SIGTERM_GRACE_MS
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      cleanupPidFile()
      return { kind: 'stopped', pid }
    }
    await sleep(100)
  }
  try { process.kill(pid, 'SIGKILL') }
  catch { /* race */ }
  cleanupPidFile()
  return { kind: 'stopped', pid }
}

export type StatusResult =
  | { kind: 'not_running' }
  | { kind: 'running', snapshot: HealthSnapshotShape, diskBytes: number }
  | { kind: 'degraded', pid: number, reason: string }

/**
 * Inspect the running daemon. Returns running status + health snapshot +
 * total bytes used by ~/.retcon/. Computes disk usage by recursive stat.
 */
export async function statusDaemon(port: number = resolvedDefaultPort()): Promise<StatusResult> {
  const pid = readPidFile()
  if (pid === null || !isAlive(pid)) {
    return { kind: 'not_running' }
  }
  const probe = await probeHealth(port, VERSION)
  if (probe.kind !== 'match') {
    const reason = probe.kind === 'mismatch'
      ? `version mismatch (running ${probe.snapshot.version}, this binary is ${VERSION})`
      : probe.kind === 'foreign'
        ? `port owned by foreign process: ${probe.reason}`
        : 'no daemon listening'
    return { kind: 'degraded', pid, reason }
  }
  const diskBytes = await dirSize(retconHome())
  return { kind: 'running', snapshot: probe.snapshot, diskBytes }
}

// ─── internals ────────────────────────────────────────────────────────────

/** Resolve port the same way the daemon does (RETCON_PORT or DEFAULT_PORT). */
export function resolvedDefaultPort(): number {
  return Number(process.env.RETCON_PORT) || DEFAULT_PORT
}

function readPidFile(): number | null {
  try {
    const raw = fs.readFileSync(retconPidFile(), 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }
  catch { return null }
}

/** Read the PID file IF it exists AND the PID is dead. Otherwise null. */
function readPidIfStale(): number | null {
  const pid = readPidFile()
  if (pid === null) return null
  return isAlive(pid) ? null : pid
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (err) {
    const e = err as NodeJS.ErrnoException
    // EPERM means the process exists but we can't signal it. Still "alive."
    return e.code === 'EPERM'
  }
}

function cleanupPidFile(): void {
  try { fs.unlinkSync(retconPidFile()) }
  catch { /* not there */ }
}

async function stopExistingDaemon(reason: string): Promise<void> {
  // Replicates a subset of stopDaemon, but quieter — caller logs the reason.
  void reason
  const pid = readPidFile()
  if (pid === null || !isAlive(pid)) {
    cleanupPidFile()
    return
  }
  try { process.kill(pid, 'SIGTERM') }
  catch { /* race */ }
  const deadline = Date.now() + STOP_SIGTERM_GRACE_MS
  while (Date.now() < deadline && isAlive(pid)) {
    await sleep(100)
  }
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL') }
    catch { /* race */ }
    // Give SIGKILL a moment to take effect (kernel needs to reap). If the
    // process really refuses to die (zombie parent, uninterruptible sleep,
    // permission flap), keep the PID file around so the next ensureDaemon
    // run surfaces "another retcon claims this port" instead of spawning a
    // fresh daemon that immediately fails its bind.
    const sigkillDeadline = Date.now() + 500
    while (Date.now() < sigkillDeadline && isAlive(pid)) {
      await sleep(50)
    }
    if (isAlive(pid)) {
      throw new Error(
        `existing retcon daemon (pid ${pid}) refused to die after SIGTERM + SIGKILL. `
        + `Investigate manually: \`ps -p ${pid}\` and \`kill -9 ${pid}\`.`,
      )
    }
  }
  cleanupPidFile()
}

async function spawnAndWait(port: number, upstream: string): Promise<EnsureDaemonResult> {
  const logFd = fs.openSync(retconLogFile(), 'a')
  try {
    // Spawn the same node binary, re-invoking this CLI with --daemon. We
    // resolve the script path from RETCON_CLI_ENTRY (set in tests so we can
    // point at dist/cli.js while vitest is the actual argv[1]) or fall back
    // to process.argv[1] in the real install.
    const cliPath = process.env.RETCON_CLI_ENTRY ?? process.argv[1]
    const child = spawn(process.execPath, [cliPath, '--daemon'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: buildDaemonEnv(process.env, { port, upstream }),
    })
    child.unref()
    // Don't await child.exit — we WANT it to outlive us.
  }
  finally {
    fs.closeSync(logFd)
  }

  const ready = await waitForHealthMatch(port, SPAWN_READY_TIMEOUT_MS)
  if (!ready) {
    throw new Error(
      `retcon daemon failed to come up on port ${port} within ${SPAWN_READY_TIMEOUT_MS}ms. `
      + `Check ~/.retcon/daemon.log for details.`,
    )
  }
  return { port, spawnedNew: true, reusedSnapshot: null }
}

/**
 * Build the env dict that the detached daemon inherits. The daemon is a
 * long-lived background process that holds the SQLite DB and proxies HTTP;
 * it does NOT need user provider credentials (ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, AWS_*, OPENAI_*, etc.) — claude attaches those
 * per request and the proxy forwards request headers as-is.
 *
 * We use an allow-list rather than a deny-list because the spawning shell
 * may have credentials we haven't enumerated (vendor-specific APIs, internal
 * tooling, etc.) and a long-lived daemon shouldn't sit on top of them.
 *
 * Allowed:
 *   - System basics:      HOME, USER, PATH, SHELL, TMPDIR/TMP/TEMP
 *   - Locale / timezone:  LANG, LC_*, TZ
 *   - Node runtime:       NODE_OPTIONS, NODE_DEBUG, NODE_NO_WARNINGS, NODE_ENV
 *   - retcon's own:       RETCON_HOME, RETCON_CLI_ENTRY (for tests)
 *   - Injected:           RETCON_PORT, RETCON_UPSTREAM
 */
export function buildDaemonEnv(
  parentEnv: NodeJS.ProcessEnv,
  opts: { port: number, upstream: string },
): NodeJS.ProcessEnv {
  const ALLOW = new Set([
    'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL',
    'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'TZ',
    'NODE_OPTIONS', 'NODE_DEBUG', 'NODE_NO_WARNINGS', 'NODE_ENV',
    // Network egress configuration. The daemon's outbound /v1/* requests use
    // node:http/https directly (which don't honor HTTP_PROXY natively), but
    // any future fetch() or upstream-side library that does will need these.
    // Custom CA bundles ship with corporate MITM setups; without them, TLS
    // fails silently and the user sees "daemon failed to come up" with vague
    // errors in daemon.log.
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'RETCON_HOME', 'RETCON_CLI_ENTRY',
  ])
  const ALLOW_PREFIX = ['LC_']  // LC_ALL, LC_CTYPE, LC_TIME, etc.

  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue
    if (ALLOW.has(k) || ALLOW_PREFIX.some(p => k.startsWith(p))) {
      env[k] = v
    }
  }
  env.RETCON_PORT = String(opts.port)
  env.RETCON_UPSTREAM = opts.upstream
  return env
}

async function waitForHealthMatch(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await probeHealth(port, VERSION, { timeoutMs: 500 })
    if (probe.kind === 'match') return true
    await sleep(100)
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Walk a directory and sum file sizes. Best-effort; returns 0 on missing
 * paths. Handles the symlink case by following links — `~/.retcon/` is
 * never expected to contain symlinks but we don't want to throw if it does.
 */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: fs.Dirent[]
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) }
  catch { return 0 }
  for (const e of entries) {
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) {
      total += await dirSize(full)
    }
    else {
      try {
        const st = await fs.promises.stat(full)
        total += st.size
      }
      catch { /* file vanished mid-walk; skip */ }
    }
  }
  return total
}
