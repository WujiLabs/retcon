# Changelog

All notable changes to `@playtiss/retcon` are documented here.

## [0.4.0-alpha.0] - 2026-04-30

The release where retcon's MCP tools stop sounding like protocol jargon and start sounding like what the user actually wants to do. The empirical signal that drove this: Sonnet didn't reach for `fork_back` even when asked to rewind, while Opus did. That's a tool-design problem, not a model problem. We renamed (hard cut, no aliases — pre-1.0 alpha policy), rewrote descriptions in USE WHEN form, leaned out result text, and added a progressive-disclosure guardrail on `rewind_to` that delivers rules + an opaque dual-secret classifier on the first call so the AI can't bypass the rules-read with a guessed value.

### Migration

**Hard cut.** No deprecated aliases. If you have anything pointing at the old tool names, update it:

| Old | New | Notes |
|---|---|---|
| `mcp__retcon__fork_list` | `mcp__retcon__recall` | No args = list. |
| `mcp__retcon__fork_show` | `mcp__retcon__recall` | Pass `turn_id` or `turn_back_n` for detail mode. |
| `mcp__retcon__fork_back` | `mcp__retcon__rewind_to` | Two-step now: first call returns rules + tokens, re-call with `confirm=<clean_token>`. |
| `mcp__retcon__fork_bookmark` | `mcp__retcon__bookmark` | Same semantics. |
| `n` argument on `fork_back` | `turn_back_n` on `rewind_to` | Or pass `turn_id` to target a specific turn. |
| `MAX_FORK_BACK_MESSAGE_BYTES` | `MAX_REWIND_MESSAGE_BYTES` | Same 1 MiB cap. |
| `FORK_SHOW_MAX_DEPTH` | `RECALL_MAX_DEPTH` | Same 1000-depth cap. |
| `createForkTools` | `createMcpTools` | Same factory shape; tests can use `createMcpToolsWithTokens` to inject a `ConfirmTokenStore` for assertions. |

### Added

- **`recall` MCP tool.** Combines `fork_list` + `fork_show` into one intent-aligned tool. No args lists recent forkable turns with content previews + turn ids. Pass `turn_back_n: N` or `turn_id: "..."` to inspect a specific turn. Lean result text by default (turn_id, position, preview, stop_reason); `verbose: true` exposes internal fields for debugging.
- **`rewind_to` MCP tool — opaque dual-secret + narrow regex.** Replaces `fork_back`. First call WITHOUT a valid `confirm` token returns the rules text inline + a freshly-generated 8-char-random `confirm_clean` and `confirm_meta` token pair (server-side keyed by session_id with 5-min TTL, single-use). The AI classifies its own message and re-calls with the matching token. clean_token + clean message → narrow regex check (4 patterns: "see above", "continue from here/where we left off", "redo your/my last answer", "the last/previous question I asked/gave/sent") → write TOBE + return loud-failure-text response. clean_token + regex-matched message → rejection + new pair. meta_token → educational "good catch — revise" + new pair. The opaque tokens have no semantic prefix, so the AI can't pick the "ship it" path without reading the rules to learn which token does what. Includes `allow_meta_refs: true` escape hatch for the rare intentional case where a message references content visible in the rewound history.
- **`bookmark` MCP tool.** Renamed from `fork_bookmark`. Same semantics, intent-aligned name + USE WHEN description.
- **Permissions injection for `~/.retcon/dumps/`.** retcon's CLI now inline-merges `permissions.allow` entries for `Read/Edit/Write/Glob/Grep` over `<HOME>/.retcon/dumps/**` into the spawned claude's `--settings`. Lands in 0.4 even though the dumps directory is not used yet — it pre-allows the path that Phase 3's `dump_to_file` / `submit_file` tools will write to, so the AI can read/edit dumps without a permission prompt. Five entries per spawn, deduped against any user-supplied allowlist. New `retconAllowEntries(homeDir)` export in `cli/run.ts` for consumers + tests.
- **Loud-failure response on staged-action tools.** `rewind_to`'s scheduled-success response now includes a `RETCON ERROR: If you are reading this, the rewind did NOT take effect. Tell the user retcon failed to apply the change.` body. On the success path, the proxy's body-splice replaces the entire turn carrying this response, so the AI never reads it. If the splice fails for any reason, the AI sees the response and surfaces the failure to the user — fail-loud-by-construction at zero implementation cost.
- **Tests.** ~30 new unit tests covering dual-secret flow (first-call rules-return, static-value rejection, opaque-token regression guard, clean-token happy path, synthetic-message verbatim, meta-token self-flag, narrow regex catches, narrow regex no-false-positive regression guard, allow_meta_refs escape hatch, single-use consumption for both paths, TTL expiration), recall list-mode + detail-mode (turn_back_n + turn_id resolution, depth cap, verbose flag), bookmark, META_REFS detector + regex assertions, retconAllowEntries shape, settings-merge with user-supplied permissions (dedup, empty-permissions, append).

