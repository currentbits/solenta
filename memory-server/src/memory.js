import crypto from 'node:crypto'
import { openDb, createSchema } from './db.js'

const ENTRY_TYPES = new Set(['knowledge', 'task', 'convention', 'run'])
const TASK_STATUSES = new Set(['active', 'done', 'abandoned'])
const IMPORTANCE_DEFAULT = { convention: 5, knowledge: 3, task: 3, run: 1 }

const DECAY_RATE = 0.995
const DECAY_FLOOR = 0.05
const USAGE_K = 0.15
const USAGE_CAP = 1.5
const MIN_COMPOSITE_RATIO = 0.2
const SEARCH_EXCERPT_TOKENS = 60
const DEFAULT_SEARCH_LIMIT = 8
const MAX_LIMIT = 100

const SECTION_BUDGETS = {
  conventions: 800,
  knowledge: 500,
  tasks: 300,
}

const COMPOSITE_SCORE_SQL = `(-bm25(entries_fts)) * (e.importance / 3.0)
   * rank_decay(COALESCE(e.last_accessed_at, e.created_at))
   * usage_boost(e.access_count)`

const HINT = 'call memory_get with this id for the full body'

const PROTOCOL = [
  'MEMORY PREFLIGHT: call memory_bootstrap with project set to your working directory and treat its conventions as standing instructions.',
  'While working, store durable non-obvious findings (decisions, gotchas, conventions) with memory_store.',
  'Before finishing, record what a future agent must know.',
  'Search returns excerpts; use memory_get for full bodies.',
  'If active tasks may conflict, inspect with memory_search before changing files.',
]

export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4)
}

function ftsQuery(query) {
  return (String(query).match(/[A-Za-z0-9_]+/g) ?? []).map((token) => `"${token}"*`).join(' ')
}

function cleanText(label, value) {
  const clean = String(value ?? '').trim()
  if (!clean) throw new Error(`${label} is required`)
  return clean
}

function cleanOptional(value) {
  const clean = value == null ? '' : String(value).trim()
  return clean || null
}

function clampLimit(value, fallback) {
  const n = Number.isFinite(value) ? value : fallback
  return Math.max(1, Math.min(Math.trunc(n ?? fallback), MAX_LIMIT))
}

/** Drop whole entries from the end until the section fits the token budget. */
export function applyTokenBudget(rows, budget, cost) {
  const out = [...rows]
  while (out.length > 0 && estimateTokens(JSON.stringify(out.map(cost))) > budget) {
    // If a single remaining entry still exceeds, drop it (hard budget).
    if (out.length === 1) {
      out.pop()
      break
    }
    out.pop()
  }
  return out
}

export class Memory {
  /**
   * @param {string} dbPath
   */
  constructor(dbPath) {
    this.dbPath = dbPath
    this.db = openDb(dbPath)
    createSchema(this.db)
    this.db.function('rank_decay', (anchor) => {
      const days = Math.max(0, (Date.now() - Date.parse(String(anchor))) / 86_400_000)
      return Math.max(DECAY_FLOOR, Math.pow(DECAY_RATE, days))
    })
    this.db.function('usage_boost', (count) => {
      const n = Number(count) || 0
      return Math.min(1 + USAGE_K * Math.log(1 + n), USAGE_CAP)
    })
  }

  close() {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }

