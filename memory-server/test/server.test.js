import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { rmTree } from '../../electron/test/support/rmTree.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Memory } from '../src/memory.js'
import { startServer, loadOrCreateConfig } from '../src/index.js'

const TOKEN = 'test-token-0123456789abcdef'

describe('HTTP auth and health', () => {
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

  it('rejects missing and wrong tokens with 401 on MCP', async () => {
    const missing = await fetch(`${baseURL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    })
    assert.equal(missing.status, 401)

    const wrong = await fetch(`${baseURL}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer wrong-token-xxxxxxxx',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    })
    assert.equal(wrong.status, 401)
  })

  it('accepts query token only on /mcp (handshake 200)', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseURL}/mcp?token=${encodeURIComponent(TOKEN)}`),
    )
    const mcp = new Client({ name: 'test-query-token', version: '0.0.0' })
    await mcp.connect(transport)
    const tools = await mcp.listTools()
    assert.ok(tools.tools.some((t) => t.name === 'memory_bootstrap'))
    await mcp.close()
  })

  it('rejects wrong query token on /mcp with 401', async () => {
    const res = await fetch(`${baseURL}/mcp?token=wrong-token-xxxxxxxx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    })
    assert.equal(res.status, 401)
  })

  it('valid header wins over wrong query token on /mcp', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseURL}/mcp?token=wrong-token-xxxxxxxx`),
      { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
    )
    const mcp = new Client({ name: 'test-header-wins', version: '0.0.0' })
    await mcp.connect(transport)
    const tools = await mcp.listTools()
    assert.ok(tools.tools.some((t) => t.name === 'memory_bootstrap'))
    await mcp.close()
  })

  it('wrong header rejects even with valid query token on /mcp', async () => {
    const res = await fetch(`${baseURL}/mcp?token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer wrong-token-xxxxxxxx',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    })
    assert.equal(res.status, 401)
  })

  it('query token alone does not authorize /api/*', async () => {
    const res = await fetch(
      `${baseURL}/api/recent?token=${encodeURIComponent(TOKEN)}&limit=5`,
    )
    assert.equal(res.status, 401)
  })

  it('GET /health is open (no auth) and returns ok', async () => {
    const res = await fetch(`${baseURL}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(typeof body.entryCount, 'number')
    assert.ok(!('dbPath' in body))
    assert.ok(body.vectors)
    assert.equal(typeof body.vectors.enabled, 'boolean')
    assert.equal(typeof body.vectors.count, 'number')
  })

  it('GET /health?nonce= returns HMAC proof of the token', async () => {
    const nonce = 'abc'
    const res = await fetch(`${baseURL}/health?nonce=${nonce}`)
    assert.equal(res.status, 200)
    const body = await res.json()
    const expected = crypto.createHmac('sha256', TOKEN).update(nonce).digest('hex')
    assert.equal(body.proof, expected)
    const wrong = crypto.createHmac('sha256', 'wrong-token-xxxxxxxx').update(nonce).digest('hex')
    assert.notEqual(body.proof, wrong)
  })

  it('store/get/supersede round-trip over real MCP HTTP', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    })
    const mcp = new Client({ name: 'test', version: '0.0.0' })
    await mcp.connect(transport)

    const tools = await mcp.listTools()
    const names = tools.tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'memory_bootstrap',
      'memory_delete',
      'memory_distill',
      'memory_feedback',
      'memory_get',
      'memory_maintenance',
      'memory_recent',
      'memory_resolve',
      'memory_search',
      'memory_store',
      'memory_supersede',
      'session_record',
      'session_search',
    ])
    const storeTool = tools.tools.find((t) => t.name === 'memory_store')
    assert.match(storeTool.description, /nearDuplicate/)
    assert.match(storeTool.description, /memory_supersede/)

    const stored = await mcp.callTool({
      name: 'memory_store',
      arguments: {
        type: 'knowledge',
        title: 'Integration fact',
        body: 'the walrus operator lives here',
        project: 'coder',
      },
    })
    const storedText = stored.content[0].text
    const { id } = JSON.parse(storedText)
    assert.ok(id)

    const got = await mcp.callTool({ name: 'memory_get', arguments: { id } })
    const entry = JSON.parse(got.content[0].text)
    assert.equal(entry.body, 'the walrus operator lives here')

    const found = await mcp.callTool({
      name: 'memory_search',
      arguments: { query: 'walrus operator' },
    })
    const hits = JSON.parse(found.content[0].text)
    assert.equal(hits[0].id, id)
    assert.ok(hits[0].excerpt || hits[0].snippet)
    assert.equal(hits[0].hint, 'call memory_get with this id for the full body')

    const sup = await mcp.callTool({
      name: 'memory_supersede',
      arguments: { id, title: 'Integration fact v2', body: 'updated walrus note' },
    })
    const { id: newId } = JSON.parse(sup.content[0].text)
    assert.notEqual(newId, id)

    const boot = await mcp.callTool({
      name: 'memory_bootstrap',
      arguments: { project: 'coder' },
    })
    const briefing = JSON.parse(boot.content[0].text)
    assert.ok(Array.isArray(briefing.protocol))
    assert.ok(Array.isArray(briefing.conventions))
    assert.ok(Array.isArray(briefing.knowledge))

    await mcp.close()
  })

  it('?project= bind scopes search and rejects a foreign project (issue #671)', async () => {
    memory.store({
      type: 'knowledge',
      title: 'Alpha only fact',
      body: 'alphawalrus lives here',
      project: 'alpha',
    })
    memory.store({
      type: 'knowledge',
      title: 'Beta only fact',
      body: 'betanarwhal lives here',
      project: 'beta',
    })

    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseURL}/mcp?project=${encodeURIComponent('alpha')}`),
      { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
    )
    const mcp = new Client({ name: 'test-bind', version: '0.0.0' })
    await mcp.connect(transport)

    const found = await mcp.callTool({
      name: 'memory_search',
      arguments: { query: 'lives here' },
    })
    const hits = JSON.parse(found.content[0].text)
    assert.ok(
      hits.some((h) => h.title === 'Alpha only fact'),
      `expected alpha hit, got ${JSON.stringify(hits)}`,
    )
    assert.ok(!hits.some((h) => h.title === 'Beta only fact'))

    const foreign = await mcp.callTool({
      name: 'memory_search',
      arguments: { query: 'lives here', project: 'beta' },
    })
    assert.equal(foreign.isError, true)
    assert.match(JSON.stringify(foreign), /bound to project/)

    await mcp.close()
  })
})

