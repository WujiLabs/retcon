# @playtiss/retcon

**Alpha.** Retcon for AI conversations. Edit any past turn in your Claude Code session and replay everything downstream. The canonical Observer Actor instantiation of the Collaboration Protocol.

One HTTP server: `/v1/*` proxies to your Anthropic-compatible upstream, `/mcp` serves the Model Context Protocol (Streamable HTTP) for the rewind tools, `/hooks/session-start` learns claude's session id post-resume, `/health` reports daemon identity.

## Status

In-development alpha. Expect breaking changes.

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

- `recall` — list recent forkable turns (no args) OR inspect one (`turn_back_n: N` for the Nth turn back, `turn_id: "..."` for a specific id). Returns content previews so you can pick a target without dumping the full conversation.
- `rewind_to` — roll the conversation back to a chosen turn and replace the next message. **Two-step call**: the first call returns rules + a single-use `confirm_clean`/`confirm_meta` token pair; the AI classifies its own message (does it stand alone, or does it contain a meta-reference to cut-off content?) and re-calls with the matching token. Catches the AI before it sends a `"redo your last answer"`-style message that would confuse the post-rewind context.
- `bookmark` — pin the latest forkable turn with an optional human label so you can return to it via `recall` later.
- `dump_to_file` — write the conversation through a chosen turn to `~/.retcon/dumps/<id>.jsonl` (one Anthropic message per line). retcon's CLI pre-allows `Read`/`Edit`/`Write`/`Glob`/`Grep` over `~/.retcon/dumps/**` in the spawned claude's permissions, so the AI can inspect and modify the file without prompting you. No args = dump current state; `turn_id` or `turn_back_n` = dump through that turn.
- `submit_file` — read a JSONL dump back, validate it (each line a well-formed Anthropic message, last line must be assistant-role), append your `message` arg as a new user turn, and queue it as the next /v1/messages from claude. Same **two-step token flow** as `rewind_to`. Pairs with `dump_to_file` for the "let me actually edit a few past turns before continuing" use case that pure `rewind_to` can't express.

**When to reach for which:**

| You want to... | Tool |
|---|---|
| See what turns you can rewind to | `recall` (no args) |
| Inspect a specific turn before rewinding | `recall` with `turn_id` or `turn_back_n` |
| Actually rewind (replace the next turn only) | `rewind_to` (two-step: first call returns rules + tokens, second call applies) |
| Edit several past turns before continuing | `dump_to_file` → `Read`/`Edit` the JSONL → `submit_file` |
| Save a spot to return to later | `bookmark` |

Source of truth is the event log; the projector marks each `/v1/messages` round-trip as `closed_forkable`, `dangling_unforkable`, or `open` based on stop reason and stream state. Only `closed_forkable` turns are recall/rewind targets.

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

[ARCHITECTURE.md](./ARCHITECTURE.md) covers the model: event sourcing, the fork classification, persistent fork branches via the penultimate-user splice, content-addressed message storage, actor identity + resume binding, and a component map of every file under `src/`.

## License

MIT. See `LICENSE`.
