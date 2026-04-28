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
//        (NEW SESSION ONLY — `--session-id` conflicts with `--resume`/
//        `--continue`; in that case we omit it and rely on the SessionStart
//        hook to bind the transport id to claude's actual session_id post-
//        picker.)
//      - --settings inline JSON installs a SessionStart HTTP hook that
//        POSTs to /hooks/session-start with the binding token in headers.
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
 * Detect whether user-supplied args put claude into resume mode. `--resume`
 * accepts an optional positional id (`--resume <session-id>`) or runs the
 * picker UI when used alone. `--continue` always picks the most recent.
 * Either flag is incompatible with `--session-id`, so we have to choose.
 */
export function detectResumeMode(args: readonly string[]): boolean {
  for (const a of args) {
    if (a === '--resume' || a === '--continue' || a === '-r' || a === '-c') return true
    // Long-form with `=` syntax: `--resume=<id>`
    if (a.startsWith('--resume=') || a.startsWith('--continue=')) return true
  }
  return false
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

  // Step 2: mint one transport id to bind /v1/* and /mcp under one identity.
  // For new sessions this becomes claude's session_id (--session-id T).
  // For --resume/--continue we cannot pass --session-id, so this stays as a
  // binding_token until the SessionStart hook arrives with claude's real id.
  const transportId = randomUUID()
  const isResume = detectResumeMode(opts.args)

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
          'Mcp-Session-Id': transportId,
        },
      },
    },
  })

  // SessionStart hook config. Claude calls our daemon on session start +
  // resume so we can learn its actual session_id and rebind the transport id.
  //
  // We use a command hook (not http) because Claude Code rejects http hooks
  // for SessionStart specifically: "HTTP hooks are not supported for
  // SessionStart" (verified against v2.1.122). The command pipes stdin (the
  // hook payload JSON) to curl, which POSTs to our daemon. The transport id
  // travels via the RETCON_BINDING env var, which we set on the child.
  //
  // For new-session it's a harmless echo (transport id == claude session_id);
  // for resumed sessions it's how we learn claude's session_id post-picker.
  const hookCmd
    = `curl -sS -X POST -H 'content-type: application/json' `
    + `-H "x-playtiss-session: $RETCON_BINDING" `
    + `--data-binary @- http://${host}:${port}/hooks/session-start >/dev/null`
  const settings = JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: hookCmd,
              timeout: 5,
            },
          ],
        },
      ],
    },
  })

  // Step 4: spawn claude. Args we inject are PREPENDED (so user-supplied
  // args still win on conflict — but conflicts on --session-id /
  // --mcp-config from the user are unusual and would defeat the binding,
  // so we don't try to be clever about deduping).
  //
  // For resume mode, omit --session-id (claude rejects --session-id together
  // with --resume/--continue unless --fork-session is also set).
  const injectedArgs = isResume
    ? ['--mcp-config', mcpConfig, '--settings', settings]
    : ['--session-id', transportId, '--mcp-config', mcpConfig, '--settings', settings]
  const result = await spawnAgent({
    agent: opts.agent,
    args: [...injectedArgs, ...opts.args],
    baseUrl: `http://${host}:${port}`,
    envOverrides: {
      // Tells claude's Anthropic SDK to add this header on every /v1/*
      // request. Format is newline-separated `Header: value` pairs.
      ANTHROPIC_CUSTOM_HEADERS: `x-playtiss-session: ${transportId}`,
      // Available to the SessionStart command hook so it can echo the
      // binding token back to the daemon (see settings JSON above).
      RETCON_BINDING: transportId,
    },
  })
  if (result.spawnError) {
    process.stderr.write(`[retcon] ${result.spawnError}\n`)
  }
  return result.exitCode
}
