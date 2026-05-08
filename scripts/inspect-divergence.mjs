#!/usr/bin/env node
// Inspect the actual differences between the forked turn (16:18:43→16:20:35)
// and the release-triggering turn (16:24:38) on session b17275fb.

import Database from 'better-sqlite3'
import { homedir } from 'node:os'

const db = new Database(`${homedir()}/.retcon/proxy.db`, { readonly: true })

function blob(cid) {
  const r = db.prepare('SELECT bytes FROM blobs WHERE cid=?').get(cid)
  if (!r) return null
  return r.bytes
}

// dag-json {/: cid} link decoding for message-split bodies. The top blob is
// dag-json; messages[] entries are themselves links to leaf blobs.
function decodeLink(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '/' in v) {
    return v['/']
  }
  return null
}

function leaf(maybeLink) {
  const cid = decodeLink(maybeLink)
  if (!cid) return maybeLink
  const b = blob(cid)
  if (!b) return null
  try { return JSON.parse(b.toString('utf8')) } catch { return null }
}

function hydrateBody(topCid) {
  const top = blob(topCid)
  if (!top) return null
  let parsed
  try { parsed = JSON.parse(top.toString('utf8')) } catch { return { raw: top.toString('utf8'), error: 'top is not JSON' } }
  // Top blob carries `messages` as array of links + other fields inline (system, tools).
  if (Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map(leaf)
  }
  // tools[] may also be link-shaped
  if (Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map(leaf)
  }
  if (Array.isArray(parsed.system)) {
    parsed.system = parsed.system.map(leaf)
  }
  return parsed
}

function bodyFromCid(cid) {
  const b = blob(cid)
  if (!b) return null
  // Try as dag-json hydrated body first
  const hydrated = hydrateBody(cid)
  if (hydrated && Array.isArray(hydrated.messages)) return hydrated
  // Fallback: treat as flat JSON
  try { return JSON.parse(b.toString('utf8')) } catch { return { raw: b.toString('utf8') } }
}

function summarizeMessage(m, idx) {
  if (!m) return `[${idx}] (null)`
  const role = m.role ?? '?'
  const c = m.content
  if (typeof c === 'string') {
    return `[${idx}] ${role} text="${c.slice(0, 80).replace(/\n/g, ' ')}"`
  }
  if (Array.isArray(c)) {
    const types = c.map(b => {
      if (!b || typeof b !== 'object') return 'unknown'
      if (b.type === 'text') return `text("${(b.text || '').slice(0, 60).replace(/\n/g, ' ')}")`
      if (b.type === 'tool_use') return `tool_use(${b.id?.slice(0, 14)} ${b.name})`
      if (b.type === 'tool_result') return `tool_result(${b.tool_use_id?.slice(0, 14)})`
      if (b.type === 'thinking') return 'thinking'
      return b.type ?? 'unknown'
    })
    return `[${idx}] ${role} ${types.join(' | ')}`
  }
  return `[${idx}] ${role} (content shape: ${typeof c})`
}

function dump(label, body) {
  console.log(`\n========= ${label} =========`)
  if (!body) { console.log('  (missing)'); return }
  if (body.raw && !body.messages) { console.log('  (flat, not messages body):'); console.log(body.raw.slice(0, 500)); return }
  console.log(`  total messages: ${body.messages?.length}`)
  console.log(`  system blocks:  ${Array.isArray(body.system) ? body.system.length : (body.system ? 1 : 0)}`)
  console.log(`  tools:          ${Array.isArray(body.tools) ? body.tools.length : 0}`)
  // Show last 6 + first 2
  if (body.messages && body.messages.length > 0) {
    console.log('  --- first 2 ---')
    for (let i = 0; i < Math.min(2, body.messages.length); i++) {
      console.log(' ', summarizeMessage(body.messages[i], i))
    }
    console.log('  --- last 6 ---')
    for (let i = Math.max(0, body.messages.length - 6); i < body.messages.length; i++) {
      console.log(' ', summarizeMessage(body.messages[i], i))
    }
  }
}

