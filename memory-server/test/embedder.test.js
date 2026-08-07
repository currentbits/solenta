import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  fakeEmbedder,
  cosine,
  l2normalize,
  floatToBlob,
  blobToFloat,
  EMBED_MAX_CHARS,
} from '../src/embedder.js'

describe('vector math', () => {
  it('cosine of identical normalized vectors is ~1, orthogonal ~0', () => {
    const a = l2normalize(new Float32Array([1, 2, 3, 4]))
    const b = l2normalize(new Float32Array([1, 2, 3, 4]))
    const c = l2normalize(new Float32Array([-4, 3, -2, 1]))
    assert.ok(Math.abs(cosine(a, b) - 1) < 1e-5)
    assert.ok(Math.abs(cosine(a, c)) < 1e-5)
  })

  it('l2normalize yields unit length; zero vector stays zero', () => {
    const n = l2normalize(new Float32Array([3, 4]))
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6)
    const z = l2normalize(new Float32Array([0, 0]))
    assert.deepEqual([...z], [0, 0])
  })

  it('float<->blob round-trips exactly', () => {
    const v = new Float32Array([0.5, -1.25, 3.0, 0])
    const back = blobToFloat(floatToBlob(v))
    assert.deepEqual([...back], [...v])
  })
})

describe('fakeEmbedder', () => {
  it('is deterministic, unit-length, and correct dim', () => {
    const e = fakeEmbedder(8)
    assert.equal(e.dim, 8)
    assert.equal(e.model, 'fake')
    const v1 = e.embed('hello world')
    const v2 = e.embed('hello world')
    assert.ok(v1 instanceof Float32Array)
    assert.equal(v1.length, 8)
    assert.deepEqual([...v1], [...v2])
    assert.ok(Math.abs(Math.hypot(...v1) - 1) < 1e-5)
  })

  it('maps texts sharing tokens closer than disjoint texts (cosine ordering)', () => {
    const e = fakeEmbedder(32)
    const a = e.embed('deploy the release pipeline')
    const b = e.embed('release pipeline deploy steps')
    const c = e.embed('nginx timeout tuning')
    assert.ok(cosine(a, b) > cosine(a, c))
  })

  it('truncates input to EMBED_MAX_CHARS without throwing', () => {
    const e = fakeEmbedder(8)
    const long = 'token '.repeat(EMBED_MAX_CHARS)
    const v = e.embed(long)
    assert.ok(v instanceof Float32Array)
  })
})
