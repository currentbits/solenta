"use strict";

/**
 * User model prices (#1531): model id → USD per million tokens. Solenta has
 * no built-in price table; every cost it shows is what the provider CLI
 * reported. These prices only fill usage cells that carry tokens but no
 * reported cost (the "unmetered" rows), and never touch a provider's own
 * figure such as Claude's total_cost_usd.
 */

const FIELDS = ["input", "output", "cacheRead", "cacheWrite"];

/**
 * @typedef {{ input: number, output: number, cacheRead?: number, cacheWrite?: number }} ModelPrice
 */

/** @param {unknown} v */
function isPrice(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Strict: throws on anything a user could have typed wrong.
 * @param {unknown} raw
 * @returns {Record<string, ModelPrice>}
 */
function validateModelPrices(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("modelPrices must be an object");
  }
  /** @type {Record<string, ModelPrice>} */
  const out = {};
  for (const [key, row] of Object.entries(raw)) {
    const model = key.trim();
    if (!model) throw new Error("Model price needs a model id");
    if (!row || typeof row !== "object") {
      throw new Error(`Price for ${model} must be an object`);
    }
    /** @type {Record<string, unknown>} */
    const r = /** @type {any} */ (row);
    /** @type {Record<string, number>} */
    const price = {};
    for (const field of FIELDS) {
      const v = r[field];
      if (v == null) {
        if (field === "input" || field === "output") {
          throw new Error(`Price for ${model} needs ${field}`);
        }
        continue;
      }
      if (!isPrice(v)) {
        throw new Error(`${field} price for ${model} must be a non-negative number`);
      }
      price[field] = v;
    }
    out[model] = /** @type {ModelPrice} */ (/** @type {unknown} */ (price));
  }
  return out;
}

/**
 * Lenient: junk on disk drops the bad row, not the whole map.
 * @param {unknown} raw
 * @returns {Record<string, ModelPrice>}
 */
function normalizeModelPrices(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  /** @type {Record<string, ModelPrice>} */
  const out = {};
  for (const [model, row] of Object.entries(raw)) {
    try {
      Object.assign(out, validateModelPrices({ [model]: row }));
    } catch {
      // drop the row
    }
  }
  return out;
}

/**
 * Cost of one cell at `price`. Cache reads and writes fall back to the
 * input price when the user left them blank.
 * @param {{ inputTokens?: number, cachedInputTokens?: number, cacheWriteTokens?: number, outputTokens?: number }} cell
 * @param {ModelPrice} price
 */
function priceCell(cell, price) {
  const n = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return (
    (n(cell.inputTokens) * price.input +
      n(cell.cachedInputTokens) * (price.cacheRead ?? price.input) +
      n(cell.cacheWriteTokens) * (price.cacheWrite ?? price.input) +
      n(cell.outputTokens) * price.output) /
    1e6
  );
}

/** @param {any} cell */
function unmetered(cell) {
  if (!cell || typeof cell !== "object" || Number(cell.costUsd) > 0) return false;
  return (
    Number(cell.inputTokens) > 0 ||
    Number(cell.cachedInputTokens) > 0 ||
    Number(cell.cacheWriteTokens) > 0 ||
    Number(cell.outputTokens) > 0
  );
}

/**
 * The usage report with unmetered cells priced. Returns new objects; the
 * store's ledger keeps the raw (cost 0) cells, so a price edit re-prices
 * history on the next read.
 * @param {{ byDay: Record<string, Record<string, Record<string, any>>>, threadsByDay: Record<string, Record<string, any>> }} report
 * @param {Record<string, ModelPrice>} prices
 */
function applyModelPrices(report, prices) {
  if (!prices || Object.keys(prices).length === 0) return report;
  /** @param {any} cell @param {unknown} model */
  const priced = (cell, model) => {
    const price = typeof model === "string" ? prices[model] : undefined;
    if (!price || !unmetered(cell)) return cell;
    return { ...cell, costUsd: priceCell(cell, price) };
  };
  /** @type {Record<string, Record<string, Record<string, any>>>} */
  const byDay = {};
  for (const [day, providers] of Object.entries(report.byDay || {})) {
    /** @type {Record<string, Record<string, any>>} */
    const dayOut = {};
    for (const [provider, models] of Object.entries(providers || {})) {
      /** @type {Record<string, any>} */
      const modelsOut = {};
      for (const [model, cell] of Object.entries(models || {})) {
        modelsOut[model] = priced(cell, model);
      }
      dayOut[provider] = modelsOut;
    }
    byDay[day] = dayOut;
  }
  /** @type {Record<string, Record<string, any>>} */
  const threadsByDay = {};
  for (const [day, threads] of Object.entries(report.threadsByDay || {})) {
    /** @type {Record<string, any>} */
    const dayOut = {};
    // ponytail: a thread cell is priced by its last-seen model.
    for (const [id, cell] of Object.entries(threads || {})) {
      dayOut[id] = priced(cell, cell && cell.model);
    }
    threadsByDay[day] = dayOut;
  }
  return { byDay, threadsByDay };
}

module.exports = {
  validateModelPrices,
  normalizeModelPrices,
  priceCell,
  applyModelPrices,
};
