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

`recall`, `rewind_to`, `bookmark`, `dump_to_file`, and `submit_file` are exposed as MCP tools. claude calls them via the same protocol it calls any other tool. The model's "world" doesn't change shape when retcon is present — it gains five entries in `tools/list`.

The names are intent-aligned, not protocol-aligned. The earlier surface (`fork_list`, `fork_show`, `fork_back`, `fork_bookmark`) was technically correct but pulled the model into protocol-thinking. The empirical signal: Sonnet didn't reach for `fork_back` even when explicitly asked to rewind. We renamed in v0.4 (hard cut, no aliases) and rewrote descriptions in `USE WHEN: <intent sentence>` form. "fork" is engineer jargon; "rewind" is what the user means.

This is also a deliberate architectural choice. Rewind could have been a CLI command or a slash-command UI; it's a tool instead so the AI itself can decide to rewind. A model that recognizes its current path is going off the rails can call `rewind_to(turn_back_n=2, ...)` without the user pulling a lever. retcon's model isn't "user rewinds the model"; it's "the AI has agency over its own past."

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

- [`proxy-handler.ts`](./src/proxy-handler.ts) — the body rewrites (TOBE swap + persistent-fork splice).
- [`hook-handler.ts`](./src/hook-handler.ts) — the hook contract (rebind, clear/compact release).
- [`mcp-tools.ts`](./src/mcp-tools.ts) — the fork tools.
- [`tobe.ts`](./src/tobe.ts) — the one-shot rewind baton.

Everything else is plumbing. `ls src/` and the header comment of each file is a faster tour than any component map could be.
