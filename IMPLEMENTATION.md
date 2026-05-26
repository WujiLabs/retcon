# Implementation

The "how" of retcon's non-trivial mechanisms. [INSIGHTS.md](./INSIGHTS.md) covers the design principles and why each shape is the right shape; this doc covers the parts where the mechanism itself is load-bearing — the multi-step pipelines, the hand-offs across time/process boundaries, the ordering invariants that aren't obvious from reading any single file.

What this doc deliberately doesn't cover: file layout, type definitions, function signatures. Those are derivable by reading the code.

## Anchor splice: how rewinds carry across turns

`rewind_to` and `submit_file` create a row in the `fork_anchors` table and return a tool_result containing `<retcon-anchor token="tok_<12hex>" />`. The 48-bit token is the per-fork handle. On every subsequent `/v1/messages`, the proxy scans claude's outgoing body backward through user-role `tool_result` blocks, finds the most-recent token, looks up the row, and splices `target_messages_json` into the body — replacing everything before and including that tool_result turn. Whatever claude wrote after the anchor passes through unchanged.

```
  MCP rewind_to call             proxy.request_received                next turn's request
       │                                │                                       │
       ├─ INSERT fork_anchors           ├─ findLatestAnchorTokenInToolResults    ├─ same scan;
       │  (state=active, token=tok_X,   │                                       │  finds tok_X again
       │   target_messages_json=[...])  ├─ row.state=active → splice            │
       │                                │  body = [target_messages, …postAnchor]├─ postAnchor now
       └─ return tool_result with       │                                       │  includes earlier
          <retcon-anchor token="tok_X"  └─ forward to upstream                  │  assistant + user
          /> embedded in the text                                                │  turns claude added
```

