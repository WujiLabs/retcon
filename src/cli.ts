#!/usr/bin/env node
// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// retcon CLI dispatcher.
//
// Subcommands:
//
//   retcon                 → spawn claude under retcon (default agent)
//   retcon [args...]       → forward [args...] to claude
//   retcon --claude [...]  → explicit agent flag (today: always claude)
//   retcon stop            → stop the background daemon
//   retcon status          → show daemon state, uptime, disk usage
//   retcon --version       → print the retcon package version
//   retcon --help          → print this usage
//   retcon --daemon        → INTERNAL: run the daemon body (called by
//                            ensureDaemon's detached spawn; not for users)
//
// Future agent flags (`--cursor`, `--aider`, etc.) are stubbed: today they
// print "not yet supported" and exit 2.

import { runDaemon } from './cli/daemon.js'
import { statusDaemon, stopDaemon } from './cli/daemon-control.js'
import { runAgent } from './cli/run.js'
import { VERSION } from './version.js'

function usage(): void {
  process.stdout.write(
    `retcon ${VERSION}\n`
    + 'Usage:\n'
    + '  retcon [args...]            run claude through retcon (forwards args)\n'
    + '  retcon --claude [args...]   explicit agent flag\n'
    + '  retcon stop                 stop the background daemon\n'
    + '  retcon status               show daemon status, uptime, disk usage\n'
    + '  retcon --version            print version\n'
    + '  retcon --help               print this message\n'
    + '\n'
    + 'Environment:\n'
    + '  RETCON_PORT                 listen port for the proxy (default: 4099)\n'
    + '  RETCON_HOME                 state directory (default: ~/.retcon)\n',
  )
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)

  // Short-circuits before any daemon side effects.
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    if (args.length === 0) {
      // No args still launches the agent in interactive mode — that's the
      // primary use case. Fall through.
    }
    else {
      usage()
      return 0
    }
  }

  // Subcommands.
  if (args[0] === '--daemon') {
    return await runDaemon()
  }
  if (args[0] === 'stop') {
    const r = await stopDaemon()
    switch (r.kind) {
      case 'stopped':
        process.stdout.write(`stopped retcon daemon (pid ${r.pid})\n`)
        return 0
      case 'cleaned_stale':
        process.stdout.write(`cleaned stale PID file (pid ${r.pid} was already dead)\n`)
        return 0
      case 'not_running':
        process.stdout.write('retcon daemon is not running\n')
        return 0
    }
  }
  if (args[0] === 'status') {
    const r = await statusDaemon()
    if (r.kind === 'not_running') {
      process.stdout.write('retcon daemon is not running\n')
      return 0
    }
    if (r.kind === 'degraded') {
      process.stdout.write(`retcon daemon DEGRADED (pid ${r.pid}): ${r.reason}\n`)
      return 1
    }
    printStatus(r.snapshot, r.diskBytes)
    return 0
  }

  // Agent invocation. First arg may be a known agent flag; everything after
  // is forwarded.
  let agentArgs = args
  const agent = 'claude'
  if (args[0] === '--claude') {
    agentArgs = args.slice(1)
  }
  else if (args[0] === '--cursor' || args[0] === '--aider') {
    process.stderr.write(
      `${args[0]} is not yet supported. Today retcon only knows --claude.\n`,
    )
    return 2
  }
  return await runAgent({ agent, args: agentArgs })
}

function printStatus(s: import('./cli/health-probe.js').HealthSnapshotShape, diskBytes: number): void {
  const uptime = formatDuration((s.uptime_s ?? 0) * 1000)
  const startedDate = s.started_at ? new Date(s.started_at).toISOString().slice(0, 19).replace('T', ' ') : 'unknown'
  process.stdout.write(
    `retcon daemon\n`
    + `  Status:   running (pid ${s.pid ?? '?'})\n`
    + `  Port:     ${s.port ?? '?'}\n`
    + `  Version:  ${s.version}\n`
    + `  Started:  ${startedDate} (${uptime} ago)\n`
    + `  Sessions: ${s.sessions ?? 0}\n`
    + `  Storage:  ${formatBytes(diskBytes)} total\n`
    + `            db:  ${formatBytes(s.db_size_bytes ?? 0)}\n`
    + `  MCP URL:  http://127.0.0.1:${s.port ?? '?'}/mcp\n`,
  )
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (mins || parts.length === 0) parts.push(`${mins}m`)
  return parts.join(' ')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

main().then(
  code => process.exit(code),
  (err) => {
    process.stderr.write(`[retcon] fatal: ${(err as Error).stack ?? (err as Error).message}\n`)
    process.exit(1)
  },
)
