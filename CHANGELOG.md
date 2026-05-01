# Changelog

All notable changes to `@playtiss/retcon` are documented here.

## [0.4.4-alpha.0] - 2026-05-01

User started dogfooding retcon and hit the gap immediately: `bookmark()` saves a spot but there's no way to list, delete, or navigate around saved spots. Worse, after a `rewind_to`, the pre-rewind branch becomes unreachable by ancestor-walking from the post-rewind head — `branch_views` was the only mechanism preserving the pointer back, but with no read API the user had spotters they couldn't use. This release closes the gap with two new MCP tools and extends `recall` to navigate via branch_views. Tool count goes from 5 to 7 — the v0.4 lesson was that intent-aligned naming beats tool-count minimization, and packing list+delete into multi-mode `bookmark` would trade clarity for token count we don't need to save.

### Added

- **`list_branches` MCP tool.** Returns every `branch_views` row for the current session's task, ordered by `updated_at DESC`. Surfaces both explicit bookmarks (`auto_label` starts with `bookmark@`) and auto fork-point views (`auto_label` starts with `fork@`, created automatically by `rewind_to`). Each entry has a `kind: "bookmark" | "fork_point"` discriminator. The list is the only way to see and navigate to branches you've forked away from. Pagination via `limit` (1-200, default 50) and `offset`. `verbose: true` exposes `auto_label`, `created_at`, `updated_at`. `n_back_of_head: 0` = currently tracking head (auto-advance still active), `N>0` = N forkable turns back, `null` = head not in the closed_forkable sequence (rare reclassification).
- **`delete_bookmark` MCP tool.** Removes a single branch_view by `id_or_label`. Errors if a label matches multiple views (returns `ambiguous_view_ids`). Auto fork-point views (label=NULL) can only be deleted by view_id since the resolver's label query excludes NULL-label rows. Cross-session deletes silently fail resolution. Idempotent: deleting an already-deleted view returns "not found".
- **`fork.bookmark_deleted` event topic.** Payload `{view_id, task_id}`. `BranchViewsV1Projector` subscribes and runs `DELETE FROM branch_views WHERE id = ? AND task_id = ?`. The event log itself is append-only (replayable); the DELETE applies to the projected view only.
- **`recall({view_id})` entry path.** Resolves to the branch_view's CURRENT `head_revision_id` (live, advances with auto-advance), then runs the existing detail-mode code. Mutually exclusive with `turn_id` and `turn_back_n`. The two-call workflow `recall({view_id})` → `rewind_to({turn_id})` is intentional — forces the AI to inspect what the branch really is before rewinding to it. A single-call `rewind_to({view_id})` shortcut was considered and rejected: friction-as-safety catches stale labels and AI confusion about which view is which.
- **`recall({surrounding: N})` window.** When inspecting a turn (via `turn_id`, `turn_back_n`, or `view_id`), also returns N forkable turns before AND after the inspected turn (0-10 each side). Each tagged with `relative_to_target` (negative = older, positive = newer). Omitted from response when 0 / unset to keep shape minimal. Useful for "what was happening around this saved spot?".
- **`recall()` list-mode `rewind_events` field.** Surfaces `fork.back_requested` events for THIS session inline with the turn list (LIMIT 50). Each entry: `{at, from_turn_id, to_turn_id, view_id}`. The AI scans turns + events by timestamp to see "a rewind happened here between turns X and Y". The fork-point view_id is the navigable handle.
- **`recall()` detail-mode `branch_views_at_turn` field.** Lists every branch_view (bookmark + fork_point) whose `head_revision_id` matches the inspected turn. Empty array when none.
- **24 new unit tests across the new tools and recall extensions.** Phase 1 (delete_bookmark): 9 tests covering happy paths, ambiguous label, cross-session reject, label-on-fork-point reject, label-collision-skips-fork-points, idempotent delete, projector task_id mismatch silent skip. Phase 2 (list_branches): 6 tests for empty, mixed kind, n_back tracking/frozen/null cases, pagination. Phase 3 (recall extensions): 9 tests for view_id resolution, view_id-not-found, surrounding window correctness, edge clipping, rewind_events populated/empty, branch_views_at_turn, deleted-view error, surrounding=0 omits field.

### Changed

- **`bookmark` tool description rewritten.** Now explicitly documents the git-branch-like (not git-tag-like) auto-advance behavior. The label may still be NULL when no `label` arg is passed.
- **`recall` tool description rewritten.** Surfaces the new `view_id` and `surrounding` arms, and the `rewind_events` / `branch_views_at_turn` outputs. Mutual-exclusion error message now reads "pass exactly one of turn_id, turn_back_n, view_id" (was "pass either turn_id or turn_back_n, not both").
- **Inline ASCII diagram in `branch-views-v1.ts:onResponseCompleted`.** Documents the auto-advance state transitions before the handler so future readers see git-branch-like behavior is the design, not an accident.
- **README "Rewind tools" section.** Two new bullets, two new "When to reach for which" rows, plus updated bookmark/recall descriptions.
- **ARCHITECTURE.md "How the AI sees its past" section.** Tool count updated to seven. New paragraph on the read/write split, new subsection "Branches are git-branch-like, not git-tag-like" explaining the two `branch_views` kinds and the live-resolution semantics of `view_id`.

