import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { Memory } from './memory.js'
import { runJanitor, readJanitorSnapshot } from './janitor.js'
import { createRealEmbedder, semanticEnabled } from './embedder.js'

const INSTRUCTIONS =
  'Coder shared memory. MEMORY PREFLIGHT: at session start call memory_bootstrap with project set to your working directory and treat its conventions as standing instructions. While working, store durable non-obvious findings (decisions, gotchas, conventions) with memory_store; before finishing, record what a future agent must know. Search returns excerpts; use memory_get for full bodies. Record notable turns with session_record; session_search finds past conversation excerpts. memory_maintenance reports queue items to resolve with memory_resolve.'

export function defaultRoot() {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'coder')
    : path.join(os.homedir(), '.config', 'coder')
}

export function configPath() {
  return process.env.CODER_MEMORY_CONFIG ?? path.join(defaultRoot(), 'memory-server.json')
}

/**
 * Load existing config strictly, or create one on first run.
 * Never silently regenerates a broken file.
 * @param {string} [file]
 * @returns {{ port: number, token: string, dbPath: string }}
 */
export function loadOrCreateConfig(file = configPath()) {
  if (fs.existsSync(file)) {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      throw new Error(`config at ${file} is not valid JSON - refusing to start (fix or delete it)`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`config at ${file} is missing port/token/dbPath - refusing to start`)
    }
    const config = parsed
    const tokenOk =
      typeof config.token === 'string' &&
      config.token === config.token.trim() &&
      !/\s/.test(config.token) &&
      config.token.length >= 16
    const portOk =
      typeof config.port === 'number' &&
      Number.isInteger(config.port) &&
      config.port >= 1 &&
      config.port <= 65535
    const dbOk =
      typeof config.dbPath === 'string' &&
      config.dbPath === config.dbPath.trim() &&
      config.dbPath.trim().length > 0

    if (!tokenOk) {
      throw new Error(
        `config at ${file} has a missing or short token (need >= 16 chars) - refusing to start`,
      )
    }
    if (!portOk || !dbOk) {
      throw new Error(`config at ${file} is missing port/token/dbPath - refusing to start`)
    }
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // best-effort
    }
    return { port: config.port, token: config.token, dbPath: config.dbPath }
  }

  const config = {
    port: 49500 + crypto.randomInt(500), // 49500-49999 inclusive (500 values)
    token: crypto.randomBytes(32).toString('hex'),
    dbPath: path.join(defaultRoot(), 'memory.db'),
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // best-effort
  }
  return config
}

function timingSafeEqualString(a, b) {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB)
}

/**
 * Bearer Authorization header, or (when allowQueryToken) ?token= on the URL.
 * Header always wins: a present Bearer credential is never overridden by query.
 * @param {http.IncomingMessage} req
 * @param {string} token
 * @param {URL} url
 * @param {{ allowQueryToken?: boolean }} [opts]
 */
function authorized(req, token, url, { allowQueryToken = false } = {}) {
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) {
    return timingSafeEqualString(header.slice(7), token)
  }
  if (allowQueryToken) {
    const queryToken = url.searchParams.get('token')
    if (queryToken == null) return false
    return timingSafeEqualString(queryToken, token)
  }
  return false
}

function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

const entryType = z.enum(['knowledge', 'task', 'convention', 'run'])
const taskStatus = z.enum(['active', 'done', 'abandoned'])
const feedbackVerdict = z.enum(['helpful', 'harmful'])
const sessionRole = z.enum(['user', 'assistant', 'tool', 'system'])
const reviewResolution = z.enum(['update', 'invalidate', 'noop'])

/**
 * @param {Memory} memory
 */
