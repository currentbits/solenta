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
import { canonicalProject } from './project-key.js'
import { parseCitations } from './citations.js'
import { runJanitor, readJanitorSnapshot } from './janitor.js'
import { createRealEmbedder, semanticEnabled } from './embedder.js'
import { exitWhenOrphaned } from './orphan.js'

const INSTRUCTIONS =
  'Solenta shared memory, PROJECT-SCOPED: everything you read and write belongs to the project you name, and other projects never see it. MEMORY PREFLIGHT: at session start call memory_bootstrap with project set to your working directory and treat its conventions as standing instructions. Always pass that same project on every memory call. While working, store durable non-obvious findings (decisions, gotchas, conventions) with memory_store and cite evidence (file path+line+excerpt, thread id, or commit sha). When project is a live working directory, bootstrap/search/get verify file citations against that tree and invalidate contradictions instead of injecting them. Before finishing, record what a future agent must know. Search returns excerpts; use memory_get for full bodies. Record notable turns with session_record; session_search finds past conversation excerpts. memory_maintenance reports queue items to resolve with memory_resolve.'

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

const entryType = z.enum(['knowledge', 'task', 'convention', 'run', 'strategy'])
const taskStatus = z.enum(['active', 'done', 'abandoned'])
const citationSchema = z.object({
  kind: z.enum(['file', 'thread', 'commit']),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  excerpt: z.string().optional(),
  id: z.string().optional(),
  sha: z.string().optional(),
})
const feedbackVerdict = z.enum(['helpful', 'harmful'])
const sessionRole = z.enum(['user', 'assistant', 'tool', 'system'])
const reviewResolution = z.enum(['update', 'invalidate', 'noop'])

/**
 * @param {Memory} memory
 * @param {{ bindProject?: string | null }} [opts] - when set (MCP URL
 *   ?project=), every tool is forced to that project and a claimed other
 *   project is rejected (issue #671).
 */