## [0.4.3-alpha.0] - 2026-05-01

User hit a 400 from Anthropic mid-conversation: `messages.112.content.0.cache_control.ttl: a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`. We had the count cap (4 markers max, 0.4.1) but not the TTL ordering invariant. This release adds a pre-pass that strips redundant earlier 5m markers when a later 1h marker is present — Anthropic's prefix-lookback already covers everything the earlier 5m would have anchored. Caught the b17275fb session's specific 400s in forensic dry-run; both bodies are valid post-fix.

The wrinkle: this was after a `/compact` that ran inside a forked branch. branch_context_json was NULL'd at compact-release time, but the compact summary itself was generated through the forked branch — so the message history claude is now sending carries marker placement inherited from the rewound conversation. Not 100% claude's fault, not 100% retcon's: an edge case at the boundary.

### Added

- **`stripTtlViolations(parsedBody)` helper in `proxy-handler.ts`.** Walks markers in Anthropic's processing order (`tools` → `system` → `messages`), finds the index of the last `ttl='1h'` marker, and strips every `ttl='5m'` marker before it. Default-TTL (no `ttl` field) is treated as `5m` per Anthropic's spec. Mutates in-place; returns the count of markers removed. Same `hasMarker` semantics as `capCacheControlBlocks` (null/undefined cache_control values are no-ops, not slot consumers).
- **`proxy.cache_control_ttl_violation_fixed` audit event.** Fires when `stripTtlViolations` strips at least one marker. Payload `{session_id, removed}`. Lets you see how often claude's marker placement violates Anthropic's ordering rule and how aggressively retcon is rewriting.
- **12 unit tests for `stripTtlViolations`** covering: no-markers no-op, all-1h no-op, all-5m no-op, valid-order no-op, both real failing-body shapes from b17275fb (5m-in-messages-before-1h, 5m-in-system-before-1h-in-messages), trailing-5m-after-last-1h-survives, default-TTL-treated-as-5m, tools→system→messages ordering, cross-section strips (tools 5m before messages 1h), null-cache_control-not-counted, runs-cleanly-alongside-capCacheControlBlocks.

### Changed

- **Request handler runs `stripTtlViolations` BEFORE `capCacheControlBlocks`.** The TTL pre-pass removes redundant 5m markers first so the count cap doesn't waste a slot on a marker that's about to be invalidated anyway. Re-serializes the body if either step modified anything.
- **`scripts/audit-cc.mjs` forensic tool.** Now bundled with the repo (was untracked, used during 0.4.3 investigation). Reads `~/.retcon/proxy.db` and prints a request body's cache_control marker layout in processing order. Pass `--fix` to dry-run `stripTtlViolations` against a real body and print before/after — useful when triaging a future 400.

## [0.4.2-alpha.0] - 2026-04-29

End of the "schema bump wipes your DB" era. retcon's first real user is starting to depend on the event log surviving across upgrades, and silently dropping every table on a schema mismatch is unacceptable for that. This release replaces the nuke-and-reinit shortcut with a backup + per-version migration registry. Empty registry for now (v5 is the only release in the wild and the only entry path is fresh-install), but the framework is in place so the next schema bump has somewhere to land.

### Changed

- **DB migration policy: no more silent wipes.** When `migrate()` finds an on-disk DB at an older schema_version than the current binary, it now (1) takes a `VACUUM INTO` snapshot to `<dbPath>.bak.v<old>.<ISO-ts>` so the user has a fallback, then (2) walks `MIGRATIONS[from] → MIGRATIONS[from+1] → ...` applying each registered step. If any step is missing from the registry, `migrate()` throws with the backup path and the live DB is left untouched. Previous behavior (`DROP TABLE` everything and recreate at current) is gone. The error message tells the user where the backup is and how to recover (downgrade retcon, restore the backup, or remove the live DB to start fresh).
- **`MIGRATIONS` registry in `src/db.ts`.** `Record<number, (db: DB) => void>`, keyed by from-version. Empty for v0.4.2 since v5 is the only release. Future schema bumps register a function under the from-version when they bump `CURRENT_SCHEMA_VERSION`.
- **`migrate(db, dbPath?)` signature.** The optional `dbPath` enables backups; omit for `:memory:` tests where there's no file to copy. Threaded through `cli/daemon.ts:runDaemon` so production launches always supply it.
- **`openDb({ path, readonly: true })` no longer tries to set WAL pragmas.** Read-only opens can't write the DB header, so `journal_mode = WAL` and `wal_autocheckpoint` are skipped. `foreign_keys = ON` still applies (per-connection). Surfaced because the new test suite opens backup files in read-only mode to verify their integrity.

### Added

- **5 new unit tests in `db.test.ts`.** Covers: fresh-DB-no-backup-file, refusal-when-no-migration-registered (live DB byte-identical after the throw, including a fingerprint blob), backup-file-is-a-real-openable-SQLite-with-original-content, error-message-tells-user-backup-path, in-memory-mode-skips-backup. The "leaves live DB untouched" assertion is the one that pins the user-visible promise.



