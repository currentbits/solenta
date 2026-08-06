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

const INSTRUCTIONS =
  'Coder shared memory. MEMORY PREFLIGHT: at session start call memory_bootstrap with project set to your working directory and treat its conventions as standing instructions. While working, store durable non-obvious findings (decisions, gotchas, conventions) with memory_store; before finishing, record what a future agent must know. Search returns excerpts; use memory_get for full bodies.'

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

function authorized(req, token) {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Bearer ')) return false
  return timingSafeEqualString(header.slice(7), token)
}

function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

const entryType = z.enum(['knowledge', 'task', 'convention', 'run'])
const taskStatus = z.enum(['active', 'done', 'abandoned'])

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
        'Store a durable memory shared by all agents. Use for non-obvious facts: decisions, gotchas, conventions, task records.',
      inputSchema: {
        type: entryType,
        title: z.string().min(1),
        body: z.string().min(1),
        project: z.string().optional(),
        agent: z.string().optional(),
        status: taskStatus.optional(),
        importance: z.number().int().min(1).max(5).optional(),
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
    async (args) => json(memory.search(args)),
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

  return server
}

/**
 * Read the full request body as a Buffer.
 * @param {http.IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * @param {Memory} memory
 * @param {{ port: number, token: string, dbPath: string }} config
 * @param {string} [host]
 * @returns {Promise<http.Server>}
 */
export function startServer(memory, config, host = '127.0.0.1') {
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
        }),
      )
      return
    }

    // MCP endpoint requires bearer auth.
    if (url.pathname === '/mcp') {
      if (!authorized(req, config.token)) {
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
  const memory = new Memory(config.dbPath)
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
