import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractEntities } from '../src/extract.js'

describe('extractEntities', () => {
  it('extracts wikilinks as concepts and strips |alias and #anchor', () => {
    const found = extractEntities('See [[Graph Retriever]] and [[Foo|alias]] plus [[Bar#anchor]] and [[Baz|Q#x]]')
    const concepts = found.filter((e) => e.kind === 'concept').map((e) => e.name).sort()
    assert.deepEqual(concepts, ['Bar', 'Baz', 'Foo', 'Graph Retriever'].sort())
  })

  it('extracts file tokens with allow-listed extensions', () => {
    const found = extractEntities('touch src/db.js and memory.ts then README.md config.yml')
    const files = found.filter((e) => e.kind === 'file').map((e) => e.name).sort()
    assert.ok(files.some((n) => n.endsWith('db.js') || n === 'db.js' || n === 'src/db.js'))
    assert.ok(files.some((n) => n.endsWith('memory.ts') || n === 'memory.ts'))
    assert.ok(files.some((n) => n.endsWith('README.md') || n === 'README.md'))
    assert.ok(files.some((n) => n.endsWith('config.yml') || n === 'config.yml'))
  })

  it('rejects non-allow-listed extensions like e.g. and 3.4s', () => {
    const found = extractEntities('for example e.g. not a file, and timeout 3.4s is not either')
    const files = found.filter((e) => e.kind === 'file')
    assert.equal(files.length, 0)
    const names = found.map((e) => e.name)
    assert.ok(!names.includes('e.g'))
    assert.ok(!names.includes('3.4s'))
    assert.ok(!names.includes('g'))
  })

  it('extracts PascalCase modules with at least 2 humps only', () => {
    const found = extractEntities('HttpServer and GraphRetriever and User and getUser and API')
    const modules = found.filter((e) => e.kind === 'module').map((e) => e.name).sort()
    assert.deepEqual(modules, ['GraphRetriever', 'HttpServer'].sort())
    assert.ok(!modules.includes('User'))
    assert.ok(!modules.includes('getUser'))
    assert.ok(!modules.includes('API'))
  })

  it('enforces name length 3-80 and max 15 entities', () => {
    // Names shorter than 3 must never appear; single-hump Xy is not a module either.
    const short = extractEntities('ab and Xy and [[x]]')
    assert.ok(short.every((e) => e.name.length >= 3))
    assert.ok(!short.some((e) => e.name === 'ab' || e.name === 'Xy' || e.name === 'x'))

    const longName = 'A' + 'b'.repeat(40) + 'C' + 'd'.repeat(40) // > 80
    const long = extractEntities(`${longName} ok`)
    assert.ok(!long.some((e) => e.name.length > 80))

    const many = Array.from({ length: 30 }, (_, i) => `ModuleThing${String.fromCharCode(65 + (i % 26))}${i}`).join(' ')
    const capped = extractEntities(many)
    assert.ok(capped.length <= 15)
  })

  it('dedupes same name+kind within one extract', () => {
    const found = extractEntities('[[Alpha]] again [[Alpha]] and HttpServer HttpServer')
    const concepts = found.filter((e) => e.kind === 'concept' && e.name === 'Alpha')
    const modules = found.filter((e) => e.kind === 'module' && e.name === 'HttpServer')
    assert.equal(concepts.length, 1)
    assert.equal(modules.length, 1)
  })
})
