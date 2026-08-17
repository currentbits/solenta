import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, createSchema, normalizeEntities, backfillCoOccurrenceEdges, EDGES_BACKFILL_KEY } from '../src/db.js'
import { Memory } from '../src/memory.js'
import { runJanitor } from '../src/janitor.js'

describe('normalizeEntities', () => {
  let dir
  let db

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-norm-'))
    db = openDb(path.join(dir, 'memory.db'))
    createSchema(db)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('merges case-duplicate entities into the earliest row and repoints mentions/edges', () => {
    db.prepare(
      `INSERT INTO entries (id, type, title, body, created_at, updated_at)
       VALUES ('e1', 'knowledge', 't', 'b', '2026-01-01', '2026-01-01'),
              ('e2', 'knowledge', 't2', 'b2', '2026-01-01', '2026-01-01')`,
    ).run()

    db.prepare(
      `INSERT INTO entities (id, name, kind) VALUES
        ('ent-early', 'HttpServer', 'module'),
        ('ent-late', 'httpserver', 'module'),
        ('ent-other', 'OtherThing', 'module')`,
    ).run()

    db.prepare(
      `INSERT INTO mentions (entry_id, entity_id) VALUES
        ('e1', 'ent-early'),
        ('e2', 'ent-late')`,
    ).run()

    db.prepare(
      `INSERT INTO edges (src, dst, relation, entry_id, created_at) VALUES
        ('ent-late', 'ent-other', 'uses', 'e2', '2026-01-01'),
        ('ent-other', 'ent-late', 'used_by', 'e2', '2026-01-01')`,
    ).run()

    normalizeEntities(db)

    const entities = db.prepare(`SELECT id, name, kind FROM entities WHERE kind = 'module' ORDER BY name COLLATE NOCASE`).all()
    const httpRows = entities.filter((e) => e.name.toLowerCase() === 'httpserver')
    assert.equal(httpRows.length, 1)
    assert.equal(httpRows[0].id, 'ent-early')
    assert.equal(httpRows[0].name, 'HttpServer')

    const mentions = db.prepare(`SELECT entry_id, entity_id FROM mentions ORDER BY entry_id`).all()
    assert.equal(mentions.length, 2)
    assert.equal(mentions[0].entry_id, 'e1')
    assert.equal(mentions[0].entity_id, 'ent-early')
    assert.equal(mentions[1].entry_id, 'e2')
    assert.equal(mentions[1].entity_id, 'ent-early')

    const edges = db.prepare(`SELECT src, dst, relation, entry_id FROM edges ORDER BY relation`).all()
    for (const edge of edges) {
      assert.notEqual(edge.src, 'ent-late')
      assert.notEqual(edge.dst, 'ent-late')
    }
    assert.ok(edges.some((e) => e.src === 'ent-early' && e.dst === 'ent-other'))
    assert.ok(edges.some((e) => e.src === 'ent-other' && e.dst === 'ent-early'))
  })

  it('keeper is earliest rowid via explicit ORDER BY, not GROUP_CONCAT order', () => {
    // Insert late first, early second: if keeper used GROUP_CONCAT index 0, it
    // might pick wrong; explicit ORDER BY rowid LIMIT 1 always keeps earliest.
    db.prepare(
      `INSERT INTO entities (id, name, kind) VALUES
        ('ent-z', 'FooBar', 'module'),
        ('ent-a', 'foobar', 'module')`,
    ).run()
    // Force ent-a to have the lower rowid by deleting and re-inserting ent-z last
    // (rowids assigned in insert order above: ent-z first, so ent-z is earliest).
    normalizeEntities(db)
    const kept = db
      .prepare(`SELECT id, name FROM entities WHERE lower(name) = 'foobar'`)
      .all()
    assert.equal(kept.length, 1)
    assert.equal(kept[0].id, 'ent-z', 'earliest-inserted rowid must be the keeper')
  })
})

