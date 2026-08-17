/**
 * Per-agent trust (#309).
 *
 * Provenance answers "who wrote this"; trust answers "can I believe them".
 * An agent whose entries keep getting marked harmful or invalidated writes
 * lower-trust entries, and that demotes everything else it wrote — the
 * memory-poisoning case from OWASP ASI06, where one bad writer quietly
 * outranks good ones.
 *
 * Trust is a multiplier in the same family as feedbackFactor in memory.js:
 * 1.0 is neutral, and the clamp keeps it a nudge on ranking rather than a
 * veto. Evidence is per-agent and derived — nothing new is written to the
 * entries themselves.
 */

export const TRUST_MIN = 0.5
export const TRUST_MAX = 1.5

/** Below this an agent is bad enough to flag in memory_maintenance. */
export const TRUST_SUSPECT = 0.8

/**
 * Trust multiplier for one agent's accumulated evidence.
 *
 * Harmful and invalidated weigh heavier than helpful on purpose: a wrong
 * memory costs more than a right one earns. Caps stop a single prolific
 * agent from pinning itself at either end.
 *
 * @param {{ helpful?: number, harmful?: number, invalidated?: number }} [evidence]
 * @returns {number} clamped to [TRUST_MIN, TRUST_MAX]; 1.0 with no evidence
 */
export function trustFactor(evidence = {}) {
  const helpful = Math.max(0, Number(evidence.helpful) || 0)
  const harmful = Math.max(0, Number(evidence.harmful) || 0)
  const invalidated = Math.max(0, Number(evidence.invalidated) || 0)
  const raw =
    1 + 0.05 * Math.min(helpful, 10) - 0.1 * Math.min(harmful, 5) - 0.1 * Math.min(invalidated, 5)
  return Math.min(TRUST_MAX, Math.max(TRUST_MIN, raw))
}

/**
 * Per-agent evidence rollup. One grouped query; trust is derived, never stored.
 * NULL/empty writers are skipped (they stay at the 1.0 default in ranking).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ agent: string, entries: number, helpful: number, harmful: number, invalidated: number, trust: number }[]}
 */
export function agentTrust(db) {
  try {
    const rows = db
      .prepare(
        `SELECT agent,
                COUNT(*) AS entries,
                COALESCE(SUM(helpful_count), 0) AS helpful,
                COALESCE(SUM(harmful_count), 0) AS harmful,
                COALESCE(SUM(invalid_at IS NOT NULL), 0) AS invalidated
         FROM entries
         WHERE agent IS NOT NULL AND trim(agent) != ''
         GROUP BY agent`,
      )
      .all()
    const out = []
    for (const r of rows) {
      const entries = Number(r.entries) || 0
      if (entries <= 0) continue
      const helpful = Number(r.helpful) || 0
      const harmful = Number(r.harmful) || 0
      const invalidated = Number(r.invalidated) || 0
      out.push({
        agent: r.agent,
        entries,
        helpful,
        harmful,
        invalidated,
        trust: trustFactor({ helpful, harmful, invalidated }),
      })
    }
    out.sort((a, b) => a.trust - b.trust || a.agent.localeCompare(b.agent))
    return out
  } catch (err) {
    console.error('agentTrust failed (non-fatal):', err)
    return []
  }
}

/**
 * Source surfaces an entry can come from. Free text is still accepted (the
 * column is plain TEXT); this is the vocabulary the UI and reports expect.
 */
export const SOURCES = ['mcp', 'app', 'rest', 'janitor', 'import']
