/**
 * Maintenance: access-count evidence decay, orphan cleanup, health snapshot.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ liveEntries: number, entityCount: number, edgeCount: number, lastRun: string }}
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

    // (c) health snapshot
    const liveEntries =
      db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE superseded_by IS NULL`).get()?.n ?? 0
    const entityCount = db.prepare(`SELECT COUNT(*) AS n FROM entities`).get()?.n ?? 0
    const edgeCount = db.prepare(`SELECT COUNT(*) AS n FROM edges`).get()?.n ?? 0
    const lastRun = new Date().toISOString()
    const snapshot = { liveEntries, entityCount, edgeCount, lastRun }

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
  return { liveEntries: 0, entityCount: 0, edgeCount: 0, lastRun: null }
}

export const JANITOR_INTERVAL_MS = 6 * 60 * 60 * 1000