describe('config validation', () => {
  let dir

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-cfg-'))
  })

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates config on first run with port/token/dbPath', () => {
    const file = path.join(dir, 'fresh.json')
    const cfg = loadOrCreateConfig(file)
    assert.ok(cfg.port >= 49500 && cfg.port <= 49999)
    assert.equal(cfg.token.length, 64)
    assert.ok(cfg.dbPath)
    // Windows has no POSIX permission bits; chmod 0o600 is a no-op there.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777
      assert.equal(mode, 0o600)
    }
    // second load returns same values, never regenerates
    const again = loadOrCreateConfig(file)
    assert.deepEqual(again, cfg)
  })

  it('refuses bad JSON without regenerating', () => {
    const file = path.join(dir, 'bad.json')
    fs.writeFileSync(file, '{not json', { mode: 0o600 })
    assert.throws(() => loadOrCreateConfig(file), /valid JSON|refusing/i)
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json')
  })

  it('refuses short token without regenerating', () => {
    const file = path.join(dir, 'short.json')
    const content = JSON.stringify({ port: 49501, token: 'tooshort', dbPath: '/tmp/x.db' })
    fs.writeFileSync(file, content, { mode: 0o600 })
    assert.throws(() => loadOrCreateConfig(file), /token|refusing/i)
    assert.equal(fs.readFileSync(file, 'utf8'), content)
  })

  it('refuses missing fields without regenerating', () => {
    const file = path.join(dir, 'missing.json')
    const content = JSON.stringify({ port: 49502 })
    fs.writeFileSync(file, content, { mode: 0o600 })
    assert.throws(() => loadOrCreateConfig(file), /missing|refusing/i)
  })
})