Smoke-testing 0.4 against a real conversation surfaced a 400 from Anthropic on the third or fourth spliced turn: `A maximum of 4 blocks with cache_control may be provided`. Persistent-fork splicing accumulates ephemeral `cache_control` markers across turns, and a few turns in we'd push the body past Anthropic's hard cap. This release adds a cap that mirrors what claude does internally — keep the tail markers, strip the head — so the cached prefix extends turn-by-turn instead of being frozen at the start of the spliced branch. Plus the Phase 4 tool-adoption test now reliably verifies what claude actually does (event-log assertions, not silent passes).

### Added

- **`cache_control` cap to 4 (Anthropic limit).** Persistent-fork splicing accumulates ephemeral `cache_control` markers across turns; the third or fourth spliced turn used to 400 with "A maximum of 4 blocks with cache_control may be provided." `capCacheControlBlocks` (proxy-handler.ts) protects `system` + `tools` markers and strips the earliest `messages` markers first, keeping the latest — mirroring what claude itself does turn-to-turn (markers naturally migrate to the latest stable block as the conversation grows; older message-level markers age out). Anthropic's 20-block lookback hits the latest entry from the prior turn, extending the cached prefix turn-by-turn instead of capping savings at a fixed prefix. Audit event `proxy.cache_control_capped` fires on each cap with `{stripped, system_count, tools_count, messages_count}`. See [ARCHITECTURE.md §cache_control](./ARCHITECTURE.md#cache_control-stripping-heading-markers-when-the-splice-exceeds-4) for the mechanism.
- **10 unit tests for `capCacheControlBlocks`** in `proxy-handler.test.ts` covering: under-cap no-op, head-message-stripped-tail-kept, multiple-message-strips-from-the-start, string-`system`-no-array, string-`content`-no-scan, system+tools-protected-when-only-messages-exceed, degenerate-system+tools-alone-exceed, custom-max-parameter, missing-system/tools/messages-fields, null/undefined-marker-not-counted.

### Fixed

- **Phase 4 tool-adoption A/B harness** (cli-tmux-tool-adoption.test.ts) was reporting passes without verifying the tool actually fired. Four bugs: (a) `waitForReady` regex matched "auto mode unavailable for this model" on Sonnet and returned instantly; (b) `userTurn` waited on `proxy.response_completed` which fires on claude's internal probes (max_tokens, system-reminder fetches), letting the function return before the user keystroke was consumed and bundling subsequent prompts together; (c) `waitFor` could return truthy in race conditions without the event firing; (d) `afterAll` always wiped state, blocking forensic inspection. Now: drop the auto-mode regex (rely on MCP session row + UUID validation); count `closed_forkable` revisions instead (only end_turn user-driven replies); explicit `expect(count).toBeGreaterThanOrEqual(1)` after each event-presence wait; `RETCON_TEST_KEEP_DATA=1` one-way switch + per-test pane capture to `/tmp/p4-pane-<session>.txt`. Verified: all 3 Sonnet scenarios pass with verified events (rewind_to: `fork.back_requested=1`, bookmark: `fork.bookmark_created=1`, dump_to_file: `dumps before=0 after=1`).
- **`hasMarker` predicate counts truthy-object markers only.** A `null` or `undefined` cache_control is a no-op marker per Anthropic's semantics — it doesn't consume one of the 4 slots. Earlier draft of `capCacheControlBlocks` would over-count and strip live markers when the body had any null markers, leaving the request below the cap. Predicate now requires `!!x.cache_control && typeof x.cache_control === 'object'`. Caught in /review pass; covered by the null-marker tests above.

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
- **`dump_to_file` + `submit_file` MCP tools (Phase 3 of the plan).** dump_to_file writes the conversation through a target turn's assistant response to `~/.retcon/dumps/<sid>-<rev>.jsonl` (one Anthropic message per line, atomic via tmpfile+rename, last line ends with assistant role per the load-bearing rule). The AI reads the file with `Read` (pre-allowed by Phase 1's permissions injection), edits it with `Edit`, then calls submit_file. submit_file validates path-resolves-inside-dumps + JSONL line shape + role allowlist (user|assistant|system) + last-line-must-be-assistant, then writes the final messages array (dump + appended user `message`) to TOBE so the next /v1/messages from claude carries the result. Same opaque dual-secret + narrow regex as rewind_to, with separate ConfirmTokenStore per tool. 8 MiB cap per dump (mirrors `BRANCH_CONTEXT_MAX_BYTES`). 24-hour GC of stale dumps runs hourly via `setInterval` in the daemon.
- **Tool-adoption A/B harness (Phase 4 of the plan).** Gated tmux test (`RETCON_TEST_INTEGRATION=1` AND `RETCON_TEST_TOOL_ADOPTION=1`) drives claude (Sonnet AND Opus) through natural-language rewind/bookmark/dump scenarios with NO explicit "Call mcp__retcon__X" hand-holding. Asserts the right MCP tool was invoked end-to-end via the event log + filesystem. Catches future surface changes that drop adoption rate. Six test cases (3 scenarios × 2 models).

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
