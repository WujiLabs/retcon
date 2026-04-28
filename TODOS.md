# retcon TODOs

Deferred from v1 launch. Source-of-truth alignment docs: `~/filo/collaboration-protocol/v1/`.

## P1 — protocol architecture (ready for `/plan-eng-review` against alignment docs)

- [ ] **Channel interface adoption** — wrap retcon SQLite + blob store as a `@playtiss/core` Channel impl. (playtiss-proxy-alignment.md §7.2)
- [ ] **fork_back as explicit Submit/Resolve** — refactor TOBE to be in-channel proposal queue. (§7.3)
- [ ] **Mount/Exit first-class for MCP session** — explicit `channel.mount()` at `session_initialized`. (§7.4)
- [ ] **Schema first-class via Naming Grammar** — register topic schemas. (§7.5)

## P1 — cross-package alignment

- [ ] **`@playtiss/core` rename downstream consumers** — graphql-server schema (`type Version`, `enum VersionType`, `parent_version_id` field, `current_version_id` field), graphql-server resolver parameter `scopeId` → `actorId`, `default_scope_id` → `default_actor_id`, downstream codegen consumers (cli, typescript-worker, pipeline-runner). Also rename SDK concrete `Version` / `OutputVersion` / `ErrorVersion` types together with the schema. Drop retcon's local naming-asymmetry comments. (playtiss-core-alignment.md §2.3, playtiss-graphql-server-alignment.md)

## P2 — product UX hypothesis

- [ ] **ToBe-as-file MVP** — dump messages array to local JSON, AI edits with Read/Edit, fork_apply on next /v1/messages. Validate UX before committing. Edge cases: concurrent edits, edits during streaming, malformed JSON, AI editing fields it shouldn't.
- [ ] **`retcon --cursor` / `retcon --aider` real impls** — agent flag dispatch is in v1 but only `--claude` works. Add other agents once ANTHROPIC_BASE_URL-equivalent integration is verified per agent.

## P3 — operational

- [ ] **Real SQLite migration** (replace nuke-and-recreate) once v1.0+ has users with audit logs worth preserving.
- [ ] **Verify `@playtiss/proxy` deprecation tombstone** still resolves on registry.
- [ ] **MCP CLI result caching** — skip `claude mcp get` when `~/.claude.json` mtime unchanged. ~200ms savings per `retcon` invocation. Cache TTL 5 min.
- [ ] **Daemon log rotation** for `~/.retcon/daemon.log`. Rotate at 100MB or daily, keep 7 days.
- [ ] **Idle timeout option** — `RETCON_IDLE_TIMEOUT` env var to auto-stop daemon after N minutes of no traffic. Off by default.
- [ ] **XDG_DATA_HOME / XDG_RUNTIME_DIR** — Linux convention compliance for `~/.retcon/`.
- [ ] **Encrypted at-rest** for `proxy.db` — local trust model is fine for v1 single-user; add for shared machines.
- [ ] **Windows path/signal support** — currently macOS + Linux only.

## P3 — DX

- [ ] **`retcon doctor`** subcommand — check claude on PATH, MCP entry exists at user scope, port 4099 free or owned by retcon, permissions on `~/.retcon/`, daemon health. Useful for triage.
- [ ] **Auto-update notifier** — warn if a newer retcon version is on npm.
