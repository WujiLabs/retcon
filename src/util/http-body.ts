// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Bounded request-body reader for the proxy's HTTP handlers. Two callers
// (the SessionStart hook and /actor/register) had byte-identical copies;
// they now share this helper. The overflow path destroys the socket so a
// slow-loris client streaming bytes-past-the-limit can't pin the
// connection indefinitely.

import type http from 'node:http'

/**
 * Read a request body up to `maxBytes`. Resolves to the buffered bytes on
 * normal end. Rejects with `new Error('overflow')` if the cumulative size
 * exceeds the cap, after destroying the socket. Rejects with the
 * underlying error on socket error.
 */
export function readBoundedBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finishOverflow = (): void => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error('overflow'))
    }
    req.on('data', (c: Buffer) => {
      if (settled) return
      total += c.length
      if (total > maxBytes) {
        finishOverflow()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}
