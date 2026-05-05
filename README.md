# @playtiss/retcon

retcon for AI conversations. The AI recontextualizes its own past — that's the verb the tool is named for: introducing new information that reshapes what came before. recall any turn, rewind to one, bookmark spots, dump and re-submit edited transcripts. The canonical Observer Actor instantiation of the Collaboration Protocol.

## Why retcon?

You ask the AI to do something. It misunderstands. You correct it. But the messed-up turn stays in context, and the AI is fighting both your correction and its own past mistake. The instinctive move — *recontextualize the past turn and replay forward* — is what you'd do with a human collaborator. Yet, most AI tooling prohibits it.

`retcon` flips the model. Instead of you typing a `/rewind` command, `retcon` exposes MCP tools so the AI can edit its own history. You just tell it what you want in natural language:

> **Human:** "Go back to where we started this discussion and try again with the new constraint."
> **AI:** [Called retcon 2 times… (ctrl+o to expand)]
> **AI:** "I've rewound the context and cleared the previous error. Continuing with the new constraint..."

## Architecture overview

One HTTP server: `/v1/*` proxies to your Anthropic-compatible upstream, `/mcp` serves the Model Context Protocol (Streamable HTTP) for the rewind tools, `/hooks/session-start` learns claude's session id post-resume, `/health` reports daemon identity.

## Status

Pre-1.0. Expect breaking changes between minor versions.

## Install

```bash
npm install -g @playtiss/retcon
```

## Run

```bash
retcon                              # spawn claude under retcon (default)
retcon --actor alice                # tag this session as belonging to "alice"
retcon --resume                     # resume a previous claude session
retcon --resume <session-id>        # resume a specific session
retcon --continue                   # resume the most recent session
retcon stop                         # stop the background daemon
retcon status                       # daemon state, uptime, disk usage
retcon clean --actor X              # wipe every session tagged with X (dry-run)
retcon clean --actor X --yes        # apply the wipe
```

`retcon` runs claude as a child process. The detached daemon listens on `127.0.0.1:4099` (override with `RETCON_PORT`) and outlives any single claude invocation, so your fork history persists across sessions. Closing claude does NOT close the daemon.

## Persistent fork branches

Once you run `rewind_to`, retcon doesn't just rewrite one /v1/messages call — it keeps the forked branch alive across every subsequent turn until you start a new session, run `/clear`, or run `/compact` inside claude. Each new turn from claude is spliced onto the fork's history at the penultimate-user message, so the upstream Anthropic API sees a coherent conversation that picks up from your edit instead of from claude's local jsonl.

The branch survives daemon restarts, `claude --resume`, and `claude --continue`. Run a fresh `rewind_to` to switch branches. Run `/clear` or `/compact` inside claude to release the fork and let claude's local view drive future turns.

## Actors and cleanup

Every session is tagged with an actor name. The default actor is `default`; pass `--actor <name>` to scope a session under your own tag (1–64 characters, `[A-Za-z0-9_-]`).

`retcon clean --actor <name>` wipes every row associated with that actor: events, branch_views, revisions, tasks, sessions, pending registrations, and the per-session TOBE pending files on disk. Defaults to dry-run; pass `--yes` to apply. Refuses to run while the daemon is up unless you pass `--force`.

This is destructive of the event log (the source-of-truth append-only history) for that actor. The intended use is cleaning up integration-test runs and unwanted exploration. Other actors' data is untouched.

## Rewind tools

Available to claude inside the session via the MCP server retcon auto-registers as `mcp__retcon__*`:

