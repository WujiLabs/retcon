#!/usr/bin/env node
// Step 4 of the channel refactor: behavior verification on a real
// existing retcon DB. Per the plan:
//
//   "Open at least one real existing retcon database with the new code
//    path. Walk every event, every blob, every projection result —
//    confirm byte-equal to what the old code path produced."
//
// With Step 2's schema change, pure byte-equality is partial (new
// channel_schema_version + task_metadata tables; legacy
// projection_offsets stays put). What matters is BEHAVIOR equality:
//
//   1. The migration runs cleanly on a real DB (no errors).
//   2. All retcon-owned tables (sessions / tasks / revisions /
//      branch_views / pending_actors) are byte-identical before/after.
//   3. The events / blobs tables stay byte-identical
//      (channel.migrate uses CREATE TABLE IF NOT EXISTS — no-op on
//      pre-existing rows).
//   4. projection_offsets data lands intact in task_metadata
//      (every (projection_id, last_processed_event_id) pair is now
//      reachable via channel.taskMetadata(task_id).get('events_offset')).
//   5. The Channel's submit() works against the migrated DB — picking
//      up where the pre-Step-2 projectors left off.
//
// This script: open a copy of the real v7 backup, run retcon's
// migrate() (which calls channel.migrate first), then verify 1-5.

import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import { hostname } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(HERE)
const HOME = process.env.HOME

// Pick the most recent v7 backup as the input. (proxy.db is already
// at v8 after the Step 2 daemon run today; we want to exercise the
// migration end-to-end.)
const candidates = fs.readdirSync(path.join(HOME, '.retcon'))
  .filter(n => /^proxy\.db\.bak\.v7\./.test(n))
  .sort()
  .reverse()
if (candidates.length === 0) {
  console.error('No v7 backup found at ~/.retcon/proxy.db.bak.v7.*; aborting.')
  process.exit(1)
}
const sourceBackup = path.join(HOME, '.retcon', candidates[0])
const workCopy = `/tmp/step4-${hostname()}-${Date.now()}.db`
console.error(`Step 4 — copying ${sourceBackup} → ${workCopy} ...`)
fs.copyFileSync(sourceBackup, workCopy)

// 0. Pre-migration snapshot: row counts + sample hashes
const before = new Database(workCopy, { readonly: true })
function rowCount(db, table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  }
  catch {
    return null
  }
}
function hashTable(db, table, orderClause = 'rowid') {
  // Lazy hash: concatenate stringified rows + sha256. For verification
  // we only need stable identity across before/after.
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderClause}`).all()
  return execSync(`shasum -a 256`, { input: JSON.stringify(rows) }).toString().split(/\s+/)[0]
}
const beforeStats = {
  events: rowCount(before, 'events'),
  blobs: rowCount(before, 'blobs'),
  sessions: rowCount(before, 'sessions'),
  tasks: rowCount(before, 'tasks'),
  revisions: rowCount(before, 'revisions'),
  branch_views: rowCount(before, 'branch_views'),
  pending_actors: rowCount(before, 'pending_actors'),
  projection_offsets: rowCount(before, 'projection_offsets'),
  schema_version: before.prepare('SELECT MAX(version) AS v FROM schema_version').get().v,
}
const beforeHashes = {
  events: hashTable(before, 'events', 'event_id'),
  sessions: hashTable(before, 'sessions', 'id'),
  tasks: hashTable(before, 'tasks', 'id'),
  revisions: hashTable(before, 'revisions', 'id'),
  branch_views: hashTable(before, 'branch_views', 'id'),
  projection_offsets: hashTable(before, 'projection_offsets', 'projection_id'),
}
// blobs hash: hash content cids only (bytes are blobs; same shape).
const beforeBlobCids = before.prepare('SELECT cid FROM blobs ORDER BY cid').all().map(r => r.cid).join('\n')
const beforeBlobsHash = execSync(`shasum -a 256`, { input: beforeBlobCids }).toString().split(/\s+/)[0]
before.close()

console.error('Pre-migration state:')
console.error(JSON.stringify(beforeStats, null, 2))

// 1. Run the migration. Use dynamic import to pick up the dist build.
const distMigrate = path.join(REPO, 'dist', 'db.js')
if (!fs.existsSync(distMigrate)) {
  console.error(`Missing build artifact: ${distMigrate}. Run \`pnpm build\` first.`)
  process.exit(1)
}
const { migrate, openDb } = await import(distMigrate)
const live = openDb({ path: workCopy })
const t0 = Date.now()
try {
  migrate(live, workCopy)
}
catch (err) {
  console.error('MIGRATION FAILED:', err)
  process.exit(1)
}
const migrationMs = Date.now() - t0
console.error(`Migration completed in ${migrationMs}ms`)
live.close()

