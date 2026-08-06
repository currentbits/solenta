import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'

describe('memory core', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-'))
    memory = new Memory(path.join(dir, 'memory.db'))
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function backdate(id, days) {
    const then = new Date(Date.now() - days * 86_400_000).toISOString()
    memory.db.prepare(`UPDATE entries SET created_at = ?, last_accessed_at = NULL WHERE id = ?`).run(then, id)
  }

  function setAccess(id, days, count) {
    const then = new Date(Date.now() - days * 86_400_000).toISOString()
    memory.db
      .prepare(`UPDATE entries SET last_accessed_at = ?, access_count = ? WHERE id = ?`)
      .run(then, count, id)
  }

  it('store/get round-trip with importance defaults', () => {
    const c = memory.store({ type: 'convention', title: 'No em dash', body: 'never use em dashes' })
    const r = memory.store({ type: 'run', title: 'Quick note', body: 'ran once' })
    const k = memory.store({ type: 'knowledge', title: 'Fact', body: 'something durable' })
    assert.ok(c.id)
    assert.equal(memory.get(c.id).importance, 5)
    assert.equal(memory.get(r.id).importance, 1)
    assert.equal(memory.get(k.id).importance, 3)
    assert.equal(memory.get(k.id).body, 'something durable')
    assert.equal(memory.get('missing'), null)
  })

  it('FTS update trigger: search finds new text not old after update', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Deploy notes',
      body: 'original alphaword content here',
    })
    // Simulate supersede-style content change via direct update (exercises FTS update trigger)
    memory.db
      .prepare(`UPDATE entries SET title = ?, body = ?, updated_at = ? WHERE id = ?`)
      .run('Deploy notes', 'replacement betaword content here', new Date().toISOString(), id)

    const oldHits = memory.search({ query: 'alphaword' })
    const newHits = memory.search({ query: 'betaword' })
    assert.equal(oldHits.length, 0, 'old text must not remain in FTS')
    assert.equal(newHits.length, 1)
    assert.equal(newHits[0].id, id)
  })

  it('composite ordering: importance and recency influence rank', () => {
    const low = memory.store({
      type: 'run',
      title: 'Shared topic phrase',
      body: 'shared topic phrase detail',
      importance: 1,
    })
    const high = memory.store({
      type: 'convention',
      title: 'Shared topic phrase',
      body: 'shared topic phrase detail',
      importance: 5,
    })
    // Pin identical timestamps so importance alone decides (avoids micro-decay on the older row).
    const now = new Date().toISOString()
    memory.db
      .prepare(`UPDATE entries SET created_at = ?, last_accessed_at = NULL WHERE id IN (?, ?)`)
      .run(now, low.id, high.id)
    const hits = memory.search({ query: 'shared topic phrase' })
    assert.ok(hits.length >= 2)
    assert.equal(hits[0].id, high.id)
    assert.notEqual(hits[0].id, low.id)

    const old = memory.store({
      type: 'knowledge',
      title: 'Cache invalidation trick',
      body: 'the trick details',
    })
    const young = memory.store({
      type: 'knowledge',
      title: 'Cache invalidation trick',
      body: 'the trick details',
    })
    backdate(old.id, 200)
    const recency = memory.search({ query: 'cache invalidation' })
    assert.equal(recency[0].id, young.id)
  })

  it('relevance gate drops results scoring under 20% of the top hit', () => {
    // Strong exact-ish match
    memory.store({
      type: 'knowledge',
      title: 'Zebra pipeline gotcha uniquephrase',
      body: 'zebra pipeline gotcha uniquephrase full detail',
      importance: 5,
    })
    // Weak tangential match sharing one common token
    for (let i = 0; i < 5; i++) {
      memory.store({
        type: 'run',
        title: `Unrelated run ${i}`,
        body: 'misc note mentioning pipeline in passing only',
        importance: 1,
      })
    }
    const hits = memory.search({ query: 'zebra pipeline gotcha uniquephrase', limit: 20 })
    assert.ok(hits.length >= 1)
    const top = hits[0].score
    for (const h of hits) {
      assert.ok(h.score >= top * 0.2 - 1e-9, `score ${h.score} below 20% of top ${top}`)
    }
    // Weak pipeline-only runs should typically be gated out against a strong uniquephrase hit
    assert.ok(hits.every((h) => !h.title.startsWith('Unrelated run') || h.score >= top * 0.2))
  })

  it('marks access once on final returned ids only', () => {
    const a = memory.store({
      type: 'knowledge',
      title: 'Kafka topic naming',
      body: 'kafka naming details for topics',
    })
    memory.search({ query: 'kafka' })
    const count1 = memory.db.prepare(`SELECT access_count FROM entries WHERE id = ?`).get(a.id).access_count
    assert.equal(count1, 1)
    memory.search({ query: 'kafka' })
    const count2 = memory.db.prepare(`SELECT access_count FROM entries WHERE id = ?`).get(a.id).access_count
    assert.equal(count2, 2)
    const accessed = memory.db
      .prepare(`SELECT last_accessed_at FROM entries WHERE id = ?`)
      .get(a.id).last_accessed_at
    assert.ok(accessed)
  })

  it('search returns excerpts not full bodies, plus hint', () => {
    const longBody = Array.from({ length: 80 }, (_, i) => `token${i}`).join(' ')
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Long body entry',
      body: longBody,
    })
    const hits = memory.search({ query: 'token10 token11' })
    assert.ok(hits.length >= 1)
    const hit = hits.find((h) => h.id === id) ?? hits[0]
    assert.ok(hit.excerpt || hit.snippet)
    const excerpt = hit.excerpt ?? hit.snippet
    assert.ok(excerpt.length < longBody.length)
    assert.equal(hit.hint, 'call memory_get with this id for the full body')
    assert.equal(hit.body, undefined)
  })

  it('supersede marks old and returns new id', () => {
    const { id: oldId } = memory.store({
      type: 'knowledge',
      title: 'Old fact',
      body: 'v1 body',
      project: '/tmp/p',
    })
    const { id: newId } = memory.supersede(oldId, { title: 'New fact', body: 'v2 body' })
    assert.notEqual(newId, oldId)
    const old = memory.db.prepare(`SELECT superseded_by, body FROM entries WHERE id = ?`).get(oldId)
    assert.equal(old.superseded_by, newId)
    assert.equal(old.body, 'v1 body')
    const neu = memory.get(newId)
    assert.equal(neu.title, 'New fact')
    assert.equal(neu.body, 'v2 body')
    assert.equal(neu.project, '/tmp/p')
    // search should not return superseded
    const hits = memory.search({ query: 'fact', project: '/tmp/p' })
    assert.ok(hits.every((h) => h.id !== oldId))
  })

  it('bootstrap budgets drop whole entries from the end', () => {
    const project = '/tmp/budget-project'
    // Many large conventions to exceed ~800 token budget
    for (let i = 0; i < 12; i++) {
      memory.store({
        type: 'convention',
        title: `Convention ${i} ${'word '.repeat(40)}`,
        body: `Body of convention ${i}. ${'detail '.repeat(80)}`,
        project,
        importance: 5 - (i % 2),
      })
    }
    for (let i = 0; i < 10; i++) {
      memory.store({
        type: 'knowledge',
        title: `Knowledge ${i} ${'word '.repeat(30)}`,
        body: `Body of knowledge ${i}. ${'detail '.repeat(60)}`,
        project,
      })
    }
    for (let i = 0; i < 10; i++) {
      memory.store({
        type: 'task',
        title: `Active task ${i} ${'word '.repeat(20)}`,
        body: `Task body ${i}. ${'detail '.repeat(40)}`,
        project,
        status: 'active',
      })
    }

    const boot = memory.bootstrap({ project })
    assert.ok(Array.isArray(boot.conventions))
    assert.ok(Array.isArray(boot.knowledge))
    assert.ok(Array.isArray(boot.tasks) || Array.isArray(boot.activeTasks))
    assert.ok(Array.isArray(boot.protocol))
    assert.ok(boot.protocol.length >= 1)

    const tasks = boot.tasks ?? boot.activeTasks
    // Oversize sections must drop some whole entries (not return all 12/10/10)
    assert.ok(boot.conventions.length < 12, `conventions ${boot.conventions.length} should drop some`)
    assert.ok(boot.knowledge.length < 10, `knowledge ${boot.knowledge.length} should drop some`)
    assert.ok(tasks.length < 10, `tasks ${tasks.length} should drop some`)

    // Budgets: estimate tokens of each section stay near limits
    const est = (rows) => Math.ceil(JSON.stringify(rows).length / 4)
    assert.ok(est(boot.conventions) <= 900, `conventions tokens ${est(boot.conventions)}`)
    assert.ok(est(boot.knowledge) <= 600, `knowledge tokens ${est(boot.knowledge)}`)
    assert.ok(est(tasks) <= 400, `tasks tokens ${est(tasks)}`)
  })

  it('usage boost and recency affect composite rank', () => {
    const stale = memory.store({
      type: 'knowledge',
      title: 'Redis cache notes',
      body: 'redis cache tuning',
    })
    const warm = memory.store({
      type: 'knowledge',
      title: 'Redis cache notes',
      body: 'redis cache tuning',
    })
    backdate(stale.id, 120)
    backdate(warm.id, 120)
    setAccess(warm.id, 1, 3)
    const hits = memory.search({ query: 'redis cache' })
    assert.equal(hits[0].id, warm.id)
  })
})