// Refs from the events
const RAW_16_18 = 'bafkreihmhpuwxodzrzlrpbzpiieylm5vnyaajc37pfdcjpvd6s6sx7ksie'  // claude's body BEFORE TOBE
const SPLICED_16_18 = 'baguqeera7j4hb5ozv2wc7jsbg4mwp7i42i4jbrslks4rg7l2ee3yz2om5rqa'  // body forwarded after TOBE
const RESP_16_20 = 'bafkreibvgjkjhhj6pjv5fuqundfkdk663w5uffdsjv2z3woh4fwkvd77fq'  // SSE response
const RAW_16_24 = 'baguqeeralat2qo3wlim6h36k3blx3puvrdnl2oqc43kjdcg4cthhrpxxlltq'  // claude's body at 16:24:38 (release-trigger)

const raw1618 = bodyFromCid(RAW_16_18)
const spliced1618 = bodyFromCid(SPLICED_16_18)
const raw1624 = bodyFromCid(RAW_16_24)

dump('16:18:43 RAW (claude before TOBE)', raw1618)
dump('16:18:43 SPLICED (sent upstream after TOBE)', spliced1618)
dump('16:24:38 RAW (release-trigger; no splice happened)', raw1624)

// Extract response text from the SSE stream blob
const resp = blob(RESP_16_20)?.toString('utf8') ?? ''
console.log('\n========= 16:20:35 RESPONSE (SSE) =========')
console.log(`  raw size: ${resp.length} bytes`)
const textDeltas = [...resp.matchAll(/"text_delta","text":"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`))
const fullText = textDeltas.join('')
console.log(`  reassembled assistant text length: ${fullText.length} chars`)
console.log(`  first 300 chars: ${fullText.slice(0, 300).replace(/\n/g, ' ')}`)
console.log(`  last 300 chars:  ${fullText.slice(-300).replace(/\n/g, ' ')}`)

// Critical check: does the 16:24:38 raw body contain the assistant's response text?
console.log('\n========= DIVERGENCE CHECK =========')
const respFingerprint = fullText.slice(0, 60)  // first 60 chars of asst response
console.log(`  searching for asst response fingerprint: "${respFingerprint.slice(0, 60).replace(/\n/g, ' ')}"`)

function searchInMessages(body, needle) {
  if (!body?.messages) return { found: false, where: 'no messages' }
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i]
    if (!m) continue
    const c = m.content
    if (typeof c === 'string') {
      if (c.includes(needle)) return { found: true, where: `msg[${i}] role=${m.role} string` }
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'text' && b.text?.includes(needle)) return { found: true, where: `msg[${i}] role=${m.role} text-block` }
      }
    }
  }
  return { found: false, where: 'not found' }
}

const inSpliced = searchInMessages(spliced1618, respFingerprint)
const in1624 = searchInMessages(raw1624, respFingerprint)
console.log(`  appears in 16:18 SPLICED body? ${inSpliced.found} (${inSpliced.where})`)
console.log(`  appears in 16:24 RAW body?     ${in1624.found} (${in1624.where})`)

// Reverse: what's the LATEST asst text in 16:24's body?
function lastAsstText(body) {
  if (!body?.messages) return null
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i]
    if (m?.role !== 'assistant') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const txt = c.filter(b => b?.type === 'text').map(b => b.text).join('\n')
      if (txt) return txt
    }
  }
  return null
}
console.log(`\n  16:24 body's LAST assistant text (first 300 chars): ${lastAsstText(raw1624)?.slice(0, 300).replace(/\n/g, ' ')}`)
console.log(`  16:24 body's LAST assistant text (last 300 chars):  ${lastAsstText(raw1624)?.slice(-300).replace(/\n/g, ' ')}`)

// Also: the 16:24 body should naturally start where? Does it look like it
// resumed past the synthetic_user_message + asst response?
console.log(`\n  16:24 body's LAST user (last 400 chars):`)
const lastU = (() => {
  if (!raw1624?.messages) return null
  for (let i = raw1624.messages.length - 1; i >= 0; i--) {
    const m = raw1624.messages[i]
    if (m?.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const txt = c.filter(b => b?.type === 'text').map(b => b.text).join('\n')
      if (txt) return txt
    }
  }
  return null
})()
console.log(`    ${lastU?.slice(-400).replace(/\n/g, ' ')}`)

db.close()
