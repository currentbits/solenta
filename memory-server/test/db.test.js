import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, createSchema, addColumnIfMissing } from '../src/db.js'

describe('db schema', () => {
  let dir
  let dbPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-db-'))
    dbPath = path.join(dir, 'memory.db')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is idempotent when booted twice', () => {
    const db1 = openDb(dbPath)
    createSchema(db1)
    db1.prepare(
      `INSERT INTO entries (id, type, title, body, agent, created_at, updated_at)
       VALUES ('e1', 'knowledge', 't', 'b', 'test', '2026-01-01', '2026-01-01')`,
    ).run()
    db1.close()

    const db2 = openDb(dbPath)
    createSchema(db2)
    const row = db2.prepare(`SELECT title FROM entries WHERE id = 'e1'`).get()
    assert.equal(row.title, 't')
    const cols = db2.prepare(`PRAGMA table_info(entries)`).all().map((c) => c.name)
    assert.ok(cols.includes('importance'))
    assert.ok(cols.includes('access_count'))
    assert.ok(cols.includes('last_accessed_at'))
    db2.close()
  })

  it('addColumnIfMissing returns true only on first add', () => {
    const db = openDb(dbPath)
    createSchema(db)
    const again = addColumnIfMissing(db, 'entries', 'importance', 'INTEGER DEFAULT 3')
    assert.equal(again, false)
    const added = addColumnIfMissing(db, 'entries', 'extra_col', 'TEXT')
    assert.equal(added, true)
    const third = addColumnIfMissing(db, 'entries', 'extra_col', 'TEXT')
    assert.equal(third, false)
    db.close()
  })

  it('backfills importance by type only when the column is first added', () => {
    const db = openDb(dbPath)
    db.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('knowledge','task','convention','run')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        project TEXT,
        agent TEXT,
        status TEXT CHECK (status IN ('active','done','abandoned')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_by TEXT
      );
      INSERT INTO entries (id,type,title,body,created_at,updated_at) VALUES
        ('c1','convention','t','b','2026-01-01','2026-01-01'),
        ('r1','run','t','b','2026-01-01','2026-01-01'),
        ('k1','knowledge','t','b','2026-01-01','2026-01-01');
    `)
    createSchema(db)
    const imp = (id) => db.prepare(`SELECT importance FROM entries WHERE id = ?`).get(id).importance
    assert.equal(imp('c1'), 5)
    assert.equal(imp('r1'), 1)
    assert.equal(imp('k1'), 3)
    db.prepare(`UPDATE entries SET importance = 2 WHERE id = 'c1'`).run()
    createSchema(db)
    assert.equal(imp('c1'), 2)
    db.close()
  })
})
