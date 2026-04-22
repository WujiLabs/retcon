// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Header redaction for recording.
//
// The proxy stores request/response headers as blobs. Anthropic API calls
// carry `Authorization: Bearer sk-ant-...` or `x-api-key: ...`. Storing
// those verbatim would leave plaintext API keys in proxy.db.
//
// We redact BEFORE computing headers_cid so the redacted form is what
// lands in blobs. Forwarding to upstream uses the ORIGINAL headers —
// redaction is recording-only.

export const DEFAULT_REDACTED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
])

export const REDACTED_VALUE = 'REDACTED'

/**
 * Parse PLAYTISS_PROXY_REDACT_HEADERS env var (comma-separated, case-insensitive)
 * and merge with the default list.
 */
export function resolveRedactedHeaderSet(envValue: string | undefined): Set<string> {
  const set = new Set(DEFAULT_REDACTED_HEADERS)
  if (!envValue) return set
  for (const raw of envValue.split(',')) {
    const name = raw.trim().toLowerCase()
    if (name) set.add(name)
  }
  return set
}

/**
 * Return a copy of `headers` with sensitive values replaced by REDACTED.
 * Keys are compared case-insensitively; the original key casing is preserved
 * in the returned object so the structural shape matches what clients sent.
 *
 * Accepts the loose `Record<string, string | string[] | undefined>` shape
 * that Node's http module produces.
 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  redactSet: ReadonlySet<string> = DEFAULT_REDACTED_HEADERS,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (redactSet.has(key.toLowerCase())) {
      out[key] = Array.isArray(value) ? value.map(() => REDACTED_VALUE) : REDACTED_VALUE
    }
    else {
      out[key] = value
    }
  }
  return out
}
