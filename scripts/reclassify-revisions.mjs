#!/usr/bin/env node
// Reclassify revisions.classification using the current classifier.
//
// Background: rev_0ab6978d… (and ~750 sibling rows) carry the (legacy)
// audit-migration classification `tool_use → closed_forkable`, which today's
// classifier maps to `open`. rewind_to validates only on classification, so
// the stale rows pass the gate, reconstructForkMessages walks into a tool_use
// tail, slice(0, -1) leaves an unpaired tool_use, and Anthropic 400s.
//
// This script copies proxy.db to a destination file, then re-runs classify()
// over every revision and updates the classification column where the value
// disagrees. It does NOT touch the source DB. Verify the destination, then
// swap manually:
//   retcon stop
//   mv ~/.retcon/proxy.db ~/.retcon/proxy.db.bak
//   mv ~/.retcon/proxy.db.reclassified ~/.retcon/proxy.db
//   retcon
//
// Skipped rows:
//   - stop_reason='rewind_synthetic' or 'submit_synthetic' (SRs — custom
//     classification was set by the SR-creation path, not by classify()).
//   - classification='in_flight' (projector hasn't observed the terminal
//     event yet — leave alone).
//
// Usage:
//   node scripts/reclassify-revisions.mjs [src] [dst]
// Defaults: src=~/.retcon/proxy.db, dst=~/.retcon/proxy.db.reclassified