- `recall` — list recent forkable turns OR inspect one (`turn_back_n: N`, `turn_id: "..."`, or `view_id: "..."`). Each entry has a `kind` field: `"turn"` (real /v1/messages assistant turn), `"rewind_marker"` (a synthetic departure row marking a successful prior rewind), or `"submit_marker"` (same for `submit_file`). Markers are first-class navigable points — you can rewind back to them or dump them just like real turns. `surrounding: N` (0-10) on inspect adds N forkable turns on each side. Detail mode also lists `branch_views_at_turn` — every saved spot pointing at the inspected turn.
- `rewind_to` — roll the conversation back to a chosen turn and replace the next message. **Two-step call**: the first call returns rules + a single-use `confirm_clean`/`confirm_meta` token pair; the AI classifies its own message (does it stand alone, or does it contain a meta-reference to cut-off content?) and re-calls with the matching token. Catches the AI before it sends a `"redo your last answer"`-style message that would confuse the post-rewind context.
- `bookmark` — pin the latest forkable turn with an optional human label. **Behaves like a git branch, not a git tag**: its head auto-advances as new turns close on this branch. When you fork via `rewind_to`, the bookmark stays on the original branch and a new auto fork-point view is created at the fork point.
- `list_branches` — return every saved navigation point in this session. Both explicit bookmarks AND the auto fork-point views created by `rewind_to`. Each entry has a `kind` field (`"bookmark"` or `"fork_point"`) and `n_back_of_head` (0 = currently tracking head, N>0 = N forkable turns back, null = head not in the closed_forkable sequence). This is the only way to see and navigate to branches you've forked away from.
- `delete_bookmark` — remove a saved spot by `id_or_label`. Auto fork-point views can only be deleted by `view_id` since their label is NULL. Errors if the label matches multiple views.
- `dump_to_file` — write the conversation through a chosen turn to `~/.retcon/dumps/<id>.jsonl` (one Anthropic message per line). retcon's CLI pre-allows `Read`/`Edit`/`Write`/`Glob`/`Grep` over `~/.retcon/dumps/**` in the spawned claude's permissions, so the AI can inspect and modify the file without prompting you. No args = dump current state; `turn_id` or `turn_back_n` = dump through that turn.
- `submit_file` — read a JSONL dump back, validate it (each line a well-formed Anthropic message, last line must be assistant-role), append your `message` arg as a new user turn, and queue it as the next /v1/messages from claude. Same **two-step token flow** as `rewind_to`. Pairs with `dump_to_file` for the "let me actually edit a few past turns before continuing" use case that pure `rewind_to` can't express.

**When to reach for which:**

| You want to... | Tool |
|---|---|
| See what turns you can rewind to | `recall` (no args) |
| See what saved spots and forks exist | `list_branches` |
| Inspect a specific turn before rewinding | `recall` with `turn_id`, `turn_back_n`, or `view_id` |
| See N turns around a turn or saved spot | `recall` with `surrounding: N` |
| Actually rewind (replace the next turn only) | `rewind_to` (two-step: first call returns rules + tokens, second call applies) |
| Edit several past turns before continuing | `dump_to_file` → `Read`/`Edit` the JSONL → `submit_file` |
| Save a spot to return to later | `bookmark` |
| Remove a saved spot or stale fork-point view | `delete_bookmark` |

Source of truth is the event log; the projector marks each `/v1/messages` round-trip as `closed_forkable`, `dangling_unforkable`, or `open` based on stop reason and stream state. Only `closed_forkable` turns are recall/rewind targets — including the synthetic departure rows (SR rows) that materialize after a successful `rewind_to` or `submit_file`.

### Common workflows

retcon supports four named workflows. The first three are what AIs reach for in practice; the fourth is a power-user pattern.

**1. Clean redo of a single turn.** "Try that answer again with X instead of Y." Use `rewind_to` alone — single-point rewinds are the simplest and most common case.

**2. Save a spot and come back to it.** "Bookmark here, I want to try a different approach but might want to return." Use `bookmark` to save, `list_branches` to see saved spots, `recall({view_id})` then `rewind_to({turn_id})` to return.

**3. Forget the pink elephant.** "Pretend you never saw that sensitive log dump / off-topic tangent / leaked credential." Single-point `rewind_to` only works when the contamination is one turn. When it's spread across multiple turns, use the dump+edit+submit pattern: `dump_to_file` writes the conversation to a JSONL file → use `Read` and `Edit` (or `Grep` to find specific content) to remove or rewrite the lines → `submit_file` queues the sanitized history as the next /v1/messages. The receiving AI sees the cleaned conversation with no memory of what was removed. Use cases: stripping leaked secrets, removing a tangent that biased the model's later reasoning, "answer this WITHOUT mentioning X" workflows, recovering from a botched rewind.

