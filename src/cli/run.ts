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
import http from 'node:http'

import { ANTHROPIC_UPSTREAM } from '../proxy-handler.js'
import { DEFAULT_ACTOR, extractActor } from './arg-parse.js'
import { isRecord, loadJsonArg, readFlag, removeFlag, validateUserArgs } from './arg-validate.js'
import { ensureDaemon, resolvedDefaultPort } from './daemon-control.js'
import { findClaudeBinary } from './find-claude.js'
import { spawnAgent } from './spawn-agent.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RunAgentOptions {
  agent: string
  args: readonly string[]
  /** Override port; defaults to RETCON_PORT or 4099. */
  port?: number
  /** Override host; defaults to 127.0.0.1. */
  host?: string
}

/**
 * Resolve the upstream provider that the daemon should proxy to.
 *
 * Users running claude through a non-Anthropic provider (OpenRouter, Bedrock-
 * proxy, Vertex shim, etc.) configure that via `ANTHROPIC_BASE_URL` in their
 * shell. retcon sits in the middle, so we capture that value before
 * overriding the env for the spawned claude (which we point at the local
 * daemon). Auth headers (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN) are left
 * on the child claude unchanged — claude attaches them per request and the
 * daemon forwards them as-is to the upstream provider.
 *
 * If the user already has ANTHROPIC_BASE_URL pointing at retcon's exact local
 * URL (e.g., they exported it in a previous shell session), don't recurse —
 * fall back to the default upstream. We compare strictly: a different
 * loopback URL (like a LiteLLM relay on :8080) is a legitimate third-party
 * upstream and we proxy to it, not to api.anthropic.com.
 */
