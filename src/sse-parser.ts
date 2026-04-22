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

export class SseStopReasonParser {
  private buffer = ''
  private stopReason: string | null = null
  private finished = false
  private readonly listeners: Listener[] = []

  /** Feed one chunk of SSE bytes. Safe to call any number of times. */
  feed(chunk: Uint8Array | Buffer | string): void {
    if (this.finished) return
    const asStr = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    this.buffer += asStr

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
