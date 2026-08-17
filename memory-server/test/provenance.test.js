import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'

describe('provenance (#309)', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-prov-'))
    memory = new Memory(path.join(dir, 'memory.db'))
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('store with agent+source round-trips through get and search', async () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Provenance fact',
      body: 'uniqueprovenanceword lives here',
      agent: 'grok',
      source: 'mcp',
      project: 'p',
    })
    const got = memory.get(id)
    assert.equal(got.agent, 'grok')
    assert.equal(got.source, 'mcp')

    const hits = await memory.search({ query: 'uniqueprovenanceword', project: 'p' })
    const hit = hits.find((h) => h.id === id)
    assert.ok(hit)
    assert.equal(hit.agent, 'grok')
    assert.equal(hit.source, 'mcp')

    const recents = memory.recent({ project: 'p' })
    const recent = recents.find((r) => r.id === id)
    assert.ok(recent)
    assert.equal(recent.agent, 'grok')
    assert.equal(recent.source, 'mcp')
  })

  it('store with neither agent nor source returns nulls', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Bare fact',
      body: 'no writer and no surface',
    })
    const got = memory.get(id)
    assert.equal(got.agent, null)
    assert.equal(got.source, null)
  })

  it('supersede preserves agent and source when omitted', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Old provenance',
      body: 'original provenance body text',
      agent: 'claude',
      source: 'app',
    })
    const { id: next } = memory.supersede(id, {
      title: 'New provenance',
      body: 'updated provenance body text',
    })
    const got = memory.get(next)
    assert.equal(got.agent, 'claude')
    assert.equal(got.source, 'app')
  })

  it('supersede can replace agent and source', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Rewrite me',
      body: 'original rewrite body text here',
      agent: 'claude',
      source: 'app',
    })
    const { id: next } = memory.supersede(id, {
      body: 'corrected rewrite body text here',
      agent: 'grok',
      source: 'import',
    })
    const got = memory.get(next)
    assert.equal(got.agent, 'grok')
    assert.equal(got.source, 'import')
  })

  it('search agent filter excludes other writers', async () => {
    const mine = memory.store({
      type: 'knowledge',
      title: 'Mine',
      body: 'sharedfiltertoken written by grok',
      agent: 'grok',
      force: true,
    })
    const theirs = memory.store({
      type: 'knowledge',
      title: 'Theirs',
      body: 'sharedfiltertoken written by claude',
      agent: 'claude',
      force: true,
    })

    const onlyGrok = await memory.search({ query: 'sharedfiltertoken', agent: 'grok' })
    assert.ok(onlyGrok.some((h) => h.id === mine.id))
    assert.ok(onlyGrok.every((h) => h.agent === 'grok'))
    assert.ok(!onlyGrok.some((h) => h.id === theirs.id))

    const all = await memory.search({ query: 'sharedfiltertoken' })
    assert.ok(all.some((h) => h.id === mine.id))
    assert.ok(all.some((h) => h.id === theirs.id))
  })

  it('bootstrap tasks surface source next to agent', () => {
    memory.store({
      type: 'task',
      title: 'Open provenance task',
      body: 'do the provenance thing',
      status: 'active',
      agent: 'grok',
      source: 'janitor',
      project: 'p',
    })
    const boot = memory.bootstrap({ project: 'p' })
    const task = boot.tasks.find((t) => t.title === 'Open provenance task')
    assert.ok(task)
    assert.equal(task.agent, 'grok')
    assert.equal(task.source, 'janitor')
  })
})