### Changed

- **MCP tool surface renamed.** Hard cut. See migration table above.
- **Tool descriptions in USE WHEN format.** Each tool's description leads with `USE WHEN: <intent-anchored sentence>`, followed by what the tool does, and ends with `NEXT STEPS:` naming concrete follow-ups. Designed to pull the AI into intent-thinking, not protocol-thinking.
- **Lean result text by default.** `recall` no longer returns `revision_id`, `task_id`, `parent_revision_id`, `asset_cid`, `classification`, etc. unless `verbose: true` is set. The default response is what the AI needs to make a decision: turn_id + preview + stop_reason. Internal fields move behind the verbose flag.
- **`createForkTools` → `createMcpTools`** in `src/mcp-tools.ts`. The exported factory name now matches what the tools surface is. `createMcpToolsWithTokens(deps, tokenStore)` is exposed for tests that need to inject a custom `ConfirmTokenStore` (e.g., for TTL/single-use assertions).
- **Constants renamed.** `MAX_FORK_BACK_MESSAGE_BYTES` → `MAX_REWIND_MESSAGE_BYTES`, `FORK_SHOW_MAX_DEPTH` → `RECALL_MAX_DEPTH`. Same values, same semantics.
- **Test files updated.** `cli-tmux-integration.test.ts` and `cli-tmux-assumptions.test.ts` now drive `mcp__retcon__rewind_to` (with explicit two-step instructions in the prompt) instead of `mcp__retcon__fork_back`. A future Phase 4 will add a tool-adoption A/B harness that tests rewind tool use against both Sonnet and Opus.

## [0.3.0-alpha.0] - 2026-04-29

The release where retcon's forks stop being one-shot. After `fork_back` you can keep going. Plus actor tagging + cleanup, content-addressed message storage that scales linearly with conversation length, and graceful handling of `/clear` and `/compact` inside claude.

### Added

- **Persistent fork branches.** Once you run `fork_back`, the forked branch stays alive for every subsequent /v1/messages turn until you start a new session, run `/clear`, or run `/compact`. Each new turn from claude gets spliced onto the fork's history at the penultimate-user message, so Anthropic sees a coherent conversation that picks up from your edit instead of from claude's local jsonl. Survives daemon restarts, `claude --resume`, and `claude --continue`. Run another `fork_back` to switch branches.
- **`--actor <name>` flag.** Tag a session under your own actor name for grouping and selective cleanup. 1–64 chars, `[A-Za-z0-9_-]`. Default actor is `default`. retcon also records the actor via a new `/actor/register` endpoint so the projector stamps it on the session row when the first event lands, even across daemon restarts between CLI launch and claude's first request.
- **`retcon clean --actor X` subcommand.** Wipe every row associated with sessions tagged under X: events, branch_views, revisions, tasks, sessions, pending registrations, and per-session TOBE pending files on disk. Defaults to dry-run; pass `--yes` to apply. Pass `--force` to override the daemon-running guard. Intended for cleaning up integration-test runs.
- **Content-addressed `/v1/messages` request bodies.** Each message and tool entry is hashed individually and stored as its own blob; the top body is encoded with CID links to those leaves. Identical messages across turns dedup perfectly, so storage no longer scales O(N²) with conversation length. The `system-reminder` user turn that claude replays on every request now costs one blob instead of N copies of the same bytes.
- **Graceful `/clear` and `/compact` handling.** When you run `/clear` or `/compact` inside claude, the SessionStart hook fires with the matching source. retcon drops the persistent fork override (which would otherwise re-inflate the body claude just wiped or compacted) and lets claude's local view drive future upstream calls. Each clear/compact emits a `session.branch_context_cleared` audit event.
- **`session.branch_context_overflow` audit event.** Hard cap at 8 MiB on the JSON-encoded fork branch context. Past that the column is NULL'd, the event fires, and the next request forwards claude's body unchanged. Hitting the cap means something went wrong (runaway tool loop, adversarial driver) — well past any model's actual context window.
- **`/actor/register` endpoint.** retcon CLI hits this at launch with the (transport_id, actor) pair so the projector can stamp the right actor on the session row. Persistent (vs in-memory) so a daemon restart between CLI register-time and the first event landing doesn't lose the actor. Stale entries (over an hour old) are garbage-collected on daemon startup.
- **Fork persistence assumption test suite.** `cli-tmux-assumptions.test.ts` codifies the Claude Code behaviors retcon depends on (SessionStart firing on clear / compact / resume, --session-id UUID validation, --session-id+--resume conflict, fork_back stop_reason classification, MCP inputSchema requirement). Gated behind `RETCON_TEST_ASSUMPTIONS=1` so it runs on a release-checklist cadence, not every PR. Failure = a claude update changed an assumption and we need to adjust.

