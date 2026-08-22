/** Review-queue helpers, token overlap and cosine neighbours (shared by store gate + janitor scan). */

import { blobToFloat, cosine } from './embedder.js'

/**
 * Cosine similarity above which two entries are treated as the same fact said
 * twice. MiniLM puts unrelated project notes around 0.3-0.5, so this only fires
 * on genuine paraphrases.
 */
export const SEMANTIC_DUP = 0.9

/**
 * Cosine floor for a pair to be worth a human's attention at all. 02cf175
 * dropped this as unused; the janitor's semanticNeighbors rewire (#310) is
 * its consumer, so it is back. SEMANTIC_DUP stays at main's 0.9.
 */
export const SEMANTIC_RELATED = 0.6

/**
 * Cosine neighbours of `vec` among live entries that already have a vector,
 * strongest first. Same-project only, matching every other scoped read.
 *
 * ponytail: brute-force scan with a BLOB decode per row, same as vectorSearch.
 * Fine at hundreds of entries; swap the scan for sqlite-vec (ANN) if the store
 * grows past ~10k.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Float32Array} vec
 * @param {{ model: string, project?: string|null, exclude?: string|null, types?: string[]|null, minScore?: number, limit?: number }} opts
 * @returns {{ id: string, title: string, body: string, project: string|null, score: number }[]}
 */
export function semanticNeighbors(db, vec, opts) {
  const {
    model,
    project = null,
    exclude = null,
    types = null,
    minScore = SEMANTIC_DUP,
    limit = 10,
  } = opts ?? {}
  if (!vec || !vec.length || !model) return []
  try {
    const typeSql = types?.length ? `AND e.type IN (${types.map(() => '?').join(',')})` : ''
    const rows = db
      .prepare(
        `SELECT e.id, e.title, e.body, e.project, v.vec AS vec, v.dim AS dim
         FROM entry_vectors v
         JOIN entries e ON e.id = v.entry_id
         WHERE v.model = ?
           AND e.superseded_by IS NULL
           AND e.invalid_at IS NULL
           AND e.project IS ?
           AND (? IS NULL OR e.id != ?)
           ${typeSql}`,
      )
      .all(model, project, exclude, exclude, ...(types ?? []))

    const out = []
    for (const r of rows) {
      if (r.dim !== vec.length) continue
      const score = Math.round(cosine(vec, blobToFloat(r.vec)) * 1000) / 1000
      if (score < minScore) continue
      out.push({ id: r.id, title: r.title, body: r.body, project: r.project, score })
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit)
  } catch (err) {
    console.error('semanticNeighbors failed (non-fatal):', err)
    return []
  }
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
export function contentTokens(text) {
  const tokens = String(text ?? '')
    .toLowerCase()
    .match(/[a-z0-9_]+/g) ?? []
  return new Set(tokens.filter((t) => t.length >= 3))
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
export function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

/**
 * Best-effort canonical review-queue insert. Pairs stored with entry_a < entry_b.
 * Partial unique index + NOT EXISTS keeps open pairs unique. Returns true iff inserted.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'near_dup'|'contradiction'} kind
 * @param {string} aId
 * @param {string} bId
 * @param {string} detail
 */
export function queueReview(db, kind, aId, bId, detail) {
  try {
    const [a, b] = aId < bId ? [aId, bId] : [bId, aId]
    const info = db
      .prepare(
        `INSERT INTO review_queue (kind, entry_a, entry_b, detail, created_at)
         SELECT ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM review_queue
           WHERE kind = ? AND entry_a = ? AND entry_b = ? AND resolved_at IS NULL
         )`,
      )
      .run(kind, a, b, detail, new Date().toISOString(), kind, a, b)
    return (info.changes ?? 0) > 0
  } catch (err) {
    console.error('queueReview failed (non-fatal):', err)
    return false
  }
}
