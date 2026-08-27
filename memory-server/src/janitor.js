import {
  contentTokens,
  jaccard,
  queueReview,
  semanticNeighbors,
  SEMANTIC_RELATED,
  AUTO_RESOLVE_PREFIX,
} from './review.js'
import { blobToFloat } from './embedder.js'

/** Default retention for raw session transcripts (days). */
export const SESSION_RETENTION_DAYS = 30

/** Open review_queue rows older than this are auto-resolved as noop. */
export const STALE_QUEUE_DAYS = 30

/**
 * Live `run` entries older than this are auto-invalidated. Distill looks
 * back DISTILL_RUN_DAYS (14); AGING_RUN_DAYS (7) is report-only. 30 keeps
 * a margin so distillation still sees the recent window.
 */
export const ANCIENT_RUN_DAYS = 30

/**
 * Cosine at which a `near_dup` is the same fact, not merely related.
 * Enqueue bar is SEMANTIC_DUP (0.9). Validated on the live store
 * 2026-08-27 (#720): 0.93 false-merges sequential run notes; 0.95 has
 * zero tagged hits; 0.97 adds no extra safety. Parses `cosine=` from
 * detail — does not recompute vectors.
 */
export const SEMANTIC_DUP_AUTO = 0.95

/** Max entries examined per contradiction scan pass. */
export const QUEUE_SCAN_CAP = 500

/** Jaccard threshold for the weak contradiction signal (shared entity + text overlap). */
export const DEDUP_WARN = 0.4

/**
 * A single entry sharing an entity with twenty others must not dump twenty
 * pairs into a human's review queue.
 */
export const MAX_PAIRS_PER_ENTRY = 3

/** @deprecated alias of MAX_PAIRS_PER_ENTRY; kept for tests that import CONTRA_TOP. */
export const CONTRA_TOP = MAX_PAIRS_PER_ENTRY

/**
 * Incremental contradiction-candidate scan. Watermarked on entries.rowid so each
 * live knowledge/convention entry is examined once. A pair is flagged when two live
 * same-project knowledge/convention entries share >=2 mentioned entities,
 * or >=1 shared entity with title+body Jaccard >= DEDUP_WARN,
 * or (when the candidate has a stored vector) >=1 shared entity with cosine
 * >= SEMANTIC_RELATED. Vector-backed candidates rank survivors by cosine and
 * enqueue only the top MAX_PAIRS_PER_ENTRY. Candidates with no vector keep
 * today's lexical strong/weak gates, uncapped, with the original detail string.
 * Best-effort: any error logs and returns 0 without aborting the rest of the janitor.
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

    // Table can be missing on old DBs mid-migration; a miss is "no vector".
    let vecStmt = null
    try {
      vecStmt = db.prepare(`SELECT vec, dim, model FROM entry_vectors WHERE entry_id = ?`)
    } catch {
      vecStmt = null
    }

    const vecRowOf = (id) => {
      try {
        return vecStmt?.get(id) ?? null
      } catch {
        return null
      }
    }

    let queued = 0
    let maxRowid = watermark
    // A partner already examined this pass already picked its top pairs.
    // Skipping it here stops the other side from re-adding a pair the first
    // side dropped under the cap (otherwise a hub still floods the queue).
    const scannedThisPass = new Set()
    for (const cand of candidates) {
      maxRowid = Math.max(maxRowid, cand.rowid)
      const myTokens = contentTokens(`${cand.title} ${cand.body}`)
      const partners = partnersFor.all(cand.id, cand.id, cand.project)

      const vecRow = vecRowOf(cand.id)
      let myVec = null
      if (vecRow?.vec && vecRow.model) {
        try {
          myVec = blobToFloat(vecRow.vec)
          if (!myVec?.length) myVec = null
        } catch {
          myVec = null
        }
      }

      // No stored vector (not yet embedded, embeddings off, table missing):
      // today's exact lexical behaviour — strong/weak only, no cap, same detail.
      if (!myVec) {
        for (const p of partners) {
          const strong = p.shared >= 2
          const weak =
            p.shared >= 1 && jaccard(myTokens, contentTokens(`${p.title} ${p.body}`)) >= DEDUP_WARN
          if (!strong && !weak) continue
          if (queueReview(db, 'contradiction', cand.id, p.id, `shared entities: ${p.names ?? ''}`)) {
            queued += 1
          }
        }
        scannedThisPass.add(cand.id)
        continue
      }

      const scoreById = new Map()
      for (const n of semanticNeighbors(db, myVec, {
        model: vecRow.model,
        project: cand.project,
        exclude: cand.id,
        types: ['knowledge', 'convention'],
        minScore: 0,
        limit: 500,
      })) {
        scoreById.set(n.id, n.score)
      }

      const qualified = []
      for (const p of partners) {
        if (scannedThisPass.has(p.id)) continue
        const score = scoreById.get(p.id) ?? 0
        const strong = p.shared >= 2
        const weak =
          p.shared >= 1 && jaccard(myTokens, contentTokens(`${p.title} ${p.body}`)) >= DEDUP_WARN
        const semantic = p.shared >= 1 && score >= SEMANTIC_RELATED
        if (!strong && !weak && !semantic) continue
        qualified.push({ p, score })
      }

      qualified.sort((a, b) => b.score - a.score)

      for (const { p, score } of qualified.slice(0, MAX_PAIRS_PER_ENTRY)) {
        const detail = `shared entities: ${p.names ?? ''}; cosine=${score}`
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
 * @param {unknown} detail
 * @returns {number | null}
 */
