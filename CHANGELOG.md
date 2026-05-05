# Changelog

All notable changes to `@playtiss/retcon` are documented here.

## [0.5.0] - 2026-05-04

First non-alpha release of `@playtiss/retcon` — retcon makes AI conversations rewindable. Pre-1.0 hardening across the v0.5.0 alpha series (alpha.0 → alpha.5) is rolled into a single shipped version. New external surface unchanged from alpha.5; this entry summarizes what's in 0.5.0 vs the last 0.4.x release.

### What's new since 0.4.x

- **Synthetic departure Revisions (SR).** Every successful `rewind_to` / `submit_file` produces a real row in the `revisions` table with `stop_reason='rewind_synthetic'` (or `'submit_synthetic'`), so navigation events show up in the same query patterns as ordinary turns. `recall` discriminates SR rows via the existing `stop_reason` column. Failed rewinds (parallel-tool guard fires, upstream 5xx, non-end_turn stop_reason) leave neither an SR row nor an auto fork-point view — the existing "rewind failed" assistant turn is the only trace. See INSIGHTS.md and IMPLEMENTATION.md.
- **`dump_to_file` + `submit_file`.** New tools for the multi-turn-edit workflow ("forget the pink elephant"). `dump_to_file` writes the conversation JSONL to `~/.retcon/dumps/`; the AI inspects/edits with Read/Edit; `submit_file` validates and queues. submit_file's last-line-must-be-assistant validation is the load-bearing constraint that makes the appended user message blend naturally.
- **Progressive-disclosure rules with opaque dual-secret tokens.** `rewind_to` and `submit_file`'s first call returns rules + `clean_token` + `meta_token`. The AI classifies its message and re-calls with the token that matches; opaque random tokens force the rules-read step. Plus a narrow 4-pattern regex backstop on the clean path for the most flagrant meta-references.
- **Invisible-success, loud-failure response pattern.** Staged-action tools (`rewind_to`, `submit_file`) embed `RETCON ERROR: ...` text in their success response. The proxy splice discards the response on the success path; if the AI ever reads it, the splice didn't run and the AI surfaces the failure to the user. Fail-loud-by-construction at zero implementation cost.
- **Permissions injection.** Retcon's CLI inline-merges `permissions.allow` for `Read/Edit/Write/Glob/Grep` over `~/.retcon/dumps/**` plus retcon's own MCP tools, so the AI accesses dumps and calls retcon tools without permission prompts.
- **fork.forked / fork.synthesis_failed audit events.** Every successful or failed rewind/submit now leaves a structured event row, regardless of whether it materializes an SR.
- **Doc split.** ARCHITECTURE.md (single doc) split into INSIGHTS.md (the why) and IMPLEMENTATION.md (the non-trivial how). Reader-facing docs are smaller; mechanism docs cover the cross-time-point hand-offs (T0/T1/T2 SR pipeline, TOBE one-shot baton, penultimate-user splice, branch-context persistence, cache_control accumulation passes, resume binding rebind).

### Fixed since alpha.0

- **SSE+gzip blindness in production (alpha.0).** Anthropic returns `/v1/messages` as gzipped SSE; the proxy was trying to JSON.parse it to extract R1's tool_use_id and silently failing, so SR rows never materialized in real conversations even though unit tests passed. Fixed by reading R1's parsed assistant content from R2's request body (uncompressed JSON) instead.
- **Permission prompts on every retcon MCP tool call (alpha.2).** Added `mcp__retcon__*` to the inlined `permissions.allow` list.
- **Bare-vs-prefixed name mismatch in `detectParallelTools` (alpha.2).** Claude Code dispatches retcon's tools as `mcp__retcon__rewind_to` while the parallel-tool guard matched bare `rewind_to`. Now matches both forms.
- **branch_views_v1 phantom rows for failed rewinds (alpha.4).** Projector subscribed to `fork.back_requested` (request-time) instead of `fork.forked` (success-time), creating auto fork-point views for rewinds that never actually applied. Switched to fork.forked. `fork.back_requested` is now audit-only.

