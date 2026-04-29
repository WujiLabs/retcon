# Changelog

All notable changes to `@playtiss/retcon` are documented here.

## [0.2.1-alpha.0] - 2026-04-28

Hardening pass on top of 0.2.0. No new user-facing features, but fewer surprises across the realistic shapes of a real user's environment.

### Fixed

- **Custom localhost upstreams no longer get silently rerouted to api.anthropic.com.** If you set `ANTHROPIC_BASE_URL=http://localhost:8080` to point at a LiteLLM relay, devstack mock, or any other non-retcon local proxy, retcon now proxies to that URL instead of swallowing it as a self-reference. Previously the prefix check was too broad and your auth tokens could land at the wrong provider.
- **`ANTHROPIC_CUSTOM_HEADERS` no longer accumulates stale `x-playtiss-session` lines** when retcon is invoked from a shell that re-exported headers from a previous run (or from inside a nested retcon). Pre-existing session headers are stripped before our fresh one is appended.
- **Resume binding is now race-free.** The in-memory binding-table is updated *before* the SQL rebind transaction, so a `/v1/messages` request landing in the window between transaction commit and binding registration no longer gets stranded under the old transport id.
- **Hook endpoint `/hooks/session-start` rejects oversize bodies.** A slow-loris-shaped local client could previously stream bytes past the 64 KiB cap indefinitely; now the connection is destroyed on overflow.
- **Stuck daemons fail loudly instead of silently.** If `retcon stop` (or the version-replace path) sends SIGKILL and the process refuses to die, retcon refuses to delete the PID file and surfaces a clear error pointing at the offending PID. The next invocation no longer spawns a fresh daemon that immediately fails its bind.

### Added

- **Daemon env now passes corporate-network knobs through.** `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` were missing from the allow-list; users behind MITM proxies or with private CA bundles previously hit silent TLS failures while their interactive `claude` worked fine.
- **`pnpm lint` and `pnpm lint:fix` scripts** in `package.json` so the lint config stays runnable without remembering the binary path.

### Changed

- **SessionStart hook uses inline `node -e` instead of `curl`.** Works wherever Node runs (which is wherever claude itself runs). curl isn't always installed on minimal Linux containers, and shell variable expansion differs between sh (`$VAR`) and cmd.exe (`%VAR%`); reading the binding token via `process.env` inside the Node script sidesteps both.
- **`loadJsonArg` file-size cap raised from 1 MiB to 10 MiB.** Real `--mcp-config` / `--settings` files are KBs to a few hundred KB; 10 MiB leaves comfortable headroom for unusual setups while still bounding worst-case allocation.
- **`findClaudeBinary` skips PATH entries that resolve to directories.** If your PATH happened to contain a directory named `claude`, retcon would previously try to spawn it and surface `EISDIR`. Now it walks past quietly.

### For contributors

- Full `eslint --fix` pass across the package. 51 files touched, no behavior change. 212 unit tests + 2 tmux integration tests still pass. The remaining errors that `--fix` couldn't handle (try/catch and lambda one-liners, unused imports, one `require()` import) were resolved manually.

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
