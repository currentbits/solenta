import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory, promptPaths } from '../src/memory.js'

// #271: glob / auto / manual entries stay out of bootstrap until they match.
describe('inclusion modes', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const titles = (boot) =>
    [...boot.conventions, ...boot.strategies, ...boot.knowledge, ...boot.tasks].map((r) => r.title)

  function seed() {
    memory.store({ type: 'convention', title: 'Always rule', body: 'every turn', project: 'p' })
    memory.store({
      type: 'convention',
      title: 'Electron rule',
      body: 'only electron files',
      project: 'p',
      inclusion: 'glob',
      globs: ['electron/**/*.js', '*.css'],
    })
    memory.store({
      type: 'strategy',
      title: 'Grok config toml corruption',
      body: 'hand repair is a stopgap',
      project: 'p',
      inclusion: 'auto',
    })
    return memory.store({
      type: 'knowledge',
      title: 'Release checklist',
      body: 'only on mention',
      project: 'p',
      inclusion: 'manual',
    })
  }

  it('keeps conditional entries out without a match and counts them', () => {
    seed()
    const boot = memory.bootstrap({ project: 'p', prompt: 'fix the sidebar' })
    assert.deepEqual(titles(boot), ['Always rule'])
    assert.equal(boot.deferred, 3)
  })

  it('loads each mode on its own trigger, matched entries first', () => {
    const manual = seed()
    const boot = memory.bootstrap({
      project: 'p',
      files: ['electron/sub/runner.js'],
      prompt: `the grok config keeps corrupting, see #${manual.id.slice(0, 8)}`,
    })
    assert.deepEqual(boot.conventions.map((r) => r.title), ['Electron rule', 'Always rule'])
    assert.equal(boot.conventions[0].inclusion, 'glob')
    assert.equal(boot.conventions[1].inclusion, undefined)
    assert.deepEqual(boot.strategies.map((r) => r.title), ['Grok config toml corruption'])
    assert.deepEqual(boot.knowledge.map((r) => r.title), ['Release checklist'])
    assert.equal(boot.deferred, 0)
  })

  it('matches paths named in the prompt and slash-less globs by basename', () => {
    seed()
    assert.ok(titles(memory.bootstrap({ project: 'p', prompt: 'edit `electron/ask.js:74`' })).includes('Electron rule'))
    assert.ok(titles(memory.bootstrap({ project: 'p', files: ['src/a/b.css'] })).includes('Electron rule'))
    assert.ok(!titles(memory.bootstrap({ project: 'p', files: ['src/ask.js'] })).includes('Electron rule'))
  })

  it('strips the project root from absolute file paths', () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-tree-'))
    try {
      memory.store({
        type: 'convention',
        title: 'Tree rule',
        body: 'b',
        project: tree,
        inclusion: 'glob',
        globs: ['electron/*.js'],
      })
      const boot = memory.bootstrap({ project: tree, files: [path.join(tree, 'electron', 'x.js')] })
      assert.deepEqual(titles(boot), ['Tree rule'])
    } finally {
      fs.rmSync(tree, { recursive: true, force: true })
    }
  })

  it('matchedOnly drops the always-on pack and the wiki', () => {
    seed()
    const boot = memory.bootstrap({ project: 'p', prompt: 'grok config', matchedOnly: true })
    assert.deepEqual(titles(boot), ['Grok config toml corruption'])
    assert.equal(boot.wiki, null)
  })

  it('validates and inherits inclusion through supersede', () => {
    assert.throws(
      () => memory.store({ type: 'knowledge', title: 't', body: 'b', inclusion: 'glob' }),
      /needs at least one glob/,
    )
    assert.throws(
      () => memory.store({ type: 'knowledge', title: 't', body: 'b', globs: ['*.js'] }),
      /only valid with inclusion 'glob'/,
    )
    assert.throws(
      () => memory.store({ type: 'knowledge', title: 't', body: 'b', inclusion: 'sometimes' }),
      /invalid inclusion/,
    )
    const { id } = memory.store({
      type: 'knowledge',
      title: 'scoped',
      body: 'b',
      inclusion: 'glob',
      globs: ['*.js'],
    })
    const kept = memory.supersede(id, { body: 'b2' })
    assert.equal(memory.get(kept.id).inclusion, 'glob')
    assert.deepEqual(memory.get(kept.id).globs, ['*.js'])
    const auto = memory.supersede(kept.id, { inclusion: 'auto' })
    assert.equal(memory.get(auto.id).inclusion, 'auto')
    assert.equal(memory.get(auto.id).globs, undefined)
    const always = memory.supersede(auto.id, { inclusion: 'always' })
    assert.equal(memory.get(always.id).inclusion, 'always')
  })

  it('promptPaths picks path-like tokens', () => {
    assert.deepEqual(promptPaths('see electron/ask.js:74, then README.md. ok'), [
      'electron/ask.js',
      'README.md',
    ])
  })
})