### Migration

- `@playtiss/core` bumped 0.2.0-alpha.0 → 0.2.0 in lockstep.
- No schema migration. `proxy.db` files from alpha.5 work with 0.5.0 unchanged.
- Existing branch_views from past `fork.back_requested` events stay where they are (including any phantoms from past failed rewinds); the alpha.4 fix applies going forward only. SQL to clean up phantoms: see [0.5.0-alpha.4] entry below.

## [0.5.0-alpha.5] - 2026-05-03

Follow-up to alpha.4 — small enhancement to the submit_file rules-return text. The "forget the pink elephant" workflow sanitizes the /v1/messages context the receiving AI sees, but doesn't touch long-lived files (CLAUDE.md, ~/.claude/projects/*/memory/, project notes, TODOS.md, IDE-open files, scratch dumps). If contaminating content was written to any of those, the next session re-leaks it on first read. The previous workflow guidance left this gap implicit.

### Changed

- **`submit_file` rules-return text — FORGET THE PINK ELEPHANT workflow.** Added an explicit external-memory scrub step BEFORE the submit_file call. The AI is now told to verify the content is gone from CLAUDE.md / auto-memory / project notes / TODOS.md / IDE-open files / scratch dumps first, then submit. Reasoning: submit_file's sanitization is scoped to the /v1/messages context only; durable file content survives across sessions and undoes the work.

## [0.5.0-alpha.4] - 2026-05-03

Documentation pass on INSIGHTS.md surfaced an asymmetry in the projector chain: `branch_views_v1` was creating auto fork-point views from `fork.back_requested` (request time, before splice), while `rewind_marker_v1` was creating SR rows from `fork.forked` (success time, after splice). Failed rewinds — parallel-tool guard fires, upstream 5xx, non-end_turn stop_reason, missing synthetic metadata — left phantom branch_views pointing at fork targets that were never actually used. The two surfaces are conceptually paired (both materialize a navigation handle for "you forked here"); they should share the same success gate.

### Fixed

- **`branch_views_v1` projector now subscribes to `fork.forked` instead of `fork.back_requested`.** Auto fork-point views are created only when the rewind/submit actually succeeded, the same condition that produces SR rows. `fork.back_requested` becomes audit-only — no projector consumes it. Net effect: failed rewinds leave neither an SR nor an auto fork-point view; `list_branches` no longer surfaces phantom entries from past failed attempts.
- **`auto_label` timestamp source.** Previously used the projector's `event.createdAt` (when `fork.back_requested` happened to be processed). Now uses `fork.forked.sealed_at` (the moment the user initiated the rewind), so the timestamp matches what the user thinks of as "when did I fork."

### Migration

- **No retroactive cleanup.** Existing branch_views in your live `proxy.db` from past `fork.back_requested` events stay where they are — including any phantoms from failed rewinds. The new gate applies going forward only. If you want to clean up phantom rows manually: `DELETE FROM branch_views WHERE auto_label LIKE 'fork@%' AND id NOT IN (SELECT json_extract(payload, '$.target_view_id') FROM events WHERE topic = 'fork.forked');`

### For contributors

