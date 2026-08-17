import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'
import { fakeEmbedder } from '../src/embedder.js'
import { semanticNeighbors } from '../src/review.js'

describe('semanticNeighbors', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-sn-'))
    memory = new Memory(path.join(dir, 'memory.db'), {
      startJanitor: false,
      embedder: fakeEmbedder(64),
    })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Store and make sure the vector has landed (store fires embed async). */
  async function seed(fields) {
    const { id } = memory.store(fields)
    await memory.embedEntry(id)
    return id
  }

  it('ranks by cosine, honours minScore, and never returns the excluded entry', async () => {
    const twin = await seed({
      type: 'knowledge',
      title: 'deploys run through girder',
      body: 'girder deploys push over ssh',
      project: 'p',
    })
    await seed({
      type: 'knowledge',
      title: 'lunch is at noon',
      body: 'sandwiches downstairs',
      project: 'p',
    })
    const self = await seed({
      type: 'knowledge',
      title: 'deploys run through girder',
      body: 'girder deploys push over ssh',
      project: 'p',
      force: true,
    })

    const vec = memory.embedder.embed('deploys run through girder\ngirder deploys push over ssh')
    const hits = semanticNeighbors(memory.db, vec, {
      model: 'fake',
      project: 'p',
      exclude: self,
      minScore: 0.6,
    })

    assert.equal(hits.length, 1, 'only the paraphrase clears the floor')
    assert.equal(hits[0].id, twin)
    assert.ok(hits[0].score >= 0.6)
  })

  it('stays inside the project scope and skips dead entries', async () => {
    await seed({ type: 'knowledge', title: 'shared fact', body: 'same words', project: 'other' })
    const dead = await seed({
      type: 'knowledge',
      title: 'shared fact',
      body: 'same words',
      project: 'p',
    })
    memory.db.prepare(`UPDATE entries SET invalid_at = ? WHERE id = ?`).run('now', dead)

    const vec = memory.embedder.embed('shared fact\nsame words')
    assert.deepEqual(
      semanticNeighbors(memory.db, vec, { model: 'fake', project: 'p', minScore: 0.6 }),
      [],
    )
  })

  it('returns [] rather than throwing on a missing vector or unknown model', () => {
    assert.deepEqual(semanticNeighbors(memory.db, null, { model: 'fake' }), [])
    const vec = memory.embedder.embed('anything')
    assert.deepEqual(semanticNeighbors(memory.db, vec, { model: 'nope' }), [])
  })
})
