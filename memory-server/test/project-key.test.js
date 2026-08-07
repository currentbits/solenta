import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { canonicalProject } from '../src/project-key.js'
import { Memory } from '../src/memory.js'
import { fakeEmbedder } from '../src/embedder.js'
import { openDb, createSchema, normalizeProjectKeys } from '../src/db.js'

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('canonical project keys', () => {
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-projkey-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('maps global-ish values to null', () => {
    assert.equal(canonicalProject(null), null)
    assert.equal(canonicalProject(''), null)
    assert.equal(canonicalProject('   '), null)
    assert.equal(canonicalProject('global'), null)
  })

  it('keeps a plain slug and strips an owner prefix', () => {
    assert.equal(canonicalProject('coder'), 'coder')
    assert.equal(canonicalProject('pingdotgg/t3code'), 't3code')
  })

  it('resolves a repo path to its basename', () => {
    const repo = path.join(dir, 'myrepo')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])
    assert.equal(canonicalProject(repo), 'myrepo')
  })

  it('resolves a linked WORKTREE to the MAIN repo basename', () => {
    const repo = path.join(dir, 'mainrepo')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])
    fs.writeFileSync(path.join(repo, 'f.txt'), 'x')
    git(repo, ['add', '-A'])
    git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    const wt = path.join(dir, 'wt-branch-abc123')
    git(repo, ['worktree', 'add', '-q', '-b', 'feat', wt])
    // The whole point: a worktree must NOT become its own project.
    assert.equal(canonicalProject(wt), 'mainrepo')
  })

  it('falls back to the basename for a non-repo path', () => {
    const plain = path.join(dir, 'not-a-repo')
    fs.mkdirSync(plain)
    assert.equal(canonicalProject(plain), 'not-a-repo')
  })

  it('is idempotent', () => {
    assert.equal(canonicalProject(canonicalProject('owner/coder')), 'coder')
  })
})

describe('project scoping end to end', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-projscope-'))
    memory = new Memory(path.join(dir, 'mem.db'), { embedder: fakeEmbedder(8) })
  })
  afterEach(() => {
    memory.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('an entry stored with a slug is found when querying with the repo path', async () => {
    const repo = path.join(dir, 'coder')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])

    // App-side write: display slug.
    memory.store({
      type: 'knowledge',
      title: 'Scoped fact zanzibar',
      body: 'this fact belongs to the coder project only, zanzibar marker',
      project: 'owner/coder',
    })
    // Agent-side read: working directory path.
    const hits = await memory.search({ query: 'zanzibar', project: repo })
    assert.equal(hits.length, 1, `expected the slug-stored entry, got ${JSON.stringify(hits)}`)

    // And an unrelated project must NOT see it.
    const other = path.join(dir, 'elsewhere')
    fs.mkdirSync(other)
    git(other, ['init', '-q'])
    const miss = await memory.search({ query: 'zanzibar', project: other })
    assert.equal(miss.length, 0)
  })

  it('bootstrap and recent honour the canonical key', async () => {
    memory.store({
      type: 'convention',
      title: 'Project rule quokka',
      body: 'always run the quokka linter before committing in this project',
      project: 'coder',
    })
    const repo = path.join(dir, 'coder')
    fs.mkdirSync(repo)
    const brief = await memory.bootstrap({ project: repo })
    const all = JSON.stringify(brief)
    assert.ok(all.includes('quokka'), `bootstrap missed the project convention: ${all.slice(0, 300)}`)

    const recent = memory.recent({ limit: 10, project: repo })
    assert.ok(recent.some((r) => r.title.includes('quokka')))
  })

  it('transcripts scope by canonical key too', () => {
    memory.recordSession({
      sessionId: 's1',
      project: 'owner/coder',
      threadTitle: 't',
      agent: 'claude',
      role: 'user',
      content: 'transcript wombat line',
    })
    const repo = path.join(dir, 'coder')
    fs.mkdirSync(repo)
    const hits = memory.sessionSearch({ query: 'wombat', project: repo })
    assert.equal(hits.length, 1)
  })
})