- **branch-views-v1 unit tests** updated to seed an R1 revision row before emitting `fork.forked` (mirroring `rewind_marker_v1`'s test pattern). Two new tests added: one verifying the parent-missing path silently skips (no phantom branch_view), one regression-guarding that bare `fork.back_requested` no longer creates a branch_view.
- **mcp-tools.test.ts `seedForkPoint` helpers** (delete_bookmark + list_branches describes) updated to emit `fork.forked` instead of `fork.back_requested`.

All 455 unit tests pass; lint + build clean.

## [0.5.0-alpha.3] - 2026-05-03

Description and documentation pass for the v0.5.0 surface. AI tool descriptions are what models actually read to decide which tool to invoke; reader-facing docs are what humans skim to decide whether retcon solves their problem. Both got attention.

### Changed

- **MCP tool descriptions tightened across all 7 tools (~25% shorter on average).** Heavy guidance now lives in the rules-return on first call (rewind_to / submit_file) where it costs zero tokens for conversations that never reach for these tools. The recall, bookmark, list_branches, delete_bookmark, and dump_to_file descriptions trimmed redundancy while keeping AI tool-discovery signal intact (verified 6/6 against real Sonnet + Opus tool-adoption tests).
- **submit_file's USE WHEN line now leads with the "forget the pink elephant" use case.** The dump-edit-submit workflow lets you remove or rewrite content spread across multiple turns, where single-point rewind_to can't reach. Use cases: stripping leaked credentials, removing a tangent that biased the model's later reasoning, "answer this WITHOUT mentioning X" prompts, recovering from a botched rewind.
- **dump_to_file's USE WHEN line lists three concrete cases** instead of weighting one as primary. Initial framing ("USE WHEN: ... — *especially* to forget multi-turn content") regressed Sonnet adoption by 124s+ → timeout because Sonnet read "especially X" as scoping the tool to X. Rebalanced phrasing ("Three common cases: (1) just look, (2) fix a factual error, (3) strip multi-turn content") restored 7s adoption time. General principle for tool descriptions: lead with the simpler/broader case; list specialized cases alongside.
- **`confirm` field in rewind_to and submit_file inputSchemas** no longer references internal token names (`clean_token`, `meta_token`) that the AI doesn't yet know when reading the schema. Replaced with neutral phrasing ("Single-use token issued by this tool's first call. The rules-return response names the two choices.").
- **PARALLEL TOOLS warning** moved out of the inline tool descriptions and consolidated in the rules-return on first call, where it has more room and lands at the moment the AI is about to act.

### Added

- **Two new rules in rewind_to and submit_file rules-return text.**
  - *Rule 5: don't re-introduce the thing being forgotten.* Echoing "no pink elephants here" puts the elephant back in the post-rewind AI's context. For sensitive content, describe the removal in general terms ("(I removed the leaked credential)") rather than echoing the actual value.
  - *Rule 6: pack stacked instructions.* When the user says "rewind to X, then answer Y", put Y in `message` so the post-rewind AI has something to do. Without it, the receiving AI sees a placeholder turn and produces a confused "what would you like?" response.
- **Note in CLASSIFY section: tokens classify your CURRENT message, not the original.** The pair is bound to the session, not to a specific message. If your first attempt had a meta-reference, revise the message and use the token matching the revised version.
- **README "Common workflows" subsection** under "Rewind tools" surfaces four named patterns: clean redo, save-and-return, forget-the-pink-elephant, and factual correction. Makes retcon's most differentiated capability (multi-turn forgetting) visible to anyone reading the README.
- **Two new examples in each rules-return**: stacked-question case, leaked-credential case. New anti-pattern call-out: "Echoing the forgotten content" / `"ignore the password ABC123"` re-leaks what you stripped.

### Documentation reorg

- **`ARCHITECTURE.md` split into [INSIGHTS.md](./INSIGHTS.md) + [IMPLEMENTATION.md](./IMPLEMENTATION.md).** Two-doc structure following a project-wide principle: docs should add value beyond what code reading already gives. INSIGHTS.md answers *why* each design has its shape (mental models, design principles, load-bearing assumptions); IMPLEMENTATION.md answers *how* non-trivial mechanisms work (multi-step pipelines, hand-offs across time/process boundaries, ordering invariants). Derivable content (file lists, type layouts, "where to look in the code" pointers) dropped — Claude Code can read those.
- **New principle in INSIGHTS.md: "Progressive disclosure for context-dying tools."** Abstracts the rewind_to / submit_file dual-secret guardrail into a reusable design pattern. Names the three conditions a tool must satisfy before this overhead earns its keep, so future tools can be evaluated against the same criteria instead of copying the pattern by reflex.
- **IMPLEMENTATION.md SR pipeline section** documents the T0/T1/T2 hand-off (MCP-call-time → TOBE-consumed-time → response-completed-time) including the synthetic body shape diagram (history-through-R1 + R1's assistant turn + R2' tool_result + R3' assistant wrap-up) and the load-bearing tool_use_id pairing that makes cascade rewinds API-valid.
- **README updated** to point at INSIGHTS.md / IMPLEMENTATION.md instead of the old ARCHITECTURE.md.

### Fixed

- **`cli-tmux-integration` test 2 (resume + rewind across boundary) — fixed.** Was flaking because the test left the original tmux session alive while spawning a second claude process via `--resume <same-id>`. Two claudes attached to the same session id silently broke the resumed session's input handling. Manual reproduction confirmed: kill the original session before resuming, and the rewind works first try. Fix: `tmux kill-session -t SESSION` at the start of test 2 before spawning RESUME_SESSION.

### For contributors

- **Doc-authoring principle.** New docs should slot into INSIGHTS.md (why) or IMPLEMENTATION.md (how-non-trivial). Skip anything Claude Code can derive in a single read.
- **Tool-description-authoring principle.** "USE WHEN: X — especially Y" reads to the AI as "this tool is FOR Y." Use "USE WHEN: X. Common cases: A, B, C." instead. Lead with the broader case; list specialized ones alongside without weighting one as primary.

All 453 unit tests pass; lint + build clean. cli-tmux-tool-adoption verified 6/6 (Sonnet + Opus). cli-tmux-integration verified 3/3.

## [0.5.0-alpha.2] - 2026-05-02

Two more bugs the alpha.1 ship missed, both surfaced by extending the cli-tmux-integration test with an SR-row assertion. alpha.0 had silent SSE+gzip blindness; alpha.1 fixed that but the SR pipeline was STILL broken in production for two unrelated reasons. The integration test paid for itself the moment we let it actually run a real rewind end-to-end.

### Fixed

- **`mcp__retcon__*` tools now pre-allowed in claude permissions.** `retconAllowEntries` only listed `~/.retcon/dumps/**` filesystem permissions; retcon's own MCP tools (recall, rewind_to, bookmark, delete_bookmark, list_branches, dump_to_file, submit_file) were not pre-approved. claude prompted "Do you want to proceed?" on every invocation, which silently broke the cli-tmux-integration test (it never made it past the first rewind_to call). Real-world impact: any user who hadn't manually approved these tools before would face a permission prompt on first use. Auto-allow makes sense — the user opted in by running retcon.
- **Parallel-tool detection fixed for MCP-prefixed tool names.** claude's actual /v1/messages body uses the FULL MCP-prefixed tool name in `tool_use` blocks (`mcp__retcon__rewind_to`), not the bare `rewind_to`. alpha.1's `detectParallelTools` and `buildSyntheticAsset` matched only the bare name, so the operation tool itself was classified as a "parallel sibling" and EVERY splice aborted with `fork.synthesis_failed: parallel tool_uses (mcp__retcon__rewind_to)`. Zero SR rows materialized in production despite the SSE-decoupled architecture. Fix: accept either bare or MCP-prefixed name in both functions. Unit tests added with prefixed names so this regression has a permanent canary.

### Added (testing)

- **cli-tmux-integration test asserts on SR pipeline end-to-end.** After the existing `fork.back_requested` check, the test now waits for `fork.forked` and counts `stop_reason='rewind_synthetic'` rows. On failure it prints a rich diagnostic: every fork.* event with its error_message, every tobe-applied request's stop_reason+status, and the last 5 response_completed outcomes. Catches the SSE+gzip / prefix-name / permissions class of bugs that all hide behind clean unit-test fixtures.
- **Two regression tests in `rewind-marker-v1.test.ts`** pin the MCP-prefixed name path: one for `mcp__retcon__rewind_to`, one for `mcp__retcon__submit_file`. Failing builds catch any future drift to bare-only matching.

### Verified

- `cli-tmux-integration` test 1 (rewind_to walks the revision DAG) passes in 25s against real Anthropic SSE+gzip traffic, with `fork.forked` firing and SR rows materializing.
- `cli-tmux-assumptions` 5/5 pass.
- 453 unit tests pass; lint clean.

### Test infrastructure

- **`cli-tmux-integration` test 2 (resume + rewind across boundary) — fixed.** Was flaking because the test left the original tmux session alive while spawning a second claude process via `--resume <same-id>`. Two claudes attached to the same session id silently broke the resumed session's input handling — the rewind prompt typed via `tmux send-keys` got swallowed with no error, no permission prompt, no nothing. Manual reproduction (kill the original session before resuming) worked first try, ruling out the `--resume` permission hypothesis. Fix: kill `SESSION` before spawning `RESUME_SESSION`. All 3 cli-tmux-integration tests now pass in 73s.

## [0.5.0-alpha.1] - 2026-05-01

Bug-fix release for v0.5.0-alpha.0. Dogfood verification revealed that the SR pipeline was silently broken in production: zero `fork.forked` events ever fired, zero SR rows ever materialized, despite the daemon running v0.5 binary and the rewinds themselves applying. Root cause: the parallel-tool guard at MCP-handler time and `buildSyntheticAsset`'s R1 lookup both tried to `JSON.parse` Anthropic's `/v1/messages` response body, which is gzip-compressed SSE — the parse always failed silently, callers always saw null, the synthetic field was never written to TOBE, and proxy-handler then logged the "pre-v0.5 daemon" backward-compat warning every time. Tests didn't catch it because the proxy-handler integration fixtures used `res.end(JSON.stringify(...))` (uncompressed JSON) — the SSE+gzip path was never exercised.

The fix: drop the response-body-parsing path entirely. Use the same trick `reconstructForkMessages` already uses — claude's pre-splice request body for the next /v1/messages call (R2) carries R1's parsed `content[]` as its second-to-last entry. That body is JSON, uncompressed, no SSE reconstruction needed.

### Changed

- **Parallel-tool detection moved to proxy-handler at TOBE-consumption time.** The MCP-handler-time guard (and the `loadResponseToolUses` / `responseBodyCidFor` helpers) is gone. proxy-handler now parses claude's pre-splice body before applying the splice; if the last assistant has tool_use blocks beyond the operation, it aborts the splice, commits the TOBE, emits `fork.synthesis_failed` with `parallel_tool_names`, and lets claude's R2 go through unchanged. The AI surfaces the failure on its next turn via the loud-failure response (`POSSIBLE CAUSE — did you call rewind_to alongside other tools...?`).
- **`buildSyntheticAsset` reads R1's content from the originalBody, not from R1's response blob.** New signature: `(originalBody: Uint8Array, kind, syntheticToolResultText, syntheticAssistantText) → {topCid, refs, toolUseId} | null`. Walks the messages array backwards to find the last assistant message, extracts the operation tool's `tool_use_id`, drops the trailing user (which carries the discarded tool_results), appends synthetic R2'/R3'. No StorageProvider needed, no SSE reconstruction.
- **`SyntheticDepartureMeta.tool_use_id` field dropped.** Derived at proxy-handler time. Reduces TOBE shape duplication and the "MCP handler tries to compute it via SSE parse → fails → field is wrong" failure mode.
- **Loud-failure response in rewind_to / submit_file** adds a `POSSIBLE CAUSE — did you call <tool> alongside other tools` hint. If the splice aborted on parallel-tool detection, the AI sees this on its next turn and can self-diagnose.
- **`fork.synthesis_failed` event** gains an optional `parallel_tool_names: string[]` field for parallel-tool aborts. `parent_revision_id` becomes optional in the type (the abort path always populates it from `pending.synthetic`, but earlier emitters may not have).

### Removed

- **`loadResponseToolUses` and `responseBodyCidFor` helpers** (`mcp-tools.ts`). The SSE-blind path is gone.
- **MCP-handler-time parallel-tool rejection.** Was technically nicer UX (synchronous error inline) but only worked in tests. The deferred-to-proxy-handler version actually runs in production.

### Tests

- `mcp-tools.test.ts`: dropped the parallel-tool guard tests (no longer applicable). Updated extended-TOBE tests to assert `tool_use_id` is absent. Added loud-failure-text-mentions-parallel-tool tests for both rewind_to and submit_file.
- `proxy-handler.test.ts`: rewrote the fork.forked happy-path test with a realistic claude body shape (R1's parsed assistant turn with tool_use + trailing user with tool_result). Added a parallel-tool-abort test that drives an R1 with `rewind_to + read_file` and asserts no fork.forked fires, fork.synthesis_failed does, TOBE is committed.
- `rewind-marker-v1.test.ts`: rewrote `buildSyntheticAsset` tests against the new originalBody-based signature. Added a `makeOriginalBody` helper that constructs claude-shape bodies. Tests cover malformed JSON, no last assistant, no operation tool_use, kind discrimination (`kind=submit` rejects R1 with rewind_to), trailing-user-drop semantics.
- `sr-integration.test.ts`: end-to-end happy path now drives a realistic claude body through the proxy.

All 451 tests pass; lint + build clean. Total v0.5.0-alpha.1 diff: -300 / +250 net (mostly test rewrites; production code shrinks by ~100 lines).

## [0.5.0-alpha.0] - 2026-05-01

The CEO-as-user spotted the gap during dogfood review: every navigation event in retcon's DAG should be a real row, but rewinds were a side-effect — TOBE pending file got swapped, branch_views updated, but no Revision row marked the moment. "From" turns showed up via a `from_turn_id` field on prior `fork.back_requested` events; "to" turns showed up via auto fork-point branch_views. Neither of those is the rewind itself. This release introduces the **synthetic departure Revision (SR)** — a real row in the `revisions` table representing the moment a rewind or submit_file completed successfully. Same table, same query patterns, no special cases.

The mental model came from Playfilo: a "departure node" is a child of the assistant turn that called the navigation tool, role=toolResult, dead-end in the lineage but a navigable row. retcon doesn't control claude's persistence layer the way Playfilo's pi-integration-skill does, but retcon's DAG is its own derivation — we can synthesize a row that, when reconstructed for upstream replay, produces a coherent message body (R1.history + R1.assistant + synthetic tool_result paired with R1's tool_use_id + synthetic assistant wrap-up).

### Added

- **`fork.forked` event topic.** Emitted by `proxy-handler` after `proxy.response_completed` when ALL of: TOBE was consumed, status is 2xx, stop_reason is `'end_turn'`, and the consumed TOBE carried the `synthetic` SR-construction metadata (Phase 1 wrote it; Phase 2 reads it). Payload includes `kind: 'rewind' | 'submit'`, `synthetic_revision_id`, `parent_revision_id` (= R1.id), `target_revision_id` (= fork point), `to_revision_id` (= R_new.id), `synthetic_asset_cid` (top CID of the precomputed synthetic body), `tool_use_id`, and `sealed_at`.
- **`fork.synthesis_failed` event topic.** Audit-only. Fires when `buildSyntheticAsset` returns null or throws (e.g., R1 missing, body unparseable). Payload: `{parent_revision_id, target_revision_id, error_message}`. The rewind/submit itself still applied — only the SR row didn't materialize. Loud audit trail for dogfood-spotting "rewind succeeded but no marker in recall".
- **`RewindMarkerV1Projector` (`src/rewind-marker-v1.ts`).** Subscribes to `fork.forked`. Looks up R1's task_id (FK constraint), then INSERTs the SR row with `classification='closed_forkable'`, `stop_reason='rewind_synthetic'` (kind=rewind) or `'submit_synthetic'` (kind=submit), `asset_cid=synthetic_asset_cid` (precomputed by proxy-handler), `parent_revision_id=R1.id`, `sealed_at=back_requested_at` (the moment of rewind initiation, < R_new.sealed_at). INSERT OR IGNORE keeps the projector idempotent on event replay.
- **`buildSyntheticAsset(deps, args)` async helper (`src/rewind-marker-v1.ts`).** Loads R1's request body messages and response body content via the StorageProvider; composes the synthetic messages array `[...history_through_R1, R1.assistant_wrap, R2'_tool_result_paired_with_tool_use_id, R3'_assistant_text]`; stores it via `blobRefFromMessagesBody` so SR's asset_cid lives in the same link-walked layout as real Revision bodies. `loadHydratedMessagesBody`, `reconstructForkMessages`, and `dump_to_file` all work transparently on SR rows. Returns null on any failure; proxy-handler maps null → `fork.synthesis_failed`.
- **TOBE shape extension (`src/tobe.ts`).** New optional `synthetic` field on `TobePending`. The MCP handler computes SR-construction metadata at MCP-call time (synthetic_revision_id via generateTraceId, kind-specific R2'/R3' text, R1.id + tool_use_id from the parallel-tool guard's R1 inspection); proxy-handler reads it at TOBE-consumption time. Backward-compat: pre-v0.5 daemons that wrote TOBE without `synthetic` keep working — proxy-handler logs a warning and skips fork.forked emit, the rewind itself still applies.
- **Parallel-tool guard on `rewind_to` and `submit_file`.** If R1 (the assistant turn that emitted the navigation tool's tool_use) ALSO emitted other tool_uses, reject with a clear error naming the parallel tools. The rewound history will replace the next /v1/messages — sibling tool_use results (Read, Bash, Edit, etc.) would be discarded before the receiving AI sees them. Both first-call rules-return texts gain a "PARALLEL TOOLS — DO NOT call ... alongside other tools" warning so the AI learns the constraint upfront.
- **`recall` `kind` field on every turn entry.** Three values: `'turn'` (real /v1/messages assistant turn), `'rewind_marker'` (SR with stop_reason='rewind_synthetic'), `'submit_marker'` (SR with stop_reason='submit_synthetic'). Cheap WHERE-clause discrimination via the existing stop_reason column — no event-log read on the hot path. Surrounding-window entries carry it too. Detail mode (`recall({turn_id: SR.id})`) returns `kind=rewind_marker` (or submit_marker) inline.
- **Cascade rewinds work transparently.** `rewind_to({turn_id: SR.id})` calls `reconstructForkMessages(SR)`, which reads SR.asset_cid (the synthetic body) — same code path as real revisions. The result + new user message lands in TOBE; the next /v1/messages produces ANOTHER fork.forked, which produces a NEW SR pointing at the previous one. No special case in the rewind code.
- **`rewind_to` and `submit_file` MCP handlers now use `loadResponseToolUses` helper.** Inspects R1's response body via the StorageProvider, parses tool_use blocks, returns `Array<{id, name}>`. Used by both the parallel-tool guard and the SR-metadata extraction (we need R1's tool_use_id to pair the synthetic R2' tool_result correctly).
- **27 new tests across the SR pipeline.** mcp-tools.test.ts: parallel-tool warning in rules text (rewind_to + submit_file, 2 tests), parallel-tool rejection (2), extended TOBE shape (4), recall kind discriminator (5). proxy-handler.test.ts: fork.forked happy path + 4 negative gates (5). rewind-marker-v1.test.ts (new file): buildSyntheticAsset + RewindMarkerV1Projector unit tests (10). sr-integration.test.ts (new file): end-to-end rewind→fork.forked→SR row, 4xx upstream skips SR, R1-missing emits fork.synthesis_failed (3).

### Changed

- **`recall` no longer surfaces `rewind_events`, `rewind_events_total`, `rewind_events_truncated`.** Replaced by inline SR rows in the turns array with `kind: 'rewind_marker'` or `'submit_marker'`. The information is the same; the navigation surface is real (rewind_to/dump_to_file work directly on SR.id). The trailing fork.back_requested event-log query is gone. Pre-1.0 alpha policy makes this hard cut acceptable.
- **`recall` tool description rewritten** to explain the kind taxonomy and that markers are first-class navigable points. Next_steps text mentions rewind/submit markers explicitly.
- **`fork.back_requested` is now audit-only.** Payload unchanged. Stays useful as a "we tried to rewind" marker but the navigation surface is the SR row, not the auto fork-point view (which still exists for branch labeling, separate concern).
- **`defaultProjectors()` registers `RewindMarkerV1Projector`.** Topic-disjoint from the existing chain (fork.forked vs proxy.*); placed last for clarity.

### Removed

- **`recall` list-mode `rewind_events` array, `rewind_events_total` count, `rewind_events_truncated` boolean.** See "Changed" above. Migration: any external consumer reading these fields needs to switch to `turns[].kind === 'rewind_marker'` or `submit_marker`. Documented loudly here.

### Migration

- **No backfill of past rewinds.** v0.4.x sessions in proxy.db that pre-date this change have no SR rows for their old rewinds. `recall` on those sessions surfaces only the real Revisions and fork.back_requested events stay queryable in the audit log. New rewinds in v0.5+ produce SR rows. Acceptable per pre-1.0 alpha policy.
- **Schema unchanged.** SR rows go into the existing `revisions` table; the only new value is the `stop_reason` strings `'rewind_synthetic'` / `'submit_synthetic'`. No migration needed.

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

### Fixed (post-/review)

After running `/review` on the implementation, three bugs and four sharper-edges were caught and addressed pre-landing:

- **`rewind_events.from_turn_id` always-empty in production (P1).** The `recall` list-mode parser read `p.head_revision_id` from `fork.back_requested` event payloads, but neither `rewind_to` nor `submit_file` actually emitted that field — every entry in production would have shown `from_turn_id: ""`. The Phase 3 test passed only because it manually seeded the field in a synthetic event. Fix: emitters now include `head_revision_id` (computed via `effectiveHead` in `rewind_to`, equal to `headForkable.id` in `submit_file`). Parser surfaces `null` (not `""`) for legacy pre-v0.4.4 events that lack the field. Phase 3 test 5 rewritten to drive the real two-step rewind flow; new test 5b covers legacy-event handling.
- **`recall` silently dropped `surrounding_turns` when target.sealed_at IS NULL (Medium).** Could happen when reaching detail-mode via `view_id` whose head was reclassified out of closed_forkable. Now returns an empty array AND a `surrounding_skipped` reason string. New test 10 pins the behavior.
- **`recall({view_id})` for non-forkable head contradicted next_steps (Medium).** Said "call rewind_to" but `rewind_to` rejects non-forkable turns. Now returns a `warning` field naming the classification + telling the AI rewind_to will reject. New test 11.
- **`delete_bookmark` redesigned to label-only.** Original v0.4.4 plan accepted `id_or_label`. User feedback during /review: deleting by `view_id` is an implementation leak — the user's mental model is "the bookmark named X". Tool now requires `label` and rejects in three cases: missing/empty, no match, ambiguous (multiple bookmarks share the label). Implications: unlabeled bookmarks (`bookmark()` no args) and auto fork-point views (label=NULL) cannot be deleted via this tool — they're system-managed and reaped on `retcon clean --actor X`. Phase 1 tests rewritten: 9 tests now cover label-happy-path, missing-label, ambiguous-label-with-context, no-match, cross-session-rejected, fork-point-undeletable, unlabeled-undeletable, idempotent-delete, projector-task_id-mismatch.
- **`bookmark` label validation.** Cap at 256 bytes (UTF-8) to prevent unbounded labels expanding every future `list_branches`/`recall` response. Strip ASCII control chars (` -`) but preserve printable + emoji + non-ASCII. Reject labels that are entirely control chars after sanitization. Three new tests pin the cap, the strip, and the all-control rejection.
- **`recall` `rewind_events` truncation indicator.** Was capped at 50 with no signal. Now exposes `rewind_events_total` (full COUNT) and `rewind_events_truncated: boolean` so the AI can tell when older rewinds are out of view. New test 6b seeds 51 events and asserts truncation.
- **New index `idx_events_session_topic`.** Composite (session_id, topic, event_id). Speeds up `recall`'s `rewind_events` query on long sessions where filtering by topic across thousands of session events is a scan. Additive (`CREATE INDEX IF NOT EXISTS`); applied at next daemon start, no migration needed thanks to v0.4.2's backup-before-migrate policy.

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
