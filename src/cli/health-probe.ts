// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Port + identity probe. Used by retcon's daemon-control before deciding to
// reuse an existing daemon vs spawn a new one.
//
// Probe sequence:
//   1. TCP connect to host:port. If refused (ECONNREFUSED) → port is FREE.
//   2. Otherwise, GET /health with timeoutMs. Parse JSON. Validate shape.
//      ├── name === 'retcon' AND version matches → MATCH
//      ├── name === 'retcon' AND version differs → MISMATCH
//      └── any other shape / non-200 / parse fail / timeout → FOREIGN
//
// MATCH means we can safely reuse. MISMATCH means there's a retcon daemon
// running a different version (ours is newer or older); caller decides
// whether to upgrade-replace it. FOREIGN means port is owned by something
// else entirely; caller errors out.

import http from 'node:http'
import net from 'node:net'

export type HealthProbeResult =
  | { kind: 'free' }
  | { kind: 'match', port: number, snapshot: HealthSnapshotShape }
  | { kind: 'mismatch', port: number, snapshot: HealthSnapshotShape }
  | { kind: 'foreign', port: number, reason: string }

/** Subset of the /health JSON we care about. */
export interface HealthSnapshotShape {
  name: string
  version: string
  port?: number
  pid?: number
  started_at?: number
  uptime_s?: number
  sessions?: number
  db_size_bytes?: number
}

const DEFAULT_TIMEOUT_MS = 1000

/**
 * Probe whether `host:port` is reachable AND, if so, identifies as a retcon
 * daemon at the given version. Always resolves; never rejects.
 */
export async function probeHealth(
  port: number,
  expectedVersion: string,
  opts: { host?: string, timeoutMs?: number } = {},
): Promise<HealthProbeResult> {
  const host = opts.host ?? '127.0.0.1'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Step 1: cheap TCP probe so we don't pay for an HTTP fetch when nobody's
  // listening. Connect with a short timeout. ECONNREFUSED → port is free.
  const tcpResult = await tcpProbe(host, port, timeoutMs)
  if (tcpResult === 'free') return { kind: 'free' }
  if (tcpResult === 'timeout') {
    return { kind: 'foreign', port, reason: 'tcp connect timed out' }
  }

  // Step 2: HTTP /health with the same timeout budget.
  const httpResult = await httpProbe(host, port, timeoutMs)
  if (httpResult.kind === 'error') {
    return { kind: 'foreign', port, reason: httpResult.reason }
  }
  const snap = httpResult.snapshot
  if (snap.name !== 'retcon') {
    return { kind: 'foreign', port, reason: `name="${snap.name}" (expected "retcon")` }
  }
  if (snap.version !== expectedVersion) {
    return { kind: 'mismatch', port, snapshot: snap }
  }
  return { kind: 'match', port, snapshot: snap }
}

type TcpResult = 'free' | 'connected' | 'timeout'

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<TcpResult> {
  return new Promise<TcpResult>((resolve) => {
    const sock = net.createConnection({ host, port })
    let settled = false
    const finish = (r: TcpResult): void => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(r)
    }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => finish('connected'))
    sock.on('timeout', () => finish('timeout'))
    sock.on('error', (err: NodeJS.ErrnoException) => {
      // Anything other than ECONNREFUSED (host unreachable, EADDRNOTAVAIL,
      // etc.) we treat as 'free' too — point of the probe is "can we bind."
      // ETIMEDOUT means nothing's responding; treat as timeout.
      if (err.code === 'ETIMEDOUT') finish('timeout')
      else finish('free')
    })
  })
}

type HttpProbeResult =
  | { kind: 'ok', snapshot: HealthSnapshotShape }
  | { kind: 'error', reason: string }

function httpProbe(host: string, port: number, timeoutMs: number): Promise<HttpProbeResult> {
  return new Promise<HttpProbeResult>((resolve) => {
    let settled = false
    const finish = (r: HttpProbeResult): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()  // drain
        finish({ kind: 'error', reason: `/health returned ${res.statusCode}` })
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8')
          const parsed = JSON.parse(body) as HealthSnapshotShape
          if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
            finish({ kind: 'error', reason: '/health JSON missing name/version fields' })
            return
          }
          finish({ kind: 'ok', snapshot: parsed })
        }
        catch (err) {
          finish({ kind: 'error', reason: `/health JSON parse failed: ${(err as Error).message}` })
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      finish({ kind: 'error', reason: '/health timed out' })
    })
    req.on('error', (err) => {
      finish({ kind: 'error', reason: `/health request failed: ${err.message}` })
    })
  })
}
