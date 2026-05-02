# retcon TODOs

Deferred from v1 launch. Source-of-truth alignment docs: `~/filo/collaboration-protocol/v1/`.

## P1 — release-blocking

- [ ] **Periodic assumption test re-run** — `cli-tmux-assumptions.test.ts` codifies the Claude Code behaviors retcon depends on (SessionStart firing on clear/compact/resume, `--session-id` UUID validation, `--session-id`+`--resume` conflict, fork_back stop_reason classification, MCP inputSchema requirement, etc.). Gated behind `RETCON_TEST_ASSUMPTIONS=1` so it doesn't run per implementation test. Add to release checklist or run weekly. Failure means a claude update changed an assumption and we need to adjust.
- [ ] **Real SQLite migration — write the actual per-version up-migrations** — (a) backup-before-migrate landed in v0.4.2 (`VACUUM INTO` snapshot to `~/.retcon/proxy.db.bak.v{old}.{ts}`); (b) registry framework is in `src/db.ts:MIGRATIONS` but empty — schema bumps after v5 need to register a function; (c) the v4→v5 CID-format jump (flat-hash → Merkle-hash leaf CIDs) still has no migration written, so a v4 DB upgrading to a v5 binary throws with backup-path-in-error. Decide whether to write that one (re-hash blobs by walking the events table, replaying loads through `computeStorageBlock`) or leave it as the documented "downgrade or wipe" path since v4 only ever existed in pre-release builds.
- [ ] **`@playtiss/core` rename downstream consumers** — graphql-server schema (`type Version`, `enum VersionType`, `parent_version_id` field, `current_version_id` field), graphql-server resolver parameter `scopeId` → `actorId`, `default_scope_id` → `default_actor_id`, downstream codegen consumers (cli, typescript-worker, pipeline-runner). Also rename SDK concrete `Version` / `OutputVersion` / `ErrorVersion` types together with the schema. Drop retcon's local naming-asymmetry comments. (playtiss-core-alignment.md §2.3, playtiss-graphql-server-alignment.md)

## P1 — protocol architecture (ready for `/plan-eng-review` against alignment docs)

- [ ] **Channel interface adoption** — wrap retcon SQLite + blob store as a `@playtiss/core` Channel impl. (playtiss-proxy-alignment.md §7.2)
- [ ] **fork_back as explicit Submit/Resolve** — refactor TOBE to be in-channel proposal queue. (§7.3)
- [ ] **Mount/Exit first-class for MCP session** — explicit `channel.mount()` at `session_initialized`. (§7.4)
- [ ] **Schema first-class via Naming Grammar** — register topic schemas. (§7.5)

## P2 — product UX hypothesis