describe('normalizeProjectKeys migration', () => {
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-projmig-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rewrites legacy path and owner/slug rows to the canonical key', () => {
    const dbPath = path.join(dir, 'legacy.db')
    const db = openDb(dbPath)
    createSchema(db)

    // Simulate the three historical shapes landing in one column.
    const repo = path.join(dir, 'coder')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])
    const now = new Date().toISOString()
    const insert = db.prepare(
      `INSERT INTO entries (id, type, title, body, project, importance, created_at, updated_at)
       VALUES (?, 'knowledge', ?, ?, ?, 3, ?, ?)`,
    )
    insert.run('a', 'from path', 'body a', repo, now, now)
    insert.run('b', 'from owner slug', 'body b', 'owner/coder', now, now)
    insert.run('c', 'already canonical', 'body c', 'coder', now, now)

    const changed = normalizeProjectKeys(db)
    assert.ok(changed >= 2, `expected legacy rows rewritten, changed=${changed}`)
    const rows = db
      .prepare(`SELECT DISTINCT project FROM entries ORDER BY project`)
      .all()
      .map((r) => r.project)
    assert.deepEqual(rows, ['coder'])

    // Idempotent: a second pass changes nothing.
    assert.equal(normalizeProjectKeys(db), 0)
    db.close()
  })
})

describe('memory is project-scoped (no global leakage)', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-scope-'))
    memory = new Memory(path.join(dir, 'mem.db'), { embedder: fakeEmbedder(8) })
    memory.store({
      type: 'convention',
      title: 'Global rule narwhal',
      body: 'a machine-wide convention about the narwhal linter',
    })
    memory.store({
      type: 'knowledge',
      title: 'Project fact narwhal',
      body: 'a coder-specific note about the narwhal linter',
      project: 'coder',
      force: true,
    })
    memory.store({
      type: 'knowledge',
      title: 'Other project narwhal',
      body: 'an unrelated note about the narwhal linter elsewhere',
      project: 'other',
      force: true,
    })
  })
  afterEach(() => {
    memory.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('search in a project returns ONLY that project (no global, no siblings)', async () => {
    const hits = await memory.search({ query: 'narwhal', project: 'coder' })
    assert.deepEqual(
      hits.map((h) => h.title).sort(),
      ['Project fact narwhal'],
      `expected only the coder entry, got ${JSON.stringify(hits.map((h) => h.title))}`,
    )
  })

  it('recent in a project returns ONLY that project', () => {
    const rows = memory.recent({ limit: 20, project: 'coder' })
    assert.deepEqual(rows.map((r) => r.title), ['Project fact narwhal'])
  })

  it('bootstrap in a project does not serve another project or global rules', async () => {
    const brief = JSON.stringify(await memory.bootstrap({ project: 'coder' }))
    assert.ok(brief.includes('Project fact narwhal'))
    assert.ok(!brief.includes('Global rule narwhal'), 'global rule leaked into a project briefing')
    assert.ok(!brief.includes('Other project narwhal'), 'sibling project leaked')
  })

  it('transcripts scope the same way', () => {
    memory.recordSession({
      sessionId: 's-g',
      threadTitle: 't',
      agent: 'claude',
      role: 'user',
      content: 'global transcript narwhal line',
    })
    memory.recordSession({
      sessionId: 's-c',
      project: 'coder',
      threadTitle: 't',
      agent: 'claude',
      role: 'user',
      content: 'coder transcript narwhal line',
    })
    const hits = memory.sessionSearch({ query: 'narwhal', project: 'coder' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].sessionId, 's-c')
  })

  it('an unscoped query still sees everything (maintenance and browsing)', async () => {
    const all = await memory.search({ query: 'narwhal' })
    assert.equal(all.length, 3)
  })
})
