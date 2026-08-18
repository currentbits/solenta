import crypto from 'node:crypto'
import { openDb, createSchema, purgeStaleVectors } from './db.js'
import { extractEntities } from './extract.js'
import { runJanitor, readJanitorSnapshot, JANITOR_INTERVAL_MS } from './janitor.js'
import {
  cosine,
  floatToBlob,
  blobToFloat,
  EMBED_MAX_CHARS,
} from './embedder.js'
import { contentTokens, jaccard, queueReview, semanticNeighbors, SEMANTIC_DUP } from './review.js'
import { canonicalProject } from './project-key.js'
import { agentTrust, TRUST_SUSPECT } from './trust.js'
import { rejectInjectedMemory } from './guardrails-scan.js'

export { contentTokens, jaccard, queueReview }

const ENTRY_TYPES = new Set(['knowledge', 'task', 'convention', 'run', 'strategy'])
const TASK_STATUSES = new Set(['active', 'done', 'abandoned'])
const IMPORTANCE_DEFAULT = { convention: 5, strategy: 4, knowledge: 3, task: 3, run: 1 }
const FEEDBACK_VERDICTS = new Set(['helpful', 'harmful'])
const SESSION_ROLES = new Set(['user', 'assistant', 'tool', 'system'])
const RESOLUTIONS = new Set(['update', 'invalidate', 'noop'])

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
const VECTOR_TOP = 10
const GRAPH_MAX_HOPS = 2
const RECENT_MAX = 50
const SESSION_CONTENT_MAX = 4000
const SESSION_SEARCH_MAX = 20
const SESSION_SEARCH_DEFAULT = 10
const SESSION_RETENTION_DAYS = 30
const DEDUP_BLOCK = 0.7
const DEDUP_WARN = 0.4
const DEDUP_SCAN_CAP = 500

const EMBED_BACKFILL_CAP = 64
const AGING_RUN_DAYS = 7
const FAT_CONVENTION_CHARS = 1500
const MAINTENANCE_LIST_LIMIT = 20
// Trust map is cheap to rebuild (one GROUP BY) and must not be per-row.
// Feedback is the evidence that moves the number, so it drops the cache;
// a short TTL covers invalidate / raw SQL without touching those writers.
const TRUST_CACHE_TTL_MS = 5_000

const SECTION_BUDGETS = {
  conventions: 800,
  strategies: 500,
  knowledge: 500,
  tasks: 300,
}

/** Live = not superseded and not invalidated. Used on every read surface. */
export /**
 * Project scope predicate. Memory is PROJECT-SCOPED: asking about project X
 * returns X's entries and nothing else, for agents and for the UI alike. An
 * omitted project means "no scope given" and matches everything, which is how
 * unscoped browsing and cross-project maintenance still work.
 *
 * Deliberately NOT "project rows plus global rows": leaking one project's
 * memory into another is the failure this scoping exists to prevent.
 * @param {string} [col] column prefix, e.g. 'e'
 */
function projectScopeSql(col) {
  const c = col ? `${col}.project` : 'project'
  return `(? IS NULL OR ${c} = ?)`
}

function liveSql(alias = '') {
  const p = alias ? `${alias}.` : ''
  return `${p}superseded_by IS NULL AND ${p}invalid_at IS NULL`
}

// Base composite without bm25 (graph / final re-score path).
// usage_boost(access, helpful, harmful) includes the feedback term.
// agent_trust is 1.0 for NULL/unknown writers so existing rows keep today's score.
const BASE_SCORE_SQL = `(e.importance / 3.0)
   * rank_decay(COALESCE(e.last_accessed_at, e.created_at))
   * usage_boost(e.access_count, COALESCE(e.helpful_count, 0), COALESCE(e.harmful_count, 0))
   * agent_trust(e.agent)`

const COMPOSITE_SCORE_SQL = `(-bm25(entries_fts)) * ${BASE_SCORE_SQL}`

const HINT = 'call memory_get with this id for the full body'

