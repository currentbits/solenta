import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory, contentTokens, jaccard } from '../src/memory.js'
import { fakeEmbedder } from '../src/embedder.js'

/**
 * fakeEmbedder is a token-hash bag: low-Jaccard paraphrases land well below
 * SEMANTIC_DUP. Map the two paraphrase phrases onto one seed so they share a
 * dim-64 vector the way MiniLM would, while unrelated text still goes through
 * fakeEmbedder(64) (dim 8 collides above 0.6 and would make the negative lie).
 */
function dim64Embedder() {
  const inner = fakeEmbedder(64)
  const seed = inner.embed('canonical-ssh-deploy-vector-seed')
  return {
    model: inner.model,
    dim: inner.dim,
    embed(text) {
      const s = String(text).toLowerCase()
      if (s.includes('deploys go over ssh') || s.includes('we ship via ssh push')) return seed
      return inner.embed(text)
    },
  }
}

describe('semantic near-dup on write (embedEntry)', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-semwrite-'))
    memory = new Memory(path.join(dir, 'memory.db'), {
      startJanitor: false,
      embedder: dim64Embedder(),
    })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function openRows() {
    return memory.db
      .prepare(
        `SELECT kind, entry_a, entry_b, detail FROM review_queue WHERE resolved_at IS NULL ORDER BY id`,
      )
      .all()
  }

  it('paraphrases with low Jaccard store and enqueue near_dup with cosine= detail', async () => {
    const aText = { title: 'Deploys go over ssh', body: 'the box takes the git push' }
    const bText = { title: 'We ship via ssh push', body: 'release lands on the remote host' }
    const overlap = jaccard(
      contentTokens(`${aText.title} ${aText.body}`),
      contentTokens(`${bText.title} ${bText.body}`),
    )
    assert.ok(overlap < 0.4, `jaccard ${overlap} must be below the lexical warn band`)

    const a = memory.store({ type: 'knowledge', ...aText, project: 'demo' })
    const b = memory.store({ type: 'knowledge', ...bText, project: 'demo' })
    await memory.embedEntry(a.id)
    await memory.embedEntry(b.id)

    const rows = openRows()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'near_dup')
    assert.match(rows[0].detail ?? '', /cosine=/)
    const pair = new Set([rows[0].entry_a, rows[0].entry_b])
    assert.ok(pair.has(a.id))
    assert.ok(pair.has(b.id))
  })

  it('unrelated entries queue no semantic pair', async () => {
    const a = memory.store({
      type: 'knowledge',
      title: 'Deploys go over ssh',
      body: 'the box takes the git push',
      project: 'demo',
    })
    const b = memory.store({
      type: 'knowledge',
      title: 'Lunch is at noon',
      body: 'sandwiches downstairs in the kitchen',
      project: 'demo',
    })
    await memory.embedEntry(a.id)
    await memory.embedEntry(b.id)
    assert.equal(openRows().length, 0)
  })

  it('type task never queues a semantic pair', async () => {
    const a = memory.store({
      type: 'knowledge',
      title: 'Deploys go over ssh',
      body: 'the box takes the git push',
      project: 'demo',
    })
    await memory.embedEntry(a.id)
    const b = memory.store({
      type: 'task',
      title: 'We ship via ssh push',
      body: 'release lands on the remote host',
      status: 'active',
      project: 'demo',
    })
    await memory.embedEntry(b.id)
    assert.equal(openRows().length, 0)
  })
})