### Changed

- **Schema bumped to v5.** Phase 2 (below) shifted per-message CIDs from a flat hash to a Merkle hash; bumping the schema forces nuke-and-reinit on upgrade per the alpha policy so dedup stays consistent. Existing `~/.retcon/proxy.db` from 0.2.x will be wiped on first launch.
- **`branch_context_json` column on sessions.** New TEXT column holding the persistent fork's full message history. NULL when the session is on its main branch.
- **`pending_actors` table.** Maps `transport_id → actor` for the brief window between `/actor/register` and the first `/v1/*` event.
- **`actor` column on sessions.** Default `'default'`; set from the pending registration on first event.
- **SessionStart hook now classifies four sources.** `startup`, `resume`, `clear`, `compact` — each handled distinctly. `clear` and `compact` invalidate `branch_context_json`; `resume` performs the binding-token rebind; `startup` is the no-op for the new-session path.

### For contributors

- **`store / load / resolve` moved from the SDK (`playtiss/asset-store`) to `@playtiss/core`.** The proxy's body-blob.ts now consumes those primitives directly, dropped its private dag-json helper and `@ipld/dag-json` + `multiformats` direct deps. Same on-disk shape for inline encodings; per-message CIDs use a Merkle hash now (hence the schema bump). See `@playtiss/core` 0.2.0-alpha.0.
- **New utility modules.** `src/util/actor-name.ts` (single source of truth for `ACTOR_RE`, `DEFAULT_ACTOR`, `validateActor`); `src/util/http-body.ts` (shared `readBoundedBody` helper used by both `/hooks/session-start` and `/actor/register`).
- **`SqliteStorageProvider` threaded through `ForkToolDeps` to mcp-tools.** Hydrate path now goes through `@playtiss/core`'s `load` + `resolve` rather than raw SQL on the blobs table.
- **Test count: 294 unit + 9 skipped + 2 gated tmux integration.** ~85 new tests across the release covering: `applyBranchContextRewrite` (7 cases including the 8 MiB overflow), `ActorConflictError` paths in `rebindSession` (6 cases), `handleActorRegister` HTTP boundary (8 cases + GC sweep), `handleSessionStartHook` over real `node:http` (11 cases), `readBoundedBody` (7 cases including slow-loris guard), branch-context-overflow integration through the proxy server, `detectLiveDaemon` (4 PID states), body-blob non-object guard + tools[] round-trip, binding-table bare-pending rebind, fork_back no-source-blob fallback, retcon-clean orphan-pending-actors paths, parseCleanArgs --force + missing-value-for-actor errors.
- **DRY cleanups.** Extracted `ACTOR_RE` (3 sites) and bounded-body reader (2 sites) to shared utils. `'default'` literal (5 sites in binding-table.ts + 1 in sessions-v1.ts) replaced with the `DEFAULT_ACTOR` constant. `schema_version` DDL deduplicated (3 sites in db.ts). `--actor` end-of-args silently passed through to claude; now throws `missing value for --actor`. Body-blob non-object JSON inputs (top-level array, null, primitive) used to silently spread index keys into the linkified top blob; now fall back to the single-raw-blob path. `applyBranchContextRewrite` return type dropped its dead `sentMessages` field.
- **Comments fixed.** F4 guard top-of-file comment was stale (claimed it rejects `open` / `in_flight`; actually walks past them to the nearest settled ancestor). `actor-register.ts` SQL comment said "INSERT OR REPLACE" but the SQL is `ON CONFLICT DO UPDATE` (and the comment now explains why we picked it). `applyBranchContextRewrite` JSDoc was orphaned by an adjacent const declaration; reordered.
- **`bindingTable.unset` on `ActorConflictError`.** Hook-handler now rolls back the speculative `bindingTable.set()` when `rebindSession` throws, so in-memory routing matches the rolled-back DB state. Previously a 409 left the in-memory binding active, causing split-brain.

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
