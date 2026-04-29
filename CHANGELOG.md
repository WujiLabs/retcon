# Changelog

All notable changes to `@playtiss/retcon` are documented here.

## [0.2.0-alpha.0] - 2026-04-28

First end-to-end-usable alpha. retcon spawns claude as a child process, owns one detached daemon per machine, and now survives the realistic shapes of a real user's environment: resumed sessions, custom upstreams, wrapper scripts, conflicting flags, and stray credentials in the shell.

### Added

- **`retcon --resume` and `retcon --continue`** — late-binding via a `SessionStart` command hook installed through `--settings`. claude rejects `--session-id` together with `--resume`, so retcon mints a binding token, hands it to claude, and rebinds to claude's actual session id once the picker resolves. The daemon merges the binding-token's task into the resumed session's task and reconnects the DAG, so `fork_back` walks across the resume boundary.
- **Custom Anthropic-compatible upstream via `ANTHROPIC_BASE_URL`** — point retcon at OpenRouter, a Bedrock proxy, a Vertex shim, or anything else that speaks the Anthropic API. retcon captures the value before overriding the env for claude, configures the daemon's upstream, and forwards `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` headers as-is. The path component of the upstream is preserved (so `https://openrouter.ai/api` + `/v1/messages` stays `.../api/v1/messages`).
- **Upstream mismatch detection** — if a daemon is already running with a different upstream than this invocation wants, retcon errors with an actionable message: `retcon stop` to restart, or `RETCON_PORT=<other> retcon ...` to use a different port. Same UX as version mismatch — prevents the silent-credential-leak failure mode where requests would land at the wrong provider.
- **User `--session-id` adoption** — if you pass a valid UUID via `--session-id` to a new session, retcon binds under your id rather than minting one. The id you typed is the id you'll see in claude's local jsonl filename and in fork tools.
- **Mergeable `--mcp-config` and `--settings`** — claude allows multiple of each, and retcon's injections coexist with yours. `mcpServers.*` keys union (we error only on a `retcon` key collision); your `hooks.SessionStart` array gets our binding hook appended so all your hooks fire alongside ours.
- **Mergeable `ANTHROPIC_CUSTOM_HEADERS`** — your existing telemetry / anti-CSRF headers survive retcon. We newline-append our session header instead of clobbering yours.
- **Wrapper-script protection** — if you've put a shell wrapper at `~/.local/bin/claude` that re-execs retcon (a common setup), retcon walks PATH and skips candidates whose realpath equals retcon's own, plus small shebang scripts that reference `retcon`. `RETCON_REAL_CLAUDE=/path/to/claude` is the escape hatch.
- **Daemon environment hygiene (allow-list)** — the long-lived daemon no longer inherits your provider credentials. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_*`, `OPENAI_*`, `GITHUB_TOKEN`, and any other vendor secret in your shell are stripped. Only system basics (`HOME`, `USER`, `PATH`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TMPDIR`), Node knobs (`NODE_OPTIONS`, `NODE_DEBUG`, `NODE_NO_WARNINGS`, `NODE_ENV`), and `RETCON_*` reach the daemon. claude (the child) still gets your full env — auth keys belong there.
- **`/hooks/session-start` endpoint** — receives claude's `SessionStart` hook payload and rebinds binding tokens to actual session ids. Emits `session.rebound` events into the log.
- **`/health` reports `upstream`** — the configured proxy target is now part of the daemon's identity snapshot.

### Changed

- **`retcon --resume <id>` works without `--session-id` collision.** Previously claude would reject the combination; retcon now drops `--session-id` injection in resume mode.
- **README.md rewritten** to reflect actual usage. The old `retcon &; ANTHROPIC_BASE_URL=... claude` example is gone — `retcon` spawns claude as a child itself.

### For contributors

- New modules: `src/binding-table.ts`, `src/hook-handler.ts`, `src/cli/find-claude.ts`, `src/cli/arg-validate.ts`.
- `cli/run.ts` exports `pickTransportId`, `buildSettingsAndArgs`, `mergeCustomHeaders`, `resolveUpstream`, `detectResumeMode` — all pure helpers covered by unit tests.
- `cli/daemon-control.ts` exports `buildDaemonEnv` (allow-list) and `normalizeUpstream` (URL canonicalization for equality checks).
- Test counts: 207 unit tests + 2 tmux integration tests (gated by `RETCON_TEST_INTEGRATION=1`).

## [0.1.0-alpha.0] - 2026-04-28

Initial alpha. CLI orchestrator + detached daemon + Claude MCP registration. `/v1/*` HTTP pass-through, `/mcp` Streamable HTTP transport, `/health` JSON identity. Fork tools (`fork_list`, `fork_show`, `fork_bookmark`, `fork_back`) wired up with the F4 cycle-prevention guard and TOBE-pending-file mechanism.

### For contributors

Rename of `playtiss-proxy/` to `@playtiss/retcon` with §7.1 SQL alignment (`versions` → `revisions`, `parent_version_id` → `parent_revision_id`, `head_version_id` → `head_revision_id`).

Notable fixes during the day's work:

- MCP `inputSchema` is required for claude to expose tools to the LLM (`tools/list` without it silently drops tools).
- gzip SSE bodies decompress before stop-reason extraction instead of stripping `accept-encoding`.
- Three correlation bugs fixed so `fork_back` actually works end-to-end: pre-mint session id at CLI start, parse comma-joined duplicate `Mcp-Session-Id` headers, and feed the parser decompressed bytes.