describe('createSchema survives normalizeEntities failure', () => {
  let dir

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('Memory constructor boots when normalizeEntities throws (corrupt graph)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-corrupt-'))
    const dbPath = path.join(dir, 'memory.db')

    {
      const seed = openDb(dbPath)
      createSchema(seed)
      seed.close()
    }

    {
      const raw = openDb(dbPath)
      raw.exec(`DROP TABLE entities`)
      // Case dups + BEFORE DELETE abort: normalizeEntities keeps earliest and
      // DELETEs the rest; the abort makes normalizeEntities throw.
      raw.exec(`
        CREATE TABLE entities (
          id   TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL
        );
        INSERT INTO entities (id, name, kind) VALUES
          ('e1', 'Alpha', 'module'),
          ('e2', 'alpha', 'module');
        CREATE TRIGGER entities_abort_delete BEFORE DELETE ON entities
        BEGIN
          SELECT RAISE(ABORT, 'corrupt graph fixture');
        END;
      `)
      raw.prepare(
        `INSERT INTO entries (id, type, title, body, created_at, updated_at)
         VALUES ('ent1', 'knowledge', 't', 'b', '2026-01-01', '2026-01-01')`,
      ).run()
      raw.prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES ('ent1', 'e2')`).run()
      raw.close()
    }

    // Must not throw — normalizeEntities is non-fatal in createSchema
    const memory = new Memory(dbPath, { startJanitor: false })
    assert.ok(memory)
    assert.equal(typeof memory.entryCount(), 'number')
    memory.close()
  })
})

describe('graph retrieval and RRF', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-graph-'))
    memory = new Memory(path.join(dir, 'memory.db'))
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('store/supersede write entity mentions from extracted text', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'About HttpServer',
      body: 'The [[Cache Layer]] backs HttpServer via cache.js',
    })
    const mentions = memory.db
      .prepare(
        `SELECT e.name, e.kind FROM mentions m JOIN entities e ON e.id = m.entity_id WHERE m.entry_id = ? ORDER BY e.kind, e.name`,
      )
      .all(id)
    assert.ok(mentions.some((m) => m.kind === 'concept' && m.name === 'Cache Layer'))
    assert.ok(mentions.some((m) => m.kind === 'module' && m.name === 'HttpServer'))
    assert.ok(mentions.some((m) => m.kind === 'file' && (m.name === 'cache.js' || m.name.endsWith('cache.js'))))

    const { id: newId } = memory.supersede(id, {
      title: 'About HttpServer v2',
      body: 'Now uses [[New Concept]] and GraphRetriever',
    })
    const newMentions = memory.db
      .prepare(
        `SELECT e.name, e.kind FROM mentions m JOIN entities e ON e.id = m.entity_id WHERE m.entry_id = ?`,
      )
      .all(newId)
    assert.ok(newMentions.some((m) => m.name === 'New Concept'))
    assert.ok(newMentions.some((m) => m.name === 'GraphRetriever'))
  })

  it('graph-only recall: entry findable via shared entity when FTS misses', async () => {
    // Entry body has no token "OrphanEntityName" for FTS, but we attach that entity via mention.
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Hidden link target',
      body: 'totally unrelated wording about pipelines only',
    })
    const entId = 'ent-orphan-1'
    memory.db.prepare(`INSERT INTO entities (id, name, kind) VALUES (?, 'OrphanEntityName', 'concept')`).run(entId)
    memory.db.prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES (?, ?)`).run(id, entId)

    const hits = await memory.search({ query: 'OrphanEntityName' })
    assert.ok(hits.some((h) => h.id === id), `expected graph hit for ${id}, got ${JSON.stringify(hits)}`)
  })

  it('RRF fusion ORDER: an entry ranked by both retrievers beats a higher-importance single-retriever entry', async () => {
    // BOTH retrievers find this one: FTS (query token in body) AND graph
    // (mentions the queried entity). Plain importance 3.
    const both = memory.store({
      type: 'knowledge',
      title: 'Fusion middle child',
      body: 'quagga uniquefusiontoken appears here and mentions QuaggaFusionEntity work',
      importance: 3,
    })
    // Graph-only, but importance 5: under composite-first ordering this would
    // win outright; under RRF-first it must lose to the dual-retriever entry.
    const graphOnly = memory.store({
      type: 'convention',
      title: 'Important but single-source',
      body: 'no matching tokens in this body at all',
      importance: 5,
    })
    const entId = 'ent-rrf-order-1'
    memory.db.prepare(`INSERT INTO entities (id, name, kind) VALUES (?, 'QuaggaFusionEntity', 'concept')`).run(entId)
    memory.db.prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES (?, ?)`).run(both.id, entId)
    memory.db.prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES (?, ?)`).run(graphOnly.id, entId)

    const hits = await memory.search({ query: 'QuaggaFusionEntity uniquefusiontoken', limit: 10 })
    const ids = hits.map((h) => h.id)
    assert.ok(ids.includes(both.id), `dual-retriever candidate missing: ${JSON.stringify(ids)}`)
    assert.ok(ids.includes(graphOnly.id), `graph candidate missing: ${JSON.stringify(ids)}`)
    assert.ok(
      ids.indexOf(both.id) < ids.indexOf(graphOnly.id),
      `RRF must rank the dual-retriever entry first; got ${JSON.stringify(ids)}`,
    )
  })

  it('RRF three-retriever ORDER: vector+fts dual beats single-retriever (extends graph order pin)', async () => {
    const { fakeEmbedder } = await import('../src/embedder.js')
    memory.close()
    memory = new Memory(path.join(dir, 'memory.db'), {
      startJanitor: false,
      embedder: fakeEmbedder(32),
    })

    const dual = memory.store({
      type: 'knowledge',
      title: 'Vector fusion dual',
      body: 'quantum flux capacitor writeup details',
      importance: 3,
      force: true,
    })
    const single = memory.store({
      type: 'convention',
      title: 'High importance single',
      body: 'quantum flux notes only',
      importance: 5,
      force: true,
    })
    await memory.embedMissing(64)

    const hits = await memory.search({ query: 'quantum flux capacitor', limit: 10 })
    const ids = hits.map((h) => h.id)
    assert.ok(ids.includes(dual.id), `dual missing: ${JSON.stringify(ids)}`)
    if (ids.includes(single.id)) {
      assert.ok(
        ids.indexOf(dual.id) < ids.indexOf(single.id),
        `vector+fts dual must beat single-retriever; got ${JSON.stringify(ids)}`,
      )
    } else {
      assert.equal(ids[0], dual.id)
    }
  })

  it('graph failure never breaks search (returns FTS results)', async () => {
    memory.store({
      type: 'knowledge',
      title: 'Still searchable',
      body: 'findmewithfts token works',
    })
    // Break graph tables mid-flight by dropping edges (graph search should catch and return [])
    memory.db.exec(`DROP TABLE edges`)
    const hits = await memory.search({ query: 'findmewithfts' })
    assert.ok(hits.length >= 1)
    assert.ok(hits[0].title.includes('Still searchable') || hits[0].excerpt)
  })

  it('batched entity name lookup returns same hits as multi-token query', () => {
    const a = memory.store({
      type: 'knowledge',
      title: 'Alpha path',
      body: 'mentions BatchedEntityAlpha only',
    })
    const b = memory.store({
      type: 'knowledge',
      title: 'Beta path',
      body: 'mentions BatchedEntityBeta only',
    })
    memory.db
      .prepare(`INSERT INTO entities (id, name, kind) VALUES ('be-a', 'BatchedEntityAlpha', 'concept')`)
      .run()
    memory.db
      .prepare(`INSERT INTO entities (id, name, kind) VALUES ('be-b', 'BatchedEntityBeta', 'concept')`)
      .run()
    memory.db.prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES (?, 'be-a')`).run(a.id)
    memory.db.prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES (?, 'be-b')`).run(b.id)

    // Multi-token query exercises the batched IN path for both names at once.
    const hits = memory.graphSearch('BatchedEntityAlpha BatchedEntityBeta')
    const ids = hits.map((h) => h.id)
    assert.ok(ids.includes(a.id), `expected alpha hit: ${JSON.stringify(ids)}`)
    assert.ok(ids.includes(b.id), `expected beta hit: ${JSON.stringify(ids)}`)

    // Case-insensitive still works with lower() IN batch
    const caseHits = memory.graphSearch('batchedentityalpha')
    assert.ok(caseHits.some((h) => h.id === a.id))
  })

  it('store writes unordered co_occurs edges (src < dst, no mirrors)', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Pair writer',
      // Spaced wikilinks so extractEntities does not also emit PascalCase modules.
      body: '[[pair alpha]] sits beside [[pair bravo]] and [[pair charlie]]',
    })
    const mentioned = memory.db
      .prepare(`SELECT entity_id FROM mentions WHERE entry_id = ? ORDER BY entity_id`)
      .all(id)
      .map((r) => r.entity_id)
    assert.equal(mentioned.length, 3)

    const edges = memory.db
      .prepare(`SELECT src, dst, relation, entry_id FROM edges WHERE entry_id = ?`)
      .all(id)
    assert.equal(edges.length, 3)
    for (const edge of edges) {
      assert.equal(edge.relation, 'co_occurs')
      assert.equal(edge.entry_id, id)
      assert.ok(edge.src < edge.dst, `src must be < dst: ${edge.src} / ${edge.dst}`)
    }
    const keys = new Set(edges.map((e) => `${e.src}\0${e.dst}`))
    assert.equal(keys.size, 3)
    assert.ok(keys.has(`${mentioned[0]}\0${mentioned[1]}`))
    assert.ok(keys.has(`${mentioned[0]}\0${mentioned[2]}`))
    assert.ok(keys.has(`${mentioned[1]}\0${mentioned[2]}`))
    const mirrors = memory.db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges a
         JOIN edges b ON a.src = b.dst AND a.dst = b.src AND a.entry_id = b.entry_id
                      AND a.relation = b.relation
         WHERE a.entry_id = ?`,
      )
      .get(id).n
    assert.equal(mirrors, 0)
  })

  it('graphSearch reaches an entry two hops away via co_occurs', () => {
    const a = memory.store({
      type: 'knowledge',
      title: 'Hop seed note',
      body: '[[HopSeedX]] shares a page with [[HopBridgeY]]',
      force: true,
    })
    const b = memory.store({
      type: 'knowledge',
      title: 'Hop leaf note',
      body: '[[HopBridgeY]] continues on to [[HopLeafZ]]',
      force: true,
    })

    const hits = memory.graphSearch('HopSeedX')
    const seed = hits.find((h) => h.id === a.id)
    const leaf = hits.find((h) => h.id === b.id)
    assert.ok(seed, `seed entry missing: ${JSON.stringify(hits)}`)
    assert.equal(seed.hop, 0)
    // B mentions Y (hop 1) and Z (hop 2); ranking uses min hop.
    assert.ok(leaf, `2-hop entry missing: ${JSON.stringify(hits.map((h) => ({ id: h.id, hop: h.hop })))}`)
    assert.equal(leaf.hop, 1)
  })

  it('deleteEntry removes the entry co_occurs edges', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Soon gone',
      body: '[[DeleteAlpha]] with [[DeleteBravo]]',
    })
    assert.ok(
      memory.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE entry_id = ?`).get(id).n > 0,
    )
    assert.equal(memory.deleteEntry(id), true)
    assert.equal(
      memory.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE entry_id = ?`).get(id).n,
      0,
    )
  })

  it('janitor keeps live co_occurs edges and still sweeps orphans', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Live pair',
      body: '[[JanitorAlpha]] with [[JanitorBravo]]',
    })
    const liveBefore = memory.db
      .prepare(`SELECT COUNT(*) AS n FROM edges WHERE entry_id = ?`)
      .get(id).n
    assert.ok(liveBefore > 0)
    memory.db
      .prepare(
        `INSERT INTO edges (src, dst, relation, entry_id, created_at)
         VALUES ('ghost-src', 'ghost-dst', 'co_occurs', ?, '2026-01-01')`,
      )
      .run(id)

    runJanitor(memory.db)

    assert.equal(
      memory.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE entry_id = ?`).get(id).n,
      liveBefore,
    )
    assert.equal(
      memory.db
        .prepare(`SELECT COUNT(*) AS n FROM edges WHERE src = 'ghost-src' OR dst = 'ghost-dst'`)
        .get().n,
      0,
    )
  })
})

