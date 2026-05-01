// Read-only forensic dump for cache_control marker layout in proxy.db.
// Loads a hydrated /v1/messages body by top CID and prints every marker in
// processing order (tools → system → messages). Pass --fix to dry-run
// stripTtlViolations() and reprint, so you can verify the fix on a real
// failing body before/after.
//
//   node scripts/audit-cc.mjs <top-cid>          # just dump
//   node scripts/audit-cc.mjs <top-cid> --fix    # dump, fix, dump again

import Database from 'better-sqlite3'
import { loadHydratedMessagesBody } from '/Users/cosimodw/playtiss-public/playtiss-proxy/dist/body-blob.js'
import { SqliteStorageProvider } from '/Users/cosimodw/playtiss-public/playtiss-proxy/dist/storage.js'
import { stripTtlViolations } from '/Users/cosimodw/playtiss-public/playtiss-proxy/dist/proxy-handler.js'

const dbPath = '/Users/cosimodw/.retcon/proxy.db'
const args = process.argv.slice(2)
const topCid = args.find(a => !a.startsWith('--'))
const dryRunFix = args.includes('--fix')
if (!topCid) {
  console.error('usage: node audit-cc.mjs <top-cid> [--fix]')
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
const provider = new SqliteStorageProvider(db)

const body = await loadHydratedMessagesBody(provider, topCid)
if (!body) {
  console.error('failed to load body for', topCid)
  process.exit(1)
}

function dumpMarkers(label) {
  const ccPositions = []
  function scanBlocks(arr, prefix) {
    if (!Array.isArray(arr)) return
    for (let bi = 0; bi < arr.length; bi++) {
      const blk = arr[bi]
      if (blk && typeof blk === 'object' && 'cache_control' in blk) {
        const cc = blk.cache_control
        const ttl = cc && typeof cc === 'object' ? (cc.ttl ?? '5m') : null
        const truthy = !!cc && typeof cc === 'object'
        ccPositions.push({
          loc: `${prefix}[${bi}]`,
          kind: blk.type ?? '<no-type>',
          ttl: truthy ? ttl : `<NULL: ${JSON.stringify(cc)}>`,
          truthy,
        })
      }
    }
  }
  // Anthropic processing order: tools → system → messages.
  if (Array.isArray(body.tools)) {
    for (let ti = 0; ti < body.tools.length; ti++) {
      const tool = body.tools[ti]
      if (tool && typeof tool === 'object' && 'cache_control' in tool) {
        const cc = tool.cache_control
        const ttl = cc && typeof cc === 'object' ? (cc.ttl ?? '5m') : null
        const truthy = !!cc && typeof cc === 'object'
        ccPositions.push({
          loc: `tools[${ti}]`,
          kind: tool.name ?? '<no-name>',
          ttl: truthy ? ttl : `<NULL: ${JSON.stringify(cc)}>`,
          truthy,
        })
      }
    }
  }
  if (Array.isArray(body.system)) scanBlocks(body.system, 'system')
  if (Array.isArray(body.messages)) {
    for (let mi = 0; mi < body.messages.length; mi++) {
      const msg = body.messages[mi]
      if (Array.isArray(msg.content)) {
        scanBlocks(msg.content, `messages[${mi}](${msg.role})`)
      }
    }
  }
  console.log(`# ${label}`)
  console.log(`# Total messages: ${Array.isArray(body.messages) ? body.messages.length : 0}`)
  console.log(`# Truthy markers: ${ccPositions.filter(p => p.truthy).length}`)
  console.log('# loc                                              kind                       ttl')
  for (const p of ccPositions) {
    console.log(`${p.loc.padEnd(50)} ${String(p.kind).padEnd(28)} ${p.ttl}`)
  }
}

dumpMarkers('BEFORE')
if (dryRunFix) {
  const removed = stripTtlViolations(body)
  console.log()
  console.log(`# stripTtlViolations removed ${removed} marker(s)`)
  console.log()
  dumpMarkers('AFTER --fix')
}

db.close()
