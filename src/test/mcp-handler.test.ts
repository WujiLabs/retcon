// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate, openDb } from '../db.js'
import { createEventConsumer, type EventProducer } from '../events.js'
import { MCP_SESSION_HEADER, type McpTool } from '../mcp-handler.js'

// Test helper: build a minimal McpTool from just a handler. Real tools have
// proper inputSchema; for unit tests we use empty objects.
function tool(handler: McpTool['handler'], description = 'test tool'): McpTool {
  return { handler, description, inputSchema: { type: 'object' } }
}
import { createDefaultProducer, type ServerHandle, startServer } from '../server.js'
import { createTobeStore, type TobeStore } from '../tobe.js'

function fixture() {
  const db = openDb({ path: ':memory:' })
  migrate(db)
  const producer: EventProducer = createDefaultProducer(db)
  const tmp = mkdtempSync(path.join(tmpdir(), 'mcp-test-'))
  const tobeStore: TobeStore = createTobeStore(tmp)
  return { db, producer, tobeStore, tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

async function startWithTools(fx: ReturnType<typeof fixture>, tools: Map<string, McpTool>) {
  return startServer({
    port: 0,
    producer: fx.producer,
    tobeStore: fx.tobeStore,
    mcpTools: tools,
  })
}

async function postJsonRpc(port: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k] = v
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) as unknown : null
  return { status: res.status, headers, json }
}

