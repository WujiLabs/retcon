// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Top-level orchestrator for `retcon [args...]`.
//
//   1. ensureDaemon()    boot or reuse the background proxy
//   2. mint sessionId    one stable UUID for this invocation
//   3. spawn claude with the sessionId wired into BOTH transports:
//      - /v1/* via ANTHROPIC_CUSTOM_HEADERS env (`x-playtiss-session`)
//      - /mcp  via inline --mcp-config JSON whose `headers` field carries
//        `Mcp-Session-Id`
//      - --session-id <id>  so claude's local jsonl filename matches
//   4. wait for claude exit, propagate exit code
//
// Why pre-mint instead of capturing claude's MCP-Session-Id mid-stream:
// the /v1/* transport may produce traffic before any /mcp call is made
// (claude probes /v1/messages immediately on start, regardless of whether
// MCP tools end up being needed). If we waited to capture an Mcp-Session-Id
// from a /mcp response, we'd have nothing to tag those early /v1/* events
// with — they'd land as orphan sessions and never correlate with the MCP
// session that arrives later. Pre-minting gives us one stable id we control,
// and we tell claude to use it for both transports.
//
// retcon CLI process is intentionally short-lived: the daemon outlives any
// one claude session. Closing this CLI does NOT close the daemon.

import { randomUUID } from 'node:crypto'
import { ensureDaemon, resolvedDefaultPort } from './daemon-control.js'
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

  // Step 1: ensure the daemon is running. Throws if a foreign process owns
  // the port; bubble that to the user.
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

  // Step 2: mint one session id to bind /v1/* and /mcp under one identity.
  // Must be a valid UUID for claude's --session-id flag.
  const sessionId = randomUUID()

  // Step 3: build the per-invocation MCP config that claude will load via
  // --mcp-config. Inline JSON keeps our config out of ~/.claude.json so
  // each retcon invocation is hermetic and concurrent invocations don't
  // race over the user's persistent config file.
  const mcpConfig = JSON.stringify({
    mcpServers: {
      retcon: {
        type: 'http',
        url: `http://${host}:${port}/mcp`,
        // Pre-set Mcp-Session-Id on every /mcp request from claude. The
        // daemon's handleInitialize respects an incoming Mcp-Session-Id
        // header in preference to minting a fresh one.
        headers: {
          'Mcp-Session-Id': sessionId,
        },
      },
    },
  })

  // Step 4: spawn claude. Args we inject are PREPENDED (so user-supplied
  // args still win on conflict — but conflicts on --session-id /
  // --mcp-config from the user are unusual and would defeat the binding,
  // so we don't try to be clever about deduping).
  const injectedArgs = [
    '--session-id', sessionId,
    '--mcp-config', mcpConfig,
  ]
  const result = await spawnAgent({
    agent: opts.agent,
    args: [...injectedArgs, ...opts.args],
    baseUrl: `http://${host}:${port}`,
    envOverrides: {
      // Tells claude's Anthropic SDK to add this header on every /v1/*
      // request. Format is newline-separated `Header: value` pairs.
      ANTHROPIC_CUSTOM_HEADERS: `x-playtiss-session: ${sessionId}`,
    },
  })
  if (result.spawnError) {
    process.stderr.write(`[retcon] ${result.spawnError}\n`)
  }
  return result.exitCode
}
