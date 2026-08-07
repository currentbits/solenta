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
      `SELECT lower(name) AS lname, kind
       FROM entities
       GROUP BY lower(name), kind
       HAVING COUNT(*) > 1`,
    )
    .all()

  if (dups.length === 0) return

  db.exec('BEGIN')
  try {
    for (const group of dups) {
      // Explicit keeper: earliest rowid for this (lower(name), kind) group.
      // Do not rely on GROUP_CONCAT aggregate order matching across columns.
      const keepRow = db
        .prepare(
          `SELECT id FROM entities
           WHERE lower(name) = ? AND kind = ?
           ORDER BY rowid ASC
           LIMIT 1`,
        )
        .get(group.lname, group.kind)
      if (!keepRow) continue
      const keepId = keepRow.id
      const dropIds = db
        .prepare(
          `SELECT id FROM entities
           WHERE lower(name) = ? AND kind = ? AND id != ?`,
        )
        .all(group.lname, group.kind, keepId)
        .map((r) => r.id)

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

    CREATE TABLE IF NOT EXISTS entry_vectors (
      entry_id   TEXT PRIMARY KEY REFERENCES entries(id),
      dim        INTEGER NOT NULL,
      vec        BLOB NOT NULL,
      model      TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('near_dup','contradiction')),
      entry_a     TEXT NOT NULL REFERENCES entries(id),
      entry_b     TEXT NOT NULL REFERENCES entries(id),
      detail      TEXT,
      created_at  TEXT NOT NULL,
      resolved_at TEXT,
      resolution  TEXT CHECK (resolution IN ('update','invalidate','noop') OR resolution IS NULL)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS review_queue_open_pair
      ON review_queue (kind, entry_a, entry_b) WHERE resolved_at IS NULL;

    CREATE TABLE IF NOT EXISTS session_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL,
      project      TEXT,
      thread_title TEXT,
      agent        TEXT,
      role         TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
      content      TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS session_messages_session_idx
      ON session_messages(session_id, id);

    CREATE INDEX IF NOT EXISTS session_messages_project_idx
      ON session_messages(project, id);

    CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
      content,
      content='session_messages',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS session_messages_fts_insert AFTER INSERT ON session_messages BEGIN
      INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS session_messages_fts_delete AFTER DELETE ON session_messages BEGIN
      INSERT INTO session_messages_fts(session_messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
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
  addColumnIfMissing(db, 'entries', 'invalid_at', 'TEXT')
  addColumnIfMissing(db, 'entries', 'invalidated_by', 'TEXT')
  addColumnIfMissing(db, 'entries', 'invalidation_reason', 'TEXT')

  try {
    normalizeEntities(db)
  } catch (err) {
    // Non-fatal like the janitor: a corrupt graph must not brick Memory boot.
    console.error('normalizeEntities failed (non-fatal):', err)
  }
}

/**
 * Drop embedding rows written under a different model id so backfill can re-embed
 * into a consistent space. No-op when modelId is empty.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|null|undefined} modelId
 * @returns {number} rows deleted
 */
export function purgeStaleVectors(db, modelId) {
  if (!modelId) return 0
  try {
    const result = db.prepare(`DELETE FROM entry_vectors WHERE model != ?`).run(modelId)
    return result.changes ?? 0
  } catch (err) {
    console.error('purgeStaleVectors failed (non-fatal):', err)
    return 0
  }
}