export function buildServer(memory) {
  const server = new McpServer(
    { name: 'coder-memory', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  )

  server.registerTool(
    'memory_store',
    {
      description:
        'Store a durable memory shared by all agents. Use for non-obvious facts: decisions, gotchas, conventions, task records. Near-duplicates (jaccard >= 0.7) are refused unless force: true; moderate overlap (>= 0.4) stores but enqueues a review pair.',
      inputSchema: {
        type: entryType,
        title: z.string().min(1),
        body: z.string().min(1),
        project: z.string().optional(),
        agent: z.string().optional(),
        status: taskStatus.optional(),
        importance: z.number().int().min(1).max(5).optional(),
        force: z.boolean().optional(),
      },
    },
    async (args) => json(memory.store(args)),
  )

  server.registerTool(
    'memory_get',
    {
      description: 'Fetch one memory entry in full by id (search returns excerpts only).',
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async (args) => json(memory.get(args.id)),
  )

  server.registerTool(
    'memory_search',
    {
      description:
        'Full-text search over shared memories. Results are excerpts — call memory_get for the full body.',
      inputSchema: {
        query: z.string().min(1),
        project: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (args) => json(await memory.search(args)),
  )

  server.registerTool(
    'memory_supersede',
    {
      description:
        'Replace a live memory with an updated version. Marks the old entry superseded_by the new id.',
      inputSchema: {
        id: z.string().min(1),
        title: z.string().optional(),
        body: z.string().optional(),
        status: taskStatus.optional(),
        importance: z.number().int().min(1).max(5).optional(),
        agent: z.string().optional(),
        project: z.string().optional(),
      },
    },
    async (args) => {
      const { id, ...fields } = args
      return json(memory.supersede(id, fields))
    },
  )

  server.registerTool(
    'memory_bootstrap',
    {
      description:
        'One-call startup context: conventions, knowledge, and active tasks for a project, plus the usage protocol. Call at session start.',
      inputSchema: {
        project: z.string().optional(),
      },
    },
    async (args) => json(memory.bootstrap(args)),
  )

  server.registerTool(
    'memory_recent',
    {
      description: 'Newest live memory entries (excerpt form). Limit max 50.',
      inputSchema: {
        limit: z.number().int().positive().max(50).optional(),
        project: z.string().optional(),
        type: entryType.optional(),
      },
    },
    async (args) => json(memory.recent(args)),
  )

  server.registerTool(
    'memory_feedback',
    {
      description:
        'Report that a memory helped or misled you. Bumps helpful_count or harmful_count and writes feedback_log.',
      inputSchema: {
        id: z.string().min(1),
        verdict: feedbackVerdict,
        note: z.string().optional(),
      },
    },
    async (args) => json(memory.feedback(args)),
  )

  server.registerTool(
    'memory_resolve',
    {
      description:
        'Resolve a review_queue item (near-duplicate or contradiction candidate). resolution: update (recorded adjudication), invalidate (tombstone the older/losing entry), noop (both may coexist). Never deletes.',
      inputSchema: {
        id: z.number().int().positive(),
        resolution: reviewResolution,
      },
    },
    async (args) => json(memory.resolve(args)),
  )

  server.registerTool(
    'memory_maintenance',
    {
      description:
        'Read-only consolidation report: open review queue depth and oldest age, near-duplicate pairs, aging run notes (>7d), oversized conventions (>1500 chars). Each item includes a one-line instruction for resolving via normal tools. Makes no changes.',
      inputSchema: {
        project: z.string().optional(),
      },
    },
    async (args) => json(memory.maintenance(args)),
  )

  server.registerTool(
    'session_record',
    {
      description:
        'Record a transcript message (append-only). Use for notable turns; not for curated durable facts.',
      inputSchema: {
        sessionId: z.string().min(1),
        project: z.string().optional(),
        threadTitle: z.string().optional(),
        agent: z.string().optional(),
        role: sessionRole,
        content: z.string().min(1),
      },
    },
    async (args) => json(memory.recordSession(args)),
  )

  server.registerTool(
    'session_search',
    {
      description:
        'Full-text search over past conversation transcript excerpts. Limit max 20.',
      inputSchema: {
        query: z.string().min(1),
        project: z.string().optional(),
        limit: z.number().int().positive().max(20).optional(),
      },
    },
    async (args) => json(memory.sessionSearch(args)),
  )

  return server
}

/** Max request body size for REST/MCP JSON payloads (1 MiB). */
export const MAX_BODY_BYTES = 1024 * 1024

/**
 * Read the full request body as a Buffer.
 * Rejects with `{ code: 'PAYLOAD_TOO_LARGE' }` when over maxBytes.
 * @param {http.IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    req.on('data', (c) => {
      if (settled) return
      total += c.length
      if (total > maxBytes) {
        settled = true
        const err = new Error('request body too large')
        err.code = 'PAYLOAD_TOO_LARGE'
        // Pause so the handler can send 413; drain remaining after response.
        try {
          req.pause()
        } catch {
          // ignore
        }
        reject(err)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

/**
 * Thin REST wrappers for the Coder UI proxy.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @param {Memory} memory
 */
/**
 * App-facing list row: the Coder UI contract wants `body` (excerpt form in
 * lists) and `updated_at`; the MCP tools keep `excerpt`/`hint`.
 */
function toApiRow(r) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.excerpt ?? r.body ?? '',
    project: r.project ?? null,
    importance: r.importance,
    created_at: r.created_at,
    updated_at: r.updated_at ?? r.created_at,
  }
}

async function handleApi(req, res, url, memory) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/recent') {
      const limit = url.searchParams.get('limit')
      const project = url.searchParams.get('project') ?? undefined
      const type = url.searchParams.get('type') ?? undefined
      const result = memory.recent({
        limit: limit != null ? Number(limit) : undefined,
        project,
        type,
      })
      sendJson(res, 200, result.map(toApiRow))
      return true
    }

    if (req.method === 'GET' && url.pathname === '/api/search') {
      const query = url.searchParams.get('query') ?? ''
      const project = url.searchParams.get('project') ?? undefined
      const limit = url.searchParams.get('limit')
      const result = await memory.search({
        query,
        project,
        limit: limit != null ? Number(limit) : undefined,
      })
      sendJson(res, 200, result.map(toApiRow))
      return true
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/entry/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/entry/'.length))
      if (!id) {
        sendJson(res, 400, { error: 'id required' })
        return true
      }
      const entry = memory.get(id)
      if (!entry) {
        sendJson(res, 404, { error: 'not found' })
        return true
      }
      if (!entry.title) {
        // Superseded stub ({superseded_by, hint}); never serve it as a blank entry.
        sendJson(res, 404, {
          error: `Entry superseded${entry.superseded_by ? ` by ${entry.superseded_by}` : ''}`,
        })
        return true
      }
      sendJson(res, 200, { ...toApiRow(entry), body: entry.body })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/store') {
      let body
      try {
        const raw = await readBody(req)
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
      } catch (err) {
        if (err && err.code === 'PAYLOAD_TOO_LARGE') {
          sendJson(res, 413, { error: 'request body too large' })
          // Drain leftover body so the socket can close cleanly.
          try {
            req.resume()
          } catch {
            // ignore
          }
          return true
        }
        sendJson(res, 400, { error: 'valid JSON required' })
        return true
      }
      const result = memory.store(body)
      sendJson(res, 200, result)
      return true
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      let body
      try {
        const raw = await readBody(req)
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
      } catch (err) {
        if (err && err.code === 'PAYLOAD_TOO_LARGE') {
          sendJson(res, 413, { error: 'request body too large' })
          try {
            req.resume()
          } catch {
            // ignore
          }
          return true
        }
        sendJson(res, 400, { error: 'valid JSON required' })
        return true
      }
      const result = memory.recordSession(body)
      sendJson(res, 200, result)
      return true
    }

    if (req.method === 'GET' && url.pathname === '/api/session-search') {
      const query = url.searchParams.get('query') ?? ''
      const project = url.searchParams.get('project') ?? undefined
      const limit = url.searchParams.get('limit')
      const result = memory.sessionSearch({
        query,
        project,
        limit: limit != null ? Number(limit) : undefined,
      })
      sendJson(res, 200, result)
      return true
    }
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    return true
  }
  return false
}

