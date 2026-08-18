import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'

describe('memory citations + JIT verify (#395)', () => {
  let dir
  let tree
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cite-mem-'))
    tree = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cite-tree-'))
    fs.mkdirSync(path.join(tree, 'src'))
    fs.writeFileSync(
      path.join(tree, 'src', 'auth.ts'),
      ['export function checkToken(t) {', '  return t === SECRET', '}', ''].join('\n'),
    )
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(tree, { recursive: true, force: true })
  })

  const fileCite = (over = {}) => ({
    kind: 'file',
    path: 'src/auth.ts',
    line: 1,
    excerpt: 'export function checkToken(t) {',
    ...over,
  })

  it('store/get/search/bootstrap round-trip citations', async () => {
    const citations = [
      fileCite(),
      { kind: 'thread', id: 'thread-xyz' },
      { kind: 'commit', sha: 'abcdef1234567890' },
    ]
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Token check lives in auth',
      body: 'checkToken is the gate for bearer tokens uniquecitetoken',
      project: tree,
      citations,
    })

    const got = memory.get(id)
    assert.deepEqual(got.citations, [
      fileCite(),
      { kind: 'thread', id: 'thread-xyz' },
      { kind: 'commit', sha: 'abcdef1234567890' },
    ])

    // Slug scope: same project key, but not a live path, so no JIT verify.
    const scope = path.basename(tree)
    const hits = await memory.search({ query: 'uniquecitetoken', project: scope })
    const hit = hits.find((h) => h.id === id)
    assert.ok(hit)
    assert.ok(hit.citations.some((c) => c.kind === 'file' && c.path === 'src/auth.ts'))

    const recents = memory.recent({ project: scope })
    const recent = recents.find((r) => r.id === id)
    assert.ok(recent)
    assert.equal(recent.citations.length, 3)

    const boot = memory.bootstrap({ project: scope })
    const k = boot.knowledge.find((row) => row.id === id)
    assert.ok(k)
    assert.equal(k.citations.length, 3)
  })

  it('supersede preserves citations when omitted and replaces when given', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Old cited fact',
      body: 'original cited body text here',
      citations: [fileCite()],
    })
    const { id: kept } = memory.supersede(id, {
      title: 'Still cited fact',
      body: 'updated cited body text here',
    })
    assert.deepEqual(memory.get(kept).citations, [fileCite()])

    const { id: replaced } = memory.supersede(kept, {
      body: 'corrected cited body text here',
      citations: [{ kind: 'thread', id: 'new-thread' }],
    })
    assert.deepEqual(memory.get(replaced).citations, [{ kind: 'thread', id: 'new-thread' }])
  })

  it('bootstrap injects a file-cited entry whose excerpt still matches', () => {
    const { id } = memory.store({
      type: 'convention',
      title: 'Use checkToken',
      body: 'all routes go through checkToken',
      project: tree,
      citations: [fileCite()],
    })
    const boot = memory.bootstrap({ project: tree })
    const row = boot.conventions.find((c) => c.id === id)
    assert.ok(row, 'matching citation must still be injected')
    assert.equal(row.verified, true)
    assert.equal(memory.get(id).invalid_at, null)
  })

  it('heals a drifted line and still injects', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'checkToken line',
      body: 'the token helper uniquedriftword',
      project: tree,
      citations: [fileCite({ line: 80 })],
    })
    const boot = memory.bootstrap({ project: tree })
    const row = boot.knowledge.find((k) => k.id === id)
    assert.ok(row, 'healed citation must still be injected')
    assert.equal(row.citations[0].line, 1)
    const stored = memory.db.prepare(`SELECT citations FROM entries WHERE id = ?`).get(id)
    const parsed = JSON.parse(stored.citations)
    assert.equal(parsed[0].line, 1)
  })

  it('invalidates and omits when the excerpt is gone', () => {
    const { id } = memory.store({
      type: 'convention',
      title: 'Old helper name',
      body: 'call vanishedHelper on every request',
      project: tree,
      citations: [fileCite({ excerpt: 'export function vanishedHelper() {' })],
    })
    const boot = memory.bootstrap({ project: tree })
    assert.ok(!boot.conventions.some((c) => c.id === id))
    const stub = memory.get(id)
    assert.equal(stub.invalidated, true)
    assert.match(String(stub.invalidation_reason || ''), /stale|excerpt/i)
  })

  it('invalidates and omits when the cited file is gone', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Deleted module',
      body: 'legacy helper uniquegoneword',
      project: tree,
      citations: [fileCite({ path: 'src/gone.ts', excerpt: 'export const gone = 1' })],
    })
    const boot = memory.bootstrap({ project: tree })
    assert.ok(!boot.knowledge.some((k) => k.id === id))
    assert.equal(memory.get(id).invalidated, true)
  })

  it('skips verify when project is a slug, so uncheckable citations still inject', () => {
    const { id } = memory.store({
      type: 'convention',
      title: 'Unverifiable here',
      body: 'this fact has a citation we cannot check without a path',
      project: tree,
      citations: [fileCite({ excerpt: 'export function vanishedHelper() {' })],
    })
    const boot = memory.bootstrap({ project: path.basename(tree) })
    assert.ok(boot.conventions.some((c) => c.id === id))
    const live = memory.db.prepare(`SELECT invalid_at FROM entries WHERE id = ?`).get(id)
    assert.equal(live.invalid_at, null)
  })

  it('search against a live worktree drops a contradicted hit and writes back', async () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Stale search fact',
      body: 'uniquesearchcite still claims vanishedHelper exists',
      project: tree,
      citations: [fileCite({ excerpt: 'export function vanishedHelper() {' })],
    })
    const hits = await memory.search({ query: 'uniquesearchcite', project: tree })
    assert.ok(!hits.some((h) => h.id === id))
    assert.equal(memory.get(id).invalidated, true)
  })

  it('get with a live project path verifies and can invalidate', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Get-time stale',
      body: 'uniquegetcite vanished helper',
      project: tree,
      citations: [fileCite({ excerpt: 'export function vanishedHelper() {' })],
    })
    const stub = memory.get(id, { project: tree })
    assert.equal(stub.invalidated, true)
  })

  it('bootstrap protocol tells agents to cite and that verify writes back', () => {
    const boot = memory.bootstrap({})
    assert.ok(
      boot.protocol.some((p) => /cit(e|ations)/i.test(p) && /file/.test(p)),
      `protocol missing cite-evidence sentence: ${JSON.stringify(boot.protocol)}`,
    )
    assert.ok(
      boot.protocol.some((p) => /verif/i.test(p) && /invalidat/i.test(p)),
      `protocol missing JIT-verify sentence: ${JSON.stringify(boot.protocol)}`,
    )
  })

  it('uncited entries still inject', () => {
    const { id } = memory.store({
      type: 'convention',
      title: 'No citation yet',
      body: 'legacy uncited convention still applies',
      project: tree,
    })
    const boot = memory.bootstrap({ project: tree })
    assert.ok(boot.conventions.some((c) => c.id === id))
  })
})
