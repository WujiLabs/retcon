// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Top-level orchestrator for `retcon [args...]`. Stitches together:
//
//   ensureDaemon()       boot or reuse the background proxy
//   ensureMcpEntry()     register retcon as a Claude Code MCP server
//                        (idempotent; non-fatal on failure)
//   spawnAgent()         launch claude with ANTHROPIC_BASE_URL injected,
//                        wait for it to exit
//
// retcon CLI process is intentionally short-lived: the daemon outlives any
// one claude session. Closing this CLI does NOT close the daemon.

import { ensureDaemon, resolvedDefaultPort } from './daemon-control.js'
import { ensureMcpEntry } from './mcp-config.js'
import { spawnAgent } from './spawn-agent.js'

export interface RunAgentOptions {
  agent: string
  args: readonly string[]
  /** Override port; defaults to RETCON_PORT or 4099. */
  port?: number
  /** Override host; defaults to 127.0.0.1. */
  host?: string
}

/**
 * Run the agent (typically claude) under the retcon proxy. Returns the
 * agent's exit code (or 127 if the agent binary isn't on PATH).
 */
export async function runAgent(opts: RunAgentOptions): Promise<number> {
  const port = opts.port ?? resolvedDefaultPort()
  const host = opts.host ?? '127.0.0.1'

  // Step 1: ensure the daemon is running on the chosen port. Throws if a
  // foreign process owns the port; bubble that error to the user.
  let daemon: Awaited<ReturnType<typeof ensureDaemon>>
  try {
    daemon = await ensureDaemon(port)
  }
  catch (err) {
    process.stderr.write(`[retcon] ${(err as Error).message}\n`)
    return 1
  }

  if (daemon.spawnedNew) {
    process.stderr.write(`[retcon] daemon started on http://${host}:${port}\n`)
  }

  // Step 2: best-effort MCP registration so claude can see the fork tools.
  // Failures here don't block the run — claude will work, just without the
  // MCP fork tools available.
  const mcp = await ensureMcpEntry(port, host)
  switch (mcp.kind) {
    case 'added':
      process.stderr.write(`[retcon] registered MCP server "retcon" (user scope)\n`)
      break
    case 'replaced':
      process.stderr.write(`[retcon] updated MCP server "retcon" → http://${host}:${port}/mcp\n`)
      break
    case 'noop':
      // Already correct; quiet.
      break
    case 'skipped':
      process.stderr.write(
        `[retcon] warning: claude CLI not found on PATH — skipping MCP registration\n`,
      )
      break
    case 'failed':
      process.stderr.write(`[retcon] warning: MCP registration failed: ${mcp.reason}\n`)
      break
  }

  // Step 3: spawn the agent and wait. Exit code is whatever the agent
  // returned — retcon is invisible to the user from this point.
  const result = await spawnAgent({
    agent: opts.agent,
    args: opts.args,
    baseUrl: `http://${host}:${port}`,
  })
  if (result.spawnError) {
    process.stderr.write(`[retcon] ${result.spawnError}\n`)
  }
  return result.exitCode
}
