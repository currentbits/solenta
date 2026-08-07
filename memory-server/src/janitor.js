import { contentTokens, jaccard, queueReview } from './review.js'

/** Default retention for raw session transcripts (days). */
export const SESSION_RETENTION_DAYS = 30

/** Max entries examined per contradiction scan pass. */
export const QUEUE_SCAN_CAP = 500

/** Jaccard threshold for the weak contradiction signal (shared entity + text overlap). */
export const DEDUP_WARN = 0.4

/**
 * Incremental contradiction-candidate scan. Watermarked on entries.rowid so each
 * live knowledge/convention entry is examined once. A pair is flagged when two live
 * same-project-or-global knowledge/convention entries share >=2 mentioned entities,
 * or >=1 shared entity with title+body Jaccard >= 0.4. Best-effort: any error logs
 * and returns 0 without aborting the rest of the janitor.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} rows newly enqueued
 */
export function scanContradictions(db) {
  try {
    const watermark = Number(
      (
        db.prepare(`SELECT value FROM janitor_state WHERE key = 'review_scan_rowid'`).get()
      )?.value ?? 0,
    )

    const candidates = db
      .prepare(
        `SELECT rowid, id, title, body, project FROM entries
         WHERE rowid > ?
           AND type IN ('knowledge','convention')
           AND superseded_by IS NULL
           AND invalid_at IS NULL
         ORDER BY rowid ASC
         LIMIT ?`,
      )
      .all(watermark, QUEUE_SCAN_CAP)

    if (candidates.length === 0) return 0

    const partnersFor = db.prepare(
      `SELECT p.id, p.title, p.body,
              COUNT(DISTINCT m1.entity_id) AS shared,
              group_concat(DISTINCT en.name) AS names
       FROM mentions m1
       JOIN mentions m2 ON m2.entity_id = m1.entity_id
       JOIN entries p ON p.id = m2.entry_id
       JOIN entities en ON en.id = m1.entity_id
       WHERE m1.entry_id = ?
         AND p.id != ?
         AND p.type IN ('knowledge','convention')
         AND p.superseded_by IS NULL
         AND p.invalid_at IS NULL
         AND (? IS NULL OR p.project IS NULL OR p.project = ?)
       GROUP BY p.id`,
    )

    let queued = 0
    let maxRowid = watermark
    for (const cand of candidates) {
      maxRowid = Math.max(maxRowid, cand.rowid)
      const myTokens = contentTokens(`${cand.title} ${cand.body}`)
      const partners = partnersFor.all(cand.id, cand.id, cand.project, cand.project)
      for (const p of partners) {
        const strong = p.shared >= 2
        const weak =
          p.shared >= 1 && jaccard(myTokens, contentTokens(`${p.title} ${p.body}`)) >= DEDUP_WARN
        if (!strong && !weak) continue
        if (queueReview(db, 'contradiction', cand.id, p.id, `shared entities: ${p.names ?? ''}`)) {
          queued += 1
        }
      }
    }

    db.prepare(
      `INSERT INTO janitor_state (key, value) VALUES ('review_scan_rowid', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(maxRowid))
    return queued
  } catch (err) {
    console.error('scanContradictions failed (non-fatal):', err)
    return 0
  }
}

/**
 * Maintenance: access-count evidence decay, orphan cleanup, session prune, health snapshot.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ liveEntries: number, entityCount: number, edgeCount: number, sessionCount: number, prunedLastRun: number, queuedContradictions: number, lastRun: string }}
 */
export function runJanitor(db) {
  db.exec('BEGIN')
  try {
    // (a) access-count evidence decay: *0.98, integer floor, only rows that shrink, never below 0
    db.exec(`
      UPDATE entries
      SET access_count = CAST(access_count * 0.98 AS INTEGER)
      WHERE CAST(access_count * 0.98 AS INTEGER) < access_count
        AND CAST(access_count * 0.98 AS INTEGER) >= 0
    `)

    // (b) orphan cleanup: mentions/edges pointing at missing entries or entities.
    // NOT EXISTS (not NOT IN): a single NULL id in the subquery makes NOT IN
    // evaluate UNKNOWN for every row and silently skip the sweep.
    db.exec(`
      DELETE FROM mentions
      WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = mentions.entry_id)
         OR NOT EXISTS (SELECT 1 FROM entities n WHERE n.id = mentions.entity_id)
    `)
    db.exec(`
      DELETE FROM edges
      WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = edges.entry_id)
         OR NOT EXISTS (SELECT 1 FROM entities s WHERE s.id = edges.src)
         OR NOT EXISTS (SELECT 1 FROM entities d WHERE d.id = edges.dst)
    `)

    // Orphan vectors for hard-deleted entries
    try {
      db.exec(`
        DELETE FROM entry_vectors
        WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = entry_vectors.entry_id)
      `)
    } catch {
      // table may not exist on very old dbs mid-migration
    }

    // (c) prune session transcripts older than retention (FTS via delete trigger)
    const messageCutoff = new Date(
      Date.now() - SESSION_RETENTION_DAYS * 86_400_000,
    ).toISOString()
    const prunedLastRun =
      db.prepare(`DELETE FROM session_messages WHERE created_at < ?`).run(messageCutoff)
        .changes ?? 0

    // (d) contradiction scan (outside the pure-SQL hygiene; still inside the txn)
    const queuedContradictions = scanContradictions(db)

    // (e) health snapshot
    const liveEntries =
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM entries WHERE superseded_by IS NULL AND invalid_at IS NULL`,
        )
        .get()?.n ?? 0
    const entityCount = db.prepare(`SELECT COUNT(*) AS n FROM entities`).get()?.n ?? 0
    const edgeCount = db.prepare(`SELECT COUNT(*) AS n FROM edges`).get()?.n ?? 0
    const sessionCount = db.prepare(`SELECT COUNT(*) AS n FROM session_messages`).get()?.n ?? 0
    const lastRun = new Date().toISOString()
    const snapshot = {
      liveEntries,
      entityCount,
      edgeCount,
      sessionCount,
      prunedLastRun,
      queuedContradictions,
      lastRun,
    }

    db.prepare(
      `INSERT INTO janitor_state (key, value) VALUES ('snapshot', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(JSON.stringify(snapshot))

    db.exec('COMMIT')
    return snapshot
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // ignore
    }
    throw err
  }
}

/**
 * Read the last janitor snapshot, or a zeroed placeholder.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function readJanitorSnapshot(db) {
  try {
    const row = db.prepare(`SELECT value FROM janitor_state WHERE key = 'snapshot'`).get()
    if (row?.value) return JSON.parse(row.value)
  } catch {
    // ignore
  }
  return {
    liveEntries: 0,
    entityCount: 0,
    edgeCount: 0,
    sessionCount: 0,
    prunedLastRun: 0,
    queuedContradictions: 0,
    lastRun: null,
  }
}

export const JANITOR_INTERVAL_MS = 6 * 60 * 60 * 1000