describe('standalone smoke via spawn', () => {
  it('boots with temp config and serves /health after a port collision', async (t) => {
    const blocker = http.createServer((_req, res) => res.writeHead(503).end())
    await new Promise((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    t.after(() => new Promise((resolve) => blocker.close(resolve)))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-smoke-'))
    const cfgPath = path.join(dir, 'cfg.json')
    const dbPath = path.join(dir, 'db.sqlite')
    const token = 'a'.repeat(64)
    const port = blocker.address().port
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ port, token, dbPath }),
      { mode: 0o600 },
    )

    const child = spawn(process.execPath, [path.join(process.cwd(), 'src/index.js')], {
      env: { ...process.env, CODER_MEMORY_CONFIG: cfgPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Register before readiness: startup can fail before cleanup begins.
    const closed = new Promise((resolve) => child.once('close', resolve))

    try {
      const { port: actualPort, body } = await waitForHealth(cfgPath, child, 8000)
      assert.notEqual(actualPort, port)
      assert.equal(body.ok, true)
      assert.ok(!('dbPath' in body))
    } finally {
      child.kill('SIGTERM')
      await closed // includes stdout/stderr pipe closure, also on Windows
      await rmTree(dir)
    }
  })

  it('reports an early startup exit without missing pipe closure', async () => {
    const child = spawn(process.execPath, ['-e', 'console.error("startup failed"); process.exitCode = 7'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const closed = new Promise((resolve) => child.once('close', resolve))
    try {
      await assert.rejects(
        waitForHealth(path.join(os.tmpdir(), crypto.randomUUID(), 'cfg.json'), child, 8000),
        /memory server exited \(7\): startup failed/,
      )
    } finally {
      child.kill('SIGTERM')
      await closed
    }
  })
})

describe('EADDRINUSE port fallback', () => {
  it('binds a different port and rewrites configFile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-eaddr-'))
    const cfgFile = path.join(dir, 'memory-server.json')
    const dbPath = path.join(dir, 'm.db')
    const blocker = http.createServer()
    const port = await new Promise((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port))
    })
    const config = { port, token: TOKEN, dbPath }
    fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2), { mode: 0o600 })
    const memory = new Memory(':memory:')
    let server
    try {
      server = await startServer(memory, config, '127.0.0.1', cfgFile)
      const addr = server.address()
      assert.notEqual(addr.port, port)
      assert.equal(config.port, addr.port)
      const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      assert.equal(onDisk.port, addr.port)
      assert.equal(onDisk.token, TOKEN)
      assert.equal(onDisk.dbPath, dbPath)
    } finally {
      if (server) {
        await new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()))
        })
      }
      await new Promise((resolve, reject) => {
        blocker.close((err) => (err ? reject(err) : resolve()))
      })
      memory.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('closes the fallback listener when persisting its port fails', async (t) => {
    const blocker = http.createServer()
    await new Promise((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    const config = { port: blocker.address().port, token: TOKEN, dbPath: ':memory:' }
    const originalPort = config.port
    const cfgFile = path.join(os.tmpdir(), 'solenta-port-save-failure.json')
    const failure = Object.assign(new Error('config save failed'), { code: 'EACCES' })
    const memory = new Memory(':memory:')
    const createServer = http.createServer
    const writeFileSync = fs.writeFileSync
    let listener
    t.mock.method(http, 'createServer', (...args) => (listener = createServer(...args)))
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (file === cfgFile) throw failure
      return writeFileSync(file, ...args)
    })
    try {
      await assert.rejects(startServer(memory, config, '127.0.0.1', cfgFile), (err) => err === failure)
      assert.equal(listener.listening, false, 'rejected startup must release its listener')
      assert.equal(config.port, originalPort, 'failed save must not publish a new port')
    } finally {
      if (listener?.listening) await new Promise((resolve) => listener.close(resolve))
      await new Promise((resolve) => blocker.close(resolve))
      memory.close()
    }
  })
})

async function waitForHealth(cfgPath, child, timeoutMs) {
  let stderr = ''
  let spawnError
  let closed = false
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', (err) => { spawnError = err })
  child.once('close', () => { closed = true })
  const nonce = crypto.randomBytes(16).toString('hex')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (spawnError) throw spawnError
    if (closed) {
      throw new Error(`memory server exited (${child.exitCode ?? child.signalCode}): ${stderr}`)
    }
    try {
      // Startup may persist a fallback port after EADDRINUSE or Windows EACCES.
      const { port, token } = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      const res = await fetch(`http://127.0.0.1:${port}/health?nonce=${nonce}`, {
        signal: AbortSignal.timeout(Math.max(1, timeoutMs - (Date.now() - start))),
      })
      const body = await res.json()
      const proof = crypto.createHmac('sha256', token).update(nonce).digest('hex')
      if (res.ok && body.ok && body.proof === proof) return { port, body }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`memory server did not become healthy in ${timeoutMs}ms: ${stderr}`)
}