const PROTOCOL = [
  'MEMORY PREFLIGHT: call memory_bootstrap with project set to your working directory and treat its conventions as standing instructions.',
  'While working, store durable non-obvious findings (decisions, gotchas, conventions) with memory_store.',
  'Strategies are distilled "when doing X, do/don\'t Y" rules from past runs: follow them, and report a bad one with memory_feedback.',
  'Before finishing, record what a future agent must know.',
  'Search returns excerpts; use memory_get for the full body.',
  'If active tasks may conflict, inspect with memory_search before changing files.',
  'memory_maintenance reports queue items to resolve with memory_resolve.',
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
   * @param {{ startJanitor?: boolean, embedder?: object|null }} [opts]
   *   Inject `embedder` (e.g. fakeEmbedder in tests, createRealEmbedder in production).
   *   Default is none (vector retriever returns []). Production wires the real model
   *   from index.js unless CODER_MEMORY_SEMANTIC=0.
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
    this._agentTrustByName = null
    this._agentTrustAt = 0
    this.db.function('agent_trust', (agent) => {
      if (agent == null || agent === '') return 1
      return this._cachedAgentTrust().get(String(agent)) ?? 1
    })

    this.embedder = opts.embedder ?? null

    // Stale embedding space: drop rows whose model id differs from the active embedder.
    if (this.embedder?.model) {
      purgeStaleVectors(this.db, this.embedder.model)
    }

    this._janitorTimer = null
    if (opts.startJanitor !== false) {
      try {
        runJanitor(this.db)
      } catch (err) {
        console.error('janitor initial run failed (non-fatal):', err)
      }
      // Backfill embeddings off the hot path (cap 64 per pass).
      void this.embedMissing(EMBED_BACKFILL_CAP).catch(() => {})
      // Interval janitor (skip for pure unit tests if they pass startJanitor: false — default on)
      try {
        this._janitorTimer = setInterval(() => {
          try {
            runJanitor(this.db)
          } catch (err) {
            console.error('janitor interval failed (non-fatal):', err)
          }
          void this.embedMissing(EMBED_BACKFILL_CAP).catch(() => {})
        }, JANITOR_INTERVAL_MS)
        if (typeof this._janitorTimer.unref === 'function') this._janitorTimer.unref()
      } catch {
        // ignore
      }
    }
  }

  /** @returns {{ enabled: boolean, count: number, model: string|null }} */
  vectorsHealth() {
    let count = 0
    try {
      count = this.db.prepare(`SELECT COUNT(*) AS n FROM entry_vectors`).get()?.n ?? 0
    } catch {
      count = 0
    }
    return {
      enabled: this.embedder != null,
      count,
      model: this.embedder?.model ?? null,
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
   * Upsert extracted entities and write mentions + co-occurrence edges for an entry.
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
    const insertEdge = this.db.prepare(
      `INSERT OR IGNORE INTO edges (src, dst, relation, entry_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )

    /** @type {string[]} */
    const entityIds = []
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
      entityIds.push(entityId)
    }

    const uniqueIds = [...new Set(entityIds)].sort()
    const now = new Date().toISOString()
    // ponytail: co-occurrence only (no typed relations); ≤C(15,2)=105 rows/entry.
    // Typed/LLM-extracted relations are the upgrade if relation semantics are needed.
    for (let i = 0; i < uniqueIds.length; i++) {
      for (let j = i + 1; j < uniqueIds.length; j++) {
        insertEdge.run(uniqueIds[i], uniqueIds[j], 'co_occurs', entryId, now)
      }
    }
  }

  /**
   * @param {{ type: string, title: string, body: string, project?: string, agent?: string, source?: string, importance?: number, status?: string, force?: boolean }} input
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
    // Canonical key: agents send cwd paths, the app sends slugs; unify both.
    const project =
      input.project === undefined
        ? null
        : canonicalProject(cleanText('project', input.project))
    const agent = cleanOptional(input.agent)
    const source = cleanOptional(input.source)

    // Agent-written entries (source 'mcp') are the injection-propagation
    // channel. App / import / janitor / rest writes are human-initiated.
    // rejectInjectedMemory already fails open on a scanner fault, so the only
    // error that reaches here is a real rejection.
    if (source === 'mcp') rejectInjectedMemory(title, body)

    // Write-time dedup: Jaccard vs live same-project-or-global (cap 500 most recent).
    // Scope rule (consistent across dedup, contradiction scan, maintenance):
    // pairs are COMPARABLE when same-project or either side is global, but the
    // hard BLOCK below only fires for same-scope pairs (same project string, or
    // both global). A cross-scope overlap (global vs some project) downgrades
    // to the warn/enqueue path so a global convention can never refuse an
    // unrelated project's write.
    let nearDup = null
    if (input.type !== 'task') {
      nearDup = this.findNearDup(title, body, project)
      const sameScope = nearDup && nearDup.project === project
      if (nearDup && nearDup.overlap >= DEDUP_BLOCK && sameScope && !input.force) {
        throw new Error(
          `near-duplicate of existing entry ${nearDup.id} "${nearDup.title}" (jaccard=${nearDup.overlap}); pass force: true to store anyway`,
        )
      }
    }

    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO entries (id, type, title, body, project, agent, source, status, importance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.type, title, body, project, agent, source, input.status ?? null, importance, now, now)

    try {
      this.linkEntities(id, title, body)
    } catch (err) {
      console.error('linkEntities failed (non-fatal):', err)
    }

    if (nearDup && nearDup.overlap >= DEDUP_WARN) {
      queueReview(this.db, 'near_dup', id, nearDup.id, `jaccard=${nearDup.overlap}`)
    }

    // Fire-and-forget embed; null embedding just skips the row. Safe to
    // interleave with an open janitor transaction: a lost/rolled-back vector
    // is re-created by the janitor's embedMissing backfill on the next pass.
    // embedEntry also runs the semantic near-dup check once the vector lands.
    void this.embedEntry(id).catch(() => {})

    return { id }
  }

  /**
   * Hard-delete an entry and every dependent row, transactionally.
   * Reachable from the memory_delete tool and DELETE /api/entry/:id. The FK
   * constraints on entry_vectors/review_queue have no ON DELETE CASCADE
   * (SQLite would need table rebuilds), so dependents must go first.
   * @param {string} id
   * @returns {boolean} true when the entry existed and was deleted
   */
  deleteEntry(id) {
    const row = this.db
      .prepare(`SELECT id, rowid, title, body FROM entries WHERE id = ?`)
      .get(id)
    if (!row) return false
    // Refuse when other entries point at this one via superseded_by: deleting
    // a successor would silently resurrect its predecessor.
    const refs =
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM entries WHERE superseded_by = ?`)
        .get(id)?.n ?? 0
    if (refs > 0) {
      throw new Error(
        `Cannot delete ${id}: ${refs} entr${refs === 1 ? 'y' : 'ies'} reference it via superseded_by`,
      )
    }
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`DELETE FROM entry_vectors WHERE entry_id = ?`).run(id)
      this.db.prepare(`DELETE FROM mentions WHERE entry_id = ?`).run(id)
      this.db.prepare(`DELETE FROM edges WHERE entry_id = ?`).run(id)
      for (const table of ['feedback_log', 'serve_log']) {
        try {
          this.db.prepare(`DELETE FROM ${table} WHERE entry_id = ?`).run(id)
        } catch {
          // table absent on older schemas
        }
      }
      this.db
        .prepare(`DELETE FROM review_queue WHERE entry_a = ? OR entry_b = ?`)
        .run(id, id)
      // External-content FTS shadow removal (no delete trigger exists for entries).
      this.db
        .prepare(
          `INSERT INTO entries_fts(entries_fts, rowid, title, body) VALUES ('delete', ?, ?, ?)`,
        )
        .run(row.rowid, row.title, row.body)
      this.db.prepare(`DELETE FROM entries WHERE id = ?`).run(id)
      this.db.exec('COMMIT')
      return true
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw err
    }
  }

  /**
   * Scan up to DEDUP_SCAN_CAP most recent live same-project-or-global entries for Jaccard overlap.
   * @returns {{ id: string, title: string, overlap: number }|null}
   */
  findNearDup(title, body, project) {
    const mine = contentTokens(`${title} ${body}`)
    if (mine.size === 0) return null
    const rows = this.db
      .prepare(
        `SELECT id, title, body, project FROM entries
         WHERE ${liveSql()}
           AND project IS ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(project, DEDUP_SCAN_CAP)

    // Prefer the strongest same-scope candidate so a blockable duplicate is
    // never shadowed by a slightly-stronger cross-scope one.
    let best = null
    for (const r of rows) {
      const overlap = Math.round(jaccard(mine, contentTokens(`${r.title} ${r.body}`)) * 1000) / 1000
      if (overlap < DEDUP_WARN) continue
      const sameScope = r.project === project
      if (
        !best ||
        (sameScope && !best.sameScope) ||
        (sameScope === best.sameScope && overlap > best.overlap)
      ) {
        best = { id: r.id, title: r.title, overlap, project: r.project, sameScope }
      }
    }
    return best
  }

  /**
   * @param {string} id
   */
  get(id) {
    const row = this.db
      .prepare(
        `SELECT id, type, title, body, project, agent, source, status, created_at, updated_at,
                importance, access_count, last_accessed_at, superseded_by,
                helpful_count, harmful_count,
                invalid_at, invalidated_by, invalidation_reason
         FROM entries WHERE id = ?`,
      )
      .get(id)
    if (!row) return null
    if (row.invalid_at) {
      return {
        invalidated: true,
        invalid_at: row.invalid_at,
        invalidated_by: row.invalidated_by,
        invalidation_reason: row.invalidation_reason,
        hint: 'this entry was invalidated; treat as no longer true',
      }
    }
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
   * @param {string|null} [agent]
   * @returns {{ id: string, hop: number, score: number, title: string, type: string, project: string|null, agent: string|null, source: string|null, created_at: string, importance: number, excerpt: string }[]}
   */
  graphSearch(query, project, agent) {
    // node:sqlite rejects undefined binds; null is the "no project/agent filter" sentinel.
    project = project == null ? null : project
    agent = agent == null ? null : agent
    try {
      const extracted = extractEntities(query)
      // Also look up any extracted names case-insensitively, plus bare tokens as entity names.
      const seedIds = new Set()

      /** @type {Set<string>} */
      const lookupNames = new Set()
      for (const ent of extracted) {
        if (ent.name) lookupNames.add(ent.name)
      }
      // Case-insensitive name lookup for significant tokens (3+ chars)
      const tokens = String(query).match(/[A-Za-z0-9_][A-Za-z0-9_.-]{2,}/g) ?? []
      for (const tok of tokens) lookupNames.add(tok)
      // Multi-word concept names: try the full query trimmed
      const full = String(query).trim()
      if (full.length >= 3 && full.length <= 80) lookupNames.add(full)

      if (lookupNames.size > 0) {
        const names = [...lookupNames]
        const placeholders = names.map(() => '?').join(',')
        // Single batched IN lookup (case-insensitive via lower()).
        const rows = this.db
          .prepare(
            `SELECT id FROM entities WHERE lower(name) IN (${placeholders})`,
          )
          .all(...names.map((n) => String(n).toLowerCase()))
        for (const r of rows) seedIds.add(r.id)
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
          `SELECT e.id, e.type, e.title, e.body, e.project, e.agent, e.source, e.created_at, e.importance,
                  e.access_count, e.helpful_count, e.harmful_count,
                  ${BASE_SCORE_SQL} AS score
           FROM entries e
           WHERE e.id IN (${ePlace})
             AND ${liveSql('e')}
             AND ${projectScopeSql('e')}
             AND (? IS NULL OR e.agent = ?)`,
        )
        .all(...entryIds, project, project, agent, agent)

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
        source: r.source,
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
   * Vector retriever: embed the query, brute-force cosine over stored vectors
   * (live, project-or-global), top VECTOR_TOP by score DESC. Fail-soft → [].
   * @param {string} query
   * @param {string|null} project
   * @param {string|null} [agent]
   * @returns {Promise<{ id: string, score: number, title: string, type: string, project: string|null, agent: string|null, source: string|null, created_at: string, importance: number, excerpt: string }[]>}
   */
  async vectorSearch(query, project, agent) {
    if (!this.embedder) return []
    project = project == null ? null : project
    agent = agent == null ? null : agent
    try {
      const q = await Promise.resolve(this.embedder.embed(String(query).slice(0, EMBED_MAX_CHARS)))
      if (!q) return []
      // ponytail: brute-force cosine with a BLOB decode per row is fine at ~10^3
      // entries; sqlite-vec ANN is the upgrade if the store grows.
      const rows = this.db
        .prepare(
          `SELECT v.entry_id AS id, v.vec AS vec, v.dim AS dim,
                  e.type, e.title, e.body, e.project, e.agent, e.source, e.created_at, e.importance
           FROM entry_vectors v
           JOIN entries e ON e.id = v.entry_id
           WHERE v.model = ?
             AND ${liveSql('e')}
             AND ${projectScopeSql('e')}
             AND (? IS NULL OR e.agent = ?)`,
        )
        .all(this.embedder.model, project, project, agent, agent)

      const scored = rows
        .filter((r) => r.dim === q.length)
        .map((r) => ({
          id: r.id,
          score: cosine(q, blobToFloat(r.vec)),
          title: r.title,
          type: r.type,
          project: r.project,
          agent: r.agent,
          source: r.source,
          created_at: r.created_at,
          importance: r.importance,
          excerpt: excerptFromBody(r.body),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, VECTOR_TOP)
      return scored
    } catch (err) {
      console.error('vectorSearch failed (non-fatal):', err)
      return []
    }
  }

  /**
   * Embed one live entry and UPSERT its vector. Best-effort; never throws to callers
   * that await it carefully — failures log and return. No-op without embedder.
   * After the UPSERT, non-task entries are checked for a semantic near-dup and
   * a review pair is enqueued when cosine >= SEMANTIC_DUP. Hits never refuse
   * the write. store() stays sync; this runs on the fire-and-forget embed.
   * @param {string} id
   */
  async embedEntry(id) {
    if (!this.embedder) return
    try {
      const row = this.db
        .prepare(
          `SELECT id, title, body, type, project FROM entries WHERE id = ? AND ${liveSql()}`,
        )
        .get(id)
      if (!row) return
      const text = `${row.title}\n${row.body}`.slice(0, EMBED_MAX_CHARS)
      const vec = await Promise.resolve(this.embedder.embed(text))
      if (!vec) return
      this.db
        .prepare(
          `INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(entry_id) DO UPDATE SET
             dim = excluded.dim, vec = excluded.vec, model = excluded.model, created_at = excluded.created_at`,
        )
        .run(id, vec.length, floatToBlob(vec), this.embedder.model, new Date().toISOString())
      // ponytail: write path only, backfill is the janitor's job
      if (row.type === 'task') return
      const hits = semanticNeighbors(this.db, vec, {
        model: this.embedder.model,
        project: row.project,
        exclude: id,
        types: null,
        minScore: SEMANTIC_DUP,
        limit: 1,
      })
      const hit = hits[0]
      if (hit) queueReview(this.db, 'near_dup', id, hit.id, `cosine=${hit.score}`)
    } catch (err) {
      console.error('embedEntry failed (non-fatal):', err)
    }
  }

  /**
   * Backfill up to `limit` missing/stale embeddings for live entries (newest first).
   * @param {number} [limit]
   * @returns {Promise<number>}
   */
  async embedMissing(limit = EMBED_BACKFILL_CAP) {
    if (!this.embedder) return 0
    const cap = Math.max(1, Math.trunc(limit) || EMBED_BACKFILL_CAP)
    try {
      const model = this.embedder.model
      const rows = this.db
        .prepare(
          `SELECT e.id, e.title, e.body FROM entries e
           WHERE ${liveSql('e')}
             AND NOT EXISTS (
               SELECT 1 FROM entry_vectors v WHERE v.entry_id = e.id AND v.model = ?
             )
           ORDER BY e.rowid DESC
           LIMIT ?`,
        )
        .all(model, cap)
      if (rows.length === 0) return 0
      let n = 0
      for (const r of rows) {
        const text = `${r.title}\n${r.body}`.slice(0, EMBED_MAX_CHARS)
        const vec = await Promise.resolve(this.embedder.embed(text))
        if (!vec) continue
        this.db
          .prepare(
            `INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(entry_id) DO UPDATE SET
               dim = excluded.dim, vec = excluded.vec, model = excluded.model, created_at = excluded.created_at`,
          )
          .run(r.id, vec.length, floatToBlob(vec), model, new Date().toISOString())
        n += 1
      }
      return n
    } catch (err) {
      console.error('embedMissing failed (non-fatal):', err)
      return 0
    }
  }

  /**
   * @param {{ query: string, project?: string, agent?: string, limit?: number }} opts
   */
  async search(opts) {
    const query = cleanText('query', opts.query)
    const match = ftsQuery(query)
    const project = canonicalProject(cleanOptional(opts.project))
    const agent = cleanOptional(opts.agent)
    const wantLimit = clampLimit(opts.limit, DEFAULT_SEARCH_LIMIT)
    const excerptTokens = Math.min(64, SEARCH_EXCERPT_TOKENS)
    const fetchLimit = Math.max(wantLimit * 4, 40)

    /** @type {{ id: string, type: string, title: string, project: string|null, agent: string|null, source: string|null, created_at: string, importance: number, score: number, excerpt: string }[]} */
    let ftsRows = []
    if (match) {
      try {
        ftsRows = this.db
          .prepare(
            `SELECT e.id, e.type, e.title, e.project, e.agent, e.source, e.created_at, e.updated_at, e.importance,
                    e.access_count,
                    snippet(entries_fts, 1, '[', ']', '...', ?) AS excerpt,
                    ${COMPOSITE_SCORE_SQL} AS score
             FROM entries_fts
             JOIN entries e ON e.rowid = entries_fts.rowid
             WHERE entries_fts MATCH ?
               AND ${liveSql('e')}
               AND ${projectScopeSql('e')}
               AND (? IS NULL OR e.agent = ?)
             ORDER BY score DESC
             LIMIT ?`,
          )
          .all(excerptTokens, match, project, project, agent, agent, fetchLimit)
      } catch (err) {
        console.error('FTS search failed (non-fatal):', err)
        ftsRows = []
      }
    }

    const graphRows = this.graphSearch(query, project, agent)
    const vectorRows = await this.vectorSearch(query, project, agent)

    // If no retriever found anything, empty.
    if (ftsRows.length === 0 && graphRows.length === 0 && vectorRows.length === 0) return []

    // Pure FTS path: keep existing bm25 composite ordering (no graph/vector candidates).
    if (graphRows.length === 0 && vectorRows.length === 0) {
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
        source: r.source,
        created_at: r.created_at,
        updated_at: r.updated_at,
        importance: r.importance,
        score: r.score,
        excerpt: r.excerpt,
        hint: HINT,
      }))
    }

    // RRF fusion: score 1/(60 + rank), sum across retrievers (FTS, graph, vector).
    /** @type {Map<string, number>} */
    const rrf = new Map()
    ftsRows.forEach((r, i) => {
      rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (RRF_K + i + 1))
    })
    graphRows.forEach((r, i) => {
      rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (RRF_K + i + 1))
    })
    vectorRows.forEach((r, i) => {
      rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (RRF_K + i + 1))
    })

    const ftsById = new Map(ftsRows.map((r) => [r.id, r]))
    const graphById = new Map(graphRows.map((r) => [r.id, r]))
    const vectorById = new Map(vectorRows.map((r) => [r.id, r]))
    const fusedIds = [...rrf.keys()]

    // Re-score the fused set with a shared base composite (importance*decay*usage).
    // Mixing raw bm25 FTS scores with graph base scores breaks the 20% gate scale.
    const place = fusedIds.map(() => '?').join(',')
    const scoredRows = this.db
      .prepare(
        `SELECT e.id, e.type, e.title, e.body, e.project, e.agent, e.source, e.created_at, e.updated_at, e.importance,
                ${BASE_SCORE_SQL} AS score
         FROM entries e
         WHERE e.id IN (${place}) AND ${liveSql('e')}`,
      )
      .all(...fusedIds)

    const fused = scoredRows.map((row) => {
      const fts = ftsById.get(row.id)
      const g = graphById.get(row.id)
      const v = vectorById.get(row.id)
      return {
        id: row.id,
        type: row.type,
        title: row.title,
        project: row.project,
        agent: row.agent,
        source: row.source,
        created_at: row.created_at,
        updated_at: row.updated_at,
        importance: row.importance,
        score: row.score,
        excerpt: fts?.excerpt ?? g?.excerpt ?? v?.excerpt ?? excerptFromBody(row.body),
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
      source: r.source,
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
   * @param {{ title?: string, body?: string, status?: string, importance?: number, agent?: string, source?: string, project?: string }} fields
   */
  supersede(id, fields = {}) {
    const cleanId = cleanText('id', id)
    const old = this.db
      .prepare(
        `SELECT id, type, title, body, project, agent, source, status, importance, superseded_by
         FROM entries WHERE id = ?`,
      )
      .get(cleanId)

    if (!old) throw new Error(`no entry with id ${id}`)
    if (old.superseded_by) {
      throw new Error(`entry ${id} is already superseded by ${old.superseded_by}`)
    }

    const title = fields.title !== undefined ? cleanText('title', fields.title) : old.title
    const body = fields.body !== undefined ? cleanText('body', fields.body) : old.body
    // Canonicalize on supersede too: a successor must scope like its parent.
    const project =
      fields.project !== undefined
        ? fields.project === null
          ? null
          : canonicalProject(cleanText('project', fields.project))
        : old.project
    const agent = fields.agent !== undefined ? cleanOptional(fields.agent) : old.agent
    const source = fields.source !== undefined ? cleanOptional(fields.source) : old.source

    // Rewriting a live entry poisons the same channel as writing a new one.
    if (source === 'mcp') rejectInjectedMemory(title, body)

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
          `INSERT INTO entries (id, type, title, body, project, agent, source, status, importance, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId,
          old.type,
          title,
          body,
          project,
          agent,
          source,
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

    void this.embedEntry(newId).catch(() => {})

    return { id: newId }
  }

  /**
   * @param {{ project?: string }} opts
   */
  bootstrap(opts = {}) {
    const project = canonicalProject(cleanOptional(opts.project))

    const conventionsRaw = this.db
      .prepare(
        `SELECT id, title, body, importance, created_at FROM entries
         WHERE type = 'convention' AND ${liveSql()}
           AND (? IS NULL OR project = ?)
         ORDER BY importance DESC, created_at DESC
         LIMIT 50`,
      )
      .all(project, project)

    // Strategies go in whole: a "when X, do Y" rule truncated mid-clause is worse
    // than absent. They are short by construction and the budget caps the count.
    const strategiesRaw = this.db
      .prepare(
        `SELECT id, title, body, importance, created_at FROM entries
         WHERE type = 'strategy' AND ${liveSql()}
           AND (? IS NULL OR project = ?)
         ORDER BY importance DESC, created_at DESC
         LIMIT 50`,
      )
      .all(project, project)

    const knowledgeRaw = this.db
      .prepare(
        `SELECT id, title, body, importance, created_at FROM entries
         WHERE type = 'knowledge' AND ${liveSql()}
           AND (? IS NULL OR project = ?)
         ORDER BY importance DESC, created_at DESC
         LIMIT 50`,
      )
      .all(project, project)

    const tasksRaw = this.db
      .prepare(
        `SELECT id, title, body, status, agent, source, project, created_at, updated_at FROM entries
         WHERE type = 'task' AND ${liveSql()}
           AND COALESCE(status, 'active') = 'active'
           AND (? IS NULL OR project = ?)
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 50`,
      )
      .all(project, project)

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

    const strategies = applyTokenBudget(
      strategiesRaw,
      SECTION_BUDGETS.strategies,
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
        source: r.source,
        project: r.project,
        updated_at: r.updated_at,
      }),
    ).map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      status: r.status,
      agent: r.agent,
      source: r.source,
      project: r.project,
      updated_at: r.updated_at,
    }))

    this.markAccessed([
      ...conventions.map((c) => c.id),
      ...strategies.map((s) => s.id),
      ...knowledge.map((k) => k.id),
      ...tasks.map((t) => t.id),
    ])

    return {
      conventions,
      strategies,
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
    const project = canonicalProject(cleanOptional(opts.project))
    const type = opts.type ? cleanText('type', opts.type) : null
    if (type && !ENTRY_TYPES.has(type)) {
      throw new Error(`invalid type '${type}'`)
    }

    const rows = this.db
      .prepare(
        `SELECT id, type, title, body, project, agent, source, status, created_at, updated_at, importance
         FROM entries
         WHERE ${liveSql()}
           AND ${projectScopeSql()}
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
      source: r.source,
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
    this._agentTrustByName = null
    this._agentTrustAt = 0
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

  /**
   * Append a transcript message. Raw material only — no access accounting or decay.
   * @param {{ sessionId: string, project?: string, threadTitle?: string, agent?: string, role: string, content: string }} input
   * @returns {{ id: number }}
   */
  recordSession(input) {
    const sessionId = cleanText('session id', input.sessionId)
    const role = cleanText('role', input.role)
    if (!SESSION_ROLES.has(role)) {
      throw new Error(`invalid role '${role}'; expected user|assistant|tool|system`)
    }
    let content = cleanText('content', input.content)
    if (content.length > SESSION_CONTENT_MAX) {
      content = content.slice(0, SESSION_CONTENT_MAX)
    }
    const project = canonicalProject(cleanOptional(input.project))
    const threadTitle = cleanOptional(input.threadTitle)
    const agent = cleanOptional(input.agent)
    const now = new Date().toISOString()

    const result = this.db
      .prepare(
        `INSERT INTO session_messages (session_id, project, thread_title, agent, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, project, threadTitle, agent, role, content, now)

    return { id: Number(result.lastInsertRowid) }
  }

  /**
   * FTS over transcript content. No access accounting.
   * Project scope matches entries: (project IS NULL OR project = ?).
   * @param {{ query: string, project?: string, limit?: number }} opts
   * @returns {{ sessionId: string, threadTitle: string|null, agent: string|null, role: string, excerpt: string, createdAt: string }[]}
   */
  sessionSearch(opts) {
    const query = cleanText('query', opts.query)
    const match = ftsQuery(query)
    if (!match) return []
    const project = canonicalProject(cleanOptional(opts.project))
    const wantLimit = clampLimit(opts.limit, SESSION_SEARCH_DEFAULT, SESSION_SEARCH_MAX)
    const excerptTokens = Math.min(64, SEARCH_EXCERPT_TOKENS)

    try {
      const rows = this.db
        .prepare(
          `SELECT m.session_id AS sessionId,
                  m.thread_title AS threadTitle,
                  m.agent AS agent,
                  m.role AS role,
                  snippet(session_messages_fts, 0, '[', ']', '...', ?) AS excerpt,
                  m.created_at AS createdAt
           FROM session_messages_fts
           JOIN session_messages m ON m.id = session_messages_fts.rowid
           WHERE session_messages_fts MATCH ?
             AND ${projectScopeSql('m')}
           ORDER BY bm25(session_messages_fts), m.created_at DESC
           LIMIT ?`,
        )
        .all(excerptTokens, match, project, project, wantLimit)

      return rows.map((r) => ({
        sessionId: r.sessionId,
        threadTitle: r.threadTitle ?? null,
        agent: r.agent ?? null,
        role: r.role,
        excerpt: r.excerpt ?? '',
        createdAt: r.createdAt,
      }))
    } catch (err) {
      console.error('sessionSearch failed (non-fatal):', err)
      return []
    }
  }

  /**
   * Delete transcript rows older than `days` (default 30). FTS rows go via delete trigger.
   * @param {number} [days]
   * @returns {number} rows deleted
   */
  pruneSessions(days = SESSION_RETENTION_DAYS) {
    const n = Number.isFinite(days) ? Math.max(0, Math.trunc(days)) : SESSION_RETENTION_DAYS
    const cutoff = new Date(Date.now() - n * 86_400_000).toISOString()
    const result = this.db
      .prepare(`DELETE FROM session_messages WHERE created_at < ?`)
      .run(cutoff)
    return result.changes ?? 0
  }

  /**
   * Tombstone a live entry (never deletes).
   * @param {string} id
   * @param {{ by?: string, reason?: string }} [opts]
   */
  invalidateEntry(id, opts = {}) {
    const cleanId = cleanText('id', id)
    const row = this.db
      .prepare(`SELECT id, superseded_by, invalid_at FROM entries WHERE id = ?`)
      .get(cleanId)
    if (!row) throw new Error(`no entry with id ${id}`)
    if (row.superseded_by) throw new Error(`entry ${id} is superseded — nothing to invalidate`)
    if (row.invalid_at) throw new Error(`entry ${id} is already invalidated`)
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE entries SET invalid_at = ?, invalidated_by = ?, invalidation_reason = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, opts.by ?? null, opts.reason ?? null, now, cleanId)
  }

  /**
   * Resolve one open review_queue row.
   * - noop: mark resolved, leave both entries
   * - update: mark resolved (adjudication recorded; merge via normal supersede tools)
   * - invalidate: mark resolved and tombstone the older entry (loser); winner is the other
   * @param {{ id: number|string, resolution: 'update'|'invalidate'|'noop' }} input
   */
  resolve(input) {
    const qid = Number(input.id)
    if (!Number.isInteger(qid) || qid < 1) {
      throw new Error(`invalid review queue id '${input.id}'`)
    }
    const resolution = cleanText('resolution', input.resolution)
    if (!RESOLUTIONS.has(resolution)) {
      throw new Error(`resolution must be update|invalidate|noop, got '${resolution}'`)
    }
    const row = this.db.prepare(`SELECT * FROM review_queue WHERE id = ?`).get(qid)
    if (!row) throw new Error(`no review_queue row ${qid}`)
    if (row.resolved_at) {
      throw new Error(`review_queue row ${qid} already resolved (${row.resolution})`)
    }

    const a = this.db
      .prepare(`SELECT id, created_at, superseded_by, invalid_at FROM entries WHERE id = ?`)
      .get(row.entry_a)
    const b = this.db
      .prepare(`SELECT id, created_at, superseded_by, invalid_at FROM entries WHERE id = ?`)
      .get(row.entry_b)
    if (!a || !b) throw new Error(`review_queue row ${qid} references a missing entry`)

    const dead = (e) => e.superseded_by || e.invalid_at
    if (resolution !== 'noop' && (dead(a) || dead(b))) {
      throw new Error(
        'one of the entries is no longer live — resolve with resolution:noop to clear the queue row',
      )
    }

    this.db.exec('BEGIN')
    try {
      if (resolution === 'invalidate') {
        const loser = a.created_at <= b.created_at ? a : b
        const winner = loser.id === a.id ? b : a
        this.invalidateEntry(loser.id, {
          by: winner.id,
          reason: 'contradicted by newer memory',
        })
      }
      this.db
        .prepare(`UPDATE review_queue SET resolved_at = ?, resolution = ? WHERE id = ?`)
        .run(new Date().toISOString(), resolution, qid)
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw err
    }
    return { ok: true, id: qid, resolution }
  }

  /**
   * Read-only consolidation report for memory_maintenance.
   * @param {{ project?: string, now?: number }} [opts]
   */
  maintenance(opts = {}) {
    const project = canonicalProject(cleanOptional(opts.project))
    const now = opts.now ?? Date.now()
    const agingCutoff = new Date(now - AGING_RUN_DAYS * 86_400_000).toISOString()

    const queueStats = this.db
      .prepare(
        `SELECT COUNT(*) AS open, MIN(created_at) AS oldest
         FROM review_queue WHERE resolved_at IS NULL`,
      )
      .get()
    const open = queueStats?.open ?? 0
    const oldestAgeDays = queueStats?.oldest
      ? Math.floor((now - Date.parse(queueStats.oldest)) / 86_400_000)
      : 0

    const openItems = this.db
      .prepare(
        `SELECT q.id, q.kind, q.detail, q.created_at,
                a.id AS a_id, a.title AS a_title,
                b.id AS b_id, b.title AS b_title
         FROM review_queue q
         JOIN entries a ON a.id = q.entry_a
         JOIN entries b ON b.id = q.entry_b
         WHERE q.resolved_at IS NULL
         ORDER BY q.created_at ASC, q.id ASC
         LIMIT ?`,
      )
      .all(MAINTENANCE_LIST_LIMIT)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        detail: r.detail,
        created_at: r.created_at,
        a: { id: r.a_id, title: r.a_title },
        b: { id: r.b_id, title: r.b_title },
        instruction: 'Resolve with memory_resolve {id, resolution: update|invalidate|noop}.',
      }))

    // Near-dup pairs among recent live entries (jaccard >= warn).
    const actives = this.db
      .prepare(
        `SELECT id, title, body, created_at FROM entries
         WHERE ${liveSql()}
           AND ${projectScopeSql()}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(project, project, DEDUP_SCAN_CAP)
    const tokenMap = new Map(actives.map((e) => [e.id, contentTokens(`${e.title} ${e.body}`)]))
    const seen = new Set()
    // Compute overlaps across the FULL scan window first, then take the top N
    // by overlap, so the list really is the strongest duplicates rather than
    // the first N found in recency order. Cost: O(window^2) jaccard over at
    // most DEDUP_SCAN_CAP entries, on an on-demand read-only tool.
    const nearDupes = []
    for (let i = 0; i < actives.length; i++) {
      for (let j = i + 1; j < actives.length; j++) {
        const a = actives[i]
        const b = actives[j]
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
        if (seen.has(key)) continue
        const overlap =
          Math.round(jaccard(tokenMap.get(a.id), tokenMap.get(b.id)) * 1000) / 1000
        if (overlap < DEDUP_WARN) continue
        seen.add(key)
        nearDupes.push({
          a: { id: a.id, title: a.title },
          b: { id: b.id, title: b.title },
          overlap,
          instruction:
            'Keep the better one: memory_supersede the weaker entry (merge unique details into the survivor).',
        })
      }
    }
    nearDupes.sort((x, y) => y.overlap - x.overlap)
    nearDupes.length = Math.min(nearDupes.length, MAINTENANCE_LIST_LIMIT)

    const agingRuns = this.db
      .prepare(
        `SELECT id, title, created_at, project FROM entries
         WHERE type = 'run' AND ${liveSql()} AND created_at < ?
           AND ${projectScopeSql()}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(agingCutoff, project, project, MAINTENANCE_LIST_LIMIT)
      .map((r) => ({
        ...r,
        instruction:
          'If durable, memory_store as knowledge then memory_supersede the run with a one-line outcome.',
      }))

    const fatConventions = this.db
      .prepare(
        `SELECT id, title, length(body) AS chars, created_at FROM entries
         WHERE type = 'convention' AND ${liveSql()} AND length(body) > ?
           AND ${projectScopeSql()}
         ORDER BY chars DESC
         LIMIT ?`,
      )
      .all(FAT_CONVENTION_CHARS, project, project, MAINTENANCE_LIST_LIMIT)
      .map((r) => ({
        ...r,
        instruction:
          'memory_supersede with a tighter body that keeps every rule; never drop rules to save space.',
      }))

    const agents = agentTrust(this.db)
    const suspect = agents.filter((a) => a.trust < TRUST_SUSPECT)

    return {
      queue: {
        open,
        oldestAgeDays,
        items: openItems,
        instruction: 'Resolve open items with memory_resolve {id, resolution}.',
      },
      nearDupes,
      agingRuns,
      fatConventions,
      trust: {
        agents,
        suspect,
        instruction:
          'Per-agent trust is derived from helpful/harmful/invalidated evidence. Suspect agents (trust < 0.8) write lower-trust memories; review their live entries before acting on them.',
      },
    }
  }

  _cachedAgentTrust() {
    const now = Date.now()
    if (this._agentTrustByName && now - this._agentTrustAt < TRUST_CACHE_TTL_MS) {
      return this._agentTrustByName
    }
    const map = new Map()
    try {
      for (const row of agentTrust(this.db)) map.set(row.agent, row.trust)
    } catch (err) {
      console.error('agentTrust cache refresh failed (non-fatal):', err)
      return this._agentTrustByName ?? map
    }
    this._agentTrustByName = map
    this._agentTrustAt = now
    return map
  }
}