**4. Factual correction in past content.** "I told you the budget was $500 but it's $5,000 — redo the analysis." `dump_to_file` → `Edit` the specific message line → `submit_file` with a `message` that names the correction so the AI acknowledges what changed (e.g. "I corrected the budget from $500 to $5,000 in the earlier turn — please redo the cost analysis."). The dumped JSONL has one message per line, so editing a specific turn is a one-line change.

For workflow 3 and 4: retcon pre-allows `Read`/`Edit`/`Write`/`Glob`/`Grep` on `~/.retcon/dumps/**` so the AI can manipulate dump files without prompting the user.

### Synthetic departure rows (rewind/submit markers)

After a successful `rewind_to` (or `submit_file`), retcon inserts a real row into the revisions table marking where that navigation happened. It's a valid `closed_forkable` Revision — `recall` shows it inline with `kind: "rewind_marker"` (or `"submit_marker"`), and `rewind_to({turn_id: <SR.id>})` and `dump_to_file({turn_id: <SR.id>})` work the same as on any other turn. Cascade rewinds (rewinding to a marker) just produce another marker. The pre-rewind branch's tail and the rewind moment itself are both first-class navigable points; no special navigation surface needed.

Behind the scenes: when the spliced /v1/messages succeeds (status 2xx, stop_reason=end_turn), retcon emits `fork.forked`. A projector reads the SR-construction metadata that the MCP handler stashed in the TOBE pending file, builds a synthetic body of `[history through R1, R1's assistant turn, synthetic tool_result paired with R1's tool_use_id, synthetic assistant wrap-up]`, and INSERTs the SR row pointing at that body. R1 is the assistant turn that called `rewind_to`/`submit_file`. The synthetic body satisfies Anthropic's tool_use/tool_result pairing constraint, so cascade rewinds don't trip the API's validators.

### What "two-step" means for `rewind_to`

The AI handling the next /v1/messages after a rewind has *no memory* of the rewind — its context is the rewound history + your `message` arg as the next user-role turn. If `message` says "redo your previous answer", that AI sees no "previous answer" anywhere in its visible history and produces a confused response.

To prevent this, `rewind_to` returns rules + a token pair on the first call. The rules text teaches the AI to write a self-contained `message` (no meta-references to cut-off content). The AI then re-calls with one of two tokens:

- `confirm=<clean_token>` — the AI's own claim that the message stands alone. Server runs a narrow regex backstop on a 4-pattern list (catches "see above", "continue from here", "redo your last answer", "the last/previous question I asked") and either writes the rewind to the TOBE pending file or rejects with a fresh token pair.
- `confirm=<meta_token>` — the AI self-flagged a meta-reference. Server returns "good catch — revise" with new tokens.

Tokens are 8-char opaque random per call, server-side keyed by session_id with a 5-min TTL, single-use. The AI can't pick the "ship it" path without reading the rules text to learn which token does what. Pass `allow_meta_refs: true` if your message intentionally references content visible in the rewound history.

## Custom upstream

Set `ANTHROPIC_BASE_URL` in your shell to point retcon's daemon at a non-Anthropic provider:

```bash
ANTHROPIC_BASE_URL=https://openrouter.ai/api ANTHROPIC_API_KEY=or-sk-... retcon
```

retcon captures the value at CLI start, configures the daemon to proxy `/v1/*` to that upstream, then overrides `ANTHROPIC_BASE_URL` for the spawned claude so it talks to the local daemon. Auth headers (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) are inherited by claude unchanged and forwarded by the daemon as-is to upstream.

If a daemon is already running with a different upstream, retcon errors with an actionable message: `retcon stop` to restart, or `RETCON_PORT=<other> retcon ...` to run on a different port. Same UX as version mismatch.

## Resume support

`retcon --resume` and `retcon --continue` work end-to-end:

- claude can't accept `--session-id` together with `--resume`, so retcon mints a binding token and installs a `SessionStart` command hook via `--settings`.
- When the picker resolves (or `--continue` picks the latest), the hook fires and posts claude's actual session id back to the daemon's `/hooks/session-start`.
- The daemon re-keys events and revisions from the binding token to the actual session id, reconnecting the DAG so `rewind_to` can walk across the resume boundary.
- For new sessions the binding token equals claude's session id and the rebind is a no-op.

