import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  normalizeCitations,
  parseCitations,
  serializeCitations,
  resolveVerifyRoot,
  resolveSafePath,
  verifyFileCitation,
  verifyFileCitations,
  formatCitation,
} from '../src/citations.js'

describe('normalizeCitations', () => {
  it('keeps a file citation with path, line, and excerpt', () => {
    const out = normalizeCitations([
      { kind: 'file', path: 'src/foo.ts', line: 12, excerpt: 'export function bar()' },
    ])
    assert.deepEqual(out, [
      { kind: 'file', path: 'src/foo.ts', line: 12, excerpt: 'export function bar()' },
    ])
  })

  it('keeps thread and commit citations', () => {
    const out = normalizeCitations([
      { kind: 'thread', id: 'abc-123' },
      { kind: 'commit', sha: 'deadbeefcafebabe' },
    ])
    assert.deepEqual(out, [
      { kind: 'thread', id: 'abc-123' },
      { kind: 'commit', sha: 'deadbeefcafebabe' },
    ])
  })

  it('drops junk, caps at 8, and strips a leading ./', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      kind: 'file',
      path: `./src/f${i}.ts`,
      excerpt: `line ${i}`,
    }))
    const out = normalizeCitations([
      null,
      { kind: 'file' },
      { kind: 'thread', id: '' },
      { kind: 'commit', sha: 'not-hex' },
      { kind: 'mystery', path: 'x' },
      ...many,
    ])
    assert.equal(out.length, 8)
    assert.equal(out[0].path, 'src/f0.ts')
  })

  it('returns [] for missing or empty input', () => {
    assert.deepEqual(normalizeCitations(undefined), [])
    assert.deepEqual(normalizeCitations(null), [])
    assert.deepEqual(normalizeCitations([]), [])
    assert.deepEqual(normalizeCitations('nope'), [])
  })
})

describe('parse/serialize', () => {
  it('round-trips a citation list', () => {
    const list = [{ kind: 'file', path: 'a.js', line: 1, excerpt: 'hi' }]
    assert.deepEqual(parseCitations(serializeCitations(list)), list)
  })

  it('parseCitations accepts already-parsed arrays and junk JSON', () => {
    assert.deepEqual(parseCitations([{ kind: 'thread', id: 't' }]), [
      { kind: 'thread', id: 't' },
    ])
    assert.deepEqual(parseCitations('not-json'), [])
    assert.deepEqual(parseCitations(null), [])
  })
})

describe('formatCitation', () => {
  it('renders file:line, thread short id, and short sha', () => {
    assert.equal(
      formatCitation({ kind: 'file', path: 'src/a.ts', line: 9 }),
      'src/a.ts:9',
    )
    assert.equal(formatCitation({ kind: 'file', path: 'src/a.ts' }), 'src/a.ts')
    assert.equal(formatCitation({ kind: 'thread', id: 'abcdefghij' }), 'thread abcdefgh')
    assert.equal(formatCitation({ kind: 'commit', sha: 'abcdef123456' }), 'abcdef1')
  })
})

describe('verifyFileCitation', () => {
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-cite-'))
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(
      path.join(dir, 'src', 'foo.ts'),
      ['export const A = 1', 'export function bar() {', '  return A', '}', ''].join('\n'),
    )
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('resolves a live directory and rejects a missing path', () => {
    assert.equal(resolveVerifyRoot(dir), path.resolve(dir))
    assert.equal(resolveVerifyRoot('/definitely/missing/nope'), null)
    assert.equal(resolveVerifyRoot('just-a-slug'), null)
  })

  it('refuses paths that escape the worktree', () => {
    assert.equal(resolveSafePath(dir, '../outside.ts'), null)
    assert.equal(resolveSafePath(dir, '/etc/passwd'), null)
    assert.ok(resolveSafePath(dir, 'src/foo.ts'))
  })

  it('ok when the excerpt sits on the cited line', () => {
    const result = verifyFileCitation(dir, {
      kind: 'file',
      path: 'src/foo.ts',
      line: 2,
      excerpt: 'export function bar() {',
    })
    assert.equal(result.ok, true)
    assert.equal(result.line, 2)
    assert.equal(result.healed, false)
  })

  it('heals the line when the excerpt moved inside the file', () => {
    const result = verifyFileCitation(dir, {
      kind: 'file',
      path: 'src/foo.ts',
      line: 40,
      excerpt: 'export function bar() {',
    })
    assert.equal(result.ok, true)
    assert.equal(result.line, 2)
    assert.equal(result.healed, true)
  })

  it('fails when the file is gone', () => {
    const result = verifyFileCitation(dir, {
      kind: 'file',
      path: 'src/missing.ts',
      line: 1,
      excerpt: 'anything',
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /missing|gone|not found/i)
  })

  it('fails when the excerpt is no longer in the file', () => {
    const result = verifyFileCitation(dir, {
      kind: 'file',
      path: 'src/foo.ts',
      line: 2,
      excerpt: 'export function vanished() {',
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /stale|no longer|excerpt/i)
  })

  it('is unverifiable (not a failure) without an excerpt', () => {
    const result = verifyFileCitation(dir, {
      kind: 'file',
      path: 'src/foo.ts',
      line: 2,
    })
    assert.equal(result.ok, true)
    assert.equal(result.verifiable, false)
  })

  it('verifyFileCitations heals one file cite and ignores thread/commit', () => {
    const result = verifyFileCitations(dir, [
      { kind: 'file', path: 'src/foo.ts', line: 99, excerpt: 'return A' },
      { kind: 'thread', id: 't1' },
      { kind: 'commit', sha: 'abc1234' },
    ])
    assert.equal(result.ok, true)
    assert.equal(result.healed, true)
    assert.equal(result.citations[0].line, 3)
    assert.equal(result.citations[1].kind, 'thread')
  })

  it('verifyFileCitations fails the whole set when one file cite is stale', () => {
    const result = verifyFileCitations(dir, [
      { kind: 'file', path: 'src/foo.ts', line: 2, excerpt: 'export function bar() {' },
      { kind: 'file', path: 'src/foo.ts', line: 1, excerpt: 'this never existed' },
    ])
    assert.equal(result.ok, false)
    assert.match(result.reason, /stale|no longer|excerpt/i)
  })
})
