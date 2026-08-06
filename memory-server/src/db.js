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
  `)

  // Migrations for older shapes (column may already exist from CREATE TABLE above).
  addColumnIfMissing(db, 'entries', 'last_accessed_at', 'TEXT')
  addColumnIfMissing(db, 'entries', 'access_count', 'INTEGER NOT NULL DEFAULT 0')
  if (addColumnIfMissing(db, 'entries', 'importance', 'INTEGER NOT NULL DEFAULT 3')) {
    db.exec(
      `UPDATE entries SET importance = CASE type WHEN 'convention' THEN 5 WHEN 'run' THEN 1 ELSE 3 END`,
    )
  }
}
