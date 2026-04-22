#!/usr/bin/env node
// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// playtiss-proxy CLI entry.
//
// Scaffolded for v0.1.0-alpha.0. Subcommand handlers (server, stats,
// --install-skill) land in later commits as the server + projectors
// come online.

import { VERSION } from './version.js'

function usage(): void {
  process.stdout.write(
    `playtiss-proxy ${VERSION}\n`
    + 'Usage:\n'
    + '  playtiss-proxy              start the proxy server (not yet wired)\n'
    + '  playtiss-proxy --version    print version\n'
    + '  playtiss-proxy --help       print this message\n',
  )
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    usage()
    return
  }
  process.stderr.write(`playtiss-proxy: unknown args: ${args.join(' ')}\n`)
  process.exit(2)
}

main()
