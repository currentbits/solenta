import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory, contentTokens, jaccard, queueReview } from '../src/memory.js'
import { runJanitor, scanContradictions } from '../src/janitor.js'
import { l2normalize } from '../src/embedder.js'

describe('token helpers', () => {
  it('normalizes to lowercase words of 3+ chars', () => {
    assert.deepEqual(
      contentTokens('The DB is in WAL-mode, always!'),
      new Set(['the', 'wal', 'mode', 'always']),
    )
  })

  it('jaccard is 1 for identical sets and 0 for disjoint or empty', () => {
    const a = new Set(['one', 'two'])
    assert.equal(jaccard(a, new Set(['one', 'two'])), 1)
    assert.equal(jaccard(a, new Set(['three'])), 0)
    assert.equal(jaccard(new Set(), a), 0)
  })
})

describe('two-tier write-time dedup', () => {
  let dir
  let memory

  const original = {
    type: 'knowledge',
    title: 'Swift tests need DEVELOPER_DIR set to Xcode',
    body: 'Running swift test requires DEVELOPER_DIR=/Applications/Xcode.app or Testing module fails',
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-dedup-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function openRows() {
    return memory.db
      .prepare(
        `SELECT id, kind, entry_a, entry_b, detail FROM review_queue WHERE resolved_at IS NULL ORDER BY id`,
      )
      .all()
  }

  it('blocks a near-duplicate (>=0.7) with a descriptive Error listing id/title', () => {
    const first = memory.store(original)
    assert.ok(first.id)
    let err
    try {
      memory.store({
        type: 'knowledge',
        title: 'Swift tests need DEVELOPER_DIR set to Xcode app',
        body: 'swift test requires DEVELOPER_DIR=/Applications/Xcode.app or the Testing module fails',
      })
    } catch (e) {
      err = e
    }
    assert.ok(err, 'expected throw')
    assert.match(String(err.message), new RegExp(first.id))
    assert.match(String(err.message), /Swift tests need DEVELOPER_DIR/)
    assert.match(String(err.message), /force:\s*true/i)
    assert.equal(memory.entryCount(), 1)
  })

  it('force: true bypasses the block and enqueues near_dup', () => {
    const first = memory.store(original)
    const forced = memory.store({
      type: 'knowledge',
      title: 'Swift tests need DEVELOPER_DIR set to Xcode app',
      body: 'swift test requires DEVELOPER_DIR=/Applications/Xcode.app or the Testing module fails',
      force: true,
    })
    assert.ok(forced.id)
    assert.equal(memory.entryCount(), 2)
    const rows = openRows()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'near_dup')
    assert.ok(new Set([rows[0].entry_a, rows[0].entry_b]).has(first.id))
    assert.ok(new Set([rows[0].entry_a, rows[0].entry_b]).has(forced.id))
  })

  it('warn band (>=0.4, <0.7) stores and enqueues near_dup', () => {
    memory.store(original)
    const related = memory.store({
      type: 'knowledge',
      title: 'Swift tests need Xcode developer setup',
      body: 'running swift test requires the Testing module and Xcode developer path configured',
    })
    assert.ok(related.id)
    assert.equal(memory.entryCount(), 2)
    const rows = openRows()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'near_dup')
    assert.match(rows[0].detail ?? '', /jaccard=/)
  })

  it('partial unique index prevents re-enqueue of the same open pair', () => {
    const a = memory.store(original)
    const b = memory.store({
      type: 'knowledge',
      title: 'Swift tests need Xcode developer setup',
      body: 'running swift test requires the Testing module and Xcode developer path configured',
    })
    assert.equal(openRows().length, 1)
    // Manual re-enqueue of the same open pair must be a no-op
    const inserted = queueReview(memory.db, 'near_dup', a.id, b.id, 'jaccard=0.5')
    assert.equal(inserted, false)
    assert.equal(openRows().length, 1)

    // After resolve, a new open row is allowed
    const openId = openRows()[0].id
    memory.db
      .prepare(`UPDATE review_queue SET resolved_at = ?, resolution = 'noop' WHERE id = ?`)
      .run(new Date().toISOString(), openId)
    assert.equal(queueReview(memory.db, 'near_dup', a.id, b.id, 'jaccard=0.5'), true)
    const rows = openRows()
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0].id, openId)
  })

  it('distinct entries store without enqueue', () => {
    memory.store(original)
    memory.store({
      type: 'run',
      title: 'Deployed the website',
      body: 'pushed main to production hosting',
    })
    assert.equal(openRows().length, 0)
    assert.equal(memory.entryCount(), 2)
  })
})

