# @playtiss/retcon

**Alpha.** Retcon for AI conversations. Edit any past turn in your Claude Code session and replay everything downstream. The canonical Observer Actor instantiation of the Playtiss Collaboration Protocol.

One HTTP server: `/v1/*` proxies to your Anthropic-compatible upstream, `/mcp` serves the Model Context Protocol (Streamable HTTP) for fork tools, `/hooks/session-start` learns claude's session id post-resume, `/health` reports daemon identity.

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

Once you run `fork_back`, retcon doesn't just rewrite one /v1/messages call — it keeps the forked branch alive across every subsequent turn until you start a new session, run `/clear`, or run `/compact` inside claude. Each new turn from claude is spliced onto the fork's history at the penultimate-user message, so the upstream Anthropic API sees a coherent conversation that picks up from your edit instead of from claude's local jsonl.

The branch survives daemon restarts, `claude --resume`, and `claude --continue`. Run a fresh `fork_back` to switch branches. Run `/clear` or `/compact` inside claude to release the fork and let claude's local view drive future turns.

## Actors and cleanup

Every session is tagged with an actor name. The default actor is `default`; pass `--actor <name>` to scope a session under your own tag (1–64 characters, `[A-Za-z0-9_-]`).

`retcon clean --actor <name>` wipes every row associated with that actor: events, branch_views, revisions, tasks, sessions, pending registrations, and the per-session TOBE pending files on disk. Defaults to dry-run; pass `--yes` to apply. Refuses to run while the daemon is up unless you pass `--force`.

This is destructive of the event log (the source-of-truth append-only history) for that actor. The intended use is cleaning up integration-test runs and unwanted exploration. Other actors' data is untouched.

## Fork tools

Available to claude inside the session via the MCP server retcon auto-registers as `mcp__retcon__*`:

- `fork_list` — list every previous turn that's still forkable
- `fork_show` — inspect a specific revision's request and response
- `fork_bookmark` — pin a revision so it survives garbage collection
- `fork_back` — roll the conversation back to a chosen revision and replace your next message

Source of truth is the event log; the projector marks each `/v1/messages` round-trip as `closed_forkable`, `dangling_unforkable`, or `open` based on stop reason and stream state.

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
- The daemon re-keys events and revisions from the binding token to the actual session id, reconnecting the DAG so `fork_back` can walk across the resume boundary.
- For new sessions the binding token equals claude's session id and the rebind is a no-op.

If you pass `--session-id <uuid>` to a new session, retcon adopts your id rather than minting one of its own. The id you typed is the id you'll see in the local jsonl filename and fork tools.

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

## License

MIT. See `LICENSE`.
