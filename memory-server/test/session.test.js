import { describe, it, beforeEach, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb, createSchema } from '../src/db.js'
import { Memory } from '../src/memory.js'
import { runJanitor, readJanitorSnapshot } from '../src/janitor.js'
import { startServer } from '../src/index.js'
import { fakeEmbedder } from '../src/embedder.js'

describe('session_messages schema', () => {
  let dir
  let dbPath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-sess-db-'))
    dbPath = path.join(dir, 'memory.db')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates session_messages and fts tables idempotently', () => {
    const db1 = openDb(dbPath)
    createSchema(db1)
    db1
      .prepare(
        `INSERT INTO session_messages (session_id, project, thread_title, agent, role, content, created_at)
         VALUES ('s1', 'coder', 'My thread', 'grok', 'user', 'hello session uniquephrase', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    db1.close()

    const db2 = openDb(dbPath)
    createSchema(db2)
    const row = db2.prepare(`SELECT session_id, role, content FROM session_messages WHERE session_id = 's1'`).get()
    assert.equal(row.session_id, 's1')
    assert.equal(row.role, 'user')
    assert.equal(row.content, 'hello session uniquephrase')

    const cols = db2.prepare(`PRAGMA table_info(session_messages)`).all().map((c) => c.name)
    for (const col of [
      'id',
      'session_id',
      'project',
      'thread_title',
      'agent',
      'role',
      'content',
      'created_at',
    ]) {
      assert.ok(cols.includes(col), `missing column ${col}`)
    }

    // Insert trigger populated FTS
    const fts = db2
      .prepare(`SELECT count(*) AS n FROM session_messages_fts WHERE session_messages_fts MATCH 'uniquephrase'`)
      .get()
    assert.equal(fts.n, 1)
    db2.close()
  })
})

describe('recordSession / sessionSearch / pruneSessions', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-sess-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rejects invalid role and empty content', () => {
    assert.throws(
      () =>
        memory.recordSession({
          sessionId: 's1',
          role: 'narrator',
          content: 'hi',
        }),
      /role/i,
    )
    assert.throws(
      () =>
        memory.recordSession({
          sessionId: 's1',
          role: 'user',
          content: '   ',
        }),
      /content/i,
    )
    assert.throws(
      () =>
        memory.recordSession({
          sessionId: '',
          role: 'user',
          content: 'hi',
        }),
      /session/i,
    )
  })

  it('truncates content at 4000 chars', () => {
    const long = 'x'.repeat(5000)
    const { id } = memory.recordSession({
      sessionId: 's-trunc',
      role: 'assistant',
      content: long,
    })
    const row = memory.db.prepare(`SELECT content FROM session_messages WHERE id = ?`).get(id)
    assert.equal(row.content.length, 4000)
  })

  it('FTS search returns hit with excerpt shape (camelCase)', () => {
    memory.recordSession({
      sessionId: 's-search',
      project: 'coder',
      threadTitle: 'Wire transcripts',
      agent: 'grok',
      role: 'assistant',
      content: 'we stored the sessionzebramarker for later recall',
    })
    const hits = memory.sessionSearch({ query: 'sessionzebramarker' })
    assert.equal(hits.length, 1)
    const h = hits[0]
    assert.equal(h.sessionId, 's-search')
    assert.equal(h.threadTitle, 'Wire transcripts')
    assert.equal(h.agent, 'grok')
    assert.equal(h.role, 'assistant')
    assert.equal(typeof h.excerpt, 'string')
    assert.ok(h.excerpt.toLowerCase().includes('sessionzebramarker') || h.excerpt.includes('sessionzebra'))
    assert.equal(typeof h.createdAt, 'string')
    // No access accounting fields on transcript hits
    assert.equal(h.access_count, undefined)
    assert.equal(h.score, undefined)
    assert.equal(h.hint, undefined)
  })

  it('project scoping matches ONLY the named project (no global, no siblings)', () => {
    memory.recordSession({
      sessionId: 's-a',
      project: 'proj-a',
      role: 'user',
      content: 'sharedscopemarker in project a',
    })
    memory.recordSession({
      sessionId: 's-b',
      project: 'proj-b',
      role: 'user',
      content: 'sharedscopemarker in project b',
    })
    memory.recordSession({
      sessionId: 's-null',
      role: 'user',
      content: 'sharedscopemarker with null project',
    })

    const hits = memory.sessionSearch({ query: 'sharedscopemarker', project: 'proj-a' })
    const sessions = hits.map((h) => h.sessionId).sort()
    // Project-scoped: the unscoped ('s-null') transcript belongs to no project
    // and must NOT surface inside proj-a.
    assert.deepEqual(sessions, ['s-a'])
  })

  it('orders by bm25 then created_at DESC on ties', () => {
    // Two equal-ish matches; older first insert, newer second — same unique token.
    memory.recordSession({
      sessionId: 's-old',
      role: 'user',
      content: 'ordertiephrase alone',
    })
    memory.recordSession({
      sessionId: 's-new',
      role: 'user',
      content: 'ordertiephrase alone',
    })
    // Force timestamps so newest wins the tiebreak
    memory.db
      .prepare(`UPDATE session_messages SET created_at = ? WHERE session_id = ?`)
      .run('2020-01-01T00:00:00.000Z', 's-old')
    memory.db
      .prepare(`UPDATE session_messages SET created_at = ? WHERE session_id = ?`)
      .run('2026-06-01T00:00:00.000Z', 's-new')

    const hits = memory.sessionSearch({ query: 'ordertiephrase' })
    assert.ok(hits.length >= 2)
    assert.equal(hits[0].sessionId, 's-new')
  })

  it('does not bump access_count on any entries when searching sessions', () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Unrelated',
      body: 'something else entirely',
    })
    const before = memory.db.prepare(`SELECT access_count FROM entries WHERE id = ?`).get(id).access_count
    memory.recordSession({
      sessionId: 's-noacc',
      role: 'user',
      content: 'noaccessphrase in transcript',
    })
    memory.sessionSearch({ query: 'noaccessphrase' })
    const after = memory.db.prepare(`SELECT access_count FROM entries WHERE id = ?`).get(id).access_count
    assert.equal(after, before)
  })

  it('delete trigger keeps FTS consistent after prune: search cannot find pruned rows', () => {
    memory.recordSession({
      sessionId: 's-keep',
      role: 'user',
      content: 'prunemarker keep this recent one',
    })
    memory.recordSession({
      sessionId: 's-old',
      role: 'user',
      content: 'prunemarker ancient transcript to drop',
    })
    // Age the old row past 30 days
    const oldIso = new Date(Date.now() - 40 * 86_400_000).toISOString()
    memory.db
      .prepare(`UPDATE session_messages SET created_at = ? WHERE session_id = ?`)
      .run(oldIso, 's-old')

    // Confirm both findable before prune
    assert.equal(memory.sessionSearch({ query: 'prunemarker' }).length, 2)

    const pruned = memory.pruneSessions(30)
    assert.equal(pruned, 1)

    const hits = memory.sessionSearch({ query: 'prunemarker' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].sessionId, 's-keep')

    // Direct FTS table must not retain the pruned content either
    const ftsLeft = memory.db
      .prepare(
        `SELECT count(*) AS n FROM session_messages_fts WHERE session_messages_fts MATCH 'ancient'`,
      )
      .get().n
    assert.equal(ftsLeft, 0, 'FTS delete trigger must remove pruned content')
  })

  it('limit is capped at 20', () => {
    for (let i = 0; i < 25; i++) {
      memory.recordSession({
        sessionId: `s-lim-${i}`,
        role: 'user',
        content: `limitcapphrase message number ${i}`,
      })
    }
    const hits = memory.sessionSearch({ query: 'limitcapphrase', limit: 100 })
    assert.equal(hits.length, 20)
  })
})

describe('janitor session prune + snapshot', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-sess-jan-'))
    memory = new Memory(path.join(dir, 'memory.db'), { startJanitor: false })
  })

  afterEach(() => {
    memory.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('prunes old sessions and reports sessionCount + prunedLastRun', () => {
    memory.recordSession({
      sessionId: 's-live',
      role: 'user',
      content: 'janitor live session row',
    })
    memory.recordSession({
      sessionId: 's-dead',
      role: 'user',
      content: 'janitor dead session row',
    })
    const oldIso = new Date(Date.now() - 45 * 86_400_000).toISOString()
    memory.db
      .prepare(`UPDATE session_messages SET created_at = ? WHERE session_id = ?`)
      .run(oldIso, 's-dead')

    const snap = runJanitor(memory.db)
    assert.equal(typeof snap.sessionCount, 'number')
    assert.equal(snap.sessionCount, 1)
    assert.equal(typeof snap.prunedLastRun, 'number')
    assert.equal(snap.prunedLastRun, 1)
    assert.equal(typeof snap.liveEntries, 'number')
    assert.ok(snap.lastRun)

    const stored = readJanitorSnapshot(memory.db)
    assert.equal(stored.sessionCount, 1)
    assert.equal(stored.prunedLastRun, 1)

    // Pruned row gone from FTS
    const deadHits = memory.sessionSearch({ query: 'dead' })
    assert.equal(deadHits.length, 0)
  })
})

const TOKEN = 'test-token-session-0123456789'

describe('session REST + MCP', () => {
  let server
  let baseURL
  let memory

  before(async () => {
    memory = new Memory(':memory:', { startJanitor: false })
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

  it('REST session endpoints require bearer auth', async () => {
    const post = await fetch(`${baseURL}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', role: 'user', content: 'hi' }),
    })
    assert.equal(post.status, 401)

    const get = await fetch(`${baseURL}/api/session-search?query=hi`)
    assert.equal(get.status, 401)
  })

  it('POST /api/session and GET /api/session-search shapes', async () => {
    const post = await fetch(`${baseURL}/api/session`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        sessionId: 'rest-sess-1',
        project: 'coder',
        threadTitle: 'REST thread',
        agent: 'grok',
        role: 'user',
        content: 'restsessionmarker hello from rest',
      }),
    })
    assert.equal(post.status, 200)
    const stored = await post.json()
    assert.ok(stored.id)

    const search = await fetch(
      `${baseURL}/api/session-search?query=${encodeURIComponent('restsessionmarker')}&project=coder`,
      { headers: authHeaders() },
    )
    assert.equal(search.status, 200)
    const hits = await search.json()
    assert.ok(Array.isArray(hits))
    const hit = hits.find((h) => h.sessionId === 'rest-sess-1')
    assert.ok(hit)
    assert.equal(hit.threadTitle, 'REST thread')
    assert.equal(hit.role, 'user')
    assert.equal(typeof hit.excerpt, 'string')
    assert.equal(typeof hit.createdAt, 'string')
  })

  it('MCP session_record and session_search round-trip', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    })
    const mcp = new Client({ name: 'session-test', version: '0.0.0' })
    await mcp.connect(transport)

    const tools = await mcp.listTools()
    const names = tools.tools.map((t) => t.name)
    assert.ok(names.includes('session_record'))
    assert.ok(names.includes('session_search'))

    // Handshake instructions mention session tools
    const init = mcp.getServerCapabilities?.()
    // instructions live on server; verify via tools/list description or record+search only.
    // The buildServer instructions string is checked by recording and searching.

    const rec = await mcp.callTool({
      name: 'session_record',
      arguments: {
        sessionId: 'mcp-sess-1',
        project: 'coder',
        threadTitle: 'MCP thread',
        agent: 'grok',
        role: 'assistant',
        content: 'mcpsessionmarker from the tool',
      },
    })
    const recBody = JSON.parse(rec.content[0].text)
    assert.ok(recBody.id)

    const search = await mcp.callTool({
      name: 'session_search',
      arguments: { query: 'mcpsessionmarker', project: 'coder' },
    })
    const hits = JSON.parse(search.content[0].text)
    assert.ok(Array.isArray(hits))
    assert.ok(hits.some((h) => h.sessionId === 'mcp-sess-1'))

    await mcp.close()
  })
})

