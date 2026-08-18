import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'

const PROJECT = 'project-x'
const OLD_TITLE = 'Project X database engine'
const OLD_BODY = 'Project X uses Postgres as its primary database.'
const NEW_TITLE = 'Project X database engine'
const NEW_BODY = 'Project X migrated from Postgres to MySQL on 2026-03-04.'
const TIP_TITLE = 'Project X database engine'
const TIP_BODY = 'Project X now runs on PlanetScale MySQL as of 2026-06-01.'
const OLD_CLAIM = 'uses Postgres as its primary'

describe('state-change supersede', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-state-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function bootstrapIds() {
    const boot = memory.bootstrap({ project: PROJECT })
    return {
      boot,
      ids: [
        ...boot.knowledge.map((k) => k.id),
        ...boot.conventions.map((c) => c.id),
        ...boot.tasks.map((t) => t.id),
      ],
    }
  }

  it('successor wins on search, recent, and bootstrap; predecessor is history only', async () => {
    const { id: oldId } = memory.store({
      type: 'knowledge',
      title: OLD_TITLE,
      body: OLD_BODY,
      project: PROJECT,
    })
    const { id: newId } = memory.supersede(oldId, { title: NEW_TITLE, body: NEW_BODY })
    assert.notEqual(newId, oldId)

    const hits = await memory.search({ query: 'database engine', project: PROJECT })
    assert.ok(hits.some((h) => h.id === newId), 'successor must be a live search hit')
    assert.ok(hits.every((h) => h.id !== oldId), 'superseded predecessor must not appear in search')
    for (const h of hits) {
      const text = `${h.title} ${h.excerpt ?? ''}`
      assert.ok(!text.includes(OLD_CLAIM), `old claim leaked in live hit ${h.id}: ${text}`)
    }

    const recent = memory.recent({ project: PROJECT, limit: 50 })
    const recentIds = recent.map((r) => r.id)
    assert.ok(recentIds.includes(newId))
    assert.ok(!recentIds.includes(oldId))
    assert.ok(recent.every((r) => !`${r.title} ${r.excerpt ?? ''}`.includes(OLD_CLAIM)))

    const { boot, ids: bootIds } = bootstrapIds()
    assert.ok(bootIds.includes(newId))
    assert.ok(!bootIds.includes(oldId))
    assert.ok(boot.knowledge.every((k) => !`${k.title} ${k.excerpt ?? k.body ?? ''}`.includes(OLD_CLAIM)))

    const graph = memory.graphSearch('database engine', PROJECT)
    assert.ok(graph.every((h) => h.id !== oldId), 'superseded predecessor must not appear in graphSearch')

    const stub = memory.get(oldId)
    assert.equal(stub.superseded_by, newId)
    assert.equal(stub.body, undefined)
    assert.equal(stub.title, undefined)
    assert.match(stub.hint, /successor/)

    const live = memory.get(newId)
    assert.equal(live.id, newId)
    assert.equal(live.body, NEW_BODY)
    assert.equal(live.title, NEW_TITLE)
    assert.equal(live.project, PROJECT)
    assert.equal(live.superseded_by, null)
  })

  it('three-step chain: only the tip is live and hops from A reach C', async () => {
    const { id: a } = memory.store({
      type: 'knowledge',
      title: OLD_TITLE,
      body: OLD_BODY,
      project: PROJECT,
    })
    const { id: b } = memory.supersede(a, { title: NEW_TITLE, body: NEW_BODY })
    const { id: c } = memory.supersede(b, { title: TIP_TITLE, body: TIP_BODY })

    const hits = await memory.search({ query: 'database engine', project: PROJECT })
    assert.ok(hits.some((h) => h.id === c))
    assert.ok(hits.every((h) => h.id !== a && h.id !== b))

    const recentIds = memory.recent({ project: PROJECT, limit: 50 }).map((r) => r.id)
    assert.ok(recentIds.includes(c))
    assert.ok(!recentIds.includes(a) && !recentIds.includes(b))

    const { ids: bootIds } = bootstrapIds()
    assert.ok(bootIds.includes(c))
    assert.ok(!bootIds.includes(a) && !bootIds.includes(b))

    // Each superseded row points one hop forward; walking A reaches live tip C.
    const hopA = memory.get(a)
    const hopB = memory.get(hopA.superseded_by)
    const tip = memory.get(hopB.superseded_by)
    assert.equal(hopA.superseded_by, b)
    assert.equal(hopA.body, undefined)
    assert.equal(hopB.superseded_by, c)
    assert.equal(hopB.body, undefined)
    assert.equal(tip.id, c)
    assert.equal(tip.body, TIP_BODY)
    assert.equal(tip.superseded_by, null)
  })

  it('supersede on an already-superseded id throws', () => {
    const { id: oldId } = memory.store({
      type: 'knowledge',
      title: OLD_TITLE,
      body: OLD_BODY,
      project: PROJECT,
    })
    const { id: newId } = memory.supersede(oldId, { title: NEW_TITLE, body: NEW_BODY })

    assert.throws(() => memory.supersede(oldId, { body: TIP_BODY }), /already superseded by/)
    assert.equal(memory.get(oldId).superseded_by, newId)
    assert.equal(memory.get(newId).body, NEW_BODY)
  })
})