/**
 * @param {Memory} memory
 * @param {{ port: number, token: string, dbPath: string }} config
 * @param {string} [host]
 * @returns {Promise<http.Server>}
 */
export function startServer(memory, config, host = '127.0.0.1') {
  // The Memory constructor already ran the janitor once; running it again
  // here would double-decay access counts on every boot.

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`)

    // Health is open (no auth).
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          entryCount: memory.entryCount(),
          dbPath: config.dbPath,
          janitor: memory.janitorSnapshot?.() ?? readJanitorSnapshot(memory.db),
          vectors: memory.vectorsHealth?.() ?? { enabled: false, count: 0, model: null },
        }),
      )
      return
    }

    // REST convenience endpoints require bearer header auth only.
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req, config.token, url)) {
        res.writeHead(401).end()
        return
      }
      const handled = await handleApi(req, res, url, memory)
      if (handled) return
      res.writeHead(404).end()
      return
    }

    // MCP: bearer header, or ?token= for header-less clients (localhost only).
    if (url.pathname === '/mcp') {
      if (!authorized(req, config.token, url, { allowQueryToken: true })) {
        res.writeHead(401).end()
        return
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        res.writeHead(405).end()
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }

      let body
      try {
        const raw = await readBody(req)
        body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'valid JSON required' }))
        return
      }

      const mcp = buildServer(memory)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      try {
        await mcp.connect(transport)
        await transport.handleRequest(req, res, body)
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }),
          )
        }
      } finally {
        try {
          await transport.close()
        } catch {
          // ignore
        }
        try {
          await mcp.close()
        } catch {
          // ignore
        }
      }
      return
    }

    res.writeHead(404).end()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, host, () => resolve(server))
  })
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMain()) {
  const config = loadOrCreateConfig()
  const embedder = semanticEnabled() ? createRealEmbedder() : null
  const memory = new Memory(config.dbPath, { embedder })
  startServer(memory, config, '127.0.0.1').then((server) => {
    const address = server.address()
    console.log(
      `coder-memory listening on 127.0.0.1:${address.port} (db: ${config.dbPath})`,
    )
  }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
