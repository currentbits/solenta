import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'

describe('memory_resolve + maintenance + invalidation hides loser', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-res-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function enqueueNearDup() {
    const a = memory.store({
      type: 'knowledge',
      title: 'Swift tests need DEVELOPER_DIR set to Xcode',
      body: 'Running swift test requires DEVELOPER_DIR=/Applications/Xcode.app or Testing module fails',
    })
    // force a second near-identical write so we always get a queue row
    const b = memory.store({
      type: 'knowledge',
      title: 'Swift tests need DEVELOPER_DIR set to Xcode app',
      body: 'swift test requires DEVELOPER_DIR=/Applications/Xcode.app or the Testing module fails',
      force: true,
    })
    const row = memory.db
      .prepare(`SELECT id, entry_a, entry_b FROM review_queue WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get()
    assert.ok(row, 'expected open review_queue row')
    return { a, b, qid: row.id, entry_a: row.entry_a, entry_b: row.entry_b }
  }

  it('resolve noop marks the row resolved and leaves both entries live', () => {
    const { a, b, qid } = enqueueNearDup()
    const res = memory.resolve({ id: qid, resolution: 'noop' })
    assert.equal(res.ok, true)
    assert.equal(res.resolution, 'noop')
    const row = memory.db.prepare(`SELECT resolved_at, resolution FROM review_queue WHERE id = ?`).get(qid)
    assert.ok(row.resolved_at)
    assert.equal(row.resolution, 'noop')
    assert.equal(memory.get(a.id).title.includes('Swift'), true)
    assert.equal(memory.get(b.id).title.includes('Swift'), true)
  })

  it('resolve invalidate tombstones the older loser and hides it from search/recent/bootstrap', async () => {
    const { a, b, qid } = enqueueNearDup()
    // Make a older than b so a is the loser
    memory.db
      .prepare(`UPDATE entries SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`)
      .run(a.id)
    memory.db
      .prepare(`UPDATE entries SET created_at = '2021-01-01T00:00:00.000Z' WHERE id = ?`)
      .run(b.id)

    memory.resolve({ id: qid, resolution: 'invalidate' })

    const loser = memory.db
      .prepare(`SELECT invalid_at, invalidated_by FROM entries WHERE id = ?`)
      .get(a.id)
    assert.ok(loser.invalid_at, 'older entry must be invalidated')
    assert.equal(loser.invalidated_by, b.id)

    const got = memory.get(a.id)
    assert.equal(got.invalidated, true)

    const hits = await memory.search({ query: 'DEVELOPER_DIR Swift tests' })
    assert.ok(hits.every((h) => h.id !== a.id), 'invalidated entry must not appear in search')

    const recent = memory.recent({ limit: 50 })
    assert.ok(recent.every((r) => r.id !== a.id), 'invalidated entry must not appear in recent')

    const boot = memory.bootstrap({})
    const bootIds = [
      ...boot.knowledge.map((k) => k.id),
      ...boot.conventions.map((c) => c.id),
      ...boot.tasks.map((t) => t.id),
    ]
    assert.ok(!bootIds.includes(a.id), 'invalidated entry must not appear in bootstrap')
  })

  it('maintenance report has queue depth, nearDupes, agingRuns, fatConventions', () => {
    enqueueNearDup()
    // aging run
    const run = memory.store({
      type: 'run',
      title: 'Old run note unique agingrunmarker',
      body: 'ran something long ago agingrunmarker',
    })
    memory.db
      .prepare(`UPDATE entries SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 10 * 86_400_000).toISOString(), run.id)

    // fat convention
    memory.store({
      type: 'convention',
      title: 'Huge rulebook',
      body: 'x'.repeat(1600),
      force: true,
    })

    const report = memory.maintenance()
    assert.ok(report.queue)
    assert.ok(report.queue.open >= 1)
    assert.equal(typeof report.queue.oldestAgeDays, 'number')
    assert.ok(Array.isArray(report.queue.items))
    assert.match(report.queue.instruction, /memory_resolve/)
    assert.ok(Array.isArray(report.nearDupes))
    assert.ok(report.nearDupes.length >= 1)
    assert.match(report.nearDupes[0].instruction, /memory_supersede|supersede/i)
    assert.ok(Array.isArray(report.agingRuns))
    assert.ok(report.agingRuns.some((r) => r.id === run.id))
    assert.ok(Array.isArray(report.fatConventions))
    assert.ok(report.fatConventions.some((r) => r.chars > 1500))
    assert.match(report.fatConventions[0].instruction, /memory_supersede/)
  })

  it('bootstrap protocol mentions memory_maintenance / memory_resolve', () => {
    const boot = memory.bootstrap({})
    assert.ok(
      boot.protocol.some((p) => /memory_maintenance/.test(p) && /memory_resolve/.test(p)),
      `protocol missing maintenance sentence: ${JSON.stringify(boot.protocol)}`,
    )
  })
})
