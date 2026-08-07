/** Review-queue helpers and token overlap (shared by store gate + janitor scan). */

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
