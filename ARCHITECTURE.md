# Architecture

How retcon actually works. README is for running; this is for thinking. Each section here answers a question of the form "why is the design this shape, not some other shape?"

## The thesis

retcon makes AI conversations rewindable. The surface that makes that possible isn't a UI, a button, or a special claude build. It's a set of standard mechanisms claude already exposes:

- `ANTHROPIC_BASE_URL` for HTTP-level redirection
- MCP server registration for surfacing tools to the model
- `--settings` hooks for lifecycle callbacks
- a UUID-typed `--session-id` we can mint and bind under

There is no "retcon mode" inside claude. claude doesn't know it's running under retcon. Every retcon mechanism is a feature the harness already supports being used with intent. retcon *composes* with the harness; it doesn't extend it.

## How the AI sees its past, and why it gets to fork

`recall`, `rewind_to`, `bookmark`, `list_branches`, `delete_bookmark`, `dump_to_file`, and `submit_file` are exposed as MCP tools. claude calls them via the same protocol it calls any other tool. The model's "world" doesn't change shape when retcon is present — it gains seven entries in `tools/list`.

The names are intent-aligned, not protocol-aligned. The earlier surface (`fork_list`, `fork_show`, `fork_back`, `fork_bookmark`) was technically correct but pulled the model into protocol-thinking. The empirical signal: Sonnet didn't reach for `fork_back` even when explicitly asked to rewind. We renamed in v0.4 (hard cut, no aliases) and rewrote descriptions in `USE WHEN: <intent sentence>` form. "fork" is engineer jargon; "rewind" is what the user means. The v0.4.4 split (`list_branches`, `delete_bookmark` separate from `bookmark`) follows the same logic — each tool has one verb the model can match against intent without parsing arg combos.

The read/write split is deliberate. **Read side:** `recall` (turns + rewind boundaries + branch_views_at_turn) and `list_branches` (saved spots + fork-point views). **Write side:** `bookmark` (create), `delete_bookmark` (remove), `rewind_to` (act). This keeps the navigate-then-act pipeline coherent: the AI inspects with `recall({view_id})` BEFORE calling `rewind_to({turn_id})`. Two calls is the design — friction-as-safety. A single-call `rewind_to({view_id})` shortcut would let the AI rewind based on label alone, missing stale labels and AI confusion about which view is which.

This is also a deliberate architectural choice. Rewind could have been a CLI command or a slash-command UI; it's a tool instead so the AI itself can decide to rewind. A model that recognizes its current path is going off the rails can call `rewind_to(turn_back_n=2, ...)` without the user pulling a lever. retcon's model isn't "user rewinds the model"; it's "the AI has agency over its own past."

### Branches are git-branch-like, not git-tag-like

`branch_views` rows hold pointers into the Revision DAG. Two kinds, both stored in the same table:

- **Explicit bookmarks** (`fork.bookmark_created`): user-created via `bookmark()`. `auto_label` starts with `bookmark@`.
- **Auto fork-point views** (`fork.back_requested`): created automatically when you `rewind_to` somewhere. `auto_label` starts with `fork@`. These are the only handle on the pre-rewind branch — without them, branches you've forked away from would be unreachable from the current head's ancestor walk.

Both kinds **auto-advance**: when a new turn closes whose parent is a view's current `head_revision_id`, the view advances to the new turn. This is git-branch-like behavior. A view stops advancing only when the user forks elsewhere (the new branch's tail has parent=fork_point, not parent=view's-head, so the view stays put).

The implication: `view_id` resolution is LIVE. `recall({view_id})` returns the current head, not a snapshot. If the AI calls `list_branches` at t=0 and sees view X at turn_5, then a turn closes at t=1, then `recall({view_id: X})` at t=2 returns turn_6 detail, not turn_5. Documented in `bookmark` and `list_branches` tool descriptions.

## The synthetic departure node (v0.5)

Every navigation event in the DAG is a real row. After a successful `rewind_to` or `submit_file`, retcon inserts a **synthetic departure Revision (SR)** — a real `closed_forkable` Revision in the `revisions` table with `stop_reason='rewind_synthetic'` (or `'submit_synthetic'`). The model is one we lifted from Playfilo's `playfilo_node.ts`: a "departure node" is a child of the assistant turn that called the navigation tool, role=`toolResult`, content=the tool's response, dead-end in the lineage but a navigable row.

