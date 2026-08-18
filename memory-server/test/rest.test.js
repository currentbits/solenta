import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Memory } from '../src/memory.js'
import { startServer } from '../src/index.js'

const TOKEN = 'test-token-0123456789abcdef'

describe('REST convenience + new MCP tools', () => {
  let server
  let baseURL
  let memory

  before(async () => {
    memory = new Memory(':memory:')
    server = await startServer(memory, { port: 0, token: TOKEN, dbPath: ':memory:' })
    const addr = server.address()
    baseURL = `http://127.0.0.1:${addr.port}`
  })

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
    memory.close()
  })

  function authHeaders(extra = {}) {
    return { Authorization: `Bearer ${TOKEN}`, ...extra }
  }

  it('REST endpoints require bearer auth', async () => {
    for (const path of ['/api/recent', '/api/search?query=x', '/api/entry/x']) {
      const res = await fetch(`${baseURL}${path}`)
      assert.equal(res.status, 401, path)
    }
    const post = await fetch(`${baseURL}/api/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'knowledge', title: 't', body: 'b' }),
    })
    assert.equal(post.status, 401)
  })

  it('GET /api/recent, /api/search, /api/entry/:id, POST /api/store shapes', async () => {
    const storeRes = await fetch(`${baseURL}/api/store`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        type: 'knowledge',
        title: 'REST fact',
        body: 'the restwalrus operator for rest tests',
        project: 'coder',
      }),
    })
    assert.equal(storeRes.status, 200)
    const stored = await storeRes.json()
    assert.ok(stored.id)

    const recent = await fetch(`${baseURL}/api/recent?limit=10`, { headers: authHeaders() })
    assert.equal(recent.status, 200)
    const recentBody = await recent.json()
    assert.ok(Array.isArray(recentBody))
    const recentHit = recentBody.find((r) => r.id === stored.id)
    assert.ok(recentHit)
    // App contract: list rows carry body (excerpt form) and updated_at.
    assert.equal(typeof recentHit.body, 'string')
    assert.ok(recentHit.body.length > 0)
    assert.ok(recentHit.updated_at, 'list rows must carry updated_at')
    assert.equal(recentHit.excerpt, undefined)

    const search = await fetch(
      `${baseURL}/api/search?query=${encodeURIComponent('restwalrus')}&project=coder`,
      { headers: authHeaders() },
    )
    assert.equal(search.status, 200)
    const searchBody = await search.json()
    assert.ok(Array.isArray(searchBody))
    const searchHit = searchBody.find((h) => h.id === stored.id)
    assert.ok(searchHit)
    assert.equal(typeof searchHit.body, 'string')
    assert.ok(searchHit.updated_at, 'search rows must carry updated_at')

    const entry = await fetch(`${baseURL}/api/entry/${stored.id}`, { headers: authHeaders() })
    assert.equal(entry.status, 200)
    const full = await entry.json()
    assert.equal(full.body, 'the restwalrus operator for rest tests')
    assert.equal(full.id, stored.id)
    assert.equal(full.source, 'rest')
    assert.equal(recentHit.source, 'rest')
    assert.equal(searchHit.source, 'rest')
  })

  it('POST /api/store accepts agent+source and GET /api/search filters by agent', async () => {
    const storeRes = await fetch(`${baseURL}/api/store`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        type: 'knowledge',
        title: 'REST provenance',
        body: 'restprovenanceword from grok via app',
        project: 'coder',
        agent: 'grok',
        source: 'app',
      }),
    })
    assert.equal(storeRes.status, 200)
    const stored = await storeRes.json()

    const other = await fetch(`${baseURL}/api/store`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        type: 'knowledge',
        title: 'REST other writer',
        body: 'restprovenanceword from claude',
        project: 'coder',
        agent: 'claude',
        source: 'mcp',
      }),
    })
    assert.equal(other.status, 200)
    const otherStored = await other.json()

    const entry = await fetch(`${baseURL}/api/entry/${stored.id}`, { headers: authHeaders() })
    const full = await entry.json()
    assert.equal(full.agent, 'grok')
    assert.equal(full.source, 'app')

    const filtered = await fetch(
      `${baseURL}/api/search?query=${encodeURIComponent('restprovenanceword')}&project=coder&agent=grok`,
      { headers: authHeaders() },
    )
    assert.equal(filtered.status, 200)
    const hits = await filtered.json()
    assert.ok(hits.some((h) => h.id === stored.id))
    assert.ok(hits.every((h) => h.agent === 'grok'))
    assert.ok(!hits.some((h) => h.id === otherStored.id))
  })

  it('POST /api/store persists citations and GET surfaces them', async () => {
    const citations = [
      { kind: 'file', path: 'src/auth.ts', line: 4, excerpt: 'export function checkToken' },
      { kind: 'thread', id: 'thread-rest' },
    ]
    const storeRes = await fetch(`${baseURL}/api/store`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        type: 'knowledge',
        title: 'REST cited fact',
        body: 'restcitedword lives at src/auth.ts',
        project: 'coder',
        citations,
      }),
    })
    assert.equal(storeRes.status, 200)
    const stored = await storeRes.json()
    const entry = await fetch(`${baseURL}/api/entry/${stored.id}`, { headers: authHeaders() })
    const full = await entry.json()
    assert.deepEqual(full.citations, citations)
    const recent = await fetch(`${baseURL}/api/recent?limit=20`, { headers: authHeaders() })
    const recentHit = (await recent.json()).find((r) => r.id === stored.id)
    assert.ok(recentHit)
    assert.deepEqual(recentHit.citations, citations)
  })

  it('GET /health includes janitor snapshot', async () => {
    const res = await fetch(`${baseURL}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.ok(body.janitor)
    assert.equal(typeof body.janitor.liveEntries, 'number')
    assert.equal(typeof body.janitor.entityCount, 'number')
    assert.equal(typeof body.janitor.edgeCount, 'number')
  })

  it('POST /api/store rejects bodies over 1MB with 413 {error}', async () => {
    const big = 'x'.repeat(1024 * 1024 + 64)
    const res = await fetch(`${baseURL}/api/store`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        type: 'knowledge',
        title: 'too big',
        body: big,
      }),
    })
    assert.equal(res.status, 413)
    const body = await res.json()
    assert.ok(body.error)
    assert.match(String(body.error), /too large/i)
  })

  // The app stores through REST and agents read through MCP: a strategy written
  // from the Memory tab has to come back out of bootstrap and memory_distill.
  it('a strategy stored over REST reaches bootstrap and memory_distill', async () => {
    const stored = await fetch(`${baseURL}/api/store`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        type: 'strategy',
        title: 'Clone node_modules into a fresh worktree',
        body: "When tests fail on missing modules in a worktree, don't npm install: cp -Rc from the main checkout.",
        project: 'coder',
      }),
    })
    assert.equal(stored.status, 200)
    const { id } = await stored.json()
    assert.ok(id)

    const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    })
    const mcp = new Client({ name: 'test', version: '0.0.0' })
    await mcp.connect(transport)

    const boot = await mcp.callTool({ name: 'memory_bootstrap', arguments: { project: 'coder' } })
    const strategies = JSON.parse(boot.content[0].text).strategies
    assert.ok(strategies.some((s) => s.id === id))

    const distilled = await mcp.callTool({ name: 'memory_distill', arguments: { project: 'coder' } })
    const existing = JSON.parse(distilled.content[0].text).existing
    assert.ok(existing.items.some((s) => s.id === id))

    await mcp.close()
  })

  it('MCP exposes memory_recent and memory_feedback', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    })
    const mcp = new Client({ name: 'test', version: '0.0.0' })
    await mcp.connect(transport)

    const tools = await mcp.listTools()
    const names = tools.tools.map((t) => t.name).sort()
    assert.ok(names.includes('memory_recent'))
    assert.ok(names.includes('memory_feedback'))
    assert.ok(names.includes('memory_store'))

    const recent = await mcp.callTool({ name: 'memory_recent', arguments: { limit: 5 } })
    const recentList = JSON.parse(recent.content[0].text)
    assert.ok(Array.isArray(recentList))
    assert.ok(recentList.length >= 1)
    assert.equal(recentList[0].body, undefined)

    const id = recentList[0].id
    const fb = await mcp.callTool({
      name: 'memory_feedback',
      arguments: { id, verdict: 'helpful', note: 'yes' },
    })
    const fbBody = JSON.parse(fb.content[0].text)
    assert.equal(fbBody.ok, true)

    await mcp.close()
  })
})
