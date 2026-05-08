#!/usr/bin/env node
// Migration script: audit.db (filo/claude-proxy) → retcon format
//
// Reads the flat HTTP request/response pairs from the original audit proxy
// and produces a retcon-compatible SQLite database with proper event-sourced
// structure (blobs, events, projected views).
//
// Also writes a JSON mapping file (audit_id → retcon IDs) for cross-reference.
//
// Run from playtiss-proxy root:
//   node scripts/migrate-audit-db.mjs [source-audit.db] [dest-retcon.db] [session-id]
//
// If session-id is provided, all data is attributed to that session
// (use the current retcon session id so recall/rewind_to can see it).
// If omitted, a random migrated_<uuid> id is generated.

import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { blobRefFromMessagesBody, blobRefFromBytes } from '../dist/body-blob.js'
import { computeStorageBlock } from '@playtiss/core'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 5
const ACTOR = 'claude'
const sourceDbPath = process.argv[2] || '/Users/cosimodw/filo/claude-proxy/audit.db'
const destDbPath = process.argv[3] || '/Users/cosimodw/filo/claude-proxy/retcon-migrated.db'
const sessionId = process.argv[4] || `migrated_${randomUUID()}`
const mappingPath = destDbPath.replace(/\.db$/, '-pk-mapping.json')

// ---------------------------------------------------------------------------
// Schema DDL (mirrors db.ts CURRENT_SCHEMA_VERSION = 5)
// ---------------------------------------------------------------------------

const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);`

const SOURCE_OF_TRUTH_DDL = `
${SCHEMA_VERSION_DDL}

CREATE TABLE IF NOT EXISTS blobs (
  cid TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic, event_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, event_id);

CREATE TABLE IF NOT EXISTS projection_offsets (
  projection_id TEXT PRIMARY KEY,
  last_processed_event_id TEXT NOT NULL DEFAULT ''
);`

const PROJECTED_VIEWS_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  pid INTEGER,
  harness TEXT,
  actor TEXT NOT NULL DEFAULT 'default',
  branch_context_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_actor ON sessions(actor);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  asset_cid TEXT,
  parent_revision_id TEXT,
  classification TEXT NOT NULL,
  stop_reason TEXT,
  sealed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_task ON revisions(task_id);
CREATE INDEX IF NOT EXISTS idx_revisions_parent ON revisions(parent_revision_id);
CREATE INDEX IF NOT EXISTS idx_revisions_forkable
  ON revisions(task_id, classification)
  WHERE classification='closed_forkable';

CREATE TABLE IF NOT EXISTS branch_views (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  head_revision_id TEXT NOT NULL,
  label TEXT,
  auto_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_branch_views_task ON branch_views(task_id);

CREATE TABLE IF NOT EXISTS pending_actors (
  transport_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_actors_registered_at ON pending_actors(registered_at);`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function taskIdFromSessionId(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex')
  return `t_${hash.slice(0, 32)}`
}

function classifyStopReason(stopReason) {
  if (!stopReason) return 'dangling_unforkable'
  if (stopReason === 'end_turn' || stopReason === 'tool_use')
    return 'closed_forkable'
  if (stopReason === 'max_tokens') return 'open'
  return 'dangling_unforkable'
}

function parseTimestamp(ts) {
  return new Date(ts + 'Z').getTime()
}

let eventCounter = 0
function makeEventId(timestampMs) {
  eventCounter++
  const hex = timestampMs.toString(16).padStart(12, '0')
  const seq = eventCounter.toString(16).padStart(6, '0')
  return `evt_${hex}_${seq}`
}

function makeNonRevisionEventId(timestampMs) {
  return makeEventId(timestampMs)
}

