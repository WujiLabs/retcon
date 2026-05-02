# Implementation

The "how" of retcon's non-trivial mechanisms. [INSIGHTS.md](./INSIGHTS.md) covers the design principles and why each shape is the right shape; this doc covers the parts where the mechanism itself is load-bearing — the multi-step pipelines, the hand-offs across time/process boundaries, the ordering invariants that aren't obvious from reading any single file.

What this doc deliberately doesn't cover: file layout, type definitions, function signatures. Those are derivable by reading the code.

## TOBE pending file: the one-shot baton

`rewind_to` and `submit_file` schedule effects that land on the *next* `/v1/messages`. The hand-off mechanism is a per-session pending file at `~/.retcon/tobe/tobe_pending-<session-id>.json`. The MCP handler writes it; the proxy-handler peeks-then-commits it on the next outbound request.

```
  MCP rewind_to call           proxy.request_received          proxy.response_completed
       │                              │                                   │
       ├─ write TOBE                  ├─ peek TOBE                        ├─ commit TOBE (delete)
       │  (atomic: tmpfile+rename)    │  (read; don't delete yet)          │  iff status<500
       │                              ├─ apply splice                     ├─ emit fork.forked
       └─ return                      └─ forward to upstream               │  iff 2xx + end_turn
                                                                          │  + synthetic present
                                                                          └─ otherwise emit
                                                                            fork.synthesis_failed
```

Atomic write is mandatory. A concurrent peek of a partially-flushed file parses as malformed and the fork intent is silently lost. Implementation: write to `<target>.<pid>.tmp`, then `rename()` over the target. Peek reads the file but doesn't delete; commit (delete) happens only after the upstream call returns a 2xx response. On 5xx / abort / upstream_error the file stays so claude's retry loop re-applies it.

The TOBE shape carries:

- `messages[]` — the new conversation history to splice in.
- `fork_point_revision_id` — the rewind target's revision id.
- `source_view_id` — the calling session id.
- `synthetic` (optional) — SR-construction metadata. See "Synthetic departure Revision pipeline" below.

## Synthetic departure Revision (SR) pipeline

Every successful rewind/submit produces an SR row in the revisions table. The pipeline spans three time points:

```
  T0: MCP-call time (rewind_to / submit_file handler)
      ├── compute synthetic_revision_id (generateTraceId)
      ├── compute R2'/R3' display text
      ├── stash in TOBE.synthetic alongside messages[]
      └── (do NOT touch claude's response body — it's gzip'd SSE)

  T1: TOBE-consumed time (proxy-handler, on next /v1/messages)
      ├── parse claude's pre-splice body as JSON (NOT the response — the request)
      ├── find last assistant message → that's R1's parsed content
      ├── parallel-tool guard:
      │     if R1's content has tool_use blocks beyond the operation tool,
      │     abort splice + emit fork.synthesis_failed
      ├── apply splice (replace messages[] with TOBE.messages)
      └── forward to upstream

  T2: response-completed time (proxy-handler, after upstream replies)
      ├── if status==2xx + stop_reason==end_turn + TOBE.synthetic present:
      │     ├── extract operation tool's tool_use_id from R1's content
      │     ├── compose synthetic body (history + R2'/R3')
      │     ├── content-address each message via blobRefFromMessagesBody
      │     ├── emit fork.forked with synthetic_asset_cid + refs
      │     └── (RewindMarkerV1Projector inserts the SR row)
      └── otherwise: no SR materializes; rewind itself still applied
```

The hand-off across T0→T1→T2 is what makes the unit-test path and production path agree. T1 is where the production-only failure modes live (claude's request body shape, gzip/SSE on the response side). Tests that mock T0→T2 directly skip the T1 hazards; the integration test (`cli-tmux-integration.test.ts`) is what catches them.

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

### Pre-v0.5 TOBE backward-compat

A daemon upgrade mid-session can leave a v0.4-shaped TOBE pending file (no `synthetic` field) for the v0.5+ daemon to consume. proxy-handler logs a warning and skips fork.forked emission. The rewind/submit still applies; only the SR row doesn't materialize for that one operation. Documented gap, acceptable per pre-1.0 alpha policy.

## Persistent fork: the penultimate-user splice

After rewind_to, retcon doesn't just rewrite one `/v1/messages` and stop. It keeps the forked branch alive across every subsequent turn until you explicitly release it. Each session row carries a `branch_context_json` column: a JSON array holding the full conversation in the active forked branch.

For each `/v1/messages` from claude, the proxy:

1. Reads `branch_context_json` from the session row.
2. Finds the **penultimate user message** in claude's outgoing body.
3. Slices everything *after* that index — that's the suffix claude has added since our last upstream call.
4. Sends `[...branch_context, ...suffix]` upstream and writes back the extended branch_context.

The penultimate-user pivot is the trick: claude's `messages[]` alternates role and `tool_result` counts as user. The last user message is always the new query. The penultimate user is what we sent last turn. Everything between is the model's intermediate output that claude already assembled from the SSE stream — we don't re-parse it.

The DB column persists across daemon restarts. The binding-token rebind merges across `claude --resume` boundaries (the resumed session_id ends up on the same row that holds the branch_context). The fork survives anything short of an explicit release.

### Release on /clear and /compact

When the SessionStart hook fires with `source=clear` or `source=compact`, the hook handler NULLs `branch_context_json` and emits `session.branch_context_cleared`. From the next turn onward, the proxy forwards claude's body unchanged. See [INSIGHTS.md](./INSIGHTS.md#why-compact-aligns-the-two-realities) for why /compact's signal is the right release point semantically.

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

Projectors that ship by default:

- `sessions_v1` — creates session rows from `mcp.session_initialized` and `proxy.request_received`; merges binding-token rows on `session.rebound`.
- `revisions_v1` — INSERTs a row on `proxy.request_received`, UPDATEs it on `proxy.response_completed` (sets parent_revision_id, classification, asset_cid, sealed_at).
- `branch_views_v1` — manages branch_views from `fork.bookmark_created`, `fork.back_requested`, `fork.bookmark_deleted`, and auto-advance from `proxy.response_completed`.
- `rewind_marker_v1` — INSERTs SR rows from `fork.forked`. Topic-disjoint from the others.

The dispatch order matters. `sessions_v1` runs first so the session/task rows exist before `revisions_v1` tries to FK against them. `revisions_v1` runs before `branch_views_v1` so that `revisions.parent_revision_id` is set when branch_views_v1 reads it for auto-advance.

## Stop-reason classifier

The classifier maps Anthropic's raw `stop_reason` strings to retcon's three forkability buckets:

- `closed_forkable` — `end_turn`, `stop_sequence`. These are legal rewind targets.
- `open` — `tool_use`, `pause_turn`. Mid-thought, can't fork here.
- `dangling_unforkable` — `max_tokens`, `refusal`, `null`, unknown. Terminal but not forkable.

There's also `in_flight` (request_received but no terminal yet) which is a transient projector state, not classifier output.

The synthetic stop_reasons (`rewind_synthetic`, `submit_synthetic`) bypass the classifier entirely — `RewindMarkerV1Projector` writes the SR row with `classification='closed_forkable'` directly. The classifier only sees stop_reasons that come from upstream's actual responses.

Unknown stop_reasons log a warning once per value and default to `dangling_unforkable`. Pass-through is preserved (we never error on a body forwarded from upstream); projection rebuilds are cheap, so adopting a new value is just code + replay.
