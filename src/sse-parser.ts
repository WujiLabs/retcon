// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Streaming SSE parser for the Anthropic API's message stream.
//
// We run as a passive tap on the upstream response — we NEVER alter bytes
// going to the client. The parser accumulates chunks, splits on frame
// boundaries, and extracts the `stop_reason` from the terminal
// `message_delta` event. Partial frames across chunk boundaries are buffered.
//
// SSE frame format (per https://html.spec.whatwg.org/multipage/server-sent-events.html):
//   event: <name>\n
//   data: <json>\n
//   \n   (blank line = end of frame)
//
// Anthropic's terminal frame looks like:
//   event: message_delta
//   data: {"type":"message_delta","delta":{"stop_reason":"end_turn",...},"usage":{...}}
//
// After `message_stop` (or an unexpected end), we emit whatever stop_reason
// we have (possibly null if the stream was cut short).

export interface SseParseResult {
  stopReason: string | null
  finished: boolean
}

type Listener = (result: SseParseResult) => void

/**
 * Cap the pending-frame buffer to guard against a malformed stream (or a
 * MITM) that never emits a frame boundary. The proxy binds to 127.0.0.1 so
 * an attacker would need local privileges, but the cap keeps the failure
 * mode obvious instead of a silent OOM.
 */
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024

export class SseStopReasonParser {
  private buffer = ''
  private stopReason: string | null = null
  private finished = false
  private overflowed = false
  private readonly listeners: Listener[] = []

  /** Feed one chunk of SSE bytes. Safe to call any number of times. */
  feed(chunk: Uint8Array | Buffer | string): void {
    if (this.finished || this.overflowed) return
    const asStr = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    this.buffer += asStr

    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.overflowed = true
      this.buffer = ''
      this.finished = true
      // Surface the overflow once via the finish listeners so the caller
      // records a dangling Version rather than waiting forever.
      const result = { stopReason: this.stopReason, finished: true }
      for (const l of this.listeners) l(result)
      return
    }

    // Split on frame boundaries. SSE frames end with a blank line (\n\n).
    // Some implementations use \r\n\r\n; handle both.
    const normalized = this.buffer.replace(/\r\n/g, '\n')
    const frames = normalized.split('\n\n')
    // Keep the last segment in the buffer — it may be a partial frame.
    this.buffer = frames.pop() ?? ''

    for (const frame of frames) {
      this.processFrame(frame)
      if (this.finished) break
    }
  }

  /** Test-only: did the parser trip its buffer cap? */
  didOverflow(): boolean {
    return this.overflowed
  }

  /** Call after the upstream response has ended. Flushes any partial tail. */
  end(): void {
    if (this.buffer.length > 0) {
      this.processFrame(this.buffer)
      this.buffer = ''
    }
    this.finished = true
    const result = { stopReason: this.stopReason, finished: true }
    for (const l of this.listeners) l(result)
  }

  /** Returns the current state without waiting for `end()`. */
  snapshot(): SseParseResult {
    return { stopReason: this.stopReason, finished: this.finished }
  }

  /** Invoked once with the final result when `end()` is called. */
  onFinish(listener: Listener): void {
    this.listeners.push(listener)
  }

  private processFrame(rawFrame: string): void {
    // A frame is a sequence of lines; we care only about `data:` lines.
    const lines = rawFrame.split('\n')
    // Concatenate multi-line data values per SSE spec.
    let dataText = ''
    for (const line of lines) {
      if (line.startsWith('data:')) {
        // Strip leading "data:" and one optional space.
        let val = line.slice(5)
        if (val.startsWith(' ')) val = val.slice(1)
        dataText += dataText.length > 0 ? `\n${val}` : val
      }
    }
    if (!dataText) return
    // Anthropic uses a single JSON blob per data field; try to parse it.
    let parsed: unknown
    try {
      parsed = JSON.parse(dataText)
    }
    catch {
      // Malformed frame (or a keep-alive). Ignore.
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const obj = parsed as Record<string, unknown>
    // Anthropic's message_delta event carries stop_reason in delta.stop_reason.
    if (obj.type === 'message_delta') {
      const delta = obj.delta as Record<string, unknown> | undefined
      if (delta && typeof delta.stop_reason === 'string') {
        this.stopReason = delta.stop_reason
      }
    }
    else if (obj.type === 'message_stop') {
      this.finished = true
      const result = { stopReason: this.stopReason, finished: true }
      for (const l of this.listeners) l(result)
    }
  }
}

