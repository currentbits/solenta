import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'

describe('feedback', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-fb-'))
    memory = new Memory(path.join(dir, 'memory.db'))
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function pinEqualFts(ids) {
    const now = new Date().toISOString()
    for (const id of ids) {
      memory.db
        .prepare(
          `UPDATE entries SET created_at = ?, last_accessed_at = NULL, access_count = 0,
           helpful_count = 0, harmful_count = 0 WHERE id = ?`,
        )
        .run(now, id)
    }
  }

  it('memory_feedback bumps helpful_count and writes feedback_log', () => {
    const { id } = memory.store({
      type: 'convention',
      title: 'Rule',
      body: 'always do the thing',
    })
    const result = memory.feedback({ id, verdict: 'helpful', note: 'worked well' })
    assert.equal(result.ok, true)
    const row = memory.db
      .prepare(`SELECT helpful_count, harmful_count FROM entries WHERE id = ?`)
      .get(id)
    assert.equal(row.helpful_count, 1)
    assert.equal(row.harmful_count, 0)
    const log = memory.db
      .prepare(`SELECT entry_id, verdict, note FROM feedback_log WHERE entry_id = ?`)
      .get(id)
    assert.equal(log.verdict, 'helpful')
    assert.equal(log.note, 'worked well')
  })

  it('helpful feedback boosts rank; harmful demotes; clamps apply', async () => {
    const base = memory.store({
      type: 'knowledge',
      title: 'Shared rank topic',
      body: 'shared rank topic details here',
      importance: 3,
      force: true,
    })
    const boosted = memory.store({
      type: 'knowledge',
      title: 'Shared rank topic',
      body: 'shared rank topic details here',
      importance: 3,
      force: true,
    })
    const demoted = memory.store({
      type: 'knowledge',
      title: 'Shared rank topic',
      body: 'shared rank topic details here',
      importance: 3,
      force: true,
    })
    pinEqualFts([base.id, boosted.id, demoted.id])

    for (let i = 0; i < 10; i++) memory.feedback({ id: boosted.id, verdict: 'helpful' })
    // Extra helpful beyond clamp (min 10) should not change further vs 10
    memory.feedback({ id: boosted.id, verdict: 'helpful' })
    for (let i = 0; i < 5; i++) memory.feedback({ id: demoted.id, verdict: 'harmful' })
    memory.feedback({ id: demoted.id, verdict: 'harmful' }) // beyond clamp of 5

    const hits = await memory.search({ query: 'shared rank topic', limit: 10 })
    const order = hits.map((h) => h.id)
    assert.ok(order.includes(boosted.id) && order.includes(demoted.id) && order.includes(base.id))
    assert.ok(
      order.indexOf(boosted.id) < order.indexOf(base.id),
      `boosted should rank above base: ${order}`,
    )
    assert.ok(
      order.indexOf(base.id) < order.indexOf(demoted.id),
      `base should rank above demoted: ${order}`,
    )

    // Factor clamp: helpful_count=11 still uses min(10); harmful uses min(5)
    // Extreme harmful should not drive factor below 0.3 (score still positive finite)
    const demotedHit = hits.find((h) => h.id === demoted.id)
    assert.ok(demotedHit.score > 0)
    assert.ok(Number.isFinite(demotedHit.score))
  })

  it('rejects invalid verdict and missing id', () => {
    assert.throws(() => memory.feedback({ id: 'nope', verdict: 'helpful' }), /no entry|not found/i)
    const { id } = memory.store({ type: 'knowledge', title: 't', body: 'b' })
    assert.throws(() => memory.feedback({ id, verdict: 'meh' }), /verdict|helpful|harmful/i)
  })
})
