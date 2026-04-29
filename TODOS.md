# retcon TODOs

Deferred from v1 launch. Source-of-truth alignment docs: `~/filo/collaboration-protocol/v1/`.

## P1 — release-blocking

- [ ] **Periodic assumption test re-run** — `cli-tmux-assumptions.test.ts` codifies the Claude Code behaviors retcon depends on (SessionStart firing on clear/compact/resume, `--session-id` UUID validation, `--session-id`+`--resume` conflict, fork_back stop_reason classification, MCP inputSchema requirement, etc.). Gated behind `RETCON_TEST_ASSUMPTIONS=1` so it doesn't run per implementation test. Add to release checklist or run weekly. Failure means a claude update changed an assumption and we need to adjust.
- [ ] **New assumption test: `/compact` summarization routes through `ANTHROPIC_BASE_URL`** — ARCHITECTURE.md §7 names this as load-bearing for the post-compact alignment story. Concrete check: trigger `/compact` in a forked session under tmux; assert that an extra `/v1/messages` event landed in the proxy's events table just before the SessionStart hook fires with `source=compact`, AND that the request body of that extra event was rewritten by us (i.e., contains the forked branch_context, not claude's pre-fork view). If a future claude release adds a side-channel summarization path, the summary would be of the wrong conversation and the user would notice the discontinuity post-compact.
- [ ] **Real SQLite migration** — replace `nuke-and-reinit on schema_version mismatch` with proper per-version migrations. Pre-1.0 alpha policy is "wipe", but the moment we ship a stable retcon people start accumulating event history they don't want to lose. Tasks: (a) backup the existing DB to `~/.retcon/proxy.db.bak.v{old}.{ts}` before any destructive change, (b) write per-version up-migrations, (c) decide how to handle CID-format jumps (the v0.3→v0.4 Phase 2 shift from flat-hash to Merkle-hash leaf CIDs is the first one we'd need to migrate or live with co-existing).
- [ ] **`@playtiss/core` rename downstream consumers** — graphql-server schema (`type Version`, `enum VersionType`, `parent_version_id` field, `current_version_id` field), graphql-server resolver parameter `scopeId` → `actorId`, `default_scope_id` → `default_actor_id`, downstream codegen consumers (cli, typescript-worker, pipeline-runner). Also rename SDK concrete `Version` / `OutputVersion` / `ErrorVersion` types together with the schema. Drop retcon's local naming-asymmetry comments. (playtiss-core-alignment.md §2.3, playtiss-graphql-server-alignment.md)

## P1 — protocol architecture (ready for `/plan-eng-review` against alignment docs)

- [ ] **Channel interface adoption** — wrap retcon SQLite + blob store as a `@playtiss/core` Channel impl. (playtiss-proxy-alignment.md §7.2)
- [ ] **fork_back as explicit Submit/Resolve** — refactor TOBE to be in-channel proposal queue. (§7.3)
- [ ] **Mount/Exit first-class for MCP session** — explicit `channel.mount()` at `session_initialized`. (§7.4)
- [ ] **Schema first-class via Naming Grammar** — register topic schemas. (§7.5)

## P2 — product UX hypothesis

- [ ] **ToBe-as-file MVP** — dump messages array to local JSON, AI edits with Read/Edit, fork_apply on next /v1/messages. Validate UX before committing. Edge cases: concurrent edits, edits during streaming, malformed JSON, AI editing fields it shouldn't.
- [ ] **`retcon --cursor` / `retcon --aider` real impls** — agent flag dispatch is in v1 but only `--claude` works. Add other agents once ANTHROPIC_BASE_URL-equivalent integration is verified per agent.

## P3 — operational

- [ ] **body-blob format version marker** — `loadHydratedMessagesBody` distinguishes the link-walk path from the legacy raw-blob path by sniffing (does the decoded top blob have `messages: CID[]`?). Works under nuke-and-reinit but is fragile once real migrations land. Add a magic field, e.g. `{__retcon_split: 1, messages: [...links...], tools: [...]}`, when the migration design lands.
- [ ] **Verify `@playtiss/proxy` deprecation tombstone** still resolves on registry.
- [ ] **MCP CLI result caching** — skip `claude mcp get` when `~/.claude.json` mtime unchanged. ~200ms savings per `retcon` invocation. Cache TTL 5 min.
- [ ] **Daemon log rotation** for `~/.retcon/daemon.log`. Rotate at 100MB or daily, keep 7 days.
- [ ] **Idle timeout option** — `RETCON_IDLE_TIMEOUT` env var to auto-stop daemon after N minutes of no traffic. Off by default.
- [ ] **XDG_DATA_HOME / XDG_RUNTIME_DIR** — Linux convention compliance for `~/.retcon/`.
- [ ] **Encrypted at-rest** for `proxy.db` — local trust model is fine for v1 single-user; add for shared machines.
- [ ] **Windows path/signal support** — currently macOS + Linux only.
- [ ] **Rename `retcon clean` → `retcon prune`?** — current name doesn't signal that this destroys events (the source-of-truth log) for the actor, not just projected views. `prune` reads more "destructive of history". Bikeshed; can wait for first release.

## P3 — DX

- [ ] **`retcon doctor`** subcommand — check claude on PATH, MCP entry exists at user scope, port 4099 free or owned by retcon, permissions on `~/.retcon/`, daemon health. Useful for triage.
- [ ] **Auto-update notifier** — warn if a newer retcon version is on npm.
