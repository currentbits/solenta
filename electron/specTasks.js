"use strict";

/**
 * Parse a spec thread's tasks.md into a dispatch DAG (issue #537).
 *
 * Format — GitHub-style checkboxes; every other line is ignored:
 *
 *   - [ ] 1. Title (`src/foo.ts`) — req 1
 *   - [ ] 2. Title (`src/bar.ts`) — req 2 — needs: 1
 *   - [x] T3: Already done — needs: 1, 2
 *
 * Ids are a leading `1.` / `1)` / `#1` / `T1:` token. A line with no id
 * gets the next unused 1-based number. `needs:` is a comma/space list of
 * those ids (T1, t1, #1, and 1 are the same id). Checked boxes (`[x]`)
 * are done. The title keeps the leading id so it matches the file.
 */

/**
 * @param {unknown} raw
 * @returns {string} canonical numeric id, or "" if it is not an id
 */
function normalizeTaskId(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(?:T|t|#)?(\d+)$/);
  return m ? m[1] : "";
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function splitNeeds(raw) {
  return String(raw || "")
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * @param {string} body
 * @returns {{ id: string | null, title: string, needs: string[], needTokens: string[] }}
 */
function parseTaskBody(body) {
  let text = String(body || "").replace(/\s+/g, " ").trim();
  /** @type {string[]} */
  const needTokens = [];
  const needsMatch = text.match(/[—–-]?\s*needs:\s*(.+)$/i);
  if (needsMatch) {
    for (const token of splitNeeds(needsMatch[1])) needTokens.push(token);
    text = text.slice(0, needsMatch.index).replace(/[—–-]\s*$/, "").trim();
  }
  const idMatch = text.match(/^(?:T|t|#)?(\d+)\s*[.:)]\s+/);
  const id = idMatch ? idMatch[1] : null;
  return { id, title: text, needs: needTokens.map(normalizeTaskId), needTokens };
}

/**
 * Topological waves of the still-open tasks. A wave is every remaining
 * task whose (still-open) dependencies are already in a previous wave.
 *
 * @param {Array<{ id: string, needs?: string[], done?: boolean, status?: string }>} tasks
 * @returns {{ waves: string[][], cycle: string[] | null }}
 */
function taskWaves(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const done = new Set(
    list
      .filter((t) => t && (t.done === true || t.status === "done"))
      .map((t) => String(t.id)),
  );
  /** @type {Map<string, string[]>} */
  const remaining = new Map();
  for (const t of list) {
    if (!t || t.done === true || t.status === "done") continue;
    const id = String(t.id);
    const needs = Array.isArray(t.needs)
      ? t.needs.map(String).filter((n) => n && !done.has(n))
      : [];
    remaining.set(id, needs);
  }
  /** @type {string[][]} */
  const waves = [];
  while (remaining.size > 0) {
    const wave = [];
    for (const [id, needs] of remaining) {
      if (needs.every((n) => !remaining.has(n))) wave.push(id);
    }
    if (wave.length === 0) {
      return { waves, cycle: [...remaining.keys()] };
    }
    wave.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    waves.push(wave);
    for (const id of wave) remaining.delete(id);
  }
  return { waves, cycle: null };
}

/**
 * @param {unknown} text
 * @returns {{
 *   tasks: Array<{ id: string, title: string, needs: string[], done: boolean, line: number }>,
 *   errors: string[],
 *   waves: string[][],
 * }}
 */
function parseTasksMd(text) {
  const src = text == null ? "" : String(text);
  /** @type {Array<{ id: string, title: string, needs: string[], done: boolean, line: number }>} */
  const tasks = [];
  /** @type {string[]} */
  const errors = [];
  const used = new Set();
  let next = 1;

  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (!match) continue;
    const done = match[1] !== " ";
    const parsed = parseTaskBody(match[2]);
    if (!parsed.title) {
      errors.push(`line ${i + 1}: empty task title`);
      continue;
    }
    let id = parsed.id;
    if (!id) {
      while (used.has(String(next))) next += 1;
      id = String(next);
      next += 1;
    }
    if (used.has(id)) {
      errors.push(`line ${i + 1}: duplicate task id ${id}`);
      continue;
    }
    used.add(id);

    const needs = [];
    for (let n = 0; n < parsed.needTokens.length; n++) {
      const token = parsed.needTokens[n];
      const nid = parsed.needs[n];
      if (!nid) {
        errors.push(`line ${i + 1}: invalid dependency id "${token}"`);
        continue;
      }
      if (nid === id) {
        errors.push(`line ${i + 1}: task ${id} cannot need itself`);
        continue;
      }
      if (!needs.includes(nid)) needs.push(nid);
    }
    tasks.push({ id, title: parsed.title, needs, done, line: i + 1 });
  }

  const known = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const need of t.needs) {
      if (!known.has(need)) {
        errors.push(`task ${t.id} needs unknown task "${need}"`);
      }
    }
  }

  const { waves, cycle } = taskWaves(tasks);
  if (cycle) {
    errors.push(`dependency cycle: ${cycle.join(" → ")}`);
  }

  return { tasks, errors, waves };
}

module.exports = {
  normalizeTaskId,
  parseTasksMd,
  taskWaves,
};
