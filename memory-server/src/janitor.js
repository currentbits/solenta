import { contentTokens, jaccard, queueReview } from './review.js'
import { cosine, blobToFloat } from './embedder.js'

/** Default retention for raw session transcripts (days). */
export const SESSION_RETENTION_DAYS = 30

/** Max entries examined per contradiction scan pass. */
export const QUEUE_SCAN_CAP = 500

/** Jaccard threshold for the weak contradiction signal (shared entity + text overlap). */
export const DEDUP_WARN = 0.4

/** Cosine threshold for the paraphrase contradiction signal (shared entity + similar vectors). */
export const CONTRA_SIM = 0.75

/** Max review pairs enqueued per candidate. A hub entity must not flood the queue. */
export const CONTRA_TOP = 5

/**
 * Incremental contradiction-candidate scan. Watermarked on entries.rowid so each
 * live knowledge/convention entry is examined once. A pair is flagged when two live
 * same-project knowledge/convention entries share >=2 mentioned entities,
 * or >=1 shared entity with title+body Jaccard >= DEDUP_WARN,
 * or >=1 shared entity with stored-vector cosine >= CONTRA_SIM.
 * Qualifying partners are ranked by cosine (unscored last) and capped at
 * CONTRA_TOP per candidate. Best-effort: any error logs and returns 0 without
 * aborting the rest of the janitor.
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
         AND p.project IS ?  -- same scope only; memory is project-scoped
       GROUP BY p.id`,
    )

    // Decode each vector at most once per pass. The table can be missing on
    // old DBs mid-migration; a miss degrades to "no score", not a throw.
    const vecCache = new Map()
    let vecStmt = null
    try {
      vecStmt = db.prepare(`SELECT dim, vec, model FROM entry_vectors WHERE entry_id = ?`)
    } catch {
      vecStmt = null
    }

    const vectorOf = (id) => {
      if (vecCache.has(id)) return vecCache.get(id)
      let rec = null
      try {
        const row = vecStmt?.get(id)
        if (row) rec = { dim: row.dim, model: row.model, vec: blobToFloat(row.vec) }
      } catch {
        rec = null
      }
      vecCache.set(id, rec)
      return rec
    }

    const pairScore = (a, b) => {
      if (!a || !b) return null
      if (a.model !== b.model || a.dim !== b.dim) return null
      return cosine(a.vec, b.vec)
    }

    let queued = 0
    let maxRowid = watermark
    // A partner already examined this pass already picked its CONTRA_TOP.
    // Skipping it here stops the other side from re-adding a pair the first
    // side dropped under the cap (otherwise a hub still floods the queue).
    const scannedThisPass = new Set()
    for (const cand of candidates) {
      maxRowid = Math.max(maxRowid, cand.rowid)
      const myTokens = contentTokens(`${cand.title} ${cand.body}`)
      const myVec = vectorOf(cand.id)
      const partners = partnersFor.all(cand.id, cand.id, cand.project)

      const qualified = []
      for (const p of partners) {
        if (scannedThisPass.has(p.id)) continue
        const score = pairScore(myVec, vectorOf(p.id))
        const strong = p.shared >= 2
        const weak =
          p.shared >= 1 && jaccard(myTokens, contentTokens(`${p.title} ${p.body}`)) >= DEDUP_WARN
        const similar = p.shared >= 1 && score != null && score >= CONTRA_SIM
        if (!strong && !weak && !similar) continue
        qualified.push({ p, score })
      }

      // Unscored pairs sort last so today's lexical/strong hits stay the tail.
      qualified.sort((a, b) => {
        if (a.score == null && b.score == null) return 0
        if (a.score == null) return 1
        if (b.score == null) return -1
        return b.score - a.score
      })

      // CONTRA_TOP cap: a hub entity mentioned by many entries would otherwise
      // enqueue every partner. Truncation is logged so a silent cut is not
      // mistaken for full coverage.
      if (qualified.length > CONTRA_TOP) {
        console.error(
          `scanContradictions: ${cand.id} has ${qualified.length} partners; enqueueing top ${CONTRA_TOP} by cosine (CONTRA_TOP cap)`,
        )
      }

      for (const { p, score } of qualified.slice(0, CONTRA_TOP)) {
        const detail =
          score == null
            ? `shared entities: ${p.names ?? ''}`
            : `shared entities: ${p.names ?? ''} (cosine=${score.toFixed(2)})`
        if (queueReview(db, 'contradiction', cand.id, p.id, detail)) queued += 1
      }
      scannedThisPass.add(cand.id)
    }

    db.prepare(
      `INSERT INTO janitor_state (key, value) VALUES ('review_scan_rowid', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(maxRowid))
    return queued
  } catch (err) {
    console.error('scanContradictions failed (non-fatal):', err)
    // Surface the failure to the caller's lastError tracking while keeping
    // the non-fatal contract (janitor continues, watermark rolls back only
    // with the whole transaction).
    scanContradictions.lastError = err
    return 0
  }
}

/**
 * Maintenance: access-count evidence decay, orphan cleanup, session prune, health snapshot.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ liveEntries: number, entityCount: number, edgeCount: number, sessionCount: number, prunedLastRun: number, queuedContradictions: number, lastRun: string }}
 */
export function runJanitor(db) {
  /** First step failure of this run, or null when clean; lands in the snapshot. */
  let lastError = null
  /** Run a best-effort step: a failure is recorded (first wins), not fatal. */
  const step = (name, fn) => {
    try {
      return fn()
    } catch (err) {
      console.error(`janitor step ${name} failed (non-fatal):`, err)
      lastError = lastError ?? {
        step: name,
        message: String((err && err.message) || err),
        at: new Date().toISOString(),
      }
      return null
    }
  }
  db.exec('BEGIN')
  try {
    // (a) access-count evidence decay: *0.98, integer floor, only rows that shrink, never below 0
    step('decay', () =>
      db.exec(`
        UPDATE entries
        SET access_count = CAST(access_count * 0.98 AS INTEGER)
        WHERE CAST(access_count * 0.98 AS INTEGER) < access_count
          AND CAST(access_count * 0.98 AS INTEGER) >= 0
      `),
    )

    // (b) orphan cleanup: mentions/edges pointing at missing entries or entities.
    // NOT EXISTS (not NOT IN): a single NULL id in the subquery makes NOT IN
    // evaluate UNKNOWN for every row and silently skip the sweep.
    step('orphans', () => {
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
    })

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
      step(
        'sessionPrune',
        () =>
          db.prepare(`DELETE FROM session_messages WHERE created_at < ?`).run(messageCutoff)
            .changes ?? 0,
      ) ?? 0

    // (d) contradiction scan (outside the pure-SQL hygiene; still inside the txn)
    scanContradictions.lastError = null
    const queuedContradictions = scanContradictions(db)
    if (scanContradictions.lastError) {
      const err = scanContradictions.lastError
      lastError = lastError ?? {
        step: 'contradictions',
        message: String((err && err.message) || err),
        at: new Date().toISOString(),
      }
    }

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
      lastError,
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
