import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, createSchema } from '../src/db.js'
import { Memory } from '../src/memory.js'
import { trustFactor, agentTrust, TRUST_MIN, TRUST_MAX, TRUST_SUSPECT } from '../src/trust.js'

test('trustFactor is neutral without evidence', () => {
  assert.equal(trustFactor(), 1)
  assert.equal(trustFactor({ helpful: 0, harmful: 0, invalidated: 0 }), 1)
})

test('trustFactor rewards helpful and punishes harmful/invalidated', () => {
  assert.ok(trustFactor({ helpful: 4 }) > 1)
  assert.ok(trustFactor({ harmful: 2 }) < 1)
  assert.ok(trustFactor({ invalidated: 2 }) < 1)
  // A wrong memory costs more than a right one earns.
  assert.ok(trustFactor({ helpful: 2, harmful: 2 }) < 1)
})

test('trustFactor clamps at both ends', () => {
  assert.equal(trustFactor({ helpful: 1000 }), TRUST_MAX)
  assert.equal(trustFactor({ harmful: 1000, invalidated: 1000 }), TRUST_MIN)
})

function seedEntry(db, { id, agent = null, helpful = 0, harmful = 0, invalid = false, title, body }) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO entries (
       id, type, title, body, agent, importance, created_at, updated_at,
       helpful_count, harmful_count, invalid_at
     ) VALUES (?, 'knowledge', ?, ?, ?, 3, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    title ?? `title-${id}`,
    body ?? `body-${id}`,
    agent,
    now,
    now,
    helpful,
    harmful,
    invalid ? now : null,
  )
}

describe('agentTrust', () => {
  let dir
  let db

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-trust-'))
    db = openDb(path.join(dir, 'memory.db'))
    createSchema(db)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // already closed
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('aggregates evidence per agent and skips NULL writers', () => {
    seedEntry(db, { id: 'good-1', agent: 'helpful-bot', helpful: 4 })
    seedEntry(db, { id: 'good-2', agent: 'helpful-bot', helpful: 2 })
    seedEntry(db, { id: 'bad-1', agent: 'poison-bot', harmful: 2, invalid: true })
    seedEntry(db, { id: 'bad-2', agent: 'poison-bot', harmful: 1 })
    seedEntry(db, { id: 'anon-1', agent: null, helpful: 8, harmful: 4, invalid: true })

    const rows = agentTrust(db)
    assert.equal(rows.length, 2)
    assert.ok(rows.every((r) => r.agent != null))

    const good = rows.find((r) => r.agent === 'helpful-bot')
    const bad = rows.find((r) => r.agent === 'poison-bot')
    assert.ok(good && bad)
    assert.equal(good.entries, 2)
    assert.equal(good.helpful, 6)
    assert.equal(good.harmful, 0)
    assert.equal(good.invalidated, 0)
    assert.equal(good.trust, trustFactor({ helpful: 6 }))

    assert.equal(bad.entries, 2)
    assert.equal(bad.helpful, 0)
    assert.equal(bad.harmful, 3)
    assert.equal(bad.invalidated, 1)
    assert.equal(bad.trust, trustFactor({ harmful: 3, invalidated: 1 }))
    assert.ok(bad.trust < good.trust)
    assert.ok(bad.trust < TRUST_SUSPECT)
    assert.ok(good.trust > TRUST_SUSPECT)
  })

  test('empty db and broken handle fail soft', () => {
    assert.deepEqual(agentTrust(db), [])
    db.close()
    assert.deepEqual(agentTrust(db), [])
  })
})

