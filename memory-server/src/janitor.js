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

    // (b) orphan cleanup: mentions/edges pointing at missing entries or entities
    db.exec(`
      DELETE FROM mentions
      WHERE entry_id NOT IN (SELECT id FROM entries)
         OR entity_id NOT IN (SELECT id FROM entities)
    `)
    db.exec(`
      DELETE FROM edges
      WHERE entry_id NOT IN (SELECT id FROM entries)
         OR src NOT IN (SELECT id FROM entities)
         OR dst NOT IN (SELECT id FROM entities)
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
