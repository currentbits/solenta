import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, createSchema } from '../src/db.js'
import { Memory } from '../src/memory.js'

/** The pre-strategy shape, as an 0.5-era DB has it on disk. */
const LEGACY_ENTRIES = `
  CREATE TABLE entries (
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
`

describe('strategy entry type', () => {
  let dir
  let dbPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-strategy-'))
    dbPath = path.join(dir, 'memory.db')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('widens the legacy CHECK constraint without losing rows', () => {
    const old = openDb(dbPath)
    old.exec(LEGACY_ENTRIES)
    old.prepare(
      `INSERT INTO entries (id, type, title, body, project, created_at, updated_at, importance)
       VALUES ('e1', 'knowledge', 'kept', 'body', 'proj', '2026-01-01', '2026-01-01', 4)`,
    ).run()
    assert.throws(() =>
      old
        .prepare(
          `INSERT INTO entries (id, type, title, body, created_at, updated_at)
           VALUES ('e2', 'strategy', 't', 'b', '2026-01-01', '2026-01-01')`,
        )
        .run(),
    )
    old.close()

    const db = openDb(dbPath)
    createSchema(db)
    const kept = db.prepare(`SELECT title, importance, rowid FROM entries WHERE id = 'e1'`).get()
    assert.equal(kept.title, 'kept')
    assert.equal(kept.importance, 4)
    // Migrated columns from the newer shape are present and defaulted.
    const cols = db.prepare(`PRAGMA table_info(entries)`).all().map((c) => c.name)
    assert.ok(cols.includes('helpful_count'))
    assert.ok(cols.includes('invalid_at'))
    db.prepare(
      `INSERT INTO entries (id, type, title, body, created_at, updated_at)
       VALUES ('e2', 'strategy', 'now allowed', 'b', '2026-01-01', '2026-01-01')`,
    ).run()
    // FTS triggers survived the table swap.
    const hit = db
      .prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'allowed'`)
      .all()
    assert.equal(hit.length, 1)
    db.close()

    // Second boot is a no-op, not a second rebuild.
    const again = openDb(dbPath)
    createSchema(again)
    assert.equal(again.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n, 2)
    again.close()
  })

  it('stores strategies and injects them at bootstrap', () => {
    const memory = new Memory(dbPath)
    memory.store({
      type: 'strategy',
      title: 'Merge worker branches locally',
      body: "When a forked worker finishes, don't wait for a push: merge its local branch.",
      project: 'proj',
    })
    const boot = memory.bootstrap({ project: 'proj' })
    assert.equal(boot.strategies.length, 1)
    assert.equal(boot.strategies[0].title, 'Merge worker branches locally')
    // Whole body, not an excerpt: a half rule is worse than none.
    assert.match(boot.strategies[0].body, /merge its local branch\.$/)
    // Ranks above knowledge, below conventions.
    assert.equal(boot.strategies[0].importance, 4)
    memory.close?.()
  })
})