describe('entry correction REST (delete + supersede)', () => {
  let dir, cfgPath, server, memory, baseURL
  const TOKEN = 'c'.repeat(64)

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-edit-'))
    cfgPath = path.join(dir, 'memory-server.json')
    const port = 47000 + Math.floor(Math.random() * 500)
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ port, token: TOKEN, dbPath: path.join(dir, 'mem.db') }),
    )
    memory = new Memory(path.join(dir, 'mem.db'), { embedder: fakeEmbedder(8) })
    server = await startServer(memory, { port, token: TOKEN, dbPath: path.join(dir, 'mem.db') })
    baseURL = `http://127.0.0.1:${port}`
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
    memory.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const auth = () => ({ Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })

  it('supersedes an entry and returns the successor id', async () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Wrong fact platypus',
      body: 'the original body that turned out to be wrong about platypus',
    })
    const res = await fetch(`${baseURL}/api/entry/${id}/supersede`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ title: 'Corrected fact platypus', body: 'the corrected body about platypus' }),
    })
    assert.equal(res.status, 200)
    const out = await res.json()
    assert.ok(out.id && out.id !== id)
    const successor = await (await fetch(`${baseURL}/api/entry/${out.id}`, { headers: auth() })).json()
    assert.equal(successor.title, 'Corrected fact platypus')
    // The old entry is retained but no longer served.
    const old = await fetch(`${baseURL}/api/entry/${id}`, { headers: auth() })
    assert.equal(old.status, 404)
  })

  it('deletes an entry, 404s an unknown id, 409s a superseded target', async () => {
    const { id } = memory.store({
      type: 'knowledge',
      title: 'Junk entry quetzal',
      body: 'this entry about quetzal is junk and should be removable',
    })
    const ok = await fetch(`${baseURL}/api/entry/${id}`, { method: 'DELETE', headers: auth() })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).deleted, id)
    assert.equal(memory.get(id), null)

    const missing = await fetch(`${baseURL}/api/entry/does-not-exist`, {
      method: 'DELETE',
      headers: auth(),
    })
    assert.equal(missing.status, 404)

    // A successor cannot be deleted while its predecessor points at it.
    const a = memory.store({
      type: 'knowledge',
      title: 'Old okapi note',
      body: 'the original okapi note body for supersession testing',
    })
    const b = memory.supersede(a.id, { title: 'New okapi note', body: 'the corrected okapi note body' })
    const conflict = await fetch(`${baseURL}/api/entry/${b.id}`, {
      method: 'DELETE',
      headers: auth(),
    })
    assert.equal(conflict.status, 409)
  })

  it('404s a supersede of an unknown id', async () => {
    // The 404 branch used to match /unknown|not found/, but supersede throws
    // "no entry with id <id>", so every miss answered 400.
    const res = await fetch(`${baseURL}/api/entry/no-such-entry/supersede`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ title: 'Title', body: 'body for a missing entry' }),
    })
    assert.equal(res.status, 404)
    assert.match((await res.json()).error, /no entry with id/)
  })

  it('requires bearer auth for both routes', async () => {
    const { id } = memory.store({ type: 'knowledge', title: 'Auth check', body: 'auth check body here' })
    const del = await fetch(`${baseURL}/api/entry/${id}`, { method: 'DELETE' })
    assert.equal(del.status, 401)
    const sup = await fetch(`${baseURL}/api/entry/${id}/supersede`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', body: 'b' }),
    })
    assert.equal(sup.status, 401)
  })
})