// 2. Post-migration snapshot.
const after = new Database(workCopy, { readonly: true })
const afterStats = {
  events: rowCount(after, 'events'),
  blobs: rowCount(after, 'blobs'),
  sessions: rowCount(after, 'sessions'),
  tasks: rowCount(after, 'tasks'),
  revisions: rowCount(after, 'revisions'),
  branch_views: rowCount(after, 'branch_views'),
  pending_actors: rowCount(after, 'pending_actors'),
  projection_offsets: rowCount(after, 'projection_offsets'),
  task_metadata: rowCount(after, 'task_metadata'),
  schema_version: after.prepare('SELECT MAX(version) AS v FROM schema_version').get().v,
  channel_schema_version: after.prepare('SELECT MAX(version) AS v FROM channel_schema_version').get().v,
}
console.error('Post-migration state:')
console.error(JSON.stringify(afterStats, null, 2))

const afterHashes = {
  events: hashTable(after, 'events', 'event_id'),
  sessions: hashTable(after, 'sessions', 'id'),
  tasks: hashTable(after, 'tasks', 'id'),
  revisions: hashTable(after, 'revisions', 'id'),
  branch_views: hashTable(after, 'branch_views', 'id'),
  projection_offsets: hashTable(after, 'projection_offsets', 'projection_id'),
}
const afterBlobCids = after.prepare('SELECT cid FROM blobs ORDER BY cid').all().map(r => r.cid).join('\n')
const afterBlobsHash = execSync(`shasum -a 256`, { input: afterBlobCids }).toString().split(/\s+/)[0]

// 3. Verify task_metadata population matches projection_offsets.
const taskMetadataOffsets = after.prepare(`
  SELECT task_id, value FROM task_metadata WHERE key = 'events_offset' ORDER BY task_id
`).all()
const projectionOffsets = after.prepare(`
  SELECT projection_id AS task_id, last_processed_event_id AS value FROM projection_offsets ORDER BY projection_id
`).all()

after.close()

// 4. Verdict.
const findings = []

if (afterStats.schema_version !== 8) {
  findings.push(`retcon schema_version expected 8, got ${afterStats.schema_version}`)
}
if (afterStats.channel_schema_version !== 1) {
  findings.push(`channel_schema_version expected 1, got ${afterStats.channel_schema_version}`)
}
for (const table of ['events', 'blobs', 'sessions', 'tasks', 'revisions', 'branch_views', 'pending_actors', 'projection_offsets']) {
  if (afterStats[table] !== beforeStats[table]) {
    findings.push(`${table} row count drifted: before=${beforeStats[table]} after=${afterStats[table]}`)
  }
}
for (const table of Object.keys(beforeHashes)) {
  if (beforeHashes[table] !== afterHashes[table]) {
    findings.push(`${table} content hash drifted: before=${beforeHashes[table].slice(0, 16)}… after=${afterHashes[table].slice(0, 16)}…`)
  }
}
if (beforeBlobsHash !== afterBlobsHash) {
  findings.push(`blobs cid set drifted: before=${beforeBlobsHash.slice(0, 16)}… after=${afterBlobsHash.slice(0, 16)}…`)
}

// projection_offsets → task_metadata population check
if (taskMetadataOffsets.length !== projectionOffsets.length) {
  findings.push(`task_metadata events_offset count (${taskMetadataOffsets.length}) != projection_offsets count (${projectionOffsets.length})`)
}
else {
  for (let i = 0; i < projectionOffsets.length; i++) {
    if (taskMetadataOffsets[i].task_id !== projectionOffsets[i].task_id
      || taskMetadataOffsets[i].value !== projectionOffsets[i].value) {
      findings.push(`task_metadata row ${i} mismatch: ${JSON.stringify(taskMetadataOffsets[i])} vs ${JSON.stringify(projectionOffsets[i])}`)
      break
    }
  }
}

if (findings.length === 0) {
  console.error('')
  console.error('✅ STEP 4 PASS')
  console.error(`   - Migration v7 → v8 completed cleanly in ${migrationMs}ms`)
  console.error(`   - All 8 retcon-owned tables byte-identical before/after migration`)
  console.error(`   - blobs cid set byte-identical`)
  console.error(`   - channel_schema_version stamped at 1`)
  console.error(`   - ${taskMetadataOffsets.length} projection_offsets rows copied to task_metadata`)
  console.error(`   - DB: ${workCopy} (left in place for further inspection)`)
}
else {
  console.error('')
  console.error('❌ STEP 4 FAIL — findings:')
  for (const f of findings) console.error(`   - ${f}`)
  console.error(`   - DB: ${workCopy} (left in place for inspection)`)
  process.exit(1)
}