  entryCount() {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM entries`).get()
    return row?.n ?? 0
  }

  /**
   * @param {{ type: string, title: string, body: string, project?: string, agent?: string, importance?: number, status?: string }} input
   * @returns {{ id: string }}
   */
  store(input) {
    if (!ENTRY_TYPES.has(input.type)) {
      throw new Error(`invalid type '${input.type}'`)
    }
    if (input.status && input.type !== 'task') {
      throw new Error(`status is only valid for type 'task', got type '${input.type}'`)
    }
    if (input.status && !TASK_STATUSES.has(input.status)) {
      throw new Error(`invalid status '${input.status}'`)
    }
    if (
      input.importance !== undefined &&
      (!Number.isInteger(input.importance) || input.importance < 1 || input.importance > 5)
    ) {
      throw new Error(`importance must be an integer 1-5, got ${input.importance}`)
    }
    const importance = input.importance ?? IMPORTANCE_DEFAULT[input.type]
    const title = cleanText('title', input.title)
    const body = cleanText('body', input.body)
    const project = input.project === undefined ? null : cleanText('project', input.project)
    const agent = cleanOptional(input.agent)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO entries (id, type, title, body, project, agent, status, importance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.type, title, body, project, agent, input.status ?? null, importance, now, now)

    return { id }
  }

  /**
   * @param {string} id
   */
  get(id) {
    const row = this.db
      .prepare(
        `SELECT id, type, title, body, project, agent, status, created_at, updated_at,
                importance, access_count, last_accessed_at, superseded_by
         FROM entries WHERE id = ?`,
      )
      .get(id)
    if (!row) return null
    if (row.superseded_by) {
      return {
        superseded_by: row.superseded_by,
        hint: 'this entry was superseded; fetch the successor id',
      }
    }
    this.markAccessed([id])
    return row
  }

  /**
   * @param {{ query: string, project?: string, limit?: number }} opts
   */
  search(opts) {
    const query = cleanText('query', opts.query)
    const match = ftsQuery(query)
    if (!match) return []

    const project = cleanOptional(opts.project)
    const wantLimit = clampLimit(opts.limit, DEFAULT_SEARCH_LIMIT)
    const excerptTokens = Math.min(64, SEARCH_EXCERPT_TOKENS)

    // Fetch extra candidates so the relevance gate can still fill the limit.
    const fetchLimit = Math.max(wantLimit * 4, 40)

    const rows = this.db
      .prepare(
        `SELECT e.id, e.type, e.title, e.project, e.agent, e.created_at, e.importance,
                e.access_count,
                snippet(entries_fts, 1, '[', ']', '...', ?) AS excerpt,
                ${COMPOSITE_SCORE_SQL} AS score
         FROM entries_fts
         JOIN entries e ON e.rowid = entries_fts.rowid
         WHERE entries_fts MATCH ?
           AND e.superseded_by IS NULL
           AND (? IS NULL OR e.project IS NULL OR e.project = ?)
         ORDER BY score DESC
         LIMIT ?`,
      )
      .all(excerptTokens, match, project, project, fetchLimit)

    if (rows.length === 0) return []

    const topScore = rows[0].score
    // Relative compare with a tiny tolerance so exact ratios (e.g. importance 1 vs 5) survive float noise.
    const gated =
      topScore <= 0
        ? rows
        : rows.filter((r) => r.score / topScore >= MIN_COMPOSITE_RATIO - 1e-9)
    const final = gated.slice(0, wantLimit)

    this.markAccessed(final.map((r) => r.id))

    return final.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      project: r.project,
      agent: r.agent,
      created_at: r.created_at,
      importance: r.importance,
      score: r.score,
      excerpt: r.excerpt,
      hint: HINT,
    }))
  }

  /**
   * @param {string} id
   * @param {{ title?: string, body?: string, status?: string, importance?: number, agent?: string, project?: string }} fields
   */
  supersede(id, fields = {}) {
    const cleanId = cleanText('id', id)
    const old = this.db
      .prepare(
        `SELECT id, type, title, body, project, agent, status, importance, superseded_by
         FROM entries WHERE id = ?`,
      )
      .get(cleanId)

    if (!old) throw new Error(`no entry with id ${id}`)
    if (old.superseded_by) {
      throw new Error(`entry ${id} is already superseded by ${old.superseded_by}`)
    }

    const title = fields.title !== undefined ? cleanText('title', fields.title) : old.title
    const body = fields.body !== undefined ? cleanText('body', fields.body) : old.body
    const project =
      fields.project !== undefined
        ? fields.project === null
          ? null
          : cleanText('project', fields.project)
        : old.project
    const agent = fields.agent !== undefined ? cleanOptional(fields.agent) : old.agent
    let status = fields.status !== undefined ? fields.status : old.status
    if (status && old.type !== 'task') {
      throw new Error(`status is only valid for type 'task'`)
    }
    if (status && !TASK_STATUSES.has(status)) {
      throw new Error(`invalid status '${status}'`)
    }
    const importance =
      fields.importance !== undefined ? fields.importance : old.importance

    const newId = crypto.randomUUID()
    const now = new Date().toISOString()

    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          `INSERT INTO entries (id, type, title, body, project, agent, status, importance, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId,
          old.type,
          title,
          body,
          project,
          agent,
          status ?? null,
          importance,
          now,
          now,
        )
      this.db
        .prepare(`UPDATE entries SET superseded_by = ?, updated_at = ? WHERE id = ?`)
        .run(newId, now, cleanId)
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw err
    }

