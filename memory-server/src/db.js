import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @param {string} column
 * @param {string} definition
 * @returns {boolean} true if the column was just added
 */
export function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    return true
  }
  return false
}

/**
 * @param {string} dbPath
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  if (dbPath !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL')
    } catch {
      // ignore if WAL unavailable
    }
  }
  return db
}

/**
 * Merge case-duplicate entities (same kind, name differs only by case) into the
 * earliest row, repointing mentions and edges. Runs in a transaction.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function normalizeEntities(db) {
  const dups = db
    .prepare(
      `SELECT lower(name) AS lname, kind, GROUP_CONCAT(id, char(31)) AS ids,
              GROUP_CONCAT(rowid, char(31)) AS rowids
       FROM entities
       GROUP BY lower(name), kind
       HAVING COUNT(*) > 1`,
    )
    .all()

  if (dups.length === 0) return

  db.exec('BEGIN')
  try {
    for (const group of dups) {
      const ids = String(group.ids).split('\x1f')
      const rowids = String(group.rowids).split('\x1f').map(Number)
      // Earliest row = minimum rowid
      let keepIdx = 0
      for (let i = 1; i < rowids.length; i++) {
        if (rowids[i] < rowids[keepIdx]) keepIdx = i
      }
      const keepId = ids[keepIdx]
      const dropIds = ids.filter((id) => id !== keepId)

      for (const dropId of dropIds) {
        // Repoint mentions (skip if keep already has the same entry)
        const mentions = db
          .prepare(`SELECT entry_id FROM mentions WHERE entity_id = ?`)
          .all(dropId)
        for (const { entry_id } of mentions) {
          const exists = db
            .prepare(`SELECT 1 AS ok FROM mentions WHERE entry_id = ? AND entity_id = ?`)
            .get(entry_id, keepId)
          if (!exists) {
            db.prepare(`UPDATE mentions SET entity_id = ? WHERE entry_id = ? AND entity_id = ?`).run(
              keepId,
              entry_id,
              dropId,
            )
          } else {
            db.prepare(`DELETE FROM mentions WHERE entry_id = ? AND entity_id = ?`).run(
              entry_id,
              dropId,
            )
          }
        }

        // Repoint edges src
        const asSrc = db.prepare(`SELECT src, dst, relation, entry_id, created_at FROM edges WHERE src = ?`).all(dropId)
        for (const e of asSrc) {
          const exists = db
            .prepare(
              `SELECT 1 AS ok FROM edges WHERE src = ? AND dst = ? AND relation = ? AND entry_id = ?`,
            )
            .get(keepId, e.dst === dropId ? keepId : e.dst, e.relation, e.entry_id)
          if (!exists) {
            const newDst = e.dst === dropId ? keepId : e.dst
            try {
              db.prepare(
                `UPDATE edges SET src = ?, dst = ? WHERE src = ? AND dst = ? AND relation = ? AND entry_id = ?`,
              ).run(keepId, newDst, e.src, e.dst, e.relation, e.entry_id)
            } catch {
              db.prepare(
                `DELETE FROM edges WHERE src = ? AND dst = ? AND relation = ? AND entry_id = ?`,
              ).run(e.src, e.dst, e.relation, e.entry_id)
            }
          } else {
            db.prepare(
              `DELETE FROM edges WHERE src = ? AND dst = ? AND relation = ? AND entry_id = ?`,
            ).run(e.src, e.dst, e.relation, e.entry_id)
          }
        }

        // Repoint edges dst (remaining rows still pointing at drop)
        const asDst = db.prepare(`SELECT src, dst, relation, entry_id, created_at FROM edges WHERE dst = ?`).all(dropId)
        for (const e of asDst) {
          const exists = db
            .prepare(
              `SELECT 1 AS ok FROM edges WHERE src = ? AND dst = ? AND relation = ? AND entry_id = ?`,
            )
            .get(e.src, keepId, e.relation, e.entry_id)
          if (!exists) {
            try {
              db.prepare(
                `UPDATE edges SET dst = ? WHERE src = ? AND dst = ? AND relation = ? AND entry_id = ?`,
              ).run(keepId, e.src, e.dst, e.relation, e.entry_id)
            } catch {
              db.prepare(
                `DELETE FROM edges WHERE src = ? AND dst = ? AND relation = ? AND entry_id = ?`,
              ).run(e.src, e.dst, e.relation, e.entry_id)
            }
          } else {
            db.prepare(
              `DELETE FROM edges WHERE src = ? AND dst = ? AND relation = ? AND entry_id = ?`,
            ).run(e.src, e.dst, e.relation, e.entry_id)
          }
        }

        db.prepare(`DELETE FROM entities WHERE id = ?`).run(dropId)
      }
    }
    db.exec('COMMIT')
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
 * Idempotent schema: CREATE TABLE IF NOT EXISTS + column migrations.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL CHECK (type IN ('knowledge','task','convention','run')),
      title         TEXT NOT NULL,
      body          TEXT NOT NULL,
      project       TEXT,
      agent         TEXT,
      status        TEXT CHECK (status IN ('active','done','abandoned')),
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      superseded_by TEXT,
      importance    INTEGER NOT NULL DEFAULT 3,
      last_accessed_at TEXT,
      access_count  INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      title,
      body,
      content='entries',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS entries_fts_insert AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS entries_fts_update AFTER UPDATE OF title, body ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
      INSERT INTO entries_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;

    CREATE TABLE IF NOT EXISTS entities (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('repo','module','file','concept','agent','tool')),
      UNIQUE(name, kind)
    );

    CREATE TABLE IF NOT EXISTS edges (
      src        TEXT NOT NULL,
      dst        TEXT NOT NULL,
      relation   TEXT NOT NULL,
      entry_id   TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (src, dst, relation, entry_id)
    );

    CREATE TABLE IF NOT EXISTS mentions (
      entry_id  TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (entry_id, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_entities_kind_name ON entities(kind, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS janitor_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id   TEXT NOT NULL,
      verdict    TEXT NOT NULL CHECK (verdict IN ('helpful','harmful')),
      note       TEXT,
      created_at TEXT NOT NULL
    );
  `)

  // Migrations for older shapes (column may already exist from CREATE TABLE above).
  addColumnIfMissing(db, 'entries', 'last_accessed_at', 'TEXT')
  addColumnIfMissing(db, 'entries', 'access_count', 'INTEGER NOT NULL DEFAULT 0')
  if (addColumnIfMissing(db, 'entries', 'importance', 'INTEGER NOT NULL DEFAULT 3')) {
    db.exec(
      `UPDATE entries SET importance = CASE type WHEN 'convention' THEN 5 WHEN 'run' THEN 1 ELSE 3 END`,
    )
  }
  addColumnIfMissing(db, 'entries', 'helpful_count', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'entries', 'harmful_count', 'INTEGER NOT NULL DEFAULT 0')

  normalizeEntities(db)
}