/**
 * Extract `stop_reason` from a non-streaming (Content-Type: application/json)
 * Anthropic response body. Returns null if the body doesn't have a top-level
 * stop_reason or if parsing fails — callers should treat null as "unknown" and
 * the version as dangling.
 */
export function extractStopReasonFromJsonBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { stop_reason?: unknown }
    return typeof parsed.stop_reason === 'string' ? parsed.stop_reason : null
  }
  catch {
    return null
  }
}

/**
 * Extract `stop_reason` from a complete (already-decompressed) Anthropic SSE
 * response body. Wraps the streaming parser for callers that have buffered
 * the full body — simpler than maintaining a streaming-decompress pipeline
 * during chunk arrival when content-encoding is gzip.
 */
export function extractStopReasonFromSseBody(body: string): string | null {
  const parser = new SseStopReasonParser()
  parser.feed(body)
  parser.end()
  return parser.snapshot().stopReason
}

/**
 * Walk a buffered (already-decompressed) Anthropic SSE response body and
 * assemble the assistant message it represents. Used by proxy-handler to
 * persist completed assistant turns into a session's branch_context_json
 * so multi-turn forks can keep accumulating context across requests.
 *
 * Returns an `{ role: 'assistant', content }` message, or null if the body
 * doesn't decode as a parseable Anthropic SSE stream. Content is built from
 * `content_block_start` + `content_block_delta` events, indexed by
 * `content_block_index`. Currently handles `text` and `tool_use` blocks
 * (the only two Anthropic emits today).
 */
export function extractAssistantMessageFromSseBody(
  body: string,
): { role: 'assistant', content: unknown[] } | null {
  // Per-content-block accumulators keyed by index.
  const blocks = new Map<number, AssemblingBlock>()
  // Normalize line endings, then iterate frames separated by blank lines.
  const normalized = body.replace(/\r\n/g, '\n')
  const frames = normalized.split('\n\n')
  for (const frame of frames) {
    let dataText = ''
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      let val = line.slice(5)
      if (val.startsWith(' ')) val = val.slice(1)
      dataText += dataText.length > 0 ? `\n${val}` : val
    }
    if (!dataText) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(dataText)
    }
    catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const ev = parsed as Record<string, unknown>
    const type = ev.type
    if (type === 'content_block_start') {
      const idx = ev.index as number | undefined
      const block = ev.content_block as Record<string, unknown> | undefined
      if (typeof idx !== 'number' || !block) continue
      const blockType = block.type as string | undefined
      if (blockType === 'text') {
        blocks.set(idx, { kind: 'text', text: typeof block.text === 'string' ? block.text : '' })
      }
      else if (blockType === 'tool_use') {
        blocks.set(idx, {
          kind: 'tool_use',
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          inputJson: '',
        })
      }
    }
    else if (type === 'content_block_delta') {
      const idx = ev.index as number | undefined
      const delta = ev.delta as Record<string, unknown> | undefined
      if (typeof idx !== 'number' || !delta) continue
      const cur = blocks.get(idx)
      if (!cur) continue
      if (delta.type === 'text_delta' && cur.kind === 'text') {
        if (typeof delta.text === 'string') cur.text += delta.text
      }
      else if (delta.type === 'input_json_delta' && cur.kind === 'tool_use') {
        if (typeof delta.partial_json === 'string') cur.inputJson += delta.partial_json
      }
    }
  }

  if (blocks.size === 0) return null
  const sortedIndices = Array.from(blocks.keys()).sort((a, b) => a - b)
  const content: unknown[] = []
  for (const i of sortedIndices) {
    const b = blocks.get(i)
    if (!b) continue
    if (b.kind === 'text') {
      content.push({ type: 'text', text: b.text })
    }
    else {
      let input: unknown = {}
      try {
        input = b.inputJson ? JSON.parse(b.inputJson) : {}
      }
      catch {
        input = {}
      }
      content.push({ type: 'tool_use', id: b.id, name: b.name, input })
    }
  }
  return { role: 'assistant', content }
}

type AssemblingBlock
  = | { kind: 'text', text: string }
    | { kind: 'tool_use', id: string, name: string, inputJson: string }

/**
 * Extract the assistant message from a non-streaming JSON Anthropic response.
 * Returns null if the body isn't parseable JSON or lacks role+content.
 */
export function extractAssistantMessageFromJsonBody(
  body: string,
): { role: 'assistant', content: unknown[] } | null {
  try {
    const parsed = JSON.parse(body) as { role?: unknown, content?: unknown }
    if (parsed.role !== 'assistant') return null
    if (!Array.isArray(parsed.content)) return null
    return { role: 'assistant', content: [...parsed.content] }
  }
  catch {
    return null
  }
}
