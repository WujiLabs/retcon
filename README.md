# @playtiss/retcon

**Alpha.** Retcon for AI conversations. Edit any past turn in your Claude Code session and replay everything downstream — the canonical Observer Actor instantiation of the Playtiss Collaboration Protocol.

One HTTP server: `/v1/*` transparently proxies to `api.anthropic.com`, `/mcp` serves the Model Context Protocol (Streamable HTTP transport) for fork tools (`fork_list`, `fork_show`, `fork_bookmark`, `fork_back`).

## Status

In-development alpha. Expect breaking changes.

## Install

```bash
npm install -g @playtiss/retcon
```

## Run

```bash
retcon &
ANTHROPIC_BASE_URL=http://localhost:4099 claude
```

## License

MIT. See `LICENSE`.
