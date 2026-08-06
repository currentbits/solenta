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
    const a = memory.store({ type: 'knowledge', title: 'A', body: 'body a' })
    const b = memory.store({ type: 'knowledge', title: 'B', body: 'body b' })
    const c = memory.store({ type: 'knowledge', title: 'C', body: 'body c' })
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