function makeRevisionId() {
  return `rev_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

function makeViewId() {
  return `bv_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

// ---------------------------------------------------------------------------
// Row filtering
//
// All audit.db rows belong to a single retcon session. Message count drops
// (from subagent spawns or /compact) are NOT session boundaries.
// ---------------------------------------------------------------------------

function filterRows(rows) {
  const filtered = []
  for (const row of rows) {
    if (row.path !== '/v1/messages' && !row.path?.startsWith('/v1/messages?'))
      continue
    if (!row.request_body || row.request_body.length < 10) continue
    try {
      JSON.parse(row.request_body)
    } catch {
      continue
    }
    filtered.push(row)
  }
  return filtered
}

// ---------------------------------------------------------------------------
// Blob writing
// ---------------------------------------------------------------------------

function insertBlob(db, cid, bytes, createdAt) {
  db.prepare(
    'INSERT OR IGNORE INTO blobs (cid, bytes, size, created_at) VALUES (?, ?, ?, ?)',
  ).run(cid, bytes, bytes.length, createdAt)
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

async function migrate() {
  console.log(`Source: ${sourceDbPath}`)
  console.log(`Dest:   ${destDbPath}`)
  console.log(`Actor:  ${ACTOR}`)

  const src = new Database(sourceDbPath, { readonly: true })
  const rows = src
    .prepare(
      `SELECT id, timestamp, method, path, request_body, response_body,
              response_status, duration_ms, tobe_applied, tobe_source_id,
              original_request_body, audit_note
       FROM requests ORDER BY id`,
    )
    .all()

  console.log(`Read ${rows.length} records from audit.db`)

  const filtered = filterRows(rows)
  console.log(`Filtered to ${filtered.length} /v1/messages rows`)

  const taskId = taskIdFromSessionId(sessionId)
  const startTs = parseTimestamp(filtered[0].timestamp)
  const endTs = parseTimestamp(filtered[filtered.length - 1].timestamp)
  console.log(`Session: ${sessionId}`)
  console.log(`Task:    ${taskId}`)

  const dest = new Database(destDbPath)
  dest.pragma('journal_mode = WAL')
  dest.pragma('foreign_keys = ON')
  dest.exec(SOURCE_OF_TRUTH_DDL)
  dest.exec(PROJECTED_VIEWS_DDL)
  dest.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
    SCHEMA_VERSION,
    Date.now(),
  )

  const insertEvent = dest.prepare(
    'INSERT INTO events (event_id, topic, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  const insertSession = dest.prepare(
    `INSERT INTO sessions (id, task_id, created_at, ended_at, pid, harness, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertTask = dest.prepare(
    'INSERT INTO tasks (id, session_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  const insertRevision = dest.prepare(
    `INSERT INTO revisions (id, task_id, asset_cid, parent_revision_id, classification, stop_reason, sealed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertBranchView = dest.prepare(
    `INSERT INTO branch_views (id, task_id, head_revision_id, label, auto_label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )

  let totalBlobs = 0
  let totalEvents = 0
  let totalRevisions = 0
  let lastEventId = ''

  const pkMapping = {}

  const initEventId = makeNonRevisionEventId(startTs)
  const initPayload = JSON.stringify({
    mcp_session_id: sessionId,
    pid: null,
    harness: 'filo-audit-proxy',
  })
  insertEvent.run(initEventId, 'mcp.session_initialized', initPayload, sessionId, startTs)
  totalEvents++
  lastEventId = initEventId

  insertSession.run(sessionId, taskId, startTs, endTs, null, 'filo-audit-proxy', ACTOR)
  insertTask.run(taskId, sessionId, `Migrated session (audit.db)`, null, startTs)

  let prevRevisionId = null

  for (const row of filtered) {
    const rowTs = parseTimestamp(row.timestamp)
    const requestBytes = Buffer.from(row.request_body, 'utf8')
    const revisionId = makeRevisionId()

    let requestBodyCid
    try {
      const reqResult = await blobRefFromMessagesBody(requestBytes)
      requestBodyCid = reqResult.topCid
      for (const ref of reqResult.refs) {
        insertBlob(dest, ref.cid, ref.bytes instanceof Buffer ? ref.bytes : Buffer.from(ref.bytes), rowTs)
        totalBlobs++
      }
    } catch (e) {
      const fallback = await blobRefFromBytes(requestBytes)
      requestBodyCid = fallback.cid
      insertBlob(dest, fallback.ref.cid, Buffer.from(fallback.ref.bytes), rowTs)
      totalBlobs++
    }

    // retcon requires event_id = revision_id for proxy.request_received
    const reqEventId = revisionId

    const headerBytes = Buffer.from('{}', 'utf8')
    const headerResult = await blobRefFromBytes(headerBytes)
    insertBlob(dest, headerResult.ref.cid, Buffer.from(headerResult.ref.bytes), rowTs)

    const reqPayload = {
      method: row.method || 'POST',
      path: row.path || '/v1/messages',
      headers_cid: headerResult.cid,
      body_cid: requestBodyCid,
    }

    if (row.tobe_applied && row.original_request_body) {
      reqPayload.tobe_applied_from = {
        fork_point_revision_id: prevRevisionId || 'unknown',
        source_view_id: sessionId,
        original_body_cid: 'migrated_original',
      }
    }

    insertEvent.run(reqEventId, 'proxy.request_received', JSON.stringify(reqPayload), sessionId, rowTs)
    totalEvents++

    let responseBodyCid = null
    let stopReason = null
    let assetCid = null
    let respEventId = null

    if (row.response_body && row.response_status === 200) {
      const responseBytes = Buffer.from(row.response_body, 'utf8')
      const respResult = await blobRefFromBytes(responseBytes)
      responseBodyCid = respResult.cid
      insertBlob(dest, respResult.ref.cid, Buffer.from(respResult.ref.bytes), rowTs)
      totalBlobs++

      const srMatch = row.response_body.match(/"stop_reason":"([^"]+)"/)
      if (srMatch) stopReason = srMatch[1]

      const assetObj = {
        request_body_cid: requestBodyCid,
        response_body_cid: responseBodyCid,
      }
      const assetBlock = await computeStorageBlock(assetObj)
      assetCid = assetBlock.cid
      insertBlob(dest, assetBlock.cid, Buffer.from(assetBlock.bytes), rowTs)
      totalBlobs++

      respEventId = makeNonRevisionEventId(rowTs + (row.duration_ms || 0))
      const respPayload = {
        request_event_id: reqEventId,
        status: row.response_status,
        headers_cid: headerResult.cid,
        body_cid: responseBodyCid,
        stop_reason: stopReason,
        asset_cid: assetCid,
      }
      insertEvent.run(
        respEventId,
        'proxy.response_completed',
        JSON.stringify(respPayload),
        sessionId,
        rowTs + (row.duration_ms || 0),
      )
      totalEvents++
      lastEventId = respEventId
    } else if (row.response_status && row.response_status >= 400) {
      respEventId = makeNonRevisionEventId(rowTs + (row.duration_ms || 0))
      const errPayload = {
        request_event_id: reqEventId,
        status: row.response_status,
        error_message: `HTTP ${row.response_status}`,
      }
      insertEvent.run(
        respEventId,
        'proxy.upstream_error',
        JSON.stringify(errPayload),
        sessionId,
        rowTs + (row.duration_ms || 0),
      )
      totalEvents++
      lastEventId = respEventId
    }

    const classification = classifyStopReason(stopReason)
    const sealedAt = row.response_status === 200 ? rowTs + (row.duration_ms || 0) : null
    insertRevision.run(
      revisionId,
      taskId,
      assetCid,
      prevRevisionId,
      classification,
      stopReason,
      sealedAt,
      rowTs,
    )
    totalRevisions++

    pkMapping[row.id] = {
      session_id: sessionId,
      task_id: taskId,
      revision_id: revisionId,
      request_event_id: reqEventId,
      response_event_id: respEventId,
      request_body_cid: requestBodyCid,
      response_body_cid: responseBodyCid,
      asset_cid: assetCid,
    }

    if (classification === 'closed_forkable') {
      prevRevisionId = revisionId
    }
  }

  if (prevRevisionId) {
    insertBranchView.run(
      makeViewId(),
      taskId,
      prevRevisionId,
      'main',
      `main@${filtered[0].timestamp}`,
      startTs,
      endTs,
    )
  }

  const closeEventId = makeNonRevisionEventId(endTs)
  insertEvent.run(closeEventId, 'mcp.session_closed', '{}', sessionId, endTs)
  totalEvents++
  lastEventId = closeEventId

  for (const projId of ['sessions_v1', 'revisions_v1', 'branch_views_v1']) {
    dest.prepare(
      'INSERT INTO projection_offsets (projection_id, last_processed_event_id) VALUES (?, ?)',
    ).run(projId, lastEventId)
  }

  writeFileSync(mappingPath, JSON.stringify(pkMapping, null, 2))

  console.log('\n--- Migration complete ---')
  console.log(`Session:   ${sessionId}`)
  console.log(`Task:      ${taskId}`)
  console.log(`Rows:      ${filtered.length}`)
  console.log(`Blobs:     ${totalBlobs}`)
  console.log(`Events:    ${totalEvents}`)
  console.log(`Revisions: ${totalRevisions}`)
  console.log(`Mapping:   ${mappingPath}`)
  console.log(`Output:    ${destDbPath}`)

  src.close()
  dest.close()
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
