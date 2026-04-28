#!/usr/bin/env node
// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// retcon CLI entry.
//
// Scaffolded for v0.1.0-alpha.0. Subcommand handlers (server, stats,
// --install-skill) land in later commits as the server + projectors
// come online.

import { VERSION } from './version.js'

function usage(): void {
  process.stdout.write(
    `retcon ${VERSION}\n`
    + 'Usage:\n'
    + '  retcon              start the proxy server (not yet wired)\n'
    + '  retcon --version    print version\n'
    + '  retcon --help       print this message\n',
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
  process.stderr.write(`retcon: unknown args: ${args.join(' ')}\n`)
  process.exit(2)
}

main()
