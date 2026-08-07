import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'
import { runJanitor } from '../src/janitor.js'

describe('janitor', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-jan-'))
    memory = new Memory(path.join(dir, 'memory.db'))
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('decays access_count by 0.98 with integer floor, never below 0', () => {
    const a = memory.store({ type: 'knowledge', title: 'A', body: 'body a', force: true })
    const b = memory.store({ type: 'knowledge', title: 'B', body: 'body b', force: true })
    const c = memory.store({ type: 'knowledge', title: 'C', body: 'body c', force: true })
    memory.db.prepare(`UPDATE entries SET access_count = 100 WHERE id = ?`).run(a.id)
    memory.db.prepare(`UPDATE entries SET access_count = 1 WHERE id = ?`).run(b.id)
    memory.db.prepare(`UPDATE entries SET access_count = 0 WHERE id = ?`).run(c.id)

    const snap = runJanitor(memory.db)
    assert.ok(snap)

    const counts = {
      a: memory.db.prepare(`SELECT access_count FROM entries WHERE id = ?`).get(a.id).access_count,
      b: memory.db.prepare(`SELECT access_count FROM entries WHERE id = ?`).get(b.id).access_count,
      c: memory.db.prepare(`SELECT access_count FROM entries WHERE id = ?`).get(c.id).access_count,
    }
    assert.equal(counts.a, 98) // floor(100 * 0.98)
    assert.equal(counts.b, 0) // floor(1 * 0.98) = 0
    assert.equal(counts.c, 0)
    assert.ok(counts.a >= 0 && counts.b >= 0 && counts.c >= 0)
  })

  it('sweeps orphan mentions and edges', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Live',
      body: 'mentions HttpServer maybe',
    })
    // Orphan mention pointing at missing entry
    memory.db.prepare(`INSERT INTO entities (id, name, kind) VALUES ('ent-x', 'Ghost', 'concept')`).run()
    memory.db.prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES ('missing-entry', 'ent-x')`).run()
    // Orphan edge pointing at missing entity
    memory.db
      .prepare(
        `INSERT INTO edges (src, dst, relation, entry_id, created_at)
         VALUES ('ent-x', 'missing-ent', 'rel', ?, '2026-01-01')`,
      )
      .run(id)
    // Orphan entity with no mentions (not required to delete by task, but edge/mention orphans go)

    runJanitor(memory.db)

    const orphanMentions = memory.db
      .prepare(`SELECT COUNT(*) AS n FROM mentions WHERE entry_id = 'missing-entry'`)
      .get().n
    assert.equal(orphanMentions, 0)

    const orphanEdges = memory.db
      .prepare(`SELECT COUNT(*) AS n FROM edges WHERE dst = 'missing-ent' OR src = 'missing-ent'`)
      .get().n
    assert.equal(orphanEdges, 0)

    // Valid data preserved
    const live = memory.db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE id = ?`).get(id).n
    assert.equal(live, 1)
  })

  it('orphan sweep still works when a NULL id row exists (NOT EXISTS, not NOT IN)', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Keep',
      body: 'live entry body',
    })
    memory.db.prepare(`INSERT INTO entities (id, name, kind) VALUES ('ent-ok', 'OkEnt', 'concept')`).run()
    memory.db.prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES (?, 'ent-ok')`).run(id)

    // NULL id in entries would make `x NOT IN (SELECT id FROM entries)` no-op;
    // insert via a temporary relaxation if needed. SQLite TEXT PRIMARY KEY allows NULL.
    memory.db.exec(`INSERT INTO entries (id, type, title, body, created_at, updated_at)
      VALUES (NULL, 'knowledge', 'null-id', 'n', '2026-01-01', '2026-01-01')`)

    // Orphan mention: missing entry_id (must still be swept)
    memory.db
      .prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES ('orphan-entry', 'ent-ok')`)
      .run()
    // Orphan edge with missing dst
    memory.db
      .prepare(
        `INSERT INTO edges (src, dst, relation, entry_id, created_at)
         VALUES ('ent-ok', 'ghost-dst', 'rel', ?, '2026-01-01')`,
      )
      .run(id)

    runJanitor(memory.db)

    assert.equal(
      memory.db.prepare(`SELECT COUNT(*) AS n FROM mentions WHERE entry_id = 'orphan-entry'`).get().n,
      0,
      'orphan mention must be deleted even with a NULL entry id present',
    )
    assert.equal(
      memory.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE dst = 'ghost-dst'`).get().n,
      0,
      'orphan edge must be deleted even with a NULL entry id present',
    )
    // Live mention preserved
    assert.equal(
      memory.db.prepare(`SELECT COUNT(*) AS n FROM mentions WHERE entry_id = ?`).get(id).n,
      1,
    )
  })

  it('writes health snapshot into janitor_state', () => {
    memory.store({ type: 'knowledge', title: 'One', body: 'HttpServer and [[Concept]]' })
    const snap = runJanitor(memory.db)
    assert.equal(typeof snap.liveEntries, 'number')
    assert.equal(typeof snap.entityCount, 'number')
    assert.equal(typeof snap.edgeCount, 'number')
    assert.ok(snap.lastRun)

    const row = memory.db.prepare(`SELECT value FROM janitor_state WHERE key = 'snapshot'`).get()
    assert.ok(row)
    const stored = JSON.parse(row.value)
    assert.equal(stored.liveEntries, snap.liveEntries)
    assert.equal(stored.entityCount, snap.entityCount)
    assert.equal(stored.edgeCount, snap.edgeCount)
    assert.ok(stored.lastRun)
  })
})