- [ ] **`branch_compare` MCP tool (deferred CEO Proposal C)** — for the "I tried approach A, then B, which is actually better?" use case. `branch_compare(view_a, view_b)` returns divergence point + tail diffs of two forked branches. Real but lower priority — defer until concrete demand surfaces. Adds tool surface area; we want to validate the v0.4 5-tool surface first.
- [ ] **`--include-system-tools` flag on `dump_to_file`** — Phase 3 shipped in v0.4 with messages-only output (idea #5 from the v0.4 design plan). If a concrete need emerges for capturing the system prompt + tools[] alongside the messages, add this flag. Today the proxy.db blobs hold those independently, queryable directly; ship the flag only when a real consumer surfaces.
- [ ] **`retcon --cursor` / `retcon --aider` real impls** — agent flag dispatch is in v1 but only `--claude` works. Add other agents once ANTHROPIC_BASE_URL-equivalent integration is verified per agent.
- [ ] **Cross-session bookmark search** — `list_branches` is task-scoped (current session's task only). When the user has multiple sessions per project (multiple actors, or claude `--resume` chains that ended up on different tasks), there's no way to ask "where did I bookmark X across all my sessions?". Add an `actor_scoped: true` flag (or a new tool) that queries branch_views across every session under the current actor. Effort: M. Land if dogfood shows the cross-session find is a real need.
- [ ] **Per-turn branch lineage in recall list** — `recall()` list mode mixes turns from all branches under the same task in `sealed_at DESC` order. After a rewind, the AI sees turns from the new branch interleaved with turns from the pre-rewind branch, with no per-turn distinction. `list_branches` surfaces the navigation points (where each branch's head is); this TODO is about surfacing PER-TURN branch lineage in recall's list output. Cost: O(N) ancestor walks per list call, OR denormalize branch membership into the revisions table during projection. Defer until dogfood shows the unlabeled-mix is a real navigation problem (v0.5.0's SR rows with `kind: 'rewind_marker'` may already cover the most common case — they mark where rewinds happened, even if branch identity per turn isn't surfaced).
- [ ] **Push `n_back_of_head` computation into SQL for `list_branches`** — current implementation calls `forkableSequence(taskId)` to materialize ALL closed_forkable revision ids in memory, then does O(N) `seq.indexOf` per branch. Theoretical concern at 5000+ turns × 100+ branches = 500k string compares per call. Today's dogfood sessions are 50-200 turns, no measured impact. Fix: replace the helper with a per-row COUNT(*) subquery over the existing `idx_revisions_forkable` partial index (LEFT JOIN against the branch's head_revision_id; null when head is non-forkable). ~15 LOC + test. Land if `list_branches` shows up in real perf data.

## P2 — v0.5.0 SR follow-ups

- [ ] **Backfill SR rows for v0.4.x sessions** — v0.5.0 inserts synthetic departure Revisions (SR) on every successful `rewind_to`/`submit_file`, but pre-existing v0.4.x sessions in `proxy.db` have no SR rows for their old rewinds. `recall` on those sessions surfaces only the real Revisions; the rewind boundaries don't show up as `kind: 'rewind_marker'` entries. A one-time migration could walk historical `fork.back_requested` events that have a corresponding `tobe_applied_from` follow-up (= the splice ran), reconstruct the synthetic body, and INSERT the SR rows retroactively. Effort: M. Land if dogfood across long-lived sessions shows the gap is annoying.
- [ ] **`rewind_to({turn_id: SR.id})` UX polish** — cascade rewinds (rewinding back to a previous rewind marker) work mechanically via `reconstructForkMessages` reading SR.asset_cid like any other turn. But the UX of "I want to go back to where the last rewind started" might warrant tool description tweaks based on dogfood — e.g., does the AI know SR rows are valid `rewind_to` targets? Phase 3 tool description mentions this but real-world adoption needs verification. No code change unless dogfood surfaces a confusion pattern.
- [ ] **Auto-create labeled `branch_views` at SR creation time** — currently SR is a Revision (in `revisions`), and `branch_views` are a separate navigation surface (auto fork-point views still get created on `fork.back_requested`). A future enhancement could auto-create a labeled `branch_view` at SR insertion so `list_branches` surfaces SR rows alongside bookmarks. Trade-off: `branch_views` are mutable cursors that auto-advance; SR is immutable. Mixing them muddies the semantics. Defer unless a concrete workflow needs SRs in the bookmark list.
- [ ] **`fork.synthesis_failed` audit consistency** — proxy-handler emits `fork.synthesis_failed` when `buildSyntheticAsset` returns null or throws (real v0.5+ failures), but only `console.warn`s when `pending.synthetic` is missing (pre-v0.5 daemon TOBE). Both are "synthesis didn't happen" conditions; only one gets an audit event. Could emit `fork.synthesis_failed` with `error_message: "pre-v0.5 TOBE shape — backward-compat skip"` for symmetry. Cosmetic; observability is the only delta. Surfaced by /review on v0.5.0-alpha.0.

## P3 — investigations

- [ ] **`cli-tmux-integration` test 2 (resume + rewind across boundary) flakes** — captured pane shows the post-resume `DURIAN` rewind prompt is never delivered to the resumed claude session via tmux send-keys. Hypothesis: claude `--resume` may not re-apply the `--settings` permission allowlist the same way new sessions do, so claude hits a hidden permission prompt that consumes input. Reproduction: run `RETCON_TEST_INTEGRATION=1 pnpm test src/test/cli-tmux-integration.test.ts` — tests 1 and 3 pass, test 2 times out at `NEW fork.back_requested event under originalSessionId post-resume`. Verify by capturing the pane mid-timeout and checking for "Do you want to proceed?". If confirmed, fix in retcon's CLI or in the test setup. Surfaced in v0.5.0-alpha.2 once the prefix-name fix unblocked test 1 — was previously hidden behind that more-fundamental failure.

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

## Completed

- [x] **ToBe-as-file MVP (Phase 3 of MCP UX redesign plan)** — `dump_to_file` + `submit_file` MCP tools. Same opaque dual-secret + loud-failure contracts as `rewind_to`, with assistant-must-end validation on the JSONL so the appended user message blends naturally. **Completed:** v0.4.0-alpha.0 (2026-04-30).
- [x] **MCP tool-adoption A/B test harness (Phase 4 of MCP UX redesign plan)** — gated tmux test (`RETCON_TEST_INTEGRATION=1` AND `RETCON_TEST_TOOL_ADOPTION=1`) drives Sonnet AND Opus through natural-language rewind/bookmark/dump scenarios with no `mcp__retcon__X` hand-holding. Asserts the right tool was invoked end-to-end via the event log + filesystem. **Completed:** v0.4.0-alpha.0 (initial harness), v0.4.1-alpha.0 (verification fixes — userTurn predicate, ready-detect, instrumentation).
