import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'
import {
  runJanitor,
  scanContradictions,
  autoResolveQueue,
  CONTRA_TOP,
  MAX_PAIRS_PER_ENTRY,
  STALE_QUEUE_DAYS,
  ANCIENT_RUN_DAYS,
  SEMANTIC_DUP_AUTO,
} from '../src/janitor.js'
import { floatToBlob, l2normalize, fakeEmbedder } from '../src/embedder.js'
import { contentTokens, jaccard, queueReview, AUTO_RESOLVE_PREFIX } from '../src/review.js'

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

describe('contradiction scan embeddings', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-jan-vec-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const now = () => new Date().toISOString()

  function insertEntry(id, title, body, project = 'p') {
    const t = now()
    memory.db
      .prepare(
        `INSERT INTO entries (id, type, title, body, project, created_at, updated_at)
         VALUES (?, 'knowledge', ?, ?, ?, ?, ?)`,
      )
      .run(id, title, body, project, t, t)
  }

  function insertEntity(id, name) {
    memory.db.prepare(`INSERT INTO entities (id, name, kind) VALUES (?, ?, 'concept')`).run(id, name)
  }

  function mention(entryId, entityId) {
    memory.db.prepare(`INSERT INTO mentions (entry_id, entity_id) VALUES (?, ?)`).run(entryId, entityId)
  }

  function insertVec(entryId, components, model = 'test-model') {
    const vec = l2normalize(Float32Array.from(components))
    memory.db
      .prepare(
        `INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entryId, vec.length, floatToBlob(vec), model, now())
  }

  /** Unit 2-vector whose cosine with [1, 0] equals `c`. */
  function toward(c) {
    return [c, Math.sqrt(Math.max(0, 1 - c * c))]
  }

  function openContradictions() {
    return memory.db
      .prepare(
        `SELECT id, entry_a, entry_b, detail FROM review_queue
         WHERE kind = 'contradiction' AND resolved_at IS NULL
         ORDER BY id`,
      )
      .all()
  }

  it('enqueues a one-entity paraphrase when vectors are near-identical', () => {
    insertEntry('cand', 'Alpha claim', 'unique zebra phrase only')
    insertEntry('near', 'Beta assertion', 'distinct mango wording here')
    insertEntity('ent-hub', 'HubThing')
    mention('cand', 'ent-hub')
    mention('near', 'ent-hub')
    insertVec('cand', [1, 0, 0, 0])
    insertVec('near', [1, 0, 0, 0])

    const n = scanContradictions(memory.db)
    assert.equal(n, 1)
    const rows = openContradictions()
    assert.equal(rows.length, 1)
    assert.ok(new Set([rows[0].entry_a, rows[0].entry_b]).has('cand'))
    assert.ok(new Set([rows[0].entry_a, rows[0].entry_b]).has('near'))
    assert.match(rows[0].detail ?? '', /shared entities: HubThing/)
    assert.match(rows[0].detail ?? '', /cosine=/)
  })

  it('skips a one-entity pair with dissimilar vectors and low Jaccard', () => {
    insertEntry('cand', 'Alpha claim', 'unique zebra phrase only')
    insertEntry('far', 'Beta assertion', 'distinct mango wording here')
    insertEntity('ent-hub', 'HubThing')
    mention('cand', 'ent-hub')
    mention('far', 'ent-hub')
    insertVec('cand', [1, 0, 0, 0])
    insertVec('far', [0, 1, 0, 0])

    const n = scanContradictions(memory.db)
    assert.equal(n, 0)
    assert.equal(openContradictions().length, 0)
  })

  it('caps a hub candidate at CONTRA_TOP, highest cosine first', () => {
    insertEntry('cand', 'Hub claim', 'unique zebra phrase only')
    insertEntity('ent-hub', 'HubThing')
    mention('cand', 'ent-hub')
    insertVec('cand', [1, 0])

    // Distinct entities so partners do not pair with each other — only with cand.
    // Cosines vs cand: 0.99 … down through values still >= CONTRA_SIM.
    const cosines = [0.99, 0.95, 0.9, 0.85, 0.8, 0.76, 0.75]
    assert.ok(cosines.length > CONTRA_TOP)
    for (let i = 0; i < cosines.length; i++) {
      const id = `p${i}`
      insertEntry(id, `Partner ${i} title`, `distinct mango wording ${i} quartz`)
      insertEntity(`ent-${i}`, `Spoke${i}`)
      mention('cand', `ent-${i}`)
      mention(id, `ent-${i}`)
      insertVec(id, toward(cosines[i]))
    }

    const n = scanContradictions(memory.db)
    assert.equal(n, CONTRA_TOP)
    const rows = openContradictions()
    assert.equal(rows.length, CONTRA_TOP)
    const partnerOf = (row) => (row.entry_a === 'cand' ? row.entry_b : row.entry_a)
    assert.deepEqual(
      rows.map(partnerOf),
      cosines.slice(0, CONTRA_TOP).map((_, i) => `p${i}`),
      'highest cosine partners must be enqueued first',
    )
    for (const row of rows) {
      assert.match(row.detail ?? '', /cosine=/)
    }
  })

  it('entries with no vectors still follow the strong and weak rules', () => {
    // Strong: two shared entities, disjoint wording, no vectors.
    insertEntry('strong-a', 'Sessions live seven days', 'login window via AuthModule and TokenStore')
    insertEntry('strong-b', 'Logins expire hourly', 'credential refresh with AuthModule and TokenStore')
    insertEntity('ent-auth', 'AuthModule')
    insertEntity('ent-token', 'TokenStore')
    mention('strong-a', 'ent-auth')
    mention('strong-a', 'ent-token')
    mention('strong-b', 'ent-auth')
    mention('strong-b', 'ent-token')

    // Weak: one shared entity, high token overlap, no vectors.
    insertEntry(
      'weak-a',
      'alpha beta gamma delta epsilon zeta eta',
      'overlap body tokens remain here',
    )
    insertEntry(
      'weak-b',
      'alpha beta gamma delta epsilon theta iota',
      'overlap body tokens remain here',
    )
    insertEntity('ent-weak', 'OverlapConcept')
    mention('weak-a', 'ent-weak')
    mention('weak-b', 'ent-weak')

    // Negative: one shared entity, low Jaccard, no vectors — must stay out.
    insertEntry('miss-a', 'Alpha claim', 'unique zebra phrase only')
    insertEntry('miss-b', 'Beta assertion', 'distinct mango wording here')
    insertEntity('ent-miss', 'LonelyHub')
    mention('miss-a', 'ent-miss')
    mention('miss-b', 'ent-miss')

    const n = scanContradictions(memory.db)
    assert.equal(n, 2)
    const rows = openContradictions()
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.doesNotMatch(row.detail ?? '', /cosine=/)
      assert.match(row.detail ?? '', /shared entities:/)
    }
    const pairs = rows.map((r) => [r.entry_a, r.entry_b].sort().join('+')).sort()
    assert.deepEqual(pairs, ['strong-a+strong-b', 'weak-a+weak-b'])
  })
})

describe('contradiction scan via semanticNeighbors (#310)', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-jan-sn-'))
    memory = new Memory(path.join(dir, 'memory.db'), {
      startJanitor: false,
      embedder: fakeEmbedder(64),
    })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function openContradictionPairs() {
    return memory.db
      .prepare(
        `SELECT entry_a, entry_b, detail FROM review_queue
         WHERE kind = 'contradiction' AND resolved_at IS NULL
         ORDER BY id`,
      )
      .all()
  }

  it('enqueues a one-entity paraphrase Jaccard misses once vectors exist', async () => {
    const a = memory.store({
      type: 'knowledge',
      title: 'production deploys travel through girder over ssh',
      body: 'the release pipeline uses girder [[Girder]]',
      project: 'p',
    })
    const b = memory.store({
      type: 'knowledge',
      title: 'girder carries every production deploy over ssh',
      body: 'releases go out on girder [[Girder]]',
      project: 'p',
    })

    const jac = jaccard(
      contentTokens(
        'production deploys travel through girder over ssh the release pipeline uses girder [[Girder]]',
      ),
      contentTokens(
        'girder carries every production deploy over ssh releases go out on girder [[Girder]]',
      ),
    )
    assert.ok(jac < 0.4, `expected Jaccard below 0.4, got ${jac}`)

    await memory.embedEntry(a.id)
    await memory.embedEntry(b.id)

    const n = scanContradictions(memory.db)
    assert.equal(n, 1)
    const rows = openContradictionPairs()
    assert.equal(rows.length, 1)
    const ids = new Set([rows[0].entry_a, rows[0].entry_b])
    assert.ok(ids.has(a.id))
    assert.ok(ids.has(b.id))
    assert.match(rows[0].detail ?? '', /shared entities:/)
    assert.match(rows[0].detail ?? '', /cosine=/)
  })

  it('caps a hub at MAX_PAIRS_PER_ENTRY when vectors exist', async () => {
    assert.ok(MAX_PAIRS_PER_ENTRY >= 1)
    const partnerIds = []
    for (let i = 0; i < 5; i++) {
      const { id } = memory.store({
        type: 'knowledge',
        title: 'alpha beta gamma delta epsilon zeta eta',
        body: `overlap body tokens remain here unique${i} [[Spoke${i}]]`,
        project: 'p',
        force: true,
      })
      partnerIds.push(id)
      await memory.embedEntry(id)
    }
    // Partners share no entity with each other, so this only advances the watermark.
    assert.equal(scanContradictions(memory.db), 0)

    const spokeLinks = [0, 1, 2, 3, 4].map((i) => `[[Spoke${i}]]`).join(' ')
    const { id: hubId } = memory.store({
      type: 'knowledge',
      title: 'alpha beta gamma delta epsilon zeta eta',
      body: `overlap body tokens remain here ${spokeLinks}`,
      project: 'p',
      force: true,
    })
    await memory.embedEntry(hubId)

    const n = scanContradictions(memory.db)
    assert.ok(n <= MAX_PAIRS_PER_ENTRY, `enqueued ${n}, cap is ${MAX_PAIRS_PER_ENTRY}`)
    const rows = openContradictionPairs()
    assert.ok(rows.length <= MAX_PAIRS_PER_ENTRY)
    for (const row of rows) {
      assert.ok(row.entry_a === hubId || row.entry_b === hubId)
      assert.match(row.detail ?? '', /cosine=/)
    }
  })

  it('with no vectors, scan produces the same pairs as the lexical contract', () => {
    // Recreate without an embedder so store() cannot race a vector in.
    memory.close()
    memory = new Memory(path.join(dir, 'memory-novec.db'), { startJanitor: false })

    const strongA = memory.store({
      type: 'knowledge',
      title: 'Sessions live seven days',
      body: 'login window via AuthModule and TokenStore',
      project: 'p',
      force: true,
    })
    const strongB = memory.store({
      type: 'knowledge',
      title: 'Logins expire hourly',
      body: 'credential refresh with AuthModule and TokenStore',
      project: 'p',
      force: true,
    })
    for (const name of ['AuthModule', 'TokenStore']) {
      let row = memory.db.prepare(`SELECT id FROM entities WHERE name = ?`).get(name)
      if (!row) {
        memory.db
          .prepare(`INSERT INTO entities (id, name, kind) VALUES (?, ?, 'module')`)
          .run(`ent-${name}`, name)
        row = { id: `ent-${name}` }
      }
      memory.db
        .prepare(`INSERT OR IGNORE INTO mentions (entry_id, entity_id) VALUES (?, ?)`)
        .run(strongA.id, row.id)
      memory.db
        .prepare(`INSERT OR IGNORE INTO mentions (entry_id, entity_id) VALUES (?, ?)`)
        .run(strongB.id, row.id)
    }

    const weakA = memory.store({
      type: 'knowledge',
      title: 'alpha beta gamma delta epsilon zeta eta',
      body: 'overlap body tokens remain here',
      project: 'p',
      force: true,
    })
    const weakB = memory.store({
      type: 'knowledge',
      title: 'alpha beta gamma delta epsilon theta iota',
      body: 'overlap body tokens remain here',
      project: 'p',
      force: true,
    })
    memory.db
      .prepare(`INSERT INTO entities (id, name, kind) VALUES ('ent-weak', 'OverlapConcept', 'concept')`)
      .run()
    memory.db
      .prepare(`INSERT OR IGNORE INTO mentions (entry_id, entity_id) VALUES (?, 'ent-weak')`)
      .run(weakA.id)
    memory.db
      .prepare(`INSERT OR IGNORE INTO mentions (entry_id, entity_id) VALUES (?, 'ent-weak')`)
      .run(weakB.id)

    const missA = memory.store({
      type: 'knowledge',
      title: 'Alpha claim',
      body: 'unique zebra phrase only',
      project: 'p',
      force: true,
    })
    const missB = memory.store({
      type: 'knowledge',
      title: 'Beta assertion',
      body: 'distinct mango wording here',
      project: 'p',
      force: true,
    })
    memory.db
      .prepare(`INSERT INTO entities (id, name, kind) VALUES ('ent-miss', 'LonelyHub', 'concept')`)
      .run()
    memory.db
      .prepare(`INSERT OR IGNORE INTO mentions (entry_id, entity_id) VALUES (?, 'ent-miss')`)
      .run(missA.id)
    memory.db
      .prepare(`INSERT OR IGNORE INTO mentions (entry_id, entity_id) VALUES (?, 'ent-miss')`)
      .run(missB.id)

    const n = scanContradictions(memory.db)
    assert.equal(n, 2)
    const rows = openContradictionPairs()
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.doesNotMatch(row.detail ?? '', /cosine=/)
      assert.match(row.detail ?? '', /shared entities:/)
    }
    const pairs = rows.map((r) => [r.entry_a, r.entry_b].sort().join('+')).sort()
    assert.deepEqual(
      pairs,
      [
        [strongA.id, strongB.id].sort().join('+'),
        [weakA.id, weakB.id].sort().join('+'),
      ].sort(),
    )
  })
})

describe('janitor auto-resolve (#720)', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-jan-auto-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function daysAgo(n) {
    return new Date(Date.now() - n * 86_400_000).toISOString()
  }

  function storePair(suffix = '') {
    const a = memory.store({
      type: 'knowledge',
      title: `alpha unique zebra ${suffix}`,
      body: `distinct apple orchard harvest ${suffix}`,
      force: true,
    })
    const b = memory.store({
      type: 'knowledge',
      title: `beta unique mango ${suffix}`,
      body: `distinct river current salmon ${suffix}`,
      force: true,
    })
    return { a, b }
  }

  function enqueue(kind, aId, bId, detail) {
    assert.equal(queueReview(memory.db, kind, aId, bId, detail), true)
    const [left, right] = aId < bId ? [aId, bId] : [bId, aId]
    const q = memory.db
      .prepare(
        `SELECT * FROM review_queue
         WHERE kind = ? AND entry_a = ? AND entry_b = ? AND resolved_at IS NULL`,
      )
      .get(kind, left, right)
    assert.ok(q, 'expected open review_queue row for pair')
    return q
  }

  function row(id) {
    return memory.db.prepare(`SELECT * FROM review_queue WHERE id = ?`).get(id)
  }

  function entry(id) {
    return memory.db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id)
  }

  it('auto-noops dead pairs (superseded or invalidated) and names the rule', () => {
    const { a, b } = storePair('dead')
    const qid = enqueue('near_dup', a.id, b.id, 'jaccard=0.5').id
    memory.invalidateEntry(a.id, { reason: 'test' })

    const counts = autoResolveQueue(memory.db)
    assert.equal(counts.deadPairs, 1)
    const q = row(qid)
    assert.ok(q.resolved_at)
    assert.equal(q.resolution, 'noop')
    assert.equal(q.detail, `${AUTO_RESOLVE_PREFIX}dead_pair`)
    assert.equal(entry(a.id).id, a.id)
    assert.ok(entry(a.id).invalid_at)
    assert.equal(entry(b.id).invalid_at, null)
  })

  it('age-out noops open rows older than 30 days and leaves younger rows', () => {
    const oldPair = storePair('stale-old')
    const youngPair = storePair('stale-young')
    const oldId = enqueue('near_dup', oldPair.a.id, oldPair.b.id, 'jaccard=0.5').id
    const youngId = enqueue('near_dup', youngPair.a.id, youngPair.b.id, 'jaccard=0.5').id
    memory.db
      .prepare(`UPDATE review_queue SET created_at = ? WHERE id = ?`)
      .run(daysAgo(STALE_QUEUE_DAYS + 1), oldId)
    memory.db
      .prepare(`UPDATE review_queue SET created_at = ? WHERE id = ?`)
      .run(daysAgo(STALE_QUEUE_DAYS - 1), youngId)

    const counts = autoResolveQueue(memory.db)
    assert.equal(counts.staleRows, 1)
    const old = row(oldId)
    assert.ok(old.resolved_at)
    assert.equal(old.resolution, 'noop')
    assert.equal(old.detail, `${AUTO_RESOLVE_PREFIX}stale_row`)
    const young = row(youngId)
    assert.equal(young.resolved_at, null)
    assert.equal(young.resolution, null)
  })

  it('auto-invalidates near_dup cosine >= 0.95 (older loser) and skips below the bar', () => {
    const hot = storePair('dup-hot')
    const cold = storePair('dup-cold')
    memory.db
      .prepare(`UPDATE entries SET created_at = ? WHERE id = ?`)
      .run('2020-01-01T00:00:00.000Z', hot.a.id)
    memory.db
      .prepare(`UPDATE entries SET created_at = ? WHERE id = ?`)
      .run('2021-01-01T00:00:00.000Z', hot.b.id)
    const hotId = enqueue('near_dup', hot.a.id, hot.b.id, 'cosine=0.95').id
    const coldId = enqueue(
      'near_dup',
      cold.a.id,
      cold.b.id,
      `cosine=${SEMANTIC_DUP_AUTO - 0.02}`,
    ).id

    const counts = autoResolveQueue(memory.db)
    assert.equal(counts.semanticDups, 1)
    const q = row(hotId)
    assert.ok(q.resolved_at)
    assert.equal(q.resolution, 'invalidate')
    assert.equal(q.detail, `${AUTO_RESOLVE_PREFIX}semantic_dup cosine=0.95`)
    assert.ok(entry(hot.a.id).invalid_at, 'older entry must be tombstoned')
    assert.equal(entry(hot.a.id).invalidated_by, hot.b.id)
    assert.equal(entry(hot.b.id).invalid_at, null)
    assert.equal(row(coldId).resolved_at, null)
    assert.equal(entry(cold.a.id).invalid_at, null)
    assert.equal(entry(cold.b.id).invalid_at, null)
  })

  it('does not auto-invalidate a jaccard near_dup even at 0.99', () => {
    const { a, b } = storePair('jac')
    const qid = enqueue('near_dup', a.id, b.id, 'jaccard=0.99').id
    const counts = autoResolveQueue(memory.db)
    assert.equal(counts.semanticDups, 0)
    assert.equal(row(qid).resolved_at, null)
    assert.equal(entry(a.id).invalid_at, null)
  })

  it('does not auto-invalidate a contradiction even with cosine above the bar', () => {
    const { a, b } = storePair('contra')
    const qid = enqueue(
      'contradiction',
      a.id,
      b.id,
      'shared entities: Foo; cosine=0.99',
    ).id
    const counts = autoResolveQueue(memory.db)
    assert.equal(counts.semanticDups, 0)
    assert.equal(row(qid).resolved_at, null)
    assert.equal(entry(a.id).invalid_at, null)
    assert.equal(entry(b.id).invalid_at, null)
  })

  it('dead pair with high cosine noops, it does not invalidate', () => {
    const { a, b } = storePair('dead-cos')
    memory.db
      .prepare(`UPDATE entries SET created_at = ? WHERE id = ?`)
      .run('2020-01-01T00:00:00.000Z', a.id)
    const qid = enqueue('near_dup', a.id, b.id, 'cosine=0.99').id
    memory.invalidateEntry(a.id, { reason: 'already gone' })

    const counts = autoResolveQueue(memory.db)
    assert.equal(counts.semanticDups, 0)
    assert.equal(counts.deadPairs, 1)
    const q = row(qid)
    assert.equal(q.resolution, 'noop')
    assert.equal(q.detail, `${AUTO_RESOLVE_PREFIX}dead_pair`)
    assert.equal(entry(b.id).invalid_at, null)
  })

  it('auto-expires live run entries older than 30 days and leaves younger runs', () => {
    const oldRun = memory.store({
      type: 'run',
      title: 'old run note unique ancient',
      body: 'ran something long ago ancientmarker',
    })
    const youngRun = memory.store({
      type: 'run',
      title: 'young run note unique recent',
      body: 'ran something recently recentmarker',
    })
    memory.db
      .prepare(`UPDATE entries SET created_at = ? WHERE id = ?`)
      .run(daysAgo(ANCIENT_RUN_DAYS + 1), oldRun.id)
    memory.db
      .prepare(`UPDATE entries SET created_at = ? WHERE id = ?`)
      .run(daysAgo(ANCIENT_RUN_DAYS - 1), youngRun.id)

    const counts = autoResolveQueue(memory.db)
    assert.equal(counts.ancientRuns, 1)
    const old = entry(oldRun.id)
    assert.ok(old.invalid_at)
    assert.equal(old.invalidated_by, 'janitor')
    assert.equal(old.invalidation_reason, `${AUTO_RESOLVE_PREFIX}ancient_run`)
    assert.equal(entry(youngRun.id).invalid_at, null)
  })

  it('tombstones, never deletes', () => {
    const { a, b } = storePair('keep')
    memory.db
      .prepare(`UPDATE entries SET created_at = ? WHERE id = ?`)
      .run('2020-01-01T00:00:00.000Z', a.id)
    enqueue('near_dup', a.id, b.id, 'cosine=0.97')
    const run = memory.store({ type: 'run', title: 'ancient run keep', body: 'keep this row' })
    memory.db
      .prepare(`UPDATE entries SET created_at = ? WHERE id = ?`)
      .run(daysAgo(ANCIENT_RUN_DAYS + 5), run.id)

    runJanitor(memory.db)

    assert.equal(entry(a.id)?.id, a.id)
    assert.ok(entry(a.id).invalid_at)
    assert.equal(entry(b.id)?.id, b.id)
    assert.equal(entry(run.id)?.id, run.id)
    assert.ok(entry(run.id).invalid_at)
    assert.equal(memory.db.prepare(`SELECT COUNT(*) AS n FROM entries`).get().n, 3)
  })

  it('runJanitor applies auto-resolve inside the boot/interval pass', () => {
    const { a, b } = storePair('boot')
    enqueue('near_dup', a.id, b.id, 'jaccard=0.5')
    memory.invalidateEntry(b.id, { reason: 'test' })
    runJanitor(memory.db)
    const q = memory.db.prepare(`SELECT * FROM review_queue ORDER BY id DESC LIMIT 1`).get()
    assert.ok(q.resolved_at)
    assert.equal(q.resolution, 'noop')
    assert.equal(q.detail, `${AUTO_RESOLVE_PREFIX}dead_pair`)
  })
})
