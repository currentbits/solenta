import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'

describe('memory_distill', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-distill-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function snapAccess() {
    return memory.db
      .prepare(
        `SELECT id, access_count, updated_at, last_accessed_at, helpful_count, harmful_count
         FROM entries ORDER BY id`,
      )
      .all()
  }

  it('puts a harmful-feedback entry and its note under failures', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Always rebase onto origin/main',
      body: 'rebase before every push or the stack will explode',
      project: 'alpha',
    })
    memory.feedback({ id, verdict: 'harmful', note: 'blew up a protected branch' })

    const report = memory.distill({ project: 'alpha' })
    const hit = report.failures.items.find((i) => i.id === id)
    assert.ok(hit, 'harmful entry missing from failures')
    assert.equal(hit.kind, 'harmful')
    assert.equal(hit.harmful_count, 1)
    assert.ok(hit.notes.some((n) => n.note === 'blew up a protected branch'))
    assert.ok(report.failures.total >= 1)
  })

  it('puts an abandoned task under failures', () => {
    const { id } = memory.store({
      type: 'task',
      title: 'Rewrite the embedder in rust',
      body: 'started, then gave up after the FFI wall',
      status: 'abandoned',
      project: 'alpha',
    })

    const report = memory.distill({ project: 'alpha' })
    const hit = report.failures.items.find((i) => i.id === id)
    assert.ok(hit, 'abandoned task missing from failures')
    assert.equal(hit.kind, 'abandoned')
    assert.equal(hit.status, 'abandoned')
  })

  it('puts a recent run and a helpful entry under successes', () => {
    const run = memory.store({
      type: 'run',
      title: 'Merged the worker branch locally',
      body: 'did not wait for a push; merged the worktree branch',
      project: 'alpha',
    })
    const fact = memory.store({
      type: 'knowledge',
      title: 'cp -Rc clones node_modules on APFS',
      body: 'do not npm install in a fresh worktree',
      project: 'alpha',
    })
    memory.feedback({ id: fact.id, verdict: 'helpful', note: 'saved a minute' })

    const old = memory.store({
      type: 'run',
      title: 'Ancient run that should not surface',
      body: 'this is twenty days stale and never marked helpful',
      project: 'alpha',
    })
    memory.db
      .prepare(`UPDATE entries SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 20 * 86_400_000).toISOString(), old.id)

    const report = memory.distill({ project: 'alpha' })
    assert.ok(report.successes.items.some((i) => i.id === run.id), 'recent run missing')
    assert.ok(report.successes.items.some((i) => i.id === fact.id), 'helpful entry missing')
    assert.ok(!report.successes.items.some((i) => i.id === old.id), 'stale run leaked in')
    assert.ok(report.successes.total >= 2)
  })

  it('reports existing live strategies by title', () => {
    const { id } = memory.store({
      type: 'strategy',
      title: 'When a worker finishes, merge its local branch',
      body: "When a forked worker finishes, don't wait for a push: merge its local branch.",
      project: 'alpha',
    })

    const report = memory.distill({ project: 'alpha' })
    assert.equal(report.existing.total, 1)
    assert.equal(report.existing.items.length, 1)
    assert.equal(report.existing.items[0].id, id)
    assert.equal(report.existing.items[0].title, 'When a worker finishes, merge its local branch')
    assert.ok(report.instructions.some((line) => /memory_store/.test(line)))
    assert.ok(report.instructions.some((line) => /failures/.test(line)))
  })

  it('never includes another project\'s rows', () => {
    const aHarm = memory.store({
      type: 'knowledge',
      title: 'Alpha-only harmful fact',
      body: 'alpha project harmful evidence body',
      project: 'alpha',
    })
    memory.feedback({ id: aHarm.id, verdict: 'harmful', note: 'alpha note' })
    memory.store({
      type: 'task',
      title: 'Alpha abandoned',
      body: 'alpha abandoned body',
      status: 'abandoned',
      project: 'alpha',
    })
    memory.store({
      type: 'run',
      title: 'Alpha recent run',
      body: 'alpha recent run body',
      project: 'alpha',
    })
    memory.store({
      type: 'strategy',
      title: 'Alpha existing strategy',
      body: 'When doing alpha work, stay in alpha.',
      project: 'alpha',
    })

    const bHarm = memory.store({
      type: 'knowledge',
      title: 'Beta-only harmful fact',
      body: 'beta project harmful evidence body',
      project: 'beta',
    })
    memory.feedback({ id: bHarm.id, verdict: 'harmful', note: 'beta note must not leak' })
    memory.store({
      type: 'task',
      title: 'Beta abandoned',
      body: 'beta abandoned body',
      status: 'abandoned',
      project: 'beta',
    })
    memory.store({
      type: 'run',
      title: 'Beta recent run',
      body: 'beta recent run body',
      project: 'beta',
    })
    memory.store({
      type: 'strategy',
      title: 'Beta existing strategy',
      body: 'When doing beta work, stay in beta.',
      project: 'beta',
    })

    const report = memory.distill({ project: 'alpha' })
    const ids = [
      ...report.failures.items.map((i) => i.id),
      ...report.successes.items.map((i) => i.id),
      ...report.existing.items.map((i) => i.id),
    ]
    const titles = [
      ...report.failures.items.map((i) => i.title),
      ...report.successes.items.map((i) => i.title),
      ...report.existing.items.map((i) => i.title),
    ]
    const notes = report.failures.items.flatMap((i) => i.notes ?? []).map((n) => n.note)
    assert.ok(!ids.includes(bHarm.id))
    assert.ok(titles.every((t) => !/^Beta/.test(t)), `beta title leaked: ${titles.join(', ')}`)
    assert.ok(!notes.some((n) => /beta/i.test(n)))
    assert.equal(report.existing.total, 1)
  })

  it('writes nothing: access_count and updated_at stay put', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Untouched distill subject',
      body: 'if access_count moves, distill is not read-only',
      project: 'alpha',
    })
    memory.feedback({ id, verdict: 'harmful', note: 'so we have something to report' })

    const before = snapAccess()
    const janitorBefore = memory.db.prepare(`SELECT key, value FROM janitor_state ORDER BY key`).all()
    const report = memory.distill({ project: 'alpha' })
    assert.ok(report.failures.items.some((i) => i.id === id))
    assert.deepEqual(snapAccess(), before)
    assert.deepEqual(
      memory.db.prepare(`SELECT key, value FROM janitor_state ORDER BY key`).all(),
      janitorBefore,
    )
  })
})