export function resolveUpstream(env: NodeJS.ProcessEnv, retconBaseUrl: string): string {
  const userBase = env.ANTHROPIC_BASE_URL
  if (!userBase) return ANTHROPIC_UPSTREAM
  if (stripTrailingSlash(userBase) === stripTrailingSlash(retconBaseUrl)) {
    return ANTHROPIC_UPSTREAM
  }
  return userBase
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
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
 * Merge retcon's ANTHROPIC_CUSTOM_HEADERS contribution with the user's value.
 * The env var format is newline-separated `Header: value` pairs (per Anthropic
 * SDK), so concatenation with `\n` is the documented merge.
 *
 * Strips any existing `x-playtiss-session: ...` lines from the user's value
 * before appending ours. Without this, nested retcon invocations or shells
 * that re-export ANTHROPIC_CUSTOM_HEADERS from a previous run accumulate
 * stacked session headers; the daemon picks the first match and attributes
 * events to a stale or unrelated transport id.
 */
export function mergeCustomHeaders(
  userValue: string | undefined,
  ourHeader: string,
): string {
  if (!userValue || userValue.length === 0) return ourHeader
  // Drop any pre-existing x-playtiss-session line(s); case-insensitive on the
  // header name, anchor on either start-of-string or newline.
  const cleaned = userValue
    .split('\n')
    .filter(line => !/^\s*x-playtiss-session\s*:/i.test(line))
    .join('\n')
    .replace(/\n+$/, '')
  if (cleaned.length === 0) return ourHeader
  return `${cleaned}\n${ourHeader}`
}

/**
 * Pick the transport id retcon should bind under. If the user passed a valid
 * --session-id (only legal in non-resume mode anyway), adopt it as the
 * binding token rather than minting our own — it's what they expect to see
 * in the local jsonl filename, fork tools, etc.
 *
 * If the user passes a malformed --session-id (not a valid UUID), throw
 * loudly instead of silently substituting a fresh UUID. claude itself
 * requires a valid UUID for --session-id; surfacing the failure here gives
 * the user a clear message at retcon level rather than a downstream claude
 * error.
 *
 * Note: claude rejects --session-id together with --resume/--continue
 * (unless --fork-session is set), so we don't accept user-supplied ids
 * in resume mode either.
 */
export function pickTransportId(args: readonly string[], isResume: boolean): string {
  if (!isResume) {
    const userId = readFlag(args, '--session-id')
    if (userId !== undefined) {
      if (!UUID_RE.test(userId)) {
        throw new Error(
          `--session-id "${userId}" is not a valid UUID. `
          + `Pass a 36-character UUID (e.g. \`uuidgen | tr A-Z a-z\`) or omit --session-id `
          + `to let retcon mint one.`,
        )
      }
      return userId
    }
  }
  return randomUUID()
}

/**
 * Build the --settings JSON that gets handed to claude. Always installs
 * retcon's SessionStart command hook for binding-token rebind. If the user
 * passed their own --settings (file path or inline JSON), we deep-merge:
 * SessionStart hook entries are appended to the user's array; everything
 * else under `hooks.*` and other top-level keys is preserved as-is.
 *
 * Returns the combined JSON string AND a copy of `args` with the user's
 * `--settings <value>` removed (we replace it with our merged version so
 * claude doesn't see two competing flags).
 */
export function buildSettingsAndArgs(
  args: readonly string[],
  ourHookCmd: string,
): { settings: string, argsWithoutSettings: string[] } {
  const ourHookEntry = {
    hooks: [
      {
        type: 'command',
        command: ourHookCmd,
        timeout: 5,
      },
    ],
  }

  const userValue = readFlag(args, '--settings')
  if (userValue === undefined) {
    return {
      settings: JSON.stringify({ hooks: { SessionStart: [ourHookEntry] } }),
      argsWithoutSettings: [...args],
    }
  }

  const parsed = loadJsonArg(userValue)
  if (!isRecord(parsed)) {
    // User passed something unparseable (or non-existent file). Drop their
    // flag, install ours, and let claude surface their bad input via its
    // own settings-loader if there's still something to load.
    return {
      settings: JSON.stringify({ hooks: { SessionStart: [ourHookEntry] } }),
      argsWithoutSettings: removeFlag(args, '--settings'),
    }
  }

  // Deep-merge: clone, ensure hooks.SessionStart array exists, append ours.
  const merged: Record<string, unknown> = { ...parsed }
  const hooksRaw = isRecord(parsed.hooks) ? { ...parsed.hooks } : {}
  const sessionStartRaw = hooksRaw.SessionStart
  const sessionStartArr = Array.isArray(sessionStartRaw)
    ? [...sessionStartRaw, ourHookEntry]
    : [ourHookEntry]
  hooksRaw.SessionStart = sessionStartArr
  merged.hooks = hooksRaw

  return {
    settings: JSON.stringify(merged),
    argsWithoutSettings: removeFlag(args, '--settings'),
  }
}

/**
 * Run the agent (typically claude) under the retcon proxy. Returns the
 * agent's exit code (or 127 if the agent binary isn't on PATH).
 */
export async function runAgent(opts: RunAgentOptions): Promise<number> {
  const port = opts.port ?? resolvedDefaultPort()
  const host = opts.host ?? '127.0.0.1'
  const retconBaseUrl = `http://${host}:${port}`
  const upstream = resolveUpstream(process.env, retconBaseUrl)
  const isResume = detectResumeMode(opts.args)

  // Step 0a: extract retcon-only flags (--actor) before claude sees them.
  // Throws on a malformed actor name; surface to the user.
  let actorRequest: string | undefined
  let argsWithoutActor: string[]
  try {
    const parsed = extractActor(opts.args)
    actorRequest = parsed.actor
    argsWithoutActor = parsed.remaining
  }
  catch (err) {
    process.stderr.write(`[retcon] ${(err as Error).message}\n`)
    return 2
  }

  // Step 0b: validate user args against the things we're about to inject.
  // Today the only unmergeable conflict is mcpServers.retcon in --mcp-config.
  try {
    validateUserArgs(argsWithoutActor)
  }
  catch (err) {
    process.stderr.write(`[retcon] ${(err as Error).message}\n`)
    return 2
  }

  // Step 1: ensure the daemon is running with the right upstream. Throws if
  // a foreign process owns the port OR if a retcon daemon is up but
  // configured for a different upstream (treated like version mismatch — see
  // ensureDaemon).
  let daemon: Awaited<ReturnType<typeof ensureDaemon>>
  try {
    daemon = await ensureDaemon(port, { upstream })
  }
  catch (err) {
    process.stderr.write(`[retcon] ${(err as Error).message}\n`)
    return 1
  }
  if (daemon.spawnedNew) {
    process.stderr.write(`[retcon] daemon started on ${retconBaseUrl} → ${upstream}\n`)
  }

  // Step 2: pick the transport id retcon binds under. For a new session this
  // becomes claude's --session-id (and the local jsonl filename); for resume
  // it stays as a binding_token until the SessionStart hook posts back with
  // claude's actual session_id. If the user passed --session-id explicitly
  // and we're not in resume mode, adopt it instead of minting a fresh UUID
  // so the id they expect to see is the id retcon uses. Malformed UUIDs
  // throw — see pickTransportId.
  let transportId: string
  try {
    transportId = pickTransportId(argsWithoutActor, isResume)
  }
  catch (err) {
    process.stderr.write(`[retcon] ${(err as Error).message}\n`)
    return 2
  }
  // Drop the user's --session-id from args so we can re-inject our own
  // (same value if they supplied a valid UUID; freshly-minted otherwise).
  const argsWithoutSessionId = isResume
    ? [...argsWithoutActor]
    : removeFlag(argsWithoutActor, '--session-id')

  // Step 2b: tell the daemon what actor this transport id is launched under.
  // For new sessions, always register (default = "default"). For resume
  // without --actor, skip — the existing session keeps its recorded actor.
  // For resume WITH --actor, register so the daemon can conflict-check against
  // the existing session's actor at rebind time.
  const actorToRegister = actorRequest ?? (isResume ? undefined : DEFAULT_ACTOR)
  if (actorToRegister !== undefined) {
    try {
      await registerActor(host, port, transportId, actorToRegister)
    }
    catch (err) {
      process.stderr.write(`[retcon] failed to register actor: ${(err as Error).message}\n`)
      return 1
    }
  }

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
  // SessionStart" (verified against v2.1.122). The command runs an inline
  // Node script that reads claude's hook payload from stdin and POSTs it to
  // our daemon. Node-not-curl avoids two portability issues: curl isn't
  // always installed (rare but possible on minimal Linux containers), and
  // shell variable expansion differs between sh ($VAR) and cmd.exe (%VAR%).
  // The transport id is read inside the Node script via process.env, which
  // works identically across shells.
  //
  // The script is single-quoted JS only (no double quotes, no backticks, no
  // backslashes) so it survives both POSIX sh and Windows cmd.exe quoting
  // when wrapped in outer double quotes. Host and port are baked at
  // retcon-startup time so the script doesn't need extra env vars.
  //
  // For new sessions it's a harmless echo (transport id == claude session_id);
  // for resumed sessions it's how we learn claude's session_id post-picker.
  const hookScript
    = `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{`
      + `const r=require('http').request({hostname:'${host}',port:${port},`
      + `path:'/hooks/session-start',method:'POST',`
      + `headers:{'content-type':'application/json',`
      + `'x-playtiss-session':process.env.RETCON_BINDING}},res=>res.resume());`
      + `r.on('error',()=>{});r.end(d)})`
  const hookCmd = `node -e "${hookScript}"`
  // Build merged settings JSON. If the user passed --settings, our hook is
  // appended to their hooks.SessionStart array (rather than colliding); we
  // also drop their --settings flag so claude doesn't see two competing.
  const { settings, argsWithoutSettings } = buildSettingsAndArgs(argsWithoutSessionId, hookCmd)

  // Step 4: spawn claude. Args we inject are PREPENDED so the user-supplied
  // args we kept come last (claude's last-wins precedence). User --session-id
  // and --settings have been removed from `argsWithoutSettings`; user
  // --mcp-config is preserved verbatim (claude unions servers across
  // multiple --mcp-config flags, validateUserArgs already rejected the only
  // conflict — mcpServers.retcon).
  //
  // For resume mode, omit --session-id (claude rejects --session-id together
  // with --resume/--continue unless --fork-session is also set).
  const injectedArgs = isResume
    ? ['--mcp-config', mcpConfig, '--settings', settings]
    : ['--session-id', transportId, '--mcp-config', mcpConfig, '--settings', settings]
  // Resolve the actual claude binary, skipping any wrapper script in PATH
  // that re-invokes retcon (would fork-bomb). Only do this when the requested
  // agent is the special-cased "claude"; arbitrary agent names pass through.
  const resolvedAgent = opts.agent === 'claude' ? findClaudeBinary() : opts.agent

  // Merge our session header into any user-set ANTHROPIC_CUSTOM_HEADERS
  // (telemetry, anti-CSRF, etc.) instead of clobbering theirs.
  const ourHeader = `x-playtiss-session: ${transportId}`
  const mergedHeaders = mergeCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS, ourHeader)

  const result = await spawnAgent({
    agent: resolvedAgent,
    args: [...injectedArgs, ...argsWithoutSettings],
    baseUrl: `http://${host}:${port}`,
    envOverrides: {
      // Anthropic SDK reads this on every /v1/* request. Format is newline-
      // separated `Header: value` pairs.
      ANTHROPIC_CUSTOM_HEADERS: mergedHeaders,
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

/**
 * POST `{transport_id, actor}` to the daemon's `/actor/register` endpoint
 * before spawning claude. The daemon stores the binding in `pending_actors`
 * so the sessions_v1 projector can stamp the correct actor on the session
 * row when the first event arrives.
 *
 * Resolves on 2xx; rejects on any other status or transport error so the
 * caller can decide whether to abort the launch.
 */
function registerActor(
  host: string,
  port: number,
  transportId: string,
  actor: string,
): Promise<void> {
  const body = JSON.stringify({ transport_id: transportId, actor })
  return new Promise<void>((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path: '/actor/register',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 2000,
    }, (res) => {
      res.resume()
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve()
      }
      else {
        reject(new Error(`/actor/register returned HTTP ${res.statusCode}`))
      }
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('/actor/register timed out'))
    })
    req.on('error', reject)
    req.end(body)
  })
}
