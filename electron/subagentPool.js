"use strict";

/**
 * Described worker-model pool (issue #467).
 *
 * A settings-level menu of (alias, provider, model, one-line description).
 * The lead sees the one-liners and passes `pool=<alias>` on thread_fork.
 * `force` pins every worker to `defaultAlias`. Empty pool = inherit the lead.
 *
 * Does not route the user-facing thread (that is issue #246).
 */

/** @typedef {{ alias: string, provider: string, model: string | null, description: string }} SubagentPoolEntry */
/** @typedef {{ defaultAlias: string | null, force: boolean, entries: SubagentPoolEntry[] }} SubagentPool */
/** @typedef {{ provider: string, model?: string | null, alias?: string, fromPool: boolean }} SubagentPoolResolution */

const EMPTY_SUBAGENT_POOL = Object.freeze({
  defaultAlias: null,
  force: false,
  entries: Object.freeze([]),
});

/** Alias the lead types: lowercase slug, 1-32 chars, starts with a letter. */
const ALIAS_RE = /^[a-z][a-z0-9-]{0,31}$/;
const DESC_MAX = 160;

/**
 * @param {unknown} item
 * @param {boolean} strict
 * @returns {SubagentPoolEntry | null}
 */
function parseEntry(item, strict) {
  const fail = (msg) => {
    if (strict) throw new Error(msg);
    return null;
  };
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return fail("subagentPool entry must be a plain object");
  }
  const rec = /** @type {Record<string, unknown>} */ (item);
  const alias =
    typeof rec.alias === "string" ? rec.alias.trim().toLowerCase() : "";
  if (!ALIAS_RE.test(alias)) {
    return fail(
      'subagentPool alias must be a lowercase slug (e.g. "fast"), 1-32 characters',
    );
  }
  const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
  if (!provider) {
    return fail("subagentPool entry provider must be a non-empty string");
  }
  const model = rec.model;
  if (model !== null && typeof model !== "string") {
    return fail("subagentPool entry model must be a string or null");
  }
  const rawDesc = typeof rec.description === "string" ? rec.description : "";
  const description = rawDesc.replace(/\s+/g, " ").trim();
  if (!description) {
    return fail("subagentPool entry description must be a non-empty string");
  }
  if (description.length > DESC_MAX) {
    return fail(
      `subagentPool entry description must be at most ${DESC_MAX} characters`,
    );
  }
  return {
    alias,
    provider,
    model: typeof model === "string" ? (model.trim() || null) : null,
    description,
  };
}

/**
 * Lenient disk heal: absent/junk → empty pool. Invalid entries dropped.
 * defaultAlias that no longer names an entry heals to null.
 * @param {unknown} raw
 * @returns {SubagentPool}
 */
function normalizeSubagentPool(raw) {
  const empty = {
    defaultAlias: /** @type {string | null} */ (null),
    force: false,
    entries: /** @type {SubagentPoolEntry[]} */ ([]),
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const rec = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(rec.entries)) return empty;
  const seen = new Set();
  const entries = [];
  for (const item of rec.entries) {
    const entry = parseEntry(item, false);
    if (!entry || seen.has(entry.alias)) continue;
    seen.add(entry.alias);
    entries.push(entry);
  }
  let defaultAlias =
    typeof rec.defaultAlias === "string" ? rec.defaultAlias.trim().toLowerCase() : null;
  if (defaultAlias && !seen.has(defaultAlias)) defaultAlias = null;
  if (defaultAlias === "") defaultAlias = null;
  return {
    defaultAlias,
    force: rec.force === true && defaultAlias != null,
    entries,
  };
}

/**
 * Strict validation for settings:set. Throws on the first problem.
 * @param {unknown} raw
 * @returns {SubagentPool}
 */
function validateSubagentPool(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("subagentPool must be an object");
  }
  const rec = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(rec.entries)) {
    throw new Error("subagentPool.entries must be an array");
  }
  const seen = new Set();
  const entries = rec.entries.map((item) => {
    const entry = parseEntry(item, true);
    if (seen.has(entry.alias)) {
      throw new Error(`Duplicate subagentPool alias: ${entry.alias}`);
    }
    seen.add(entry.alias);
    return entry;
  });
  let defaultAlias = rec.defaultAlias;
  if (defaultAlias != null) {
    if (typeof defaultAlias !== "string") {
      throw new Error("subagentPool.defaultAlias must be a string or null");
    }
    defaultAlias = defaultAlias.trim().toLowerCase();
    if (defaultAlias === "") defaultAlias = null;
    else if (!seen.has(defaultAlias)) {
      throw new Error(
        `subagentPool.defaultAlias "${defaultAlias}" is not in entries`,
      );
    }
  }
  if (rec.force != null && typeof rec.force !== "boolean") {
    throw new Error("subagentPool.force must be a boolean");
  }
  const force = rec.force === true && defaultAlias != null;
  return { defaultAlias, force, entries };
}