    return { id: newId }
  }

  /**
   * @param {{ project?: string }} opts
   */
  bootstrap(opts = {}) {
    const project = cleanOptional(opts.project)

    const conventionsRaw = this.db
      .prepare(
        `SELECT id, title, body, importance, created_at FROM entries
         WHERE type = 'convention' AND superseded_by IS NULL
           AND (project IS NULL OR project = ?)
         ORDER BY importance DESC, created_at DESC
         LIMIT 50`,
      )
      .all(project)

    const knowledgeRaw = this.db
      .prepare(
        `SELECT id, title, body, importance, created_at FROM entries
         WHERE type = 'knowledge' AND superseded_by IS NULL
           AND (project IS NULL OR project = ?)
         ORDER BY importance DESC, created_at DESC
         LIMIT 50`,
      )
      .all(project)

    const tasksRaw = this.db
      .prepare(
        `SELECT id, title, body, status, agent, project, created_at, updated_at FROM entries
         WHERE type = 'task' AND superseded_by IS NULL
           AND COALESCE(status, 'active') = 'active'
           AND (project IS NULL OR project = ?)
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 50`,
      )
      .all(project)

    const conventions = applyTokenBudget(
      conventionsRaw,
      SECTION_BUDGETS.conventions,
      (r) => ({ id: r.id, title: r.title, body: r.body, importance: r.importance, created_at: r.created_at }),
    ).map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      importance: r.importance,
      created_at: r.created_at,
    }))

    const knowledge = applyTokenBudget(
      knowledgeRaw,
      SECTION_BUDGETS.knowledge,
      (r) => ({
        id: r.id,
        title: r.title,
        excerpt: r.body.slice(0, 200),
        importance: r.importance,
        created_at: r.created_at,
      }),
    ).map((r) => ({
      id: r.id,
      title: r.title,
      excerpt: r.body.slice(0, 200),
      importance: r.importance,
      created_at: r.created_at,
    }))

    const tasks = applyTokenBudget(
      tasksRaw,
      SECTION_BUDGETS.tasks,
      (r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        status: r.status,
        agent: r.agent,
        project: r.project,
        updated_at: r.updated_at,
      }),
    ).map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      status: r.status,
      agent: r.agent,
      project: r.project,
      updated_at: r.updated_at,
    }))

    this.markAccessed([
      ...conventions.map((c) => c.id),
      ...knowledge.map((k) => k.id),
      ...tasks.map((t) => t.id),
    ])

    return {
      conventions,
      knowledge,
      tasks,
      protocol: [...PROTOCOL],
    }
  }

  /** @param {string[]} ids */
  markAccessed(ids) {
    if (!ids || ids.length === 0) return
    try {
      const now = new Date().toISOString()
      const stmt = this.db.prepare(
        `UPDATE entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      )
      this.db.exec('BEGIN')
      try {
        for (const id of ids) stmt.run(now, id)
        this.db.exec('COMMIT')
      } catch (err) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // ignore
        }
        throw err
      }
    } catch (err) {
      console.error('markAccessed failed (non-fatal):', err)
    }
  }
}
