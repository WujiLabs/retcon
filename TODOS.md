# retcon TODOs

Deferred from v1 launch. Source-of-truth alignment docs: `~/filo/collaboration-protocol/v1/`.

## P1 — fork persistence follow-ups

- [ ] **Validate persistent fork under `/compact`** — Claude's `/compact` summarizes the EARLIEST messages in claude's local jsonl. The proxy's `branch_context_json` is the source of truth for what the model sees, so a compacted claude body should not corrupt the forked branch (the suffix-after-penultimate-user algo only reads the tail of claude's body). Worth a tmux test that explicitly triggers `/compact` mid-fork and asserts the model still answers from the forked context. Defer to v1.1.
- [ ] **Content-addressed message storage in blobs table** — currently every `/v1/messages` request body is stored as one whole blob. Storage scales O(N²) as the conversation grows, since each turn re-includes all prior messages. Refactor so each message in the `messages` array is serialized + hashed individually (DAG-JSON via `@playtiss/core`'s `computeTopBlock`), stored as its own blob, and replaced with a CID link in the parent body. Same for `tools[]` entries (they rarely change across turns and should dedupe perfectly). Keep `sessions.branch_context_json` as fully-expanded JSON for hot-path performance — only the projector blob storage needs to be link-ified. Reader (`reconstructForkMessages` in `mcp-tools.ts`) needs a "follow-links and hydrate" step to assemble full messages from a link-ified body. ~250 LOC + tests; defer to v1.1.

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
