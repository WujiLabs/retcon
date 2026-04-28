// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// retcon daemon body. Runs as a detached background process spawned by the
// retcon CLI when no live daemon is found. Owns ~/.retcon/proxy.db, the HTTP
// listener on port 4099 (or RETCON_PORT), the TOBE store, and the MCP fork
// tools.
//
// Lifecycle:
//
//   start  → openDb + migrate
//          → createTobeStore + createDefaultProducer + createForkTools
//          → startServer
//          → write PID file
//          → install signal handlers
//          → block (Node's event loop keeps the process alive while the http
//            server is listening)
//
//   stop   ← SIGTERM from `retcon stop` or daemon-control's
//            "supersede stale version" path
//          → server.closeAllConnections()  (drop MCP SSE keep-alives so close()
//            isn't blocked by long-lived connections)
//          → server.close() with a 2s deadline (force exit if it doesn't drain)
//          → closeDb (runs WAL checkpoint via existing closeDb logic)
//          → unlink PID file
//          → exit 0
//
//   crash  ← uncaughtException / unhandledRejection
//          → emergency closeDb + unlink PID + exit 1
//
//   SIGKILL (untrappable): WAL persists, next openDb recovers; PID file goes
//          stale and is cleaned up on next ensureDaemon() invocation.

import fs from 'node:fs'
import { closeDb, migrate, openDb } from '../db.js'
import { createForkTools } from '../mcp-tools.js'
import { createDefaultProducer, type ServerHandle, startServer, DEFAULT_PORT } from '../server.js'
import { createTobeStore } from '../tobe.js'
import { ensureRetconDirs, retconDbPath, retconPidFile, retconTobeDir } from './paths.js'

const SHUTDOWN_DEADLINE_MS = 2000

/**
 * Run the daemon body. Blocks until SIGTERM/SIGINT (clean shutdown) or
 * uncaughtException (emergency shutdown). Resolves with the exit code.
 *
 * Test mode: pass {writePidFile: false} to skip filesystem PID management
 * (lets unit tests run multiple daemons in :memory: without collision).
 */
export async function runDaemon(opts: { port?: number, writePidFile?: boolean } = {}): Promise<number> {
  const port = opts.port ?? (Number(process.env.RETCON_PORT) || DEFAULT_PORT)
  const writePid = opts.writePidFile ?? true

  ensureRetconDirs()
  const db = openDb({ path: retconDbPath() })
  migrate(db)

  const producer = createDefaultProducer(db)
  const tobeStore = createTobeStore(retconTobeDir())
  const mcpTools = createForkTools({ db, tobeStore, forkBackEnabled: true })

  const handle = await startServer({
    port,
    producer,
    tobeStore,
    mcpTools,
    db,
    dbPath: retconDbPath(),
  })

  if (writePid) {
    fs.writeFileSync(retconPidFile(), `${process.pid}\n`, { encoding: 'utf8' })
  }

  // Log startup so daemon.log shows the daemon came up. With stdio:'ignore'
  // and our log fd redirect, this lands in ~/.retcon/daemon.log.
  process.stdout.write(`[retcon] daemon up on http://127.0.0.1:${handle.port} (pid ${process.pid})\n`)

  return new Promise<number>((resolve) => {
    let shuttingDown = false

    const shutdown = async (sig: string, exitCode: number): Promise<void> => {
      if (shuttingDown) return
      shuttingDown = true
      process.stdout.write(`[retcon] daemon got ${sig}, shutting down\n`)
      await gracefulShutdown(handle, db)
      if (writePid) cleanupPidFile()
      resolve(exitCode)
    }

    process.on('SIGTERM', () => void shutdown('SIGTERM', 0))
    process.on('SIGINT', () => void shutdown('SIGINT', 0))
    process.on('uncaughtException', (err) => {
      process.stderr.write(`[retcon] uncaughtException: ${err.stack ?? err.message}\n`)
      void shutdown('uncaughtException', 1)
    })
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`[retcon] unhandledRejection: ${String(reason)}\n`)
      void shutdown('unhandledRejection', 1)
    })
  })
}

async function gracefulShutdown(handle: ServerHandle, db: ReturnType<typeof openDb>): Promise<void> {
  // Node http.Server.close() waits for keep-alive connections to drain. With
  // claude's MCP SSE channel held open, that wait is unbounded. Drop those
  // connections forcibly first.
  try { handle.closeAllConnections() }
  catch { /* best effort */ }

  // Race close() against a hard deadline. If a connection refuses to close
  // we still proceed to closeDb so the WAL checkpoints cleanly.
  await Promise.race([
    handle.close().catch(() => undefined),
    new Promise<void>(r => setTimeout(r, SHUTDOWN_DEADLINE_MS)),
  ])

  try { closeDb(db) }
  catch { /* best effort */ }
}

function cleanupPidFile(): void {
  try { fs.unlinkSync(retconPidFile()) }
  catch { /* may already be gone */ }
}