describe('MCP /mcp route', () => {
  let fx: ReturnType<typeof fixture>
  let handle: ServerHandle | undefined

  beforeEach(() => {
    fx = fixture()
  })
  afterEach(async () => {
    if (handle) {
      await handle.close()
      handle = undefined
    }
    fx.cleanup()
  })

  it('responds to initialize with a Mcp-Session-Id header and server info', async () => {
    handle = await startWithTools(fx, new Map())
    const { status, headers, json } = await postJsonRpc(handle.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '1.0' },
      },
    })
    expect(status).toBe(200)
    expect(headers[MCP_SESSION_HEADER]).toBeTruthy()
    const result = (json as { result: { protocolVersion: string, serverInfo: { name: string } } }).result
    expect(result.protocolVersion).toBe('2025-03-26')
    expect(result.serverInfo.name).toBe('retcon')
  })

  it('emits mcp.session_initialized which sessions_v1 projects', async () => {
    handle = await startWithTools(fx, new Map())
    const { headers } = await postJsonRpc(handle.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'claude-code' } },
    })
    const sessionId = headers[MCP_SESSION_HEADER]
    const consumer = createEventConsumer(fx.db)
    const [event] = consumer.poll('probe', ['mcp.session_initialized'], 1)
    expect(event).toBeTruthy()
    expect(event.sessionId).toBe(sessionId)
    // sessions_v1 should have created a sessions row for it.
    const row = fx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      | { harness: string, task_id: string } | undefined
    expect(row).toBeTruthy()
    expect(row!.harness).toBe('claude-code')
  })

  it('tools/list returns handler names from the registered map', async () => {
    const tools = new Map<string, McpTool>([
      ['fork_list', tool(async () => ({}))],
      ['fork_back', tool(async () => ({}))],
    ])
    handle = await startWithTools(fx, tools)
    // Initialize first so we have a session id to echo.
    const init = await postJsonRpc(handle.port, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'c' } },
    })
    const sid = init.headers[MCP_SESSION_HEADER]
    const { json } = await postJsonRpc(
      handle.port,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { [MCP_SESSION_HEADER]: sid },
    )
    const result = (json as { result: { tools: Array<{ name: string }> } }).result
    const names = result.tools.map(t => t.name)
    expect(names).toContain('fork_list')
    expect(names).toContain('fork_back')
  })

  it('tools/call invokes the registered handler with arguments', async () => {
    let receivedArgs: unknown
    const tools = new Map<string, McpTool>([
      ['echo', tool(async (args) => {
        receivedArgs = args
        return { echoed: args }
      })],
    ])
    handle = await startWithTools(fx, tools)
    const init = await postJsonRpc(handle.port, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'c' } },
    })
    const sid = init.headers[MCP_SESSION_HEADER]
    const { json } = await postJsonRpc(
      handle.port,
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'echo', arguments: { hello: 'world' } },
      },
      { [MCP_SESSION_HEADER]: sid },
    )
    expect(receivedArgs).toEqual({ hello: 'world' })
    const result = (json as { result: { content: Array<{ type: string, text: string }> } }).result
    expect(JSON.parse(result.content[0].text)).toEqual({ echoed: { hello: 'world' } })
  })

  it('tools/call without Mcp-Session-Id is rejected', async () => {
    handle = await startWithTools(fx, new Map([['t', async () => ({})]]))
    const { json } = await postJsonRpc(handle.port, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 't', arguments: {} },
    })
    const err = (json as { error: { code: number, message: string } }).error
    expect(err.code).toBe(-32600)
    expect(err.message).toMatch(/Mcp-Session-Id/)
  })

  it('tools/call on unknown tool returns method not found', async () => {
    handle = await startWithTools(fx, new Map())
    const init = await postJsonRpc(handle.port, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    })
    const sid = init.headers[MCP_SESSION_HEADER]
    const { json } = await postJsonRpc(
      handle.port,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      { [MCP_SESSION_HEADER]: sid },
    )
    const err = (json as { error: { code: number } }).error
    expect(err.code).toBe(-32601)
  })

  it('malformed JSON returns parse error', async () => {
    handle = await startWithTools(fx, new Map())
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    const body = await res.json() as { error: { code: number } }
    expect(body.error.code).toBe(-32700)
  })

  it('DELETE /mcp emits mcp.session_closed', async () => {
    handle = await startWithTools(fx, new Map())
    const init = await postJsonRpc(handle.port, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    })
    const sid = init.headers[MCP_SESSION_HEADER]

    const delRes = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'DELETE',
      headers: { [MCP_SESSION_HEADER]: sid },
    })
    expect(delRes.status).toBe(204)

    const consumer = createEventConsumer(fx.db)
    const closeEvents = consumer.poll('p', ['mcp.session_closed'], 10)
    expect(closeEvents.length).toBe(1)
    expect(closeEvents[0].sessionId).toBe(sid)

    const row = fx.db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(sid) as
      | { ended_at: number } | undefined
    expect(row?.ended_at).toBeGreaterThan(0)
  })

  it('ping responds with empty result', async () => {
    handle = await startWithTools(fx, new Map())
    const init = await postJsonRpc(handle.port, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    })
    const sid = init.headers[MCP_SESSION_HEADER]
    const { json } = await postJsonRpc(
      handle.port,
      { jsonrpc: '2.0', id: 99, method: 'ping' },
      { [MCP_SESSION_HEADER]: sid },
    )
    expect((json as { result: unknown }).result).toEqual({})
  })

  it('initialize is idempotent — reuses an existing Mcp-Session-Id', async () => {
    handle = await startWithTools(fx, new Map())
    const first = await postJsonRpc(handle.port, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'c' } },
    })
    const firstSid = first.headers[MCP_SESSION_HEADER]
    expect(firstSid).toBeTruthy()

    // Client re-initializes (e.g. after reconnect) with the prior session id.
    const second = await postJsonRpc(
      handle.port,
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { clientInfo: { name: 'c' } } },
      { [MCP_SESSION_HEADER]: firstSid },
    )
    expect(second.headers[MCP_SESSION_HEADER]).toBe(firstSid)

    // Only one sessions row exists.
    const rows = fx.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?')
      .get(firstSid) as { n: number }
    expect(rows.n).toBe(1)
  })

  it('rejects POST bodies over 1MB with 413', async () => {
    handle = await startWithTools(fx, new Map())
    // Craft a body just over the limit. JSON-parsing the oversize body never
    // happens — the reader bails during data.
    const big = 'x'.repeat(1024 * 1024 + 100)
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"jsonrpc":"2.0","id":1,"method":"ping","fluff":"${big}"}`,
    })
    expect(res.status).toBe(413)
  })

  it('unknown method returns method not found', async () => {
    handle = await startWithTools(fx, new Map())
    const init = await postJsonRpc(handle.port, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    })
    const sid = init.headers[MCP_SESSION_HEADER]
    const { json } = await postJsonRpc(
      handle.port,
      { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      { [MCP_SESSION_HEADER]: sid },
    )
    const err = (json as { error: { code: number } }).error
    expect(err.code).toBe(-32601)
  })
})