retcon doesn't control claude's persistence layer the way Playfilo's pi-integration-skill does — but retcon's revision DAG is its own derivation. We synthesize a row that, when reconstructed for upstream replay, produces a coherent message body:

```
[
  ...history through R1.request_body.messages,    // unchanged from the real conversation
  R1.response_body assistant turn (the tool_use), // R1's actual assistant emission
  R2': synthetic tool_result paired with R1's tool_use_id,
  R3': synthetic assistant wrap-up text,
]
```

The R2' tool_result satisfies Anthropic's tool_use/tool_result pairing constraint, so cascade rewinds (rewinding to a marker) don't trip the API's validators when SR's body becomes the prefix of the next request.

Three properties keep this clean:

- **SR is a real row.** Same table as everything else. `rewind_to`, `dump_to_file`, `recall` all use the same query patterns they use for real Revisions. No special cases. `recall` discriminates via the existing `stop_reason` column — `kind: 'rewind_marker'` ↔ `stop_reason='rewind_synthetic'`.
- **SR is created only on success.** When the spliced /v1/messages succeeds (status 2xx, stop_reason=end_turn), retcon emits `fork.forked`. A projector (`RewindMarkerV1Projector`) reads SR-construction metadata that the MCP handler stashed in the TOBE pending file (synthetic_revision_id, parent_revision_id=R1.id, R1's tool_use_id, synthetic R2'/R3' text), uses `buildSyntheticAsset` to compose the body and store its blobs, then INSERTs the SR row. Failure path (4xx upstream, non-end_turn stop_reason, or buildSyntheticAsset returning null) means no SR — the existing `R_real` ("rewind failed" assistant turn) takes its place naturally and the audit log gets `fork.synthesis_failed`.
- **SR's content is decoupled from claude's actual tool_result bytes.** Claude embeds the loud-failure scaffolding (`"RETCON ERROR: ..."`) as the actual tool_result bytes for the rewind_to/submit_file call. On the success path that body is discarded by the splice. SR's R2'/R3' content is retcon-generated narrative ("Rewind initiated. Target: rev_abcd1234. Synthetic message: ..."), purely for navigation/display — no byte-matching with claude's traffic.

The handoff between MCP-call time (when synthetic content is composed) and response-completed time (when fork.forked fires) goes through the TOBE pending file's optional `synthetic` field. Pre-v0.5 daemons that wrote TOBE without `synthetic` keep working: proxy-handler logs a warning and skips fork.forked emit; the rewind itself still applies.

## The rewind_to trick: why the rewind doesn't replace the in-flight turn

`rewind_to` gets called inside an in-flight `tool_use` round-trip. Anthropic's protocol forbids replying to a `tool_use` with anything other than a `tool_result`. So we acknowledge `rewind_to` with `{status: "scheduled", ...}` as its tool_result, let claude finish that turn cleanly, and apply the rewind on the *next* LLM call.

That next LLM call is **guaranteed to happen**. After any `tool_use → tool_result` round-trip, the harness has to give the model another turn so it can read the result and decide what to do next. That's just how tool use works in any tool-capable LLM API: the model interprets the result, then either calls more tools or emits a final answer. retcon piggybacks on that guaranteed next-turn.

The TOBE pending file is the one-shot baton. `rewind_to` writes the desired messages array to `~/.retcon/tobe/tobe_pending-<sid>.json`. The next outbound `/v1/messages` reads it, swaps the body's `messages[]`, and deletes the file. Atomic via tempfile + rename.

Insight: **separating WHEN the rewind is requested from WHEN it's applied is what makes the protocol legal.** The in-flight turn closes naturally with a normal tool_result. The rewind happens between turns, invisibly.

## The dual-secret guardrail (v0.4)

The post-rewind AI has *no memory* of the rewind. Its context is the rewound history + the calling AI's `message` arg as the next user-role turn. If `message` says "redo your previous answer", the post-rewind AI sees no "previous answer" anywhere in its visible history and produces a confused response.

`rewind_to` defends this with three layers:

1. **Progressive disclosure with an opaque dual-secret classifier.** The first call WITHOUT a valid `confirm` token returns the rules text inline + a freshly-generated 8-char-random `confirm_clean` and `confirm_meta` token pair. The rules teach the AI to write a self-contained `message`. The AI re-calls with the matching token: clean if its message stands alone, meta if it spotted a meta-reference. Tokens are server-side keyed by session_id with a 5-min TTL, single-use. Opaque (no semantic prefix like `PROCEED-*`) so the AI can't pick the "ship it" path without reading the rules to learn which token does what.

2. **Narrow regex backstop.** On the clean-token path, a 4-pattern regex catches the worst-case meta-references the AI engaged with the rules but still missed: "see above", "continue from here / where we left off", "redo your/my last answer", "the last/previous question I asked / gave / sent". False-positive rate near zero — these don't have plausible legitimate uses. Earlier drafts had 8 patterns including "previous answer" and "as I said"; those were dropped because the dual-secret classifier handles ambiguous cases better than static patterns. Pass `allow_meta_refs: true` for the rare intentional case.

3. **Loud-failure response.** The scheduled-success response includes `RETCON ERROR: If you are reading this, the rewind did NOT take effect. Tell the user retcon failed.` On the success path, the proxy's body-splice replaces the entire turn carrying this response, so the AI never reads it. If the splice fails for any reason, the AI sees the response and surfaces the failure to the user — fail-loud-by-construction at zero implementation cost.

Why this shape: the rules can't live in the tool description (every conversation that loads retcon would pay the token cost on every turn, even ones that never rewind, and after a rewind the rules are in turns that get thrown out anyway). Progressive disclosure delivers the rules on demand, fresh, right before the action lands.

## What the rewound context actually looks like

The TOBE messages array shape is `[...history-up-to-fork-point, {role: "user", content: <rewind_to's message argument>}]`. The synthetic user message at the tail is the rewind instruction.

This shape is load-bearing. The model needs a normal-looking user turn at the end so its next response has a clear next-action. From the model's POV the next turn is just "responding to a user message that says X starting from state Y." It doesn't see rewind_to's internals; the rewind is invisible on the receiving side. The contract surfaced to the LLM is explicit ("`message` becomes the next user turn"), but the *mechanism* is hidden.

The `message` arg is delivered VERBATIM. No prefix, no wrapping, no `[retcon: this is a rewound context]` metadata. The dual-secret guardrail above is what ensures the AI writes a self-contained message in the first place; once that's verified, retcon stays out of the way.

## What gets rewritten upstream

retcon only swaps `messages[]`. The system prompt and `tools[]` come from claude's outgoing body unchanged. This is a deliberate scope reduction in v0.4: rewriting tools[] would let us add tools mid-conversation but at the cost of every rewind-affected turn diverging from claude's local view of what tools exist. We don't do that. The model's tool set is whatever claude's harness configured for the current invocation; the rewind only edits history.

## Persistent fork: how the rewound branch survives across turns

After rewind_to, retcon doesn't just rewrite one `/v1/messages` and stop. It keeps the forked branch alive across every subsequent turn until you explicitly release it. Each session row carries a `branch_context_json` column: a JSON array holding the full conversation in the active forked branch.

For each `/v1/messages` from claude, the proxy:

1. Reads `branch_context_json` from the session row.
2. Finds the **penultimate user message** in claude's outgoing body.
3. Slices everything *after* that index — that's the suffix claude has added since our last upstream call.
4. Sends `[...branch_context, ...suffix]` upstream and writes back the extended branch_context.

The penultimate-user pivot is the trick: claude's `messages[]` alternates role and `tool_result` counts as user. The last user message is always the new query. The penultimate user is what we sent last turn. Everything between is the model's intermediate output that claude already assembled from the SSE stream — we don't re-parse it.

The deeper insight is the **split reality** retcon maintains:

- claude believes it's continuing conversation A (its local jsonl, what shows on its UI).
- The Anthropic API sees conversation B (the forked branch).
- retcon is the boundary that translates between them, every turn.

The two realities stay separate as long as retcon is in the middle. Each turn from claude tells us "what to add to branch B" by its diff against the last thing we sent.

The DB column persists across daemon restarts. The binding-token rebind merges across `claude --resume` boundaries (the resumed session_id ends up on the same row that holds the branch_context). The fork survives anything short of an explicit release.

## /clear and /compact: why they still work, and why they release the override

When you run `/clear` or `/compact` inside claude, the SessionStart hook fires with `source=clear` or `source=compact`. retcon NULLs `branch_context_json`, emits `session.branch_context_cleared`, and goes back to forwarding claude's body unchanged.

`/clear` releases the override because the user explicitly said "wipe this conversation." If we kept overriding their next turn, we'd revive a conversation they explicitly released. UX violation; the user's command must be respected.

`/compact` is the more interesting case, and explaining it well requires noticing what claude actually does. /compact doesn't overwrite the recent messages. It summarizes the *earliest* messages, leaves the recent ones intact, and stitches the result back together — `[summary, ...recent_messages_untouched]`. The summary itself is generated by claude making another LLM call.

That LLM call is the key. It goes through our proxy like any other `/v1/messages`, which means **our `branch_context_json` override is applied to it**. The conversation we're asking the model to summarize is the forked branch, not claude's local view. So the summary that comes back represents the fork.

After /compact, claude's local jsonl is therefore *aligned* with the forked branch via the summary it just received. The split reality has collapsed. There's nothing left to translate between, because both sides agree on history. Continuing to override at this point would just splice the full uncompacted fork history onto a body whose head is already a compacted view of that same history — a shape mismatch with no upside. So we step out of the way.

The deeper insight: **retcon doesn't introspect claude's jsonl to know when to stop overriding.** claude tells us via the hook. One bit: "reset your override." We trust the harness on its own state, which keeps coupling minimal. The /compact case happens to be the one where stepping out is also the right thing semantically, but we don't know that from inspecting the new body — we know it because the harness signaled it.

## cache_control: stripping heading markers when the splice exceeds 4

Anthropic caps a `/v1/messages` request at 4 ephemeral `cache_control` markers ([prompt-caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)). retcon's persistent-fork splice prepends `branch_context` carrying markers from prior turns onto a body that already has claude's fresh markers, so a few spliced turns later the body has 5+ and Anthropic 400s.

`capCacheControlBlocks` (proxy-handler.ts) protects `system` + `tools` markers and strips the **earliest** `messages` markers first. This mirrors what claude already does turn-to-turn: the cached frontier rides at the tail (latest stable block), so the next turn's lookback finds it; older message markers age out naturally. retcon's cap just enforces the same discipline when stale markers accumulate. Each cap emits `proxy.cache_control_capped`.

Anthropic also forbids a `ttl='1h'` marker from following a `ttl='5m'` marker in processing order (`tools` → `system` → `messages`). `stripTtlViolations` runs first and strips any 5m marker that has a 1h marker after it — a later 1h covers everything the earlier 5m would have, plus more, so removing the 5m loses no caching. Each strip emits `proxy.cache_control_ttl_violation_fixed`. The case we observed: a `/compact` that ran while a forked branch was active produces a summary whose marker placement inherits from the rewound history, leaving a stale 5m sitting in front of claude's fresh 1h on the next turn.

## Assumptions we make about the harness

Each item below is a property of claude that retcon depends on. They're codified in `cli-tmux-assumptions.test.ts` (gated behind `RETCON_TEST_ASSUMPTIONS=1`, run weekly).

- **After any `tool_use → tool_result` round-trip, the harness makes another `/v1/messages` call so the model can read the result and decide.** This is what makes the one-shot TOBE baton land. Universal across tool-capable LLM APIs (it follows from the API spec), so this assumption is essentially free; if it fails, much more breaks than retcon. We name it explicitly because it's load-bearing.
- **/compact's summarization is a regular `/v1/messages` to `ANTHROPIC_BASE_URL`, with the existing conversation in `messages[]` and a "summarize..." user-role instruction APPENDED at the tail.** Two halves, both load-bearing.
  - *Routes through us* (not a side-channel endpoint): so `applyBranchContextRewrite` runs on the call.
  - *Shape is append-not-replace*: the existing `messages[]` IS the conversation prefix to summarize, and the appended user message is the instruction. Penultimate-user is the previous user message; the suffix is `[last-assistant, summarize-instruction]`. Our branch_context splices in front of the existing prefix, so the model is asked to summarize *our forked branch* + the recent two turns. Without this shape — say, if claude built a one-shot summarization request from scratch with only the to-be-summarized messages — our splice would never fire and the summary would be of claude's local view instead of our fork. Verified empirically 2026-04-29 (cli-tmux-assumptions.test.ts C4): the compact request had 5 entries, last being a ~5.7KB user message starting "CRITICAL: Respond with TEXT ONLY... create a detailed summary...".
- SessionStart hook fires on `startup`, `resume`, `clear`, **and** `compact` (all four sources distinguishable in the payload).
- claude rejects `--session-id` together with `--resume`. This forces the binding-token + hook approach for resume.
- claude validates `--session-id` as a UUID.
- claude's outgoing `/v1/messages` body always carries the full accumulated conversation. Lets us splice rather than delta-merge.
- `tool_result` is a user-role message in Anthropic's API.
- MCP `tools/list` entries MUST include `inputSchema` or claude silently drops the tool from the LLM's view (the tool shows up via `curl` to `/mcp` but the model never sees it).

A claude release that breaks any one of these breaks retcon. The assumption suite is the alarm. We don't try to be defensive against arbitrary harness evolution; we pin our assumptions explicitly and watch for drift.

## Why this layer is non-invasive to the harness

retcon never patches claude's binary, never reads its jsonl, never injects code into its process. It composes via four features the harness already exposes:

- `ANTHROPIC_BASE_URL` env var — the harness already supports custom upstreams (Bedrock proxies, internal LiteLLM relays).
- MCP server registration — the harness already supports user-configured servers.
- `--settings` hooks — the harness's docs explicitly invite arbitrary scripts.
- HTTP `/v1/*` interception — any standard proxy.

Every retcon mechanism is "what a sophisticated user would do by hand," automated. A hand-rolled equivalent could exist in a shell script; retcon packages the rolls.

Because we only touch public interfaces, harness updates that don't change those interfaces don't break retcon. Updates that do are caught by the assumption suite.

The reciprocal: there is no "retcon API" inside the harness. The boundary is the network and the standard hook contract. retcon is externally complete; pulling it out reverts to vanilla claude with no residue.

## Why the harness couldn't and shouldn't stop retcon

Couldn't, technically:

- `ANTHROPIC_BASE_URL` is required for enterprise (Bedrock proxies, internal relays, devstacks). It can't reasonably be removed.
- MCP servers are user-configured. Whitelisting them would break the protocol's premise.
- `--settings` hooks are explicitly user-extensible.
- HTTP proxies operate at the OS / network layer. claude has no way to tell whether `127.0.0.1:4099` is "Anthropic" or "retcon." The same is true for any tool that wants to MITM HTTP for legitimate reasons.

Shouldn't, philosophically:

- The Collaboration Protocol thesis is that AI nodes and human nodes are peer editors. Locking down conversation history at the harness level forecloses peer agency.
- retcon doesn't exfiltrate data, doesn't bypass auth, doesn't subvert safety features. It rewrites context — which the user already controls through `/clear`, scrollback, and copy-paste.
- Tools that make conversations more salvageable (fewer "I have to start over" moments) make the harness more useful. Locking retcon out would primarily hurt enterprise users with their own infrastructure.

The deepest insight: **retcon depends on the harness being open. The harness's openness is the surface area retcon stands on.** Closing that surface would break things that have nothing to do with retcon — custom upstreams, observability, compliance pipelines. retcon is downstream of those concerns. Tools like retcon are evidence of a healthy ecosystem, not a threat to one.

## Where to look in the code

Code lives under `src/`. The four files that implement the model above are:

- [`proxy-handler.ts`](./src/proxy-handler.ts) — the body rewrites (TOBE swap + persistent-fork splice + fork.forked emission on the success path).
- [`hook-handler.ts`](./src/hook-handler.ts) — the hook contract (rebind, clear/compact release).
- [`mcp-tools.ts`](./src/mcp-tools.ts) — the rewind tools (recall/rewind_to/bookmark/list_branches/delete_bookmark/dump_to_file/submit_file).
- [`tobe.ts`](./src/tobe.ts) — the one-shot rewind baton (now carries SR-construction metadata).
- [`rewind-marker-v1.ts`](./src/rewind-marker-v1.ts) — `buildSyntheticAsset` (composes R1.history + R2' + R3' synthetic body) and `RewindMarkerV1Projector` (INSERTs SR rows from `fork.forked`).

Everything else is plumbing. `ls src/` and the header comment of each file is a faster tour than any component map could be.