/**
 * Pick provider/model for one worker spawn.
 *
 * Empty pool: pass through an explicit provider, else inherit (null).
 * force + default: always that entry; ignore pool/provider on the request.
 * request.pool alias: that entry (unknown alias throws).
 * request.provider: legacy explicit override (not fromPool).
 * else default alias, if set.
 * else inherit (null).
 *
 * @param {SubagentPool | null | undefined} pool
 * @param {{ pool?: unknown, provider?: unknown }} [request]
 * @returns {SubagentPoolResolution | null}
 */
function resolveSubagentPool(pool, request) {
  const req = request && typeof request === "object" ? request : {};
  const entries = pool && Array.isArray(pool.entries) ? pool.entries : [];
  const byAlias = new Map(entries.map((e) => [e.alias, e]));
  const defaultEntry =
    pool && pool.defaultAlias ? byAlias.get(pool.defaultAlias) : undefined;
  const alias =
    req.pool != null && String(req.pool).trim()
      ? String(req.pool).trim().toLowerCase()
      : "";

  if (entries.length === 0) {
    if (alias) throw new Error(`Unknown pool alias: ${alias}`);
    if (req.provider != null && String(req.provider)) {
      return { provider: String(req.provider), fromPool: false };
    }
    return null;
  }

  if (pool && pool.force && defaultEntry) {
    return {
      provider: defaultEntry.provider,
      model: defaultEntry.model,
      alias: defaultEntry.alias,
      fromPool: true,
    };
  }

  if (alias) {
    const entry = byAlias.get(alias);
    if (!entry) throw new Error(`Unknown pool alias: ${alias}`);
    return {
      provider: entry.provider,
      model: entry.model,
      alias: entry.alias,
      fromPool: true,
    };
  }

  if (req.provider != null && String(req.provider)) {
    return { provider: String(req.provider), fromPool: false };
  }

  if (defaultEntry) {
    return {
      provider: defaultEntry.provider,
      model: defaultEntry.model,
      alias: defaultEntry.alias,
      fromPool: true,
    };
  }
  return null;
}

/**
 * Menu the lead sees. Empty string when there is nothing to say.
 * @param {SubagentPool | null | undefined} pool
 * @returns {string}
 */
function formatPoolMenu(pool) {
  if (!pool || !Array.isArray(pool.entries) || pool.entries.length === 0) {
    return "";
  }
  const line = (e) => {
    const model = e.model || "default";
    return `- ${e.alias}: ${e.description} (${e.provider} / ${model})`;
  };
  const items = pool.entries.map(line).join("\n");
  if (pool.force && pool.defaultAlias) {
    const pinned = pool.entries.find((e) => e.alias === pool.defaultAlias);
    const model = pinned && pinned.model ? pinned.model : "default";
    const provider = pinned ? pinned.provider : "?";
    return (
      `[Worker pool] Pinned to "${pool.defaultAlias}" (${provider} / ${model}). ` +
      `thread_fork provider and pool arguments are ignored.`
    );
  }
  const def = pool.defaultAlias;
  const omit = def
    ? `Omit pool to use "${def}".`
    : "Omit pool to inherit this thread's provider.";
  return (
    `[Worker pool] Pass pool=<alias> on thread_fork to pick a worker model. ` +
    `${omit}\n${items}`
  );
}

/**
 * Dispatch note. Same coder-threads gate as selfIdNoteFor: with no thread
 * tools in the run there is nothing to pass these aliases to.
 * @param {SubagentPool | null | undefined} pool
 * @returns {string}
 */
function subagentPoolNoteFor(pool) {
  try {
    const { activeServers } = require("./memory-sup.js");
    if (!activeServers().some((s) => s.name === "coder-threads")) return "";
  } catch {
    return "";
  }
  const menu = formatPoolMenu(pool);
  return menu ? `\n\n${menu}` : "";
}

/**
 * Read the pool off a store, or the empty default when missing.
 * @param {{ getSettings?: () => { subagentPool?: SubagentPool } } | null | undefined} store
 * @returns {SubagentPool}
 */
function poolFromStore(store) {
  if (!store || typeof store.getSettings !== "function") {
    return {
      defaultAlias: null,
      force: false,
      entries: [],
    };
  }
  const settings = store.getSettings();
  const pool = settings && settings.subagentPool;
  if (!pool || !Array.isArray(pool.entries)) {
    return {
      defaultAlias: null,
      force: false,
      entries: [],
    };
  }
  return pool;
}

module.exports = {
  EMPTY_SUBAGENT_POOL,
  ALIAS_RE,
  DESC_MAX,
  parseEntry,
  normalizeSubagentPool,
  validateSubagentPool,
  resolveSubagentPool,
  formatPoolMenu,
  subagentPoolNoteFor,
  poolFromStore,
};
