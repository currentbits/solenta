import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'
import { fakeEmbedder, blobToFloat } from '../src/embedder.js'
import { purgeStaleVectors } from '../src/db.js'

describe('vectors: embed + backfill + stale purge', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-vec-'))
    memory = new Memory(path.join(dir, 'memory.db'), {
      startJanitor: false,
      embedder: fakeEmbedder(8),
    })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function vecRow(id) {
    return memory.db
      .prepare(`SELECT entry_id, dim, vec, model FROM entry_vectors WHERE entry_id = ?`)
      .get(id)
  }

  it('embedEntry writes a unit vector that round-trips through the blob codec', async () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Auth uses JWT sessions',
      body: 'tokens signed hs256',
    })
    // store fires embed async; ensure it lands
    await memory.embedEntry(id)
    const row = vecRow(id)
    assert.ok(row)
    assert.equal(row.dim, 8)
    assert.equal(row.model, 'fake')
    const vec = blobToFloat(row.vec)
    assert.equal(vec.length, 8)
    const norm = Math.sqrt([...vec].reduce((s, x) => s + x * x, 0))
    assert.ok(Math.abs(norm - 1) < 1e-5)
  })

  it('embedMissing respects the backfill cap and is idempotent', async () => {
    const ids = []
    for (let i = 0; i < 5; i++) {
      const { id } = memory.store({
        type: 'knowledge',
        title: `Unique knowledge item ${i} alphabet${i}`,
        body: `distinct body content number ${i} zebra${i}`,
        force: true,
      })
      ids.push(id)
    }
    // Drain fire-and-forget embeds from store, then wipe so we control backfill.
    await memory.embedMissing(64)
    memory.db.prepare(`DELETE FROM entry_vectors`).run()
    assert.equal(memory.db.prepare(`SELECT COUNT(*) AS n FROM entry_vectors`).get().n, 0)

    const first = await memory.embedMissing(2)
    assert.equal(first, 2)
    assert.equal(memory.db.prepare(`SELECT COUNT(*) AS n FROM entry_vectors`).get().n, 2)

    const second = await memory.embedMissing(64)
    assert.equal(second, 3)
    assert.equal(memory.db.prepare(`SELECT COUNT(*) AS n FROM entry_vectors`).get().n, 5)
    assert.equal(await memory.embedMissing(64), 0)
  })

  it('stale-model vectors are purged on boot so backfill can re-embed', async () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Stale model target',
      body: 'will be re-embedded after purge',
    })
    await memory.embedEntry(id)
    memory.db.prepare(`UPDATE entry_vectors SET model = 'old-model' WHERE entry_id = ?`).run(id)
    assert.equal(vecRow(id).model, 'old-model')

    // Simulate boot purge for a new Memory with the same db path
    memory.close()
    memory = new Memory(path.join(dir, 'memory.db'), {
      startJanitor: false,
      embedder: fakeEmbedder(8),
    })
    assert.equal(vecRow(id), undefined, 'stale model row must be deleted on boot')
    const n = await memory.embedMissing(64)
    assert.equal(n, 1)
    assert.equal(vecRow(id).model, 'fake')
  })

})

describe('vectors: semantic-disabled path', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-nosem-'))
    memory = new Memory(path.join(dir, 'memory.db'), {
      startJanitor: false,
      embedder: null,
    })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('with no embedder, vectorSearch returns [] and search still works via FTS', async () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'FTS only path',
      body: 'findmewithftsunique token here',
    })
    const vecHits = await memory.vectorSearch('findmewithftsunique', null)
    assert.deepEqual(vecHits, [])
    const hits = await memory.search({ query: 'findmewithftsunique' })
    assert.ok(hits.some((h) => h.id === id))
    const health = memory.vectorsHealth()
    assert.equal(health.enabled, false)
    assert.equal(health.model, null)
  })

  it('CODER_MEMORY_SEMANTIC=0 is honored by semanticEnabled()', async () => {
    const { semanticEnabled } = await import('../src/embedder.js')
    assert.equal(semanticEnabled({ CODER_MEMORY_SEMANTIC: '0' }), false)
    assert.equal(semanticEnabled({ CODER_MEMORY_SEMANTIC: '1' }), true)
    assert.equal(semanticEnabled({}), true)
  })
})

describe('vectors: RRF three-retriever fusion', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-rrf3-'))
    memory = new Memory(path.join(dir, 'memory.db'), {
      startJanitor: false,
      embedder: fakeEmbedder(32),
    })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('entry found by vector+fts beats single-retriever entries', async () => {
    // Dual: FTS match (all query tokens) + will have a strong vector for the same tokens.
    const dual = memory.store({
      type: 'knowledge',
      title: 'Dual hit writeup',
      body: 'quantum flux capacitor writeup details here',
      importance: 3,
      force: true,
    })
    // FTS-only weak-ish / different: has only one shared token via a different phrase;
    // use graph-only style single source: high importance but no query tokens in body.
    // For vector+fts dual, use a second entry that matches FTS only with lower multi-retriever score.
    // Single-retriever (vector-ish): shares some tokens but missing one so FTS AND fails.
    const vectorOnly = memory.store({
      type: 'knowledge',
      title: 'Field notes',
      body: 'quantum flux notes only without the third term',
      importance: 5,
      force: true,
    })
    // Ensure vectors exist for both
    await memory.embedMissing(64)

    // FTS requires quantum AND flux AND capacitor → only dual matches FTS.
    // Vector path finds both (shared quantum/flux tokens). Dual has FTS+vector RRF.
    const hits = await memory.search({ query: 'quantum flux capacitor', limit: 10 })
    const ids = hits.map((h) => h.id)
    assert.ok(ids.includes(dual.id), `dual missing: ${JSON.stringify(ids)}`)
    // vectorOnly may or may not appear depending on FTS; if it does, dual must rank higher
    if (ids.includes(vectorOnly.id)) {
      assert.ok(
        ids.indexOf(dual.id) < ids.indexOf(vectorOnly.id),
        `dual must beat vector-only; got ${JSON.stringify(ids)}`,
      )
    } else {
      assert.equal(ids[0], dual.id)
    }
  })

  it('vector failure never breaks search', async () => {
    const broken = {
      model: 'broken',
      dim: 8,
      embed() {
        throw new Error('embed boom')
      },
    }
    memory.close()
    memory = new Memory(path.join(dir, 'memory.db'), {
      startJanitor: false,
      embedder: broken,
    })
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Still searchable',
      body: 'findmewithfts token works',
      force: true,
    })
    const hits = await memory.search({ query: 'findmewithfts' })
    assert.ok(hits.some((h) => h.id === id))
  })
})

describe('purgeStaleVectors unit', () => {
  it('deletes rows with a different model id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-purge-'))
    const mem = new Memory(path.join(dir, 'memory.db'), { startJanitor: false, embedder: null })
    const { id } = mem.store({ type: 'knowledge', title: 'T', body: 'b unique purgebodyxyz' })
    mem.db
      .prepare(
        `INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at) VALUES (?, 4, ?, 'old', ?)`,
      )
      .run(id, Buffer.alloc(16), new Date().toISOString())
    const n = purgeStaleVectors(mem.db, 'fake')
    assert.equal(n, 1)
    assert.equal(
      mem.db.prepare(`SELECT COUNT(*) AS n FROM entry_vectors`).get().n,
      0,
    )
    mem.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