If you pass `--session-id <uuid>` to a new session, retcon adopts your id rather than minting one of its own. The id you typed is the id you'll see in the local jsonl filename and rewind tools.

## Mergeable user args / env

retcon injects `--session-id`, `--mcp-config`, `--settings`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, and `RETCON_BINDING`. Your own values for these are merged where possible:

| You provide | retcon's behavior |
|---|---|
| `--actor <name>` | consumed by retcon (not forwarded to claude); tags this session for grouping / cleanup |
| `--session-id <uuid>` (new session) | adopted as the binding token |
| `--mcp-config` with other servers | passes through (claude unions across multiple flags) |
| `--mcp-config` with `mcpServers.retcon` | error: rename your entry |
| `--settings` with `hooks.SessionStart` | inline-merged (your hooks fire alongside ours) |
| `--settings` with other hooks / config | inline-merged |
| `ANTHROPIC_CUSTOM_HEADERS=...` | newline-appended (your header survives) |
| `ANTHROPIC_BASE_URL=...` | captured as upstream, then overridden for the child |

## Wrapper-script safety

If you've put a wrapper at `~/.local/bin/claude` that re-execs retcon (a common setup with `alias claude='retcon --claude'` written as a script for non-interactive contexts), retcon walks PATH and skips:

- candidates whose realpath equals retcon's own argv[1] (symlink wrappers)
- small shebang scripts that reference `retcon` (script wrappers)

Set `RETCON_REAL_CLAUDE=/path/to/claude` to force a specific binary if the heuristic gets it wrong.

Pure shell aliases (`alias claude='retcon --claude'` in `.zshrc`) were already safe: Node's spawn doesn't go through the shell, so aliases don't apply.

## Daemon environment

The detached daemon inherits a minimal allow-listed env: `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR`/`TMP`/`TEMP`, `LANG`, `LC_*`, `TZ`, `NODE_OPTIONS`, `NODE_DEBUG`, `NODE_NO_WARNINGS`, `NODE_ENV`, plus retcon's own `RETCON_PORT`, `RETCON_UPSTREAM`, `RETCON_HOME`, `RETCON_CLI_ENTRY`.

Provider credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_*`, `OPENAI_*`, `GITHUB_TOKEN`, etc.) reach claude (where they belong) but are stripped from the long-lived daemon. The daemon proxies request headers as-is to upstream and never needs the keys itself.

## State directory

`~/.retcon/` (override with `RETCON_HOME`):

- `proxy.db` — SQLite event log + projected views (sessions, tasks, revisions, branch_views)
- `tobe/` — pending fork-back files, one per session
- `daemon.log` — daemon stdout/stderr (rotate manually for now)
- `proxy.pid` — process id of the running daemon

## Endpoints

- `GET /health` → `{name, version, port, pid, started_at, uptime_s, sessions, db_size_bytes, upstream}`
- `POST /v1/*` → transparent proxy to the configured upstream
- `POST /mcp` / `GET /mcp` / `DELETE /mcp` → MCP Streamable HTTP transport
- `POST /hooks/session-start` → SessionStart hook receiver (binding-token rebind, `/clear` and `/compact` invalidation)
- `POST /actor/register` → records `{transport_id, actor}` so the projector stamps the right actor on the session row when its first event lands

## How it works

Two docs cover the design at depth:

- [INSIGHTS.md](./INSIGHTS.md) — *why* retcon works the way it does. Composition over invasion, the read/write tool split, the SR thesis, progressive disclosure for context-dying tools, split reality across the proxy boundary, why /compact aligns the two realities, harness assumptions.
- [IMPLEMENTATION.md](./IMPLEMENTATION.md) — *how* the non-trivial mechanisms work. TOBE pending file as one-shot baton, SR pipeline across three time points, persistent-fork penultimate-user splice, cache_control marker handling, resume binding, content-addressed body storage, event sourcing + projector chain.

If you're reading the code and want to understand why a piece is shaped a certain way, INSIGHTS.md. If you're tracing a specific pipeline (TOBE consumption, SR construction, splice mechanics), IMPLEMENTATION.md.

## License

MIT. See `LICENSE`.
