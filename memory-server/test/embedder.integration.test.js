/**
 * Optional real-model integration test.
 * Skipped unless CODER_MEMORY_REAL_EMBED=1 (downloads/loads MiniLM; slow).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRealEmbedder, cosine } from '../src/embedder.js'

const run = process.env.CODER_MEMORY_REAL_EMBED === '1'

describe('real MiniLM embedder (optional)', { skip: !run }, () => {
  it('embeds two related texts closer than a disjoint pair', async () => {
    const e = createRealEmbedder()
    assert.equal(e.model, 'Xenova/all-MiniLM-L6-v2')
    const a = await e.embed('deploy the release pipeline steps')
    const b = await e.embed('release pipeline deploy checklist')
    const c = await e.embed('nginx timeout tuning guide')
    assert.ok(a instanceof Float32Array)
    assert.equal(a.length, e.dim)
    assert.ok(cosine(a, b) > cosine(a, c))
  })
})
