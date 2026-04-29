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

`fork_list`, `fork_show`, `fork_bookmark`, and `fork_back` are exposed as MCP tools. claude calls them via the same protocol it calls any other tool. The model's "world" doesn't change shape when retcon is present — it gains four entries in `tools/list`.

This is a deliberate choice. Fork tools could have been a CLI command or a slash-command UI; they're tools instead so the AI itself can decide to rewind. A model that recognizes its current path is going off the rails can `fork_back 2` without the user pulling a lever. retcon's model isn't "user rewinds the model"; it's "the AI has agency over its own past."

## The fork_back trick: why the rewind doesn't replace the in-flight turn

`fork_back` gets called inside an in-flight `tool_use` round-trip. Anthropic's protocol forbids replying to a `tool_use` with anything other than a `tool_result`. So we acknowledge `fork_back` with `{status: "scheduled"}` as its tool_result, let claude finish that turn cleanly, and apply the rewind on the *next* LLM call.

That next LLM call is **guaranteed to happen**. After any `tool_use → tool_result` round-trip, the harness has to give the model another turn so it can read the result and decide what to do next. That's just how tool use works in any tool-capable LLM API: the model interprets the result, then either calls more tools or emits a final answer. retcon piggybacks on that guaranteed next-turn.

The TOBE pending file is the one-shot baton. `fork_back` writes the desired messages array to `~/.retcon/tobe/tobe_pending-<sid>.json`. The next outbound `/v1/messages` reads it, swaps the body's `messages[]`, and deletes the file. Atomic via tempfile + rename.

Insight: **separating WHEN the fork is requested from WHEN it's applied is what makes the protocol legal.** The in-flight turn closes naturally with a normal tool_result. The rewind happens between turns, invisibly.

## What the rewound context actually looks like

The TOBE messages array shape is `[...history-up-to-fork-point, {role: "user", content: <fork_back's message argument>}]`. The synthetic user message at the tail is the rewind instruction.

This shape is load-bearing. The model needs a normal-looking user turn at the end so its next response has a clear next-action. From the model's POV the next turn is just "responding to a user message that says X starting from state Y." It doesn't see fork_back's internals; the rewind is invisible on the receiving side. The contract surfaced to the LLM is explicit ("`message` becomes the next user turn"), but the *mechanism* is hidden.

## Persistent fork: how the rewound branch survives across turns

After fork_back, retcon doesn't just rewrite one `/v1/messages` and stop. It keeps the forked branch alive across every subsequent turn until you explicitly release it. Each session row carries a `branch_context_json` column: a JSON array holding the full conversation in the active forked branch.

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

`/compact` releases the override because claude rebuilt its local jsonl from a *summary* of the conversation that already incorporated the forked context we'd been injecting. Continuing to override would (a) re-inflate the bytes claude just compressed and (b) double-count the fork's history inside the summary itself. Compounding error.

The deeper insight: **retcon doesn't introspect claude's jsonl to know when to stop overriding.** claude tells us via the hook. One bit: "reset your override." We trust the harness on its own state, which keeps the coupling minimal. If a future harness rewrite changes how compaction works internally, retcon doesn't care — as long as it still emits the hook with a recognizable source.

## Assumptions we make about the harness

Each item below is a property of claude that retcon depends on. They're codified in `cli-tmux-assumptions.test.ts` (gated behind `RETCON_TEST_ASSUMPTIONS=1`, run weekly).

- **After any `tool_use → tool_result` round-trip, the harness makes another `/v1/messages` call so the model can read the result and decide.** This is what makes the one-shot TOBE baton land. Universal across tool-capable LLM APIs (it follows from the API spec), so this assumption is essentially free; if it fails, much more breaks than retcon. We name it explicitly because it's load-bearing.
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