describe('edges backfill', () => {
  let dir
  let db

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-edge-bf-'))
    db = openDb(path.join(dir, 'memory.db'))
    createSchema(db)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('populates co_occurs from pre-existing mentions and does not double-run', () => {
    db.prepare(
      `INSERT INTO entries (id, type, title, body, created_at, updated_at)
       VALUES ('e1', 'knowledge', 't', 'b', '2026-01-01', '2026-01-01'),
              ('e2', 'knowledge', 't2', 'b2', '2026-01-01', '2026-01-01')`,
    ).run()
    db.prepare(
      `INSERT INTO entities (id, name, kind) VALUES
        ('ent-a', 'BackfillAlpha', 'concept'),
        ('ent-b', 'BackfillBravo', 'concept'),
        ('ent-c', 'BackfillCharlie', 'concept')`,
    ).run()
    db.prepare(
      `INSERT INTO mentions (entry_id, entity_id) VALUES
        ('e1', 'ent-a'),
        ('e1', 'ent-b'),
        ('e2', 'ent-b'),
        ('e2', 'ent-c')`,
    ).run()

    // createSchema already ran the one-shot on an empty mentions table.
    db.prepare(`DELETE FROM janitor_state WHERE key = ?`).run(EDGES_BACKFILL_KEY)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM edges`).get().n, 0)

    const first = backfillCoOccurrenceEdges(db)
    assert.equal(first, 2)
    const edges = db
      .prepare(`SELECT src, dst, relation, entry_id FROM edges ORDER BY entry_id, src`)
      .all()
      .map((e) => ({ src: e.src, dst: e.dst, relation: e.relation, entry_id: e.entry_id }))
    assert.deepEqual(edges, [
      { src: 'ent-a', dst: 'ent-b', relation: 'co_occurs', entry_id: 'e1' },
      { src: 'ent-b', dst: 'ent-c', relation: 'co_occurs', entry_id: 'e2' },
    ])

    const second = backfillCoOccurrenceEdges(db)
    assert.equal(second, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM edges`).get().n, 2)

    db.prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES ('e1', 'ent-c')`).run()
    assert.equal(backfillCoOccurrenceEdges(db), 0, 'guard must ignore later mentions')
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM edges`).get().n, 2)

    const guard = db.prepare(`SELECT value FROM janitor_state WHERE key = ?`).get(EDGES_BACKFILL_KEY)
    assert.ok(guard?.value)
  })

  it('createSchema invokes the one-shot backfill', () => {
    db.prepare(
      `INSERT INTO entries (id, type, title, body, created_at, updated_at)
       VALUES ('e1', 'knowledge', 't', 'b', '2026-01-01', '2026-01-01')`,
    ).run()
    db.prepare(
      `INSERT INTO entities (id, name, kind) VALUES
        ('ent-a', 'SchemaAlpha', 'concept'),
        ('ent-z', 'SchemaZulu', 'concept')`,
    ).run()
    db.prepare(
      `INSERT INTO mentions (entry_id, entity_id) VALUES
        ('e1', 'ent-a'),
        ('e1', 'ent-z')`,
    ).run()
    db.prepare(`DELETE FROM janitor_state WHERE key = ?`).run(EDGES_BACKFILL_KEY)

    createSchema(db)

    const edges = db.prepare(`SELECT src, dst, relation, entry_id FROM edges`).all()
    assert.equal(edges.length, 1)
    assert.equal(edges[0].src, 'ent-a')
    assert.equal(edges[0].dst, 'ent-z')
    assert.equal(edges[0].relation, 'co_occurs')
    assert.ok(db.prepare(`SELECT value FROM janitor_state WHERE key = ?`).get(EDGES_BACKFILL_KEY))

    createSchema(db)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM edges`).get().n, 1)
  })
})