import Database from 'better-sqlite3'
import { copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

// Mirrors src/classifier.ts — keep in sync if classify() changes.
const KNOWN_CLOSED_FORKABLE = new Set(['end_turn', 'stop_sequence'])
const KNOWN_OPEN = new Set(['tool_use', 'pause_turn'])
const KNOWN_DANGLING = new Set(['max_tokens', 'refusal'])

function classify(stopReason) {
  if (stopReason == null) return 'dangling_unforkable'
  if (KNOWN_CLOSED_FORKABLE.has(stopReason)) return 'closed_forkable'
  if (KNOWN_OPEN.has(stopReason)) return 'open'
  if (KNOWN_DANGLING.has(stopReason)) return 'dangling_unforkable'
  return 'dangling_unforkable'
}

const SR_STOP_REASONS = new Set(['rewind_synthetic', 'submit_synthetic'])

const srcPath = resolve(process.argv[2] || `${homedir()}/.retcon/proxy.db`)
const dstPath = resolve(process.argv[3] || `${homedir()}/.retcon/proxy.db.reclassified`)

if (srcPath === dstPath) {
  console.error('refusing to write into the source path')
  process.exit(1)
}
if (!existsSync(srcPath)) {
  console.error(`source not found: ${srcPath}`)
  process.exit(1)
}
if (existsSync(dstPath)) {
  console.error(`destination already exists: ${dstPath}`)
  console.error('remove it first or pass a different dst')
  process.exit(1)
}

console.log(`src: ${srcPath}`)
console.log(`dst: ${dstPath}`)

copyFileSync(srcPath, dstPath)
// Also copy WAL/SHM if present so we capture any pending state.
for (const sfx of ['-wal', '-shm']) {
  if (existsSync(srcPath + sfx)) copyFileSync(srcPath + sfx, dstPath + sfx)
}

const db = new Database(dstPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Force a checkpoint so the WAL contents land in the main file before we
// inspect/write — avoids reading stale pages.
try { db.pragma('wal_checkpoint(TRUNCATE)') } catch { /* not in WAL mode yet */ }

const before = db.prepare(`
  SELECT classification, stop_reason, COUNT(*) AS n
    FROM revisions
   GROUP BY classification, stop_reason
   ORDER BY n DESC
`).all()
console.log('\n--- BEFORE ---')
for (const r of before) {
  console.log(`  ${String(r.classification).padEnd(20)} ${String(r.stop_reason ?? '∅').padEnd(20)} ${r.n}`)
}

const rows = db.prepare(`
  SELECT id, classification, stop_reason
    FROM revisions
`).all()

const update = db.prepare(`
  UPDATE revisions SET classification = ? WHERE id = ?
`)

const transitions = new Map() // "old → new (stop_reason)" → count
let changed = 0
let skippedSr = 0
let skippedInFlight = 0

const tx = db.transaction(() => {
  for (const r of rows) {
    if (r.stop_reason && SR_STOP_REASONS.has(r.stop_reason)) {
      skippedSr++
      continue
    }
    if (r.classification === 'in_flight') {
      skippedInFlight++
      continue
    }
    const target = classify(r.stop_reason)
    if (target !== r.classification) {
      const key = `${r.classification} → ${target} (stop_reason=${r.stop_reason ?? '∅'})`
      transitions.set(key, (transitions.get(key) ?? 0) + 1)
      update.run(target, r.id)
      changed++
    }
  }
})
tx()

console.log('\n--- TRANSITIONS ---')
if (transitions.size === 0) console.log('  (none)')
for (const [k, n] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${n}`)
}

console.log('\n--- SKIPPED ---')
console.log(`  SR rows (rewind/submit_synthetic): ${skippedSr}`)
console.log(`  in_flight rows:                    ${skippedInFlight}`)

const after = db.prepare(`
  SELECT classification, stop_reason, COUNT(*) AS n
    FROM revisions
   GROUP BY classification, stop_reason
   ORDER BY n DESC
`).all()
console.log('\n--- AFTER ---')
for (const r of after) {
  console.log(`  ${String(r.classification).padEnd(20)} ${String(r.stop_reason ?? '∅').padEnd(20)} ${r.n}`)
}

// Auto-advance stale branch_views: any view whose head is no longer
// closed_forkable gets its head_revision_id rewritten to the nearest
// closed_forkable ancestor along parent_revision_id. Preserves the user's
// "I marked this point in the conversation" intent — we shift to the
// closest turn at-or-before the bookmark that's actually rewindable.
//
// Direction is BACKWARD (parent chain), never forward: a bookmark says
// "this state of the conversation," and the closest valid representation
// is the most recent fork anchor reached prior to or at that point.
const getRevision = db.prepare(
  'SELECT id, classification, parent_revision_id FROM revisions WHERE id = ?',
)
const updateBranchView = db.prepare(
  'UPDATE branch_views SET head_revision_id = ?, updated_at = ? WHERE id = ?',
)
const stale = db.prepare(`
  SELECT bv.id AS view_id, bv.label, bv.auto_label, bv.head_revision_id,
         r.classification, r.stop_reason
    FROM branch_views bv
    JOIN revisions r ON bv.head_revision_id = r.id
   WHERE r.classification != 'closed_forkable'
`).all()

function nearestForkableAncestor(startId) {
  const seen = new Set()
  let cur = startId
  // First hop is the start itself — only count it as an ancestor if start
  // is forkable (it isn't, by selection). Real walk begins at parent.
  let row = getRevision.get(cur)
  if (!row) return null
  cur = row.parent_revision_id
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    row = getRevision.get(cur)
    if (!row) return null
    if (row.classification === 'closed_forkable') return row.id
    cur = row.parent_revision_id
  }
  return null
}

const advanceTx = db.transaction(() => {
  const now = Date.now()
  let advanced = 0
  let unadvanceable = 0
  console.log('\n--- BRANCH_VIEW ADVANCEMENT ---')
  if (stale.length === 0) {
    console.log('  (no stale branch_views)')
    return { advanced, unadvanceable }
  }
  for (const v of stale) {
    const target = nearestForkableAncestor(v.head_revision_id)
    const labelDesc = v.label ? `"${v.label}"` : `(auto: ${v.auto_label})`
    if (target) {
      updateBranchView.run(target, now, v.view_id)
      console.log(`  ${labelDesc}`)
      console.log(`    ${v.head_revision_id} (${v.classification}/${v.stop_reason ?? '∅'})`)
      console.log(`    → ${target} (closed_forkable)`)
      advanced++
    } else {
      console.log(`  ${labelDesc}`)
      console.log(`    ${v.head_revision_id} — no forkable ancestor; left as-is`)
      unadvanceable++
    }
  }
  return { advanced, unadvanceable }
})
const advanceResult = advanceTx()
console.log(`\n  advanced: ${advanceResult.advanced}`)
console.log(`  unadvanceable: ${advanceResult.unadvanceable}`)

// Re-verify branch_views invariant after advancement.
const stillStale = db.prepare(`
  SELECT bv.id, bv.label, bv.auto_label
    FROM branch_views bv
    JOIN revisions r ON bv.head_revision_id = r.id
   WHERE r.classification != 'closed_forkable'
`).all()
if (stillStale.length > 0) {
  console.log(`\n  WARNING: ${stillStale.length} branch_views still point at non-forkable heads (no forkable ancestor exists). Listed above as "unadvanceable".`)
}

// Consistency check: every non-SR, non-in_flight row's classification must
// match classify(stop_reason).
const inconsistent = db.prepare(`
  SELECT id, classification, stop_reason
    FROM revisions
   WHERE classification != 'in_flight'
     AND COALESCE(stop_reason, '') NOT IN ('rewind_synthetic', 'submit_synthetic')
`).all().filter(r => classify(r.stop_reason) !== r.classification)

console.log('\n--- VERIFY ---')
if (inconsistent.length === 0) {
  console.log(`  consistent: every reclassifiable row matches classify(stop_reason)`)
} else {
  console.log(`  INCONSISTENT (${inconsistent.length} rows):`)
  for (const r of inconsistent.slice(0, 10)) {
    console.log(`    ${r.id}  classification=${r.classification}  stop_reason=${r.stop_reason}`)
  }
  if (inconsistent.length > 10) console.log(`    … ${inconsistent.length - 10} more`)
}

console.log(`\nchanged ${changed} of ${rows.length} rows`)
console.log(`output:  ${dstPath}`)
console.log('\nTo apply:')
console.log('  retcon stop')
console.log(`  mv ${srcPath} ${srcPath}.bak`)
console.log(`  mv ${dstPath} ${srcPath}`)
console.log('  retcon')

db.close()