Why this beats the v0.5.x design: the splice never has to guess where the fork started. The anchor token IS the boundary marker. The body scan never compares assistant text strings (so ambiguous short replies like "OK" no longer false-release). The fresh-fork special case is gone (no need to detect "the tail is still the synthetic landing turn"). And the tool_result text the AI sees on a successful rewind is friendly natural language — the v0.5.x "RETCON ERROR" tool_result scaffolding (which polluted claude's local jsonl on the success path) is deleted.

The row carries:

- `anchor_token` — primary key. 12 hex chars (`tok_` prefix), 48 bits entropy. Generated per rewind via `crypto.randomBytes(6)`.
- `target_messages_json` — the new conversation history to splice in. Active rows hold raw JSON; released rows fold to a content-addressed `target_messages_top_cid` (one blob per message, deduped via `@playtiss/core` storage) so storage stays bounded over the lifetime of a session.
- `fork_point_revision_id` — the rewind target's revision id.
- `source_view_id` — the calling session id.
- `synthetic_metadata_json` — SR-construction metadata. See "Synthetic departure Revision pipeline" below.
- `state` — `active` or `released`. `state_reason` describes the cause (clear / compact / divergence / superseded / parallel_tools / upstream_4xx).
- `acknowledged_at` — null while the persistent reminder is firing; set to a timestamp when the AI calls `recall(turn_id=…)` against the released fork's last-fork-applied turn.

## Synthetic departure Revision (SR) pipeline

Every successful rewind/submit produces an SR row in the revisions table. The pipeline spans three time points:

```
  T0: MCP-call time (rewind_to / submit_file handler)
      ├── compute synthetic_revision_id (generateTraceId)
      ├── compute R2'/R3' display text
      ├── stash in fork_anchors.synthetic_metadata_json alongside target_messages_json
      └── (do NOT touch claude's response body — it's gzip'd SSE)

  T1: splice time (proxy-handler, on next /v1/messages)
      ├── findLatestAnchorTokenInToolResults locates the anchor in body
      ├── parse claude's pre-splice body as JSON (NOT the response — the request)
      ├── find last assistant message → that's R1's parsed content
      ├── parallel-tool guard:
      │     if R1's content has tool_use blocks beyond the operation tool,
      │     markReleased(state_reason='parallel_tools') + emit fork.synthesis_failed
      ├── apply splice (body = [target_messages, ...messages_after_anchor])
      └── forward to upstream

  T2: response-completed time (proxy-handler, after upstream replies)
      ├── if status==2xx + stop_reason==end_turn + synthetic_metadata_json present:
      │     ├── extract operation tool's tool_use_id from R1's content
      │     ├── compose synthetic body (history + R2'/R3')
      │     ├── content-address each message via blobRefFromMessagesBody
      │     ├── emit fork.forked with synthetic_asset_cid + refs
      │     └── (RewindMarkerV1Projector inserts the SR row)
      └── otherwise: no SR materializes; rewind itself still applied
```

The hand-off across T0→T1→T2 is what makes the unit-test path and production path agree. T1 is where the production-only failure modes live (claude's request body shape, gzip/SSE on the response side). Tests that mock T0→T2 directly skip the T1 hazards; the integration test (`cli-tmux-integration.test.ts`) is what catches them.

### What the synthetic body looks like

The SR's `asset_cid` points at a messages-shape blob containing four parts:

```
[
  ...history through R1.request_body.messages,    // unchanged from the real conversation
  R1.response_body assistant turn (the tool_use), // R1's actual assistant emission
  R2': synthetic tool_result paired with R1's tool_use_id,
  R3': synthetic assistant wrap-up text,
]
```

Two pieces of this shape are load-bearing for downstream consumers:

- **R2's `tool_use_id` MUST match R1's tool_use_id** for the operation tool (rewind_to or submit_file). Anthropic's API requires every `tool_use` to be paired with a `tool_result`. The R1 turn ends with an unpaired tool_use; R2' provides the matching tool_result. Without this pairing, cascade rewinds (a later `rewind_to({turn_id: SR.id})` whose synthetic body becomes a request prefix) would 400 from upstream.
- **R3' is a normal assistant text turn.** It's there so the SR's body ends on an assistant turn, not on a user-tool_result turn. That keeps `dump_to_file({turn_id: SR.id})` producing a JSONL with the standard alternation (last line = assistant), which `submit_file`'s last-line-must-be-assistant validation requires for cascade workflows.

R2'/R3' content is retcon-generated narrative ("Rewind initiated. Target: rev_<short>. Synthetic message: <user_msg>" / "Rewind initiated. Jumping to rev_<short>"), purely for navigation/display. It's never byte-matched against claude's actual traffic — the loud-failure scaffolding claude emits as the actual tool_result for rewind_to/submit_file lives only in the discarded request body, never in the SR's body.

### Why R1's content comes from the request body, not the response

The natural place to find R1's parsed content would be R1's response body. But:

- Anthropic returns `/v1/messages` responses as `text/event-stream` (SSE).
- When `accept-encoding: gzip` is set (which claude does), the body is gzip-compressed.
- A `JSON.parse(decoded_text)` on these bytes silently fails — the catch returns null, callers see "no tool_use found," the parallel-tool guard skips, the SR is never built.

That's the bug v0.5.0-alpha.0 shipped. v0.5.0-alpha.1's fix uses the request body of the *next* /v1/messages instead: claude packs R1's parsed assistant turn back into the `messages[]` array as the next-to-last entry (the last entry is the user turn carrying the tool_result). That body is JSON, not SSE, not compressed. We extract R1's `content[]` directly from there.

This is the same trick `reconstructForkMessages` already uses to read parsed assistant turns when reconstructing fork-point messages. Re-using it for SR avoids any SSE-stream reconstruction code.

### Why parallel-tool detection runs at proxy-handler, not MCP-handler

Earlier drafts ran the guard at MCP-call time (T0). Same SSE+gzip problem — at T0, R1's response body is the only place R1's content exists, and it's unparseable as JSON. Moving the check to T1 lets us read claude's pre-splice JSON request body, which is uncompressed and unambiguous.

The trade-off: at T0 we could have returned a friendly inline error to the calling AI. At T1 the abort happens silently from the AI's perspective; the loud-failure response in `rewind_scheduled_response`/`submit_scheduled_response` surfaces it on the next turn. The loud-failure response includes a "did you call rewind_to alongside other tools?" hint so the AI can self-diagnose.


### Deferred fork.forked across tool_use chains

The original SR pipeline gates `fork.forked` on `stop_reason='end_turn'` at T2. That works when the post-rewind AI types one final answer immediately, but breaks when the AI chains tool calls (Read, Bash, recall) before answering — `stop_reason='tool_use'` doesn't pass the gate, the splice already ran at T1, the rewind applied but no SR row materializes. Empirically (3-day dogfood signal): 7 of 9 fork.back_requested events produced no fork.forked, all 7 had tool_use as the post-rewind first stop_reason.

v0.5.1 fixed this with deferred emission. When T2 sees `splice_applied && synthetic && status==2xx && stop_reason ∈ {tool_use, pause_turn}`, the synthetic metadata persists on the active fork_anchors row (`synthetic_metadata_json` column) instead of emitting fork.forked immediately. Subsequent `proxy.response_completed` events for the same session check the row; on the first `closed_forkable` stop_reason that arrives, retcon re-fetches the original (pre-splice) request body's bytes from `blobs` by CID, calls `buildSyntheticAsset`, emits fork.forked with `to_revision_id` pointing at the FIRST post-rewind turn (the splice-consumer — that's the navigation handle the user thinks of as "where the fork landed"), and clears `synthetic_metadata_json`.

State transitions for `synthetic_metadata_json` on the active fork_anchors row:

- Set: T2 with `splice_applied && stop_reason ∈ {tool_use, pause_turn}` — defer.
- Cleared on closed_forkable: emit fork.forked first.
- Cleared on dangling (max_tokens, refusal, null): emit fork.synthesis_failed (the chain ended on a non-resumable stop_reason).
- Cleared on supersede: a new rewind/submit that inserts a fresh anchor releases the prior active row (state_reason=`superseded`), with a fork.synthesis_failed audit (`error_message: "superseded by a new rewind/submit before reaching end_turn"`).

Pre-v0.6, the same metadata lived in `sessions.pending_synthetic_json` — the v8→v9 migration folds those values into the synthesized ghost fork_anchors rows so an in-flight v0.5.x deferred SR still materializes after upgrade. The mechanism details (column shape, helper module `pending-synthetic.ts` as a facade over fork-anchors helpers, where the read/write happens in proxy-handler.ts T2) are derivable from the code.

### Harness-injection skip in turn_back_n

claude code splices pseudo-prompts into messages[] as user-role turns: `<system-reminder>` probes (file-opened reminders, idle nudges), `[SUGGESTION MODE: ...]` predict-next prompts, `"The user stepped away..."` recap hooks. They become ordinary `closed_forkable` revisions in the projector — but they're not user-conversational turns. Without a skip, `turn_back_n=1` would land on the most recent injection, off by one from what the user means.

v0.5.2 added `isHarnessInjectionRevision(db, revisionId)` — a synchronous probe that reads the revision's request body, walks the last user message, and tests its text against a narrow pattern set:

- `^The user stepped away and is coming back\b` (recap hook)
- `^\[SUGGESTION MODE:` (predict-next)
- Pure system-reminder turn (only `<system-reminder>...</system-reminder>` text, nothing substantive after stripping)

The pattern set is anchored-at-start with near-zero false-positive risk on real user prose. The system-reminder check is content-aware: `<system-reminder>` PREFIX with real user content underneath (claude's standard shape for IDE-open / date-change reminders) is NOT marked injection — substantive content remains after stripping the reminder block.

Navigation helpers `effectiveHead`, `nthForkableBack`, `countForkableBack`, and `mostRecentForkableRevision` all consult `isHarnessInjectionRevision` and skip matching revisions when counting. `firstChild` (used by reconstructForkMessages for fork-point base derivation) does a bounded DFS through injection grandchildren — needed because injection probes sometimes ship with `msgs=1` (no conversation history), and the real continuation might be the grandchild via the probe.

### State-divergence detection via anchor scan

The anchor splice doesn't need a continuity check. Claude code's `/rewind` truncates claude's local jsonl past some point — but `<retcon-anchor token="..." />` lives inside the rewind_to tool_result, so if `/rewind` truncated past the fork, the token is gone from claude's outgoing body. `findLatestAnchorTokenInToolResults` returns null. The proxy looks up the session's active fork_anchors row, sees the divergence, marks the row `state='released', state_reason='divergence'`, emits `session.fork_anchor_released{reason: 'rewind_or_state_divergence'}`, and the persistent `<retcon-released>` reminder fires on subsequent turns until the AI acks via `recall`.

This replaces three pieces of v0.5.x machinery: the asst-text continuity check (false-positive prone on ambiguous short replies like "OK" matching the wrong earlier occurrence), the fresh-fork token skip (which existed only to mask the continuity check's structural blind spot on the first post-rewind turn), and the "RETCON ERROR" loud-failure tool_result text (which left a confusing artifact in claude's local jsonl on the success path). The anchor token IS the per-fork signal; the splice never compares assistant text.

### Persistent `<retcon-released>` reminder injection

When a released fork_anchors row has `acknowledged_at IS NULL`, every `/v1/messages` gets per-directive `<retcon-released>` text blocks prepended to the last user message's content array. The reminder fires on every turn until the AI acks — not just on the turn that caused the release.

Three blocks:

1. **Header**: a retcon fork was previously released and you haven't yet inspected the named turn. The release was logged earlier in this session.
2. **LAST FORK-APPLIED TURN**: the `turn_id` of the most recent successfully-spliced revision, with concrete commands the AI can suggest to the user — `recall(turn_id="<id>")` to inspect, `rewind_to(turn_id="<id>", message="...")` to resume the fork's content with a fresh user message, `dump_to_file(turn_id="<id>")` + edit + `submit_file` to inspect-and-edit before resuming.
3. **MUTE**: explicit contract — calling `recall(turn_id="<id>")` will silence the reminder for the rest of the session. Until then it appears on every `/v1/messages`. The recall handler honors this: when the AI inspects the named turn, it sets `acknowledged_at` and subsequent turns skip the injection.

Implementation in `proxy-handler.ts:buildPersistentReleaseReminderBlocks` and `injectPersistentReleaseReminder`. If the body shape is unexpected (last message not user-role, or content shape unrecognized) the injection skips and rawBody forwards unchanged — the audit event still fires.

Symmetric counterpart to `<retcon-active>` (mcp-tools.ts:buildActiveReminderBlocks). Both wrap the user's message with retcon-controlled context blocks: one on activation (way IN), one on release (way OUT until ack'd).

### Multi-block injection text concat

`isHarnessInjectionRevision` (the navigation-helper that decides whether a revision should be skipped by `turn_back_n` counting) used to inspect only the FIRST text block of each user message via `.find()`. claude code now splits content into multiple text blocks — one per `<system-reminder>` (skills list, file-opened, IDE state) and a separate block for the user's actual prompt. The first block was always a reminder; `isInjectionText` saw it alone, returned true, and `nthForkableBack` walked PAST real conversational turns as if they were noise. The cli-tmux integration test "rewind_to walks the revision DAG end-to-end" had been failing on master with "0 forkable turns available" — that's why.

Fix: concat all text blocks (newline-joined) before passing to `isInjectionText`. The strip-system-reminder regex inside `isInjectionText` already handles multiple `<system-reminder>` blocks via the `/g` flag, so a turn whose combined text is `<system-reminder>...</system-reminder>\n<system-reminder>...</system-reminder>\nReply with one word: APPLE` correctly strips both reminders, sees "Reply with one word: APPLE" remaining, and returns false (not injection). Same fix applied to `turnPreview` (the snippet `recall` shows for each turn) — the preview was previously showing the first reminder block instead of the real user prompt the user typed.

### `<retcon-active>` reminder blocks in synthetic landing turn

The synthetic user-role message that lands at the rewound branch (= `target_messages_json.last`) is constructed as a content-array with multiple text blocks — one per logical directive, matching claude code's `<system-reminder>`-per-block representation pattern:

```
{
  role: 'user',
  content: [
    { type: 'text', text: '<retcon-active fork-id="tok_<12-hex>">...activation header...</retcon-active>' },
    { type: 'text', text: '<retcon-active>...user-facing /rewind warning...</retcon-active>' },
    { type: 'text', text: '<retcon-active>...AI-internal file-staleness directive...</retcon-active>' },
    { type: 'text', text: <user's message arg verbatim> }
  ]
}
```

The reminder blocks carry these directives:

- **Activation header** (block 0, carries `fork-id`): "a retcon fork is now active." The `fork-id="tok_..."` attribute is the per-fork token used by the divergence guard's fresh-fork skip — see "Fresh-fork skip via per-fork token" above.
- **User-facing** (block 1): tell the user once after answering that claude code's `/rewind` doesn't release this fork; use `/clear`, `/compact`, or another `rewind_to`.
- **AI-internal** (block 2, do NOT echo): re-Read files referenced earlier — disk may have advanced past the rewound branch's view.

The user-facing directive is retcon's only proactive channel into claude's UI for the human (`/rewind` never reaches the LLM, pre-splice tool results are discarded by the splice itself, retcon can't modify claude's UI directly). Verified end-to-end with both Opus 4.7 and Sonnet 4.6: surfaces the user-facing warning and silently applies the file-staleness directive.

Decision #6 in INSIGHTS.md ("message delivered VERBATIM") is preserved: the user's text is its own content block, byte-equal to what they passed. The reminder is sibling blocks, not a wrapper. retcon's `isInjectionText` recognizes the pattern (`<system-reminder>`-style with substantive content remaining after stripping reminder blocks) and treats the turn as a real user prompt, not an injection. The multi-block injection text concat fix (see below) ensures `isInjectionText` sees the full combined text, not just the first reminder block.

## Persistent fork: the anchor-scan splice

After `rewind_to`, retcon doesn't just rewrite one `/v1/messages` and stop. It keeps the forked branch alive across every subsequent turn until something releases it. There's no per-session column — the source of truth is the `fork_anchors` row, and the body itself carries the boundary marker (the `<retcon-anchor token="..." />` tag inside the rewind_to tool_result).

For each `/v1/messages` from claude, `applyAnchorSplice` (src/fork-anchors.ts) does:

1. **Backward scan.** Walk `body.messages[]` from the end. For each user-role message whose content is an array containing `tool_result` blocks, regex-match `<retcon-anchor token=\\?"(tok_[0-9a-f]{12})\\?"\s*\/>` against the tool_result text. The regex's optional backslash matches both raw and JSON-escaped quotes — claude code JSON-stringifies MCP responses, so the production body carries the escaped form.
2. **Row lookup.** First match wins. Query `fork_anchors` by `anchor_token`.
3. **State dispatch.** If `state='active'`: splice `body.messages = [...target_messages, ...messages_after_the_anchor_turn]`. If `state='released'`: don't splice (the fork is gone); the persistent `<retcon-released>` reminder will fire below. If no row exists (stale token from a wiped DB, or coincidence): silent pass-through.
4. **Divergence detection.** If the scan returns nothing but the session has an active `fork_anchors` row, the user typed `/rewind` and truncated past the anchor. Mark the row `state='released', state_reason='divergence'` and emit `session.fork_anchor_released`.

The backward scan terminates on the first hit, so cascaded forks (rewind to a turn that was itself created by an earlier rewind) naturally pick the most-recent anchor — older anchor tokens still appear in body history as historical text inside the new target_messages, but they don't drive any splice.

The DB row persists across daemon restarts. The binding-token rebind merges across `claude --resume` boundaries (the resumed session_id ends up on the same row that holds the anchor — v0.6's rebindSession explicitly migrates `fork_anchors.session_id` along with `sessions.id`).

### Release on /clear and /compact

When the SessionStart hook fires with `source=clear` or `source=compact`, the hook handler calls `markSessionActiveAnchorsReleased` (folds target_messages to content-addressed CIDs and flips state) and emits `session.fork_anchor_cleared`. From the next turn onward, the proxy forwards claude's body unchanged. See [INSIGHTS.md](./INSIGHTS.md#why-compact-aligns-the-two-realities) for why /compact's signal is the right release point semantically.

### Persistent release reminder

While a released `fork_anchors` row on this session has `acknowledged_at IS NULL`, every `/v1/messages` gets a `<retcon-released>` text block prepended to the body's last user message. The reminder names the `turn_id` of the last successfully fork-applied revision so the AI can guide the user back via `recall` / `rewind_to` / `dump_to_file`. The AI mutes the reminder by calling `recall(turn_id=<that-turn>)` — the recall handler then sets `acknowledged_at` on the row and the next turn skips the injection. No auto-mute, no auto-retry. The AI/user must explicitly act to clear the alarm state.

## cache_control marker accumulation

Anthropic caps a `/v1/messages` request at 4 ephemeral `cache_control` markers. retcon's persistent-fork splice prepends `branch_context` carrying markers from prior turns onto a body that already has claude's fresh markers, so a few spliced turns later the body has 5+ and Anthropic 400s.

Two passes run before forwarding:

**`stripTtlViolations` (first).** Anthropic forbids a `ttl='1h'` marker from following a `ttl='5m'` marker in processing order (`tools` → `system` → `messages`). Strips any 5m marker that has a 1h marker after it in that order — a later 1h covers everything the earlier 5m would have, plus more, so removing the 5m loses no caching. Each strip emits `proxy.cache_control_ttl_violation_fixed`.

**`capCacheControlBlocks` (second).** Protects `system` + `tools` markers (those represent expensive prefixes worth caching) and strips the **earliest** `messages` markers first. This mirrors what claude already does turn-to-turn: the cached frontier rides at the tail (latest stable block), so the next turn's lookback finds it; older message markers age out naturally. retcon's cap just enforces the same discipline when stale markers accumulate. Each cap emits `proxy.cache_control_capped`.

Why two passes: the TTL violation is a separate failure mode (can fire even when the count is under 4) and removing 5m markers naturally leaves more room under the count cap. Order matters: TTL fix first, count cap second.

## Resume binding: how `--resume` merges back to the original session

`claude --resume <id>` can't accept `--session-id` (claude rejects the combination). retcon mints a binding token T, hands it to claude via the `x-playtiss-session` header / `Mcp-Session-Id`, and installs a SessionStart command hook via `--settings`.

```
  user runs `retcon --resume S`        retcon mints binding token T
       │                                       │
       └──► claude spawned with                ├─ claude opens picker (or accepts S directly)
            --resume + binding token T         ├─ claude resolves to actual session_id S
                                               ├─ SessionStart hook fires with source=resume
                                               │  payload includes both T and S
                                               │
                                          retcon's hook handler:
                                               ├─ rebindSession(T → S) in DB
                                               │   • merges binding-token's task into S's task
                                               │   • reconnects revision DAG so rewind targets
                                               │     across the resume boundary stay reachable
                                               └─ emits session.rebound{session_id: S, prev: T}
```

The rebind is the key invariant. Without it, claude's resumed session_id wouldn't match any session row retcon owns, and rewind_to would have no closed_forkable revisions to target. With it, the resumed session walks into the row that already holds the original session's revisions and branch_context.

For new sessions (no `--resume`), the binding token equals claude's session id and the rebind is a no-op.

## Body-blob storage: content-addressed messages

Request and response bodies for /v1/messages are stored content-addressed in the `blobs` table. The strategy is link-walked: each message in `messages[]` is hashed individually and its CID stored as a leaf blob; the top blob holds a body shape with `messages: [<cid>, <cid>, ...]` and `tools: [<cid>, ...]` instead of inline messages.

Storage scales linearly with NEW message content rather than O(N²) with conversation length. A 50-turn conversation that adds one new message per turn writes one new leaf blob per turn; the leaf blobs for the prior 49 turns are content-identical to the previous turn's body and dedupe.

`loadHydratedMessagesBody` is the read path: load the top blob, walk the CID links in `messages[]` and `tools[]`, return a fully-expanded JS object. This is what `reconstructForkMessages` and `buildSyntheticAsset` use to read past message content.

Format detection is sniff-based: any top blob whose decoded value is an object with `messages: CID[]` (and/or `tools: CID[]`) is treated as the link-walk format. There's a fallback to legacy raw-JSON format for top blobs from before the split — works under nuke-and-reinit but fragile once real schema migrations land. (TODOS.md tracks adding a magic version field for this.)

## Event log + projector model

retcon is event-sourced. The `events` table is append-only and authoritative; the `sessions`, `tasks`, `revisions`, `branch_views` tables are projected views derived from events. Projectors are pure state machines keyed on event topics; they run synchronously inside the same transaction as the event insert (the "event-emit invariant").

The event log, content-addressed blob storage, and projector dispatch live in `@playtiss/core/channel` since v0.5.6. retcon constructs a `Channel` over its SQLite handle and registers each projector as a `Task` — the Channel runs the actual dispatch. Same in-process synchronous-dispatch behavior as before; same `events` and `blobs` tables. The split moves the substrate primitives out so any consumer (today retcon; soon arianna) can ride the same protocol-conformant Channel without copy-pasting code.

Projectors that ship by default:

- `sessions_v1` — creates session rows from `mcp.session_initialized` and `proxy.request_received`; merges binding-token rows on `session.rebound`.
- `revisions_v1` — INSERTs a row on `proxy.request_received`, UPDATEs it on `proxy.response_completed` (sets parent_revision_id, classification, asset_cid, sealed_at).
- `branch_views_v1` — manages branch_views from `fork.bookmark_created`, `fork.forked`, `fork.label_updated`, `fork.bookmark_deleted`, and auto-advance from `proxy.response_completed`. Auto fork-point views materialize from `fork.forked` (success-only); `fork.back_requested` is audit-only and no projector consumes it.
- `rewind_marker_v1` — INSERTs SR rows from `fork.forked`. Topic-disjoint from the others.

Dispatch order is now declared via `TaskRef` dependencies in each projector's Task input dict, not by array position. `revisions_v1` declares `{ sessions: taskRef(sessionsId) }`; `branch_views_v1` and `rewind_marker_v1` both declare `{ revisions: taskRef(revisionsId) }`. The Channel's runner walks each Task's input recursively, harvests every `{ kind: 'task_ref', id }` value, and topologically sorts. Same effective ordering as the pre-Step-2 hardcoded array (sessions → revisions → branch_views, with rewind_marker after revisions), but reordering registration calls can no longer silently break dispatch.

### Per-projector SAVEPOINT isolation

Each projector's `apply()` runs inside its own SQLite SAVEPOINT inside the outer `BEGIN IMMEDIATE`. When a projector throws:

- Its partial writes roll back (`ROLLBACK TO sp_<i>_<...>` + `RELEASE`).
- The event row, earlier accepted projectors' writes, and downstream projectors all stay landed.
- The Channel records the exception as a `projection.exception` substrate event (payload: source event id, task id, error message) so the L1.10 Explicit Discarding invariant holds — the throw becomes data, not a swallow.
- `submit()` returns the per-Task `Outcome` (`accept` or `exception`) in dispatch order; the caller decides whether to surface the exception.

`submit()` itself rejects only on channel-level failures (DB I/O, primary-key collision on the event row). Projector exceptions never void the event.

### Two schema_version tables

`@playtiss/core/channel` owns `blobs`, `events`, `task_metadata`, and `channel_schema_version`. retcon owns `schema_version`, `sessions`, `tasks`, `revisions`, `branch_views`, `pending_actors`, and the legacy `projection_offsets`. `migrate()` calls `channelMigrate(db)` FIRST (the channel's tables must exist before retcon's v7→v8 step references `task_metadata`), then runs retcon's own migration registry. Each tracks its own version independently — channel-version bumps don't force retcon code changes.

The v7→v8 step copies `projection_offsets.last_processed_event_id` rows into `task_metadata` as `(task_id, 'events_offset', value)`. `projection_offsets` is left in place as legacy/forensic; nothing post-v8 reads from it. Verified non-destructive on a 1.77 GB production DB via `scripts/step4-byte-equality.mjs`.

## Stop-reason classifier

The classifier maps Anthropic's raw `stop_reason` strings to retcon's three forkability buckets:

- `closed_forkable` — `end_turn`, `stop_sequence`. These are legal rewind targets.
- `open` — `tool_use`, `pause_turn`. Mid-thought, can't fork here.
- `dangling_unforkable` — `max_tokens`, `refusal`, `null`, unknown. Terminal but not forkable.

There's also `in_flight` (request_received but no terminal yet) which is a transient projector state, not classifier output.

The synthetic stop_reasons (`rewind_synthetic`, `submit_synthetic`) bypass the classifier entirely — `RewindMarkerV1Projector` writes the SR row with `classification='closed_forkable'` directly. The classifier only sees stop_reasons that come from upstream's actual responses.

Unknown stop_reasons log a warning once per value and default to `dangling_unforkable`. Pass-through is preserved (we never error on a body forwarded from upstream); projection rebuilds are cheap, so adopting a new value is just code + replay.
