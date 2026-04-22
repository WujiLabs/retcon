# @playtiss/proxy

**Alpha.** Recording + replay proxy for Claude Code sessions. Records LLM calls as an append-only event log using the Playtiss Collaboration Protocol vocabulary.

One HTTP server: `/v1/*` transparently proxies to `api.anthropic.com`, `/mcp` serves the Model Context Protocol (Streamable HTTP transport) for fork-back tools.

## Status

In-development alpha. Expect breaking changes.

## Install

```bash
npm install -g @playtiss/proxy
```

## Run

```bash
playtiss-proxy &
ANTHROPIC_BASE_URL=http://localhost:4099 claude
```

## License

MIT. See `LICENSE`.