export function buildServer(memory, opts = {}) {
  const bindProject = opts.bindProject ? String(opts.bindProject) : ''

  function scoped(args = {}) {
    if (!bindProject) return args
    const claimed = args.project
    if (claimed != null && String(claimed).trim() !== '') {
      const want = canonicalProject(bindProject)
      const got = canonicalProject(claimed)
      if (want && got && want !== got) {
        throw new Error(
          `This session is bound to project "${want}"; cannot access "${got}".`,
        )
      }
    }
    return { ...args, project: bindProject }
  }

  function assertEntryInScope(id) {
    if (!bindProject) return
    const row = memory.get(id)
    if (!row) return
    const want = canonicalProject(bindProject)
    const got = row.project ? canonicalProject(row.project) : null
    if (row.invalidated || row.superseded_by) {
      if (got && want && got !== want) {
        throw new Error(`Unknown entry: ${id}`)
      }
      return
    }
    if (!got || got !== want) {
      throw new Error(`Unknown entry: ${id}`)
    }
  }

  const server = new McpServer(
    { name: 'coder-memory', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  )

  server.registerTool(
    'memory_store',
    {
      description:
        'Store a durable memory shared by all agents. Use for non-obvious facts: decisions, gotchas, conventions, task records. Cite evidence on learned facts: file (path, line, excerpt of the supporting code), thread, or commit. Near-duplicates (jaccard >= 0.7) are refused unless force: true; moderate overlap (>= 0.4) stores but enqueues a review pair.',
      inputSchema: {
        type: entryType,
        title: z.string().min(1),
        body: z.string().min(1),
        project: z.string().optional(),
        agent: z.string().optional(),
        status: taskStatus.optional(),
        importance: z.number().int().min(1).max(5).optional(),
        force: z.boolean().optional(),
        citations: z.array(citationSchema).optional(),
      },
    },
    // #409: source is set here, not by the caller. An agent that could label
    // its own write 'app' would walk straight past the injection scan in
    // Memory.store, which is keyed on source === 'mcp'.
    async (args) => json(memory.store({ ...scoped(args), source: 'mcp' })),
  )

  server.registerTool(
    'memory_get',
    {
      description:
        'Fetch one memory entry in full by id (search returns excerpts only). Pass project as your working directory to verify file citations against that tree before applying the entry.',
      inputSchema: {
        id: z.string().min(1),
        project: z.string().optional(),
      },
    },
    async (args) => {
      const a = scoped(args)
      assertEntryInScope(a.id)
      return json(memory.get(a.id, { project: a.project }))
    },
  )

  server.registerTool(
    'memory_search',
    {
      description:
        'Full-text search over shared memories. Results are excerpts — call memory_get for the full body.',
      inputSchema: {
        query: z.string().min(1),
        project: z.string().optional(),
        agent: z.string().optional().describe('Only return entries written by this agent'),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (args) => json(await memory.search(scoped(args))),
  )

  server.registerTool(
    'memory_delete',
    {
      description:
        'Permanently delete a memory entry and its dependents. Prefer memory_supersede (which keeps history) unless the entry is genuinely junk. Refuses when another entry supersedes this one.',
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      assertEntryInScope(id)
      const removed = memory.deleteEntry(id)
      if (!removed) throw new Error(`Unknown entry: ${id}`)
      return json({ deleted: id })
    },
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
        citations: z.array(citationSchema).optional(),
      },
    },
    async (args) => {
      const a = scoped(args)
      const { id, ...fields } = a
      assertEntryInScope(id)
      return json(memory.supersede(id, { ...fields, source: 'mcp' }))
    },
  )

  server.registerTool(
    'memory_bootstrap',
    {
      description:
        'One-call startup context: conventions, distilled strategies, knowledge, and active tasks for a project, plus the usage protocol. Call at session start with project set to your working directory — file citations are verified against that tree and contradicted entries are invalidated instead of injected.',
      inputSchema: {
        project: z.string().optional(),
      },
    },
    async (args) => json(memory.bootstrap(scoped(args))),
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
    async (args) => json(memory.recent(scoped(args))),
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
    async (args) => {
      assertEntryInScope(args.id)
      return json(memory.feedback(args))
    },
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
    async (args) => json(memory.maintenance(scoped(args))),
  )

  server.registerTool(
    'memory_distill',
    {
      description:
        'Read-only evidence pack for writing type:strategy memories: harmful-feedback entries and abandoned tasks (failures), recent runs and helpful-feedback entries (successes), plus titles of strategies already stored. Write each distilled rule with memory_store({ type: \'strategy\' }). Makes no changes.',
      inputSchema: {
        project: z.string().optional(),
      },
    },
    async (args) => json(memory.distill(scoped(args))),
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
    async (args) => json(memory.recordSession(scoped(args))),
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
    async (args) => json(memory.sessionSearch(scoped(args))),
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
 * Thin REST wrappers for the Solenta UI proxy.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @param {Memory} memory
 */
/**
 * App-facing list row: the Solenta UI contract wants `body` (excerpt form in
 * lists) and `updated_at`; the MCP tools keep `excerpt`/`hint`.
 */
function toApiRow(r) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.excerpt ?? r.body ?? '',
    project: r.project ?? null,
    agent: r.agent ?? null,
    source: r.source ?? null,
    importance: r.importance,
    created_at: r.created_at,
    updated_at: r.updated_at ?? r.created_at,
    citations: parseCitations(r.citations),
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
      const agent = url.searchParams.get('agent') ?? undefined
      const limit = url.searchParams.get('limit')
      const result = await memory.search({
        query,
        project,
        agent,
        limit: limit != null ? Number(limit) : undefined,
      })
      sendJson(res, 200, result.map(toApiRow))
      return true
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/entry/') && url.pathname.endsWith('/supersede')) {
      const id = decodeURIComponent(
        url.pathname.slice('/api/entry/'.length, -'/supersede'.length),
      )
      if (!id) {
        sendJson(res, 400, { error: 'id required' })
        return true
      }
      let body
      try {
        const raw = await readBody(req)
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
      } catch {
        sendJson(res, 400, { error: 'valid JSON required' })
        return true
      }
      try {
        sendJson(res, 200, memory.supersede(id, { ...body, source: body.source ?? 'rest' }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        sendJson(res, /no entry with id|unknown|not found/i.test(msg) ? 404 : 400, {
          error: msg,
        })
      }
      return true
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/entry/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/entry/'.length))
      if (!id) {
        sendJson(res, 400, { error: 'id required' })
        return true
      }
      try {
        const removed = memory.deleteEntry(id)
        if (!removed) {
          sendJson(res, 404, { error: `Unknown entry: ${id}` })
          return true
        }
        sendJson(res, 200, { deleted: id })
      } catch (err) {
        // deleteEntry refuses when another entry points here via superseded_by.
        const msg = err instanceof Error ? err.message : String(err)
        sendJson(res, /superseded_by/.test(msg) ? 409 : 400, { error: msg })
      }
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
      const result = memory.store({ ...body, source: body.source ?? 'rest' })
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

    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      const project = url.searchParams.get('project') ?? undefined
      sendJson(res, 200, memory.bootstrap({ project }))
      return true
    }

    if (req.method === 'GET' && url.pathname === '/api/maintenance') {
      const project = url.searchParams.get('project') ?? undefined
      sendJson(res, 200, memory.maintenance({ project }))
      return true
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/review/') && url.pathname.endsWith('/resolve')) {
      const idRaw = decodeURIComponent(
        url.pathname.slice('/api/review/'.length, -'/resolve'.length),
      )
      if (!idRaw) {
        sendJson(res, 400, { error: 'id required' })
        return true
      }
      let body
      try {
        const raw = await readBody(req)
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
      } catch {
        sendJson(res, 400, { error: 'valid JSON required' })
        return true
      }
      try {
        sendJson(res, 200, memory.resolve({ id: idRaw, resolution: body.resolution }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        sendJson(res, /no review_queue row|already resolved/i.test(msg) ? 404 : 400, {
          error: msg,
        })
      }
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
 * @param {string} [configFile] when set, EADDRINUSE rewrites this file onto a fresh port and retries
 * @returns {Promise<http.Server>}
 */
export function startServer(memory, config, host = '127.0.0.1', configFile) {
  // The Memory constructor already ran the janitor once; running it again
  // here would double-decay access counts on every boot.

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`)

    // Health is open (no auth) but must not leak dbPath.
    if (req.method === 'GET' && url.pathname === '/health') {
      const body = {
        ok: true,
        entryCount: memory.entryCount(),
        janitor: memory.janitorSnapshot?.() ?? readJanitorSnapshot(memory.db),
        vectors: memory.vectorsHealth?.() ?? { enabled: false, count: 0, model: null },
      }
      // Proof that we know the shared secret, without echoing the token.
      // A client sends a nonce; we never require the secret on this open endpoint.
      const nonce = url.searchParams.get('nonce')
      if (nonce != null && nonce.length >= 1 && nonce.length <= 256) {
        body.proof = crypto.createHmac('sha256', config.token).update(nonce).digest('hex')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
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

      const bindProject = url.searchParams.get('project') || ''
      const mcp = buildServer(memory, { bindProject: bindProject || undefined })
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

  return listenWithPortFallback(server, config, host, configFile)
}

const PORT_FALLBACK_ATTEMPTS = 20

/**
 * Bind `config.port`. On EADDRINUSE with a configFile, pick a fresh port in
 * the same range as loadOrCreateConfig, persist it, and retry so a squatter
 * cannot wedge us on the recorded port.
 * @param {http.Server} server
 * @param {{ port: number, token: string, dbPath: string }} config
 * @param {string} host
 * @param {string} [configFile]
 * @returns {Promise<http.Server>}
 */
async function listenWithPortFallback(server, config, host, configFile) {
  let lastErr
  for (let n = 0; n < PORT_FALLBACK_ATTEMPTS; n++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err)
        server.once('error', onError)
        server.listen(config.port, host, () => {
          server.removeListener('error', onError)
          resolve()
        })
      })
      return server
    } catch (err) {
      lastErr = err
      if (!(err && err.code === 'EADDRINUSE' && configFile)) throw err
      if (n === PORT_FALLBACK_ATTEMPTS - 1) break
      config.port = 49500 + crypto.randomInt(500)
      const next = {
        port: config.port,
        token: config.token,
        dbPath: config.dbPath,
      }
      fs.writeFileSync(configFile, JSON.stringify(next, null, 2), { mode: 0o600 })
      try {
        fs.chmodSync(configFile, 0o600)
      } catch {
        // best-effort
      }
    }
  }
  throw lastErr
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
  exitWhenOrphaned()
  const config = loadOrCreateConfig()
  const embedder = semanticEnabled() ? createRealEmbedder() : null
  const memory = new Memory(config.dbPath, { embedder })
  startServer(memory, config, '127.0.0.1', configPath()).then((server) => {
    const address = server.address()
    console.log(
      `coder-memory listening on 127.0.0.1:${address.port} (db: ${config.dbPath})`,
    )
  }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
