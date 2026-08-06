import crypto from 'node:crypto'
import { openDb, createSchema } from './db.js'
import { extractEntities } from './extract.js'
import { runJanitor, readJanitorSnapshot, JANITOR_INTERVAL_MS } from './janitor.js'

const ENTRY_TYPES = new Set(['knowledge', 'task', 'convention', 'run'])
const TASK_STATUSES = new Set(['active', 'done', 'abandoned'])
const IMPORTANCE_DEFAULT = { convention: 5, knowledge: 3, task: 3, run: 1 }
const FEEDBACK_VERDICTS = new Set(['helpful', 'harmful'])

const DECAY_RATE = 0.995
const DECAY_FLOOR = 0.05
const USAGE_K = 0.15
const USAGE_CAP = 1.5
const MIN_COMPOSITE_RATIO = 0.2
const SEARCH_EXCERPT_TOKENS = 60
const DEFAULT_SEARCH_LIMIT = 8
const MAX_LIMIT = 100
const RRF_K = 60
const GRAPH_TOP = 10
const GRAPH_MAX_HOPS = 2
const RECENT_MAX = 50

const SECTION_BUDGETS = {
  conventions: 800,
  knowledge: 500,
  tasks: 300,
}

// Base composite without bm25 (graph / final re-score path).
// usage_boost(access, helpful, harmful) includes the feedback term.
const BASE_SCORE_SQL = `(e.importance / 3.0)
   * rank_decay(COALESCE(e.last_accessed_at, e.created_at))
   * usage_boost(e.access_count, COALESCE(e.helpful_count, 0), COALESCE(e.harmful_count, 0))`

const COMPOSITE_SCORE_SQL = `(-bm25(entries_fts)) * ${BASE_SCORE_SQL}`

const HINT = 'call memory_get with this id for the full body'