describe('trust ranking + maintenance', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-trust-mem-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
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

  test('NULL agent scores identically with and without agent_trust', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Null agent rank topic',
      body: 'null agent rank topic details here',
      importance: 3,
    })
    const now = new Date().toISOString()
    memory.db
      .prepare(
        `UPDATE entries SET created_at = ?, last_accessed_at = NULL, access_count = 0, agent = NULL WHERE id = ?`,
      )
      .run(now, id)

    const row = memory.db
      .prepare(
        `SELECT
           (e.importance / 3.0)
             * rank_decay(COALESCE(e.last_accessed_at, e.created_at))
             * usage_boost(e.access_count, COALESCE(e.helpful_count, 0), COALESCE(e.harmful_count, 0))
             AS baseline,
           (e.importance / 3.0)
             * rank_decay(COALESCE(e.last_accessed_at, e.created_at))
             * usage_boost(e.access_count, COALESCE(e.helpful_count, 0), COALESCE(e.harmful_count, 0))
             * agent_trust(e.agent)
             AS with_trust
         FROM entries e WHERE e.id = ?`,
      )
      .get(id)
    assert.equal(row.with_trust, row.baseline)
    assert.equal(memory.db.prepare(`SELECT agent_trust(NULL) AS t`).get().t, 1)
  })

  test('poisoned agent ranks below a clean writer of the same text', async () => {
    const clean = memory.store({
      type: 'knowledge',
      title: 'Shared trust rank topic',
      body: 'shared trust rank topic details here',
      importance: 3,
      agent: 'clean-bot',
      force: true,
    })
    const poison = memory.store({
      type: 'knowledge',
      title: 'Shared trust rank topic',
      body: 'shared trust rank topic details here',
      importance: 3,
      agent: 'poison-bot',
      force: true,
    })
    // Evidence lives on a *different* poison-bot row so usage_boost (per-entry
    // feedback) is identical on the two ranked hits; only agent_trust differs.
    const stain = memory.store({
      type: 'knowledge',
      title: 'Unrelated stain',
      body: 'unrelated stain body that does not match the rank query',
      agent: 'poison-bot',
      force: true,
    })
    pinEqualFts([clean.id, poison.id])
    for (let i = 0; i < 3; i++) memory.feedback({ id: stain.id, verdict: 'harmful' })

    const hits = await memory.search({ query: 'shared trust rank topic', limit: 10 })
    const order = hits.map((h) => h.id)
    assert.ok(order.includes(clean.id) && order.includes(poison.id))
    assert.ok(
      order.indexOf(clean.id) < order.indexOf(poison.id),
      `clean should rank above poisoned: ${order}`,
    )
  })

  test('agent_trust cache stays stale across raw SQL then refreshes after feedback', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Cache refresh topic',
      body: 'cache refresh topic details',
      agent: 'cache-bot',
    })
    assert.equal(memory.db.prepare(`SELECT agent_trust(?) AS t`).get('cache-bot').t, 1)

    memory.db.prepare(`UPDATE entries SET harmful_count = 3 WHERE id = ?`).run(id)
    assert.equal(
      memory.db.prepare(`SELECT agent_trust(?) AS t`).get('cache-bot').t,
      1,
      'raw SQL must not rebuild the map until TTL or a feedback verdict',
    )

    memory.feedback({ id, verdict: 'harmful' })
    const after = memory.db.prepare(`SELECT agent_trust(?) AS t`).get('cache-bot').t
    assert.equal(after, trustFactor({ harmful: 4 }))
    assert.ok(after < TRUST_SUSPECT)
  })

  test('maintenance reports a suspect agent', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Suspect writer topic',
      body: 'suspect writer topic details',
      agent: 'suspect-bot',
    })
    for (let i = 0; i < 3; i++) memory.feedback({ id, verdict: 'harmful' })

    const report = memory.maintenance()
    assert.ok(report.trust)
    assert.ok(Array.isArray(report.trust.agents))
    assert.ok(Array.isArray(report.trust.suspect))
    const row = report.trust.suspect.find((a) => a.agent === 'suspect-bot')
    assert.ok(row, `expected suspect-bot in ${JSON.stringify(report.trust)}`)
    assert.ok(row.trust < TRUST_SUSPECT)
    assert.equal(row.harmful, 3)
    assert.match(report.trust.instruction, /suspect/i)
  })
})