describe('contradiction scan watermark', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-contr-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('flags shared-entity pairs and second run scans nothing new', () => {
    // Two knowledge entries sharing two entities via mentions (distinct wording).
    const a = memory.store({
      type: 'knowledge',
      title: 'Sessions live seven days',
      body: 'the sliding window keeps a login valid for a week via AuthModule and TokenStore',
    })
    const b = memory.store({
      type: 'knowledge',
      title: 'Logins expire hourly',
      body: 'a credential is only good for sixty minutes before refresh with AuthModule and TokenStore',
    })
    // Force entity mentions (extract may not always hit AuthModule depending on PascalCase rules —
    // AuthModule is two-hump Pascal so it should extract).
    const ents = memory.db
      .prepare(
        `SELECT e.name FROM mentions m JOIN entities e ON e.id = m.entity_id WHERE m.entry_id = ?`,
      )
      .all(a.id)
    // If extraction missed, insert manually
    for (const name of ['AuthModule', 'TokenStore']) {
      let row = memory.db
        .prepare(`SELECT id FROM entities WHERE name = ? AND kind = 'module'`)
        .get(name)
      if (!row) {
        row = memory.db
          .prepare(`SELECT id FROM entities WHERE name = ?`)
          .get(name)
      }
      if (!row) {
        const id = `ent-${name}`
        memory.db
          .prepare(`INSERT INTO entities (id, name, kind) VALUES (?, ?, 'module')`)
          .run(id, name)
        row = { id }
      }
      memory.db
        .prepare(`INSERT OR IGNORE INTO mentions (entry_id, entity_id) VALUES (?, ?)`)
        .run(a.id, row.id)
      memory.db
        .prepare(`INSERT OR IGNORE INTO mentions (entry_id, entity_id) VALUES (?, ?)`)
        .run(b.id, row.id)
    }

    const first = scanContradictions(memory.db)
    assert.ok(first >= 1, `expected at least one contradiction, got ${first}`)
    const open = memory.db
      .prepare(`SELECT COUNT(*) AS n FROM review_queue WHERE kind = 'contradiction' AND resolved_at IS NULL`)
      .get().n
    assert.ok(open >= 1)

    // Second run: watermark advanced, no new candidates
    const second = scanContradictions(memory.db)
    assert.equal(second, 0, 'second scan must enqueue nothing new')

    // Full janitor also runs the scan safely
    const snap = runJanitor(memory.db)
    assert.ok(snap)
    assert.equal(typeof snap.queuedContradictions, 'number')
  })
})

describe('semantic near-dup on write', () => {
  let dir
  let memory

  const nearA = l2normalize(new Float32Array([1, 0, 0, 0]))
  const nearB = l2normalize(new Float32Array([0.95, Math.sqrt(1 - 0.95 ** 2), 0, 0]))
  const far = l2normalize(new Float32Array([0, 1, 0, 0]))

  function stubEmbedder() {
    return {
      model: 'stub',
      dim: 4,
      embed(text) {
        const s = String(text).toLowerCase()
        if (s.includes('indigo')) return nearA
        if (s.includes('maroon')) return nearB
        return far
      },
    }
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-semdedup-'))
    memory = new Memory(path.join(dir, 'memory.db'), {
      startJanitor: false,
      embedder: stubEmbedder(),
    })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function openRows() {
    return memory.db
      .prepare(
        `SELECT id, kind, entry_a, entry_b, detail FROM review_queue WHERE resolved_at IS NULL ORDER BY id`,
      )
      .all()
  }

  it('paraphrases below Jaccard warn enqueue near_dup with cosine= detail', async () => {
    const aText = { title: 'Alpha widget protocol', body: 'uses indigo tokens exclusively' }
    const bText = { title: 'Zeta gadget scheme', body: 'applies maroon chips instead' }
    const overlap = jaccard(
      contentTokens(`${aText.title} ${aText.body}`),
      contentTokens(`${bText.title} ${bText.body}`),
    )
    assert.ok(overlap < 0.4, `jaccard ${overlap} must be below warn`)

    const a = memory.store({ type: 'knowledge', ...aText, project: 'demo' })
    const b = memory.store({ type: 'knowledge', ...bText, project: 'demo' })
    await memory.embedEntry(a.id)
    await memory.embedEntry(b.id)
    await memory.checkSemanticDup(b.id)

    const rows = openRows()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'near_dup')
    assert.match(rows[0].detail ?? '', /cosine=/)
    const pair = new Set([rows[0].entry_a, rows[0].entry_b])
    assert.ok(pair.has(a.id))
    assert.ok(pair.has(b.id))
  })

  it('dissimilar vectors produce no review row', async () => {
    const a = memory.store({
      type: 'knowledge',
      title: 'Alpha widget protocol',
      body: 'uses indigo tokens exclusively',
      project: 'demo',
    })
    const b = memory.store({
      type: 'knowledge',
      title: 'Deployed the website',
      body: 'pushed main to production hosting',
      project: 'demo',
    })
    await memory.embedEntry(a.id)
    await memory.embedEntry(b.id)
    await memory.checkSemanticDup(b.id)
    assert.equal(openRows().length, 0)
  })

  it('skips type task even when vectors match', async () => {
    const a = memory.store({
      type: 'knowledge',
      title: 'Alpha widget protocol',
      body: 'uses indigo tokens exclusively',
      project: 'demo',
    })
    const b = memory.store({
      type: 'task',
      title: 'Rewrite the maroon chips path',
      body: 'applies maroon chips instead',
      status: 'active',
      project: 'demo',
    })
    await memory.embedEntry(a.id)
    await memory.embedEntry(b.id)
    // The knowledge write's fire-and-forget check may have already matched the
    // task as a candidate; clear so we only assert the incoming-task skip.
    memory.db.prepare(`DELETE FROM review_queue`).run()
    await memory.checkSemanticDup(b.id)
    assert.equal(openRows().length, 0)
  })
})