const PROTOCOL = [
  'MEMORY PREFLIGHT: call memory_bootstrap with project set to your working directory and treat its conventions as standing instructions.',
  'While working, store durable non-obvious findings (decisions, gotchas, conventions) with memory_store.',
  'Before finishing, record what a future agent must know.',
  'Search returns excerpts; use memory_get for the full body.',
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

function clampLimit(value, fallback, max = MAX_LIMIT) {
  const n = Number.isFinite(value) ? value : fallback
  return Math.max(1, Math.min(Math.trunc(n ?? fallback), max))
}

function excerptFromBody(body, maxChars = 240) {
  const text = String(body ?? '')
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '...'
}

/**
 * Feedback multiplier: (1 + 0.05*min(helpful,10) - 0.1*min(harmful,5)) clamped to [0.3, 2.0]
 * @param {number} helpful
 * @param {number} harmful
 */
export function feedbackFactor(helpful, harmful) {
  const raw =
    1 + 0.05 * Math.min(Number(helpful) || 0, 10) - 0.1 * Math.min(Number(harmful) || 0, 5)
  return Math.min(2.0, Math.max(0.3, raw))
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
   * @param {{ startJanitor?: boolean }} [opts]
   */
  constructor(dbPath, opts = {}) {
    this.dbPath = dbPath
    this.db = openDb(dbPath)
    createSchema(this.db)
    this.db.function('rank_decay', (anchor) => {
      const days = Math.max(0, (Date.now() - Date.parse(String(anchor))) / 86_400_000)
      return Math.max(DECAY_FLOOR, Math.pow(DECAY_RATE, days))
    })
    // usage_boost(access_count, helpful_count, harmful_count)
    this.db.function('usage_boost', (count, helpful, harmful) => {
      const n = Number(count) || 0
      const base = Math.min(1 + USAGE_K * Math.log(1 + n), USAGE_CAP)
      return base * feedbackFactor(helpful, harmful)
    })

    this._janitorTimer = null
    if (opts.startJanitor !== false) {
      try {
        runJanitor(this.db)
      } catch (err) {
        console.error('janitor initial run failed (non-fatal):', err)
      }
      // Interval janitor (skip for pure unit tests if they pass startJanitor: false — default on)
      try {
        this._janitorTimer = setInterval(() => {
          try {
            runJanitor(this.db)
          } catch (err) {
            console.error('janitor interval failed (non-fatal):', err)
          }
        }, JANITOR_INTERVAL_MS)
        if (typeof this._janitorTimer.unref === 'function') this._janitorTimer.unref()
      } catch {
        // ignore
      }
    }
  }

  close() {
    if (this._janitorTimer) {
      clearInterval(this._janitorTimer)
      this._janitorTimer = null
    }
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

  janitorSnapshot() {
    return readJanitorSnapshot(this.db)
  }

  /**
   * Upsert extracted entities and write mentions for an entry.
   * @param {string} entryId
   * @param {string} title
   * @param {string} body
   */
  linkEntities(entryId, title, body) {
    const extracted = extractEntities(`${title}\n${body}`)
    if (extracted.length === 0) return

    const find = this.db.prepare(
      `SELECT id FROM entities WHERE kind = ? AND name = ? COLLATE NOCASE LIMIT 1`,
    )
    const insertEnt = this.db.prepare(`INSERT INTO entities (id, name, kind) VALUES (?, ?, ?)`)
    const insertMen = this.db.prepare(
      `INSERT OR IGNORE INTO mentions (entry_id, entity_id) VALUES (?, ?)`,
    )

    for (const ent of extracted) {
      let row = find.get(ent.kind, ent.name)
      let entityId
      if (row) {
        entityId = row.id
      } else {
        entityId = crypto.randomUUID()
        try {
          insertEnt.run(entityId, ent.name, ent.kind)
        } catch {
          // Race / UNIQUE on exact name+kind: re-fetch
          row = find.get(ent.kind, ent.name)
          if (!row) {
            // exact match different case already handled by NOCASE find; try exact
            row = this.db
              .prepare(`SELECT id FROM entities WHERE kind = ? AND name = ?`)
              .get(ent.kind, ent.name)
          }
          if (!row) continue
          entityId = row.id
        }
      }
      insertMen.run(entryId, entityId)
    }
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

    try {
      this.linkEntities(id, title, body)
    } catch (err) {
      console.error('linkEntities failed (non-fatal):', err)
    }

    return { id }
  }

  /**
   * @param {string} id
   */
  get(id) {
    const row = this.db
      .prepare(
        `SELECT id, type, title, body, project, agent, status, created_at, updated_at,
                importance, access_count, last_accessed_at, superseded_by,
                helpful_count, harmful_count
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
   * Graph retriever: entities in query → BFS ≤2 hops → candidate entries.
   * Ranked by (min-hop ASC, importance*decay*usage DESC). Top 10.
   * On any failure returns [].
   * @param {string} query
   * @param {string|null} project
   * @returns {{ id: string, hop: number, score: number, title: string, type: string, project: string|null, agent: string|null, created_at: string, importance: number, excerpt: string }[]}
   */
  graphSearch(query, project) {
    try {
      const extracted = extractEntities(query)
      // Also look up any extracted names case-insensitively, plus bare tokens as entity names.
      const seedIds = new Set()

      const byName = this.db.prepare(
        `SELECT id FROM entities WHERE name = ? COLLATE NOCASE`,
      )

      for (const ent of extracted) {
        const rows = byName.all(ent.name)
        for (const r of rows) seedIds.add(r.id)
      }

      // Case-insensitive name lookup for significant tokens not already extracted
      const tokens = String(query).match(/[A-Za-z0-9_][A-Za-z0-9_.-]{2,}/g) ?? []
      for (const tok of tokens) {
        const rows = byName.all(tok)
        for (const r of rows) seedIds.add(r.id)
      }

      // Multi-word concept names: try the full query trimmed
      const full = String(query).trim()
      if (full.length >= 3 && full.length <= 80) {
        for (const r of byName.all(full)) seedIds.add(r.id)
      }

      if (seedIds.size === 0) return []

      // BFS over edges up to GRAPH_MAX_HOPS
      /** @type {Map<string, number>} entityId → min hop */
      const reached = new Map()
      const queue = []
      for (const id of seedIds) {
        reached.set(id, 0)
        queue.push(id)
      }

      const neighbors = this.db.prepare(
        `SELECT dst AS other FROM edges WHERE src = ?
         UNION
         SELECT src AS other FROM edges WHERE dst = ?`,
      )

      while (queue.length > 0) {
        const cur = queue.shift()
        const hop = reached.get(cur) ?? 0
        if (hop >= GRAPH_MAX_HOPS) continue
        const rows = neighbors.all(cur, cur)
        for (const { other } of rows) {
          if (!reached.has(other)) {
            reached.set(other, hop + 1)
            queue.push(other)
          }
        }
      }

      const entityIds = [...reached.keys()]
      if (entityIds.length === 0) return []

      // Candidate entries via mentions and edges.entry_id
      /** @type {Map<string, number>} entryId → min hop */
      const entryHops = new Map()

      const placeholders = entityIds.map(() => '?').join(',')
      const mentionRows = this.db
        .prepare(
          `SELECT m.entry_id, m.entity_id FROM mentions m
           WHERE m.entity_id IN (${placeholders})`,
        )
        .all(...entityIds)

      for (const { entry_id, entity_id } of mentionRows) {
        const hop = reached.get(entity_id) ?? 99
        const prev = entryHops.get(entry_id)
        if (prev === undefined || hop < prev) entryHops.set(entry_id, hop)
      }

      const edgeRows = this.db
        .prepare(
          `SELECT entry_id, src, dst FROM edges
           WHERE src IN (${placeholders}) OR dst IN (${placeholders})`,
        )
        .all(...entityIds, ...entityIds)

      for (const { entry_id, src, dst } of edgeRows) {
        const hop = Math.min(reached.get(src) ?? 99, reached.get(dst) ?? 99)
        const prev = entryHops.get(entry_id)
        if (prev === undefined || hop < prev) entryHops.set(entry_id, hop)
      }

      if (entryHops.size === 0) return []

      const entryIds = [...entryHops.keys()]
      const ePlace = entryIds.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT e.id, e.type, e.title, e.body, e.project, e.agent, e.created_at, e.importance,
                  e.access_count, e.helpful_count, e.harmful_count,
                  ${BASE_SCORE_SQL} AS score
           FROM entries e
           WHERE e.id IN (${ePlace})
             AND e.superseded_by IS NULL
             AND (? IS NULL OR e.project IS NULL OR e.project = ?)`,
        )
        .all(...entryIds, project, project)

      rows.sort((a, b) => {
        const ha = entryHops.get(a.id) ?? 99
        const hb = entryHops.get(b.id) ?? 99
        if (ha !== hb) return ha - hb
        return (b.score ?? 0) - (a.score ?? 0)
      })

      return rows.slice(0, GRAPH_TOP).map((r) => ({
        id: r.id,
        hop: entryHops.get(r.id) ?? 99,
        score: r.score,
        title: r.title,
        type: r.type,
        project: r.project,
        agent: r.agent,
        created_at: r.created_at,
        importance: r.importance,
        excerpt: excerptFromBody(r.body),
      }))
    } catch (err) {
      console.error('graphSearch failed (non-fatal):', err)
      return []
    }
  }

  /**
   * @param {{ query: string, project?: string, limit?: number }} opts
   */
  search(opts) {
    const query = cleanText('query', opts.query)
    const match = ftsQuery(query)
    const project = cleanOptional(opts.project)
    const wantLimit = clampLimit(opts.limit, DEFAULT_SEARCH_LIMIT)
    const excerptTokens = Math.min(64, SEARCH_EXCERPT_TOKENS)
    const fetchLimit = Math.max(wantLimit * 4, 40)

    /** @type {{ id: string, type: string, title: string, project: string|null, agent: string|null, created_at: string, importance: number, score: number, excerpt: string }[]} */
    let ftsRows = []
    if (match) {
      try {
        ftsRows = this.db
          .prepare(
            `SELECT e.id, e.type, e.title, e.project, e.agent, e.created_at, e.updated_at, e.importance,
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
      } catch (err) {
        console.error('FTS search failed (non-fatal):', err)
        ftsRows = []
      }
    }

    const graphRows = this.graphSearch(query, project)

    // If neither retriever found anything, empty.
    if (ftsRows.length === 0 && graphRows.length === 0) return []

    // Pure FTS path: keep existing bm25 composite ordering (no graph candidates).
    if (graphRows.length === 0) {
      const topScore = ftsRows[0].score
      const gated =
        topScore <= 0
          ? ftsRows
          : ftsRows.filter((r) => r.score / topScore >= MIN_COMPOSITE_RATIO - 1e-9)
      const final = gated.slice(0, wantLimit)
      this.markAccessed(final.map((r) => r.id))
      return final.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        project: r.project,
        agent: r.agent,
        created_at: r.created_at,
        updated_at: r.updated_at,
        importance: r.importance,
        score: r.score,
        excerpt: r.excerpt,
        hint: HINT,
      }))
    }

    // RRF fusion: score 1/(60 + rank), sum across retrievers → candidate set.
    /** @type {Map<string, number>} */
    const rrf = new Map()
    ftsRows.forEach((r, i) => {
      rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (RRF_K + i + 1))
    })
    graphRows.forEach((r, i) => {
      rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (RRF_K + i + 1))
    })

    const ftsById = new Map(ftsRows.map((r) => [r.id, r]))
    const graphById = new Map(graphRows.map((r) => [r.id, r]))
    const fusedIds = [...rrf.keys()]

    // Re-score the fused set with a shared base composite (importance*decay*usage).
    // Mixing raw bm25 FTS scores with graph base scores breaks the 20% gate scale.
    const place = fusedIds.map(() => '?').join(',')
    const scoredRows = this.db
      .prepare(
        `SELECT e.id, e.type, e.title, e.body, e.project, e.agent, e.created_at, e.updated_at, e.importance,
                ${BASE_SCORE_SQL} AS score
         FROM entries e
         WHERE e.id IN (${place}) AND e.superseded_by IS NULL`,
      )
      .all(...fusedIds)

    const fused = scoredRows.map((row) => {
      const fts = ftsById.get(row.id)
      const g = graphById.get(row.id)
      return {
        id: row.id,
        type: row.type,
        title: row.title,
        project: row.project,
        agent: row.agent,
        created_at: row.created_at,
        updated_at: row.updated_at,
        importance: row.importance,
        score: row.score,
        excerpt: fts?.excerpt ?? g?.excerpt ?? excerptFromBody(row.body),
        rrf: rrf.get(row.id) ?? 0,
      }
    })

    // RRF is the primary order: how highly each retriever ranked the entry
    // composes honestly across incomparable score scales. Composite only
    // breaks RRF ties (e.g. two entries each found by a single retriever at
    // the same rank).
    fused.sort((a, b) => {
      const dr = (b.rrf ?? 0) - (a.rrf ?? 0)
      if (Math.abs(dr) > 1e-12) return dr
      return (b.score ?? 0) - (a.score ?? 0)
    })

    if (fused.length === 0) return []

    // Relevance gate stays composite-based (RRF has no meaningful ratio
    // scale) against the best composite in the fused set, preserving order.
    const topScore = Math.max(...fused.map((r) => r.score ?? 0))
    const gated =
      topScore <= 0
        ? fused
        : fused.filter((r) => r.score / topScore >= MIN_COMPOSITE_RATIO - 1e-9)
    const final = gated.slice(0, wantLimit)

    this.markAccessed(final.map((r) => r.id))

    return final.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      project: r.project,
      agent: r.agent,
      created_at: r.created_at,
      updated_at: r.updated_at,
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

    try {
      this.linkEntities(newId, title, body)
    } catch (err) {
      console.error('linkEntities failed (non-fatal):', err)
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

  /**
   * Newest live entries (excerpt form).
   * @param {{ limit?: number, project?: string, type?: string }} opts
   */
  recent(opts = {}) {
    const limit = clampLimit(opts.limit, 20, RECENT_MAX)
    const project = cleanOptional(opts.project)
    const type = opts.type ? cleanText('type', opts.type) : null
    if (type && !ENTRY_TYPES.has(type)) {
      throw new Error(`invalid type '${type}'`)
    }

    const rows = this.db
      .prepare(
        `SELECT id, type, title, body, project, agent, status, created_at, updated_at, importance
         FROM entries
         WHERE superseded_by IS NULL
           AND (? IS NULL OR project IS NULL OR project = ?)
           AND (? IS NULL OR type = ?)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(project, project, type, type, limit)

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      project: r.project,
      agent: r.agent,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      importance: r.importance,
      excerpt: excerptFromBody(r.body),
      hint: HINT,
    }))
  }

  /**
   * @param {{ id: string, verdict: 'helpful'|'harmful', note?: string }} input
   */
  feedback(input) {
    const id = cleanText('id', input.id)
    const verdict = cleanText('verdict', input.verdict)
    if (!FEEDBACK_VERDICTS.has(verdict)) {
      throw new Error(`verdict must be 'helpful' or 'harmful', got '${verdict}'`)
    }
    const note = cleanOptional(input.note)
    const row = this.db.prepare(`SELECT id FROM entries WHERE id = ?`).get(id)
    if (!row) throw new Error(`no entry with id ${id}`)

    const now = new Date().toISOString()
    this.db.exec('BEGIN')
    try {
      if (verdict === 'helpful') {
        this.db.prepare(`UPDATE entries SET helpful_count = helpful_count + 1 WHERE id = ?`).run(id)
      } else {
        this.db.prepare(`UPDATE entries SET harmful_count = harmful_count + 1 WHERE id = ?`).run(id)
      }
      this.db
        .prepare(
          `INSERT INTO feedback_log (entry_id, verdict, note, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(id, verdict, note, now)
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw err
    }
    return { ok: true, id, verdict }
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