function parseCosine(detail) {
  const m = String(detail ?? '').match(/cosine=([0-9]*\.?[0-9]+)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * @param {string} rule
 * @param {string} [extra]
 */
function autoDetail(rule, extra) {
  return extra ? `${AUTO_RESOLVE_PREFIX}${rule} ${extra}` : `${AUTO_RESOLVE_PREFIX}${rule}`
}

/**
 * Tombstone a live entry. Returns false if it was already dead/missing.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @param {string|null} by
 * @param {string} reason
 * @param {string} nowIso
 */
function tombstoneEntry(db, id, by, reason, nowIso) {
  const info = db
    .prepare(
      `UPDATE entries
       SET invalid_at = ?, invalidated_by = ?, invalidation_reason = ?, updated_at = ?
       WHERE id = ? AND superseded_by IS NULL AND invalid_at IS NULL`,
    )
    .run(nowIso, by, reason, nowIso, id)
  return (info.changes ?? 0) > 0
}

/**
 * Resolve one open queue row. No-op if it was already resolved this pass.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {'noop'|'invalidate'} resolution
 * @param {string} detail
 * @param {string} nowIso
 */
function resolveQueueRow(db, id, resolution, detail, nowIso) {
  const info = db
    .prepare(
      `UPDATE review_queue
       SET resolved_at = ?, resolution = ?, detail = ?
       WHERE id = ? AND resolved_at IS NULL`,
    )
    .run(nowIso, resolution, detail, id)
  return (info.changes ?? 0) > 0
}

/**
 * Deterministic, LLM-free queue consumption + run expiry. Only tombstones,
 * never deletes. Each queue resolution overwrites detail with `auto:<rule>`.
 *
 * Order: semantic dups (invalidate older of a live pair) → ancient runs
 * (tombstone) → dead pairs (noop) → stale rows (noop). Dead last so a
 * tombstone this pass clears leftover queue rows the same cycle.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} [now]
 * @returns {{ deadPairs: number, staleRows: number, semanticDups: number, ancientRuns: number }}
 */
export function autoResolveQueue(db, now = Date.now()) {
  const nowIso = new Date(now).toISOString()
  const counts = { deadPairs: 0, staleRows: 0, semanticDups: 0, ancientRuns: 0 }

  const nearDups = db
    .prepare(
      `SELECT q.id, q.detail, q.entry_a, q.entry_b,
              a.created_at AS a_created, a.superseded_by AS a_sup, a.invalid_at AS a_inv,
              b.created_at AS b_created, b.superseded_by AS b_sup, b.invalid_at AS b_inv
       FROM review_queue q
       JOIN entries a ON a.id = q.entry_a
       JOIN entries b ON b.id = q.entry_b
       WHERE q.resolved_at IS NULL AND q.kind = 'near_dup'`,
    )
    .all()
  for (const row of nearDups) {
    const score = parseCosine(row.detail)
    if (score == null || score < SEMANTIC_DUP_AUTO) continue
    const aDead = row.a_sup || row.a_inv
    const bDead = row.b_sup || row.b_inv
    if (aDead || bDead) continue
    const aOlder = row.a_created <= row.b_created
    const loser = aOlder ? row.entry_a : row.entry_b
    const winner = aOlder ? row.entry_b : row.entry_a
    const detail = autoDetail('semantic_dup', `cosine=${score}`)
    if (!tombstoneEntry(db, loser, winner, detail, nowIso)) continue
    if (resolveQueueRow(db, row.id, 'invalidate', detail, nowIso)) counts.semanticDups += 1
  }

  const runCutoff = new Date(now - ANCIENT_RUN_DAYS * 86_400_000).toISOString()
  const ancient = db
    .prepare(
      `SELECT id FROM entries
       WHERE type = 'run' AND superseded_by IS NULL AND invalid_at IS NULL
         AND created_at < ?`,
    )
    .all(runCutoff)
  for (const row of ancient) {
    if (tombstoneEntry(db, row.id, 'janitor', autoDetail('ancient_run'), nowIso)) {
      counts.ancientRuns += 1
    }
  }

  const deadRows = db
    .prepare(
      `SELECT q.id
       FROM review_queue q
       LEFT JOIN entries a ON a.id = q.entry_a
       LEFT JOIN entries b ON b.id = q.entry_b
       WHERE q.resolved_at IS NULL
         AND (a.id IS NULL OR b.id IS NULL
              OR a.superseded_by IS NOT NULL OR a.invalid_at IS NOT NULL
              OR b.superseded_by IS NOT NULL OR b.invalid_at IS NOT NULL)`,
    )
    .all()
  const deadDetail = autoDetail('dead_pair')
  for (const row of deadRows) {
    if (resolveQueueRow(db, row.id, 'noop', deadDetail, nowIso)) counts.deadPairs += 1
  }

  const staleCutoff = new Date(now - STALE_QUEUE_DAYS * 86_400_000).toISOString()
  const staleRows = db
    .prepare(
      `SELECT id FROM review_queue
       WHERE resolved_at IS NULL AND created_at < ?`,
    )
    .all(staleCutoff)
  const staleDetail = autoDetail('stale_row')
  for (const row of staleRows) {
    if (resolveQueueRow(db, row.id, 'noop', staleDetail, nowIso)) counts.staleRows += 1
  }

  return counts
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

    // (e) deterministic auto-resolution: dead/stale/certain queue rows + ancient runs
    step('autoResolve', () => autoResolveQueue(db))

    // (f) health snapshot
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
