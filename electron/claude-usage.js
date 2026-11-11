"use strict";

const FIELDS = {
  inputTokens: "input_tokens",
  cachedInputTokens: "cache_read_input_tokens",
  cacheWriteTokens: "cache_creation_input_tokens",
  outputTokens: "output_tokens",
  reasoningTokens: "reasoning_tokens",
};
const MODEL_FIELDS = {
  inputTokens: "inputTokens", cachedInputTokens: "cacheReadInputTokens",
  cacheWriteTokens: "cacheCreationInputTokens", outputTokens: "outputTokens",
  reasoningTokens: "reasoningTokens", costUsd: "costUSD",
};
const number = x => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
const modelName = x => typeof x === "string" && x && x !== "<synthetic>" ? x : null;
const TOKEN_WIRES = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"];
const isObject = x => Boolean(x) && typeof x === "object" && !Array.isArray(x);

/** Sparse, finite, nonnegative per-model counters keyed by exact wire model ID. */
function normalizeModelUsage(raw) {
  const out = {};
  if (!isObject(raw)) return out;
  for (const [model, row] of Object.entries(raw)) {
    if (!modelName(model) || !isObject(row)) continue;
    const next = {};
    for (const wire of Object.values(MODEL_FIELDS)) if (number(row[wire]) !== undefined) next[wire] = row[wire];
    if (Object.keys(next).length) out[model] = next;
  }
  return out;
}
function addModelUsage(a, b) {
  const out = normalizeModelUsage(a);
  for (const [model, row] of Object.entries(normalizeModelUsage(b))) {
    const next = out[model] || {};
    for (const [wire, value] of Object.entries(row)) next[wire] = (next[wire] || 0) + value;
    out[model] = next;
  }
  return out;
}
function normalizeUnattributed(raw) {
  const out = {};
  for (const wire of Object.values(MODEL_FIELDS)) if (number(raw?.[wire])) out[wire] = raw[wire];
  return out;
}

/**
 * Persisted Claude session accounting checkpoint (#1961). Separate from
 * Codex's sessionUsageBaseline. Malformed or other-version records are absent.
 * @returns {null | {version: 1, scope: string, sessionId: string, totalCostUsd: number,
 *   modelUsage: Record<string, Record<string, number>>, unattributed: Record<string, number>,
 *   reported: {totalCostUsd?: number, modelUsage: Record<string, Record<string, number>>}}}
 */
function normalizeClaudeCheckpoint(raw) {
  if (!isObject(raw) || raw.version !== 1 || typeof raw.scope !== "string" || !raw.scope ||
      typeof raw.sessionId !== "string" || !raw.sessionId) return null;
  const reportedCost = number(raw.reported?.totalCostUsd);
  return {
    version: 1, scope: raw.scope, sessionId: raw.sessionId,
    totalCostUsd: number(raw.totalCostUsd) || 0,
    modelUsage: normalizeModelUsage(raw.modelUsage),
    unattributed: normalizeUnattributed(raw.unattributed),
    reported: { ...(reportedCost !== undefined ? { totalCostUsd: reportedCost } : {}), modelUsage: normalizeModelUsage(raw.reported?.modelUsage) },
  };
}

/** The checkpoint a handle's settled accounting epoch implies, or null while unproven. */
function claudeCheckpointFromHandle(handle, scope, sessionId) {
  if (!handle || handle.claudeResume || !scope || typeof sessionId !== "string" || !sessionId) return null;
  return normalizeClaudeCheckpoint({
    version: 1, scope, sessionId,
    totalCostUsd: handle.lastTotalCostUsd,
    modelUsage: handle.lastModelUsage,
    unattributed: handle.unattributedModelUsage,
    reported: handle.claudeReported,
  });
}

/** Pre-2.1.277 CLIs start every process at zero (documented reset protocol). */
function legacyResetProtocol(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof version === "string" ? version : "");
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number);
  return major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 277)));
}

/**
 * Which accounting epoch the first cumulative result of a fresh resumed process
 * reports. Only exact counter identities count as proof, never magnitude:
 * restored = some checkpoint model reads exactly checkpoint + accounted-since-spawn
 * + this turn's observations (all other checkpoint models present and monotone);
 * reset = every model reads exactly accounted-since-spawn + observations, or the
 * CLI predates restored totals. Anything else is unknown.
 * @returns {"restored" | "reset" | "unknown"}
 */
function resumedEpoch(resume, handle, mu, totalCost, sources) {
  if (legacyResetProtocol(resume.version)) return "reset";
  if (!isObject(mu) || !Object.keys(mu).length) return "unknown";
  const since = normalizeModelUsage(handle.lastModelUsage);
  const observed = {};
  for (const source of sources) {
    // An unattributed observation leaves every model's turn growth unknown.
    if (!source.model) return "unknown";
    const row = observed[source.model] ||= {};
    for (const [field, wire] of Object.entries(MODEL_FIELDS)) if (source[field] !== undefined) row[wire] = (row[wire] || 0) + source[field];
  }
  const exact = (model, prior) => {
    const wires = TOKEN_WIRES.filter(wire => number(mu[model]?.[wire]) !== undefined);
    return wires.length > 0 && wires.every(wire =>
      mu[model][wire] === (prior[model]?.[wire] || 0) + (since[model]?.[wire] || 0) + (observed[model]?.[wire] || 0));
  };
  if (Object.keys(mu).every(model => exact(model, {}))) return "reset";
  const checkpoint = resume.checkpoint;
  if (!checkpoint || Object.keys(checkpoint.unattributed).length) return "unknown";
  const prior = checkpoint.modelUsage;
  const priorModels = Object.keys(prior).filter(model => TOKEN_WIRES.some(wire => prior[model][wire] > 0));
  const monotone = priorModels.every(model => isObject(mu[model]) &&
    TOKEN_WIRES.every(wire => prior[model][wire] === undefined || number(mu[model][wire]) === undefined || mu[model][wire] >= prior[model][wire]));
  const costMonotone = totalCost === undefined || totalCost + 1e-9 >= checkpoint.totalCostUsd + (handle.lastTotalCostUsd || 0);
  if (monotone && costMonotone && priorModels.some(model => exact(model, prior))) return "restored";
  return "unknown";
}

/** Run-local observations. Message snapshots repeat across streamed content blocks. */
function createClaudeUsage() {
  const records = new Map();
  const current = new Map();
  function mergeUsage(row, usage, key, parent) {
    if (!usage || typeof usage !== "object") return;
    // A later sparse snapshot cannot erase a previously measured field.
    for (const [field, wire] of Object.entries(FIELDS)) {
      const value = number(usage[wire]);
      if (value !== undefined) row[field] = Math.max(row[field] || 0, value);
    }
    if (!Array.isArray(usage.iterations)) return;
    usage.iterations.forEach((iteration, index) => {
      if (!iteration || iteration.type !== "advisor_message") return;
      const advisorKey = `${key}:advisor:${index}`;
      const advisor = records.get(advisorKey) || { kind: "advisor", parentToolUseId: parent, model: modelName(iteration.model) };
      if (!advisor.model) advisor.model = modelName(iteration.model);
      for (const [field, wire] of Object.entries(FIELDS)) {
        const value = number(iteration[wire]);
        if (value !== undefined) advisor[field] = Math.max(advisor[field] || 0, value);
      }
      records.set(advisorKey, advisor);
    });
  }
  function observe(ev, partial) {
    const message = partial?.type === "message_start" ? partial.message : ev.type === "assistant" ? ev.message : null;
    const parent = typeof ev.parent_tool_use_id === "string" ? ev.parent_tool_use_id : null;
    let key;
    if (message && typeof message.id === "string" && message.id) {
      key = JSON.stringify([parent, message.id]);
      current.set(parent, key);
      const old = records.get(key);
      const row = old || { kind: parent ? "child" : "root", parentToolUseId: parent, model: modelName(message.model) };
      if (!row.model) row.model = modelName(message.model);
      records.set(key, row);
      mergeUsage(row, message.usage, key, parent);
    } else if (partial?.type === "message_delta") {
      key = current.get(parent);
      const row = records.get(key);
      if (row) mergeUsage(row, partial.usage, key, parent);
    }
  }

  function finish(ev, handle, fallbackModel) {
    const sources = [...records.values()].map(row => ({ ...row }));
    records.clear(); current.clear();
    if (!ev && !sources.length) return null;
    const rows = new Map();
    function add(source) {
      const key = source.model || "unknown";
      const row = rows.get(key) || { model: source.model };
      for (const field of Object.keys(MODEL_FIELDS)) if (source[field] !== undefined) row[field] = (row[field] || 0) + source[field];
      rows.set(key, row);
    }
    sources.forEach(add);
    // Raw provider snapshot: kept for the baseline even when its scope is unproven.
    const rawMu = isObject(ev?.modelUsage) ? ev.modelUsage : undefined;
    const rawTotalCost = number(ev?.total_cost_usd);
    let mu = rawMu;
    let totalCost = rawTotalCost;
    if (handle?.claudeResume && ev && (rawMu || rawTotalCost !== undefined)) {
      const resume = handle.claudeResume;
      const epoch = resumedEpoch(resume, handle, rawMu, rawTotalCost, sources);
      handle.claudeResume = null;
      handle.claudeEpoch = epoch;
      if (epoch === "restored") {
        handle.lastModelUsage = addModelUsage(resume.checkpoint.modelUsage, handle.lastModelUsage);
        handle.lastTotalCostUsd = resume.checkpoint.totalCostUsd + (handle.lastTotalCostUsd || 0);
      } else if (epoch === "unknown") {
        // No trustworthy start baseline: cumulative-derived deltas for this
        // turn are unavailable. Directly observed turn fields still count.
        mu = undefined;
        totalCost = undefined;
      }
    }
    if (handle && ev) {
      const reported = handle.claudeReported || {};
      handle.claudeReported = {
        ...(rawTotalCost !== undefined ? { totalCostUsd: rawTotalCost } : reported.totalCostUsd !== undefined ? { totalCostUsd: reported.totalCostUsd } : {}),
        modelUsage: { ...normalizeModelUsage(reported.modelUsage), ...normalizeModelUsage(rawMu) },
      };
    }
    const prevMu = handle?.lastModelUsage || {};
    const prevUnknown = handle?.unattributedModelUsage || {};
    const completeModelField = (wire, snapshot = mu) => snapshot && Object.keys(snapshot).length > 0 && Object.values(snapshot).every(row => number(row?.[wire]) !== undefined);
    if (mu && typeof mu === "object") {
      for (const [model, snapshot] of Object.entries(mu)) {
        if (!snapshot || typeof snapshot !== "object") continue;
        const key = modelName(model) || "unknown";
        const row = rows.get(key) || { model: modelName(model) };
        for (const [field, wire] of Object.entries(MODEL_FIELDS)) {
          const value = number(snapshot[wire]);
          if (value !== undefined && !(prevUnknown[wire] > 0)) row[field] = Math.max(row[field] || 0, value - (number(prevMu[model]?.[wire]) || 0));
        }
        if (Object.keys(row).some(k => k !== "model" && row[k] > 0)) rows.set(key, row);
      }
    }
    if (mu && typeof mu === "object") {
      for (const [field, wire] of Object.entries(MODEL_FIELDS)) {
        if (!completeModelField(wire)) continue;
        const growth = Object.entries(mu).reduce((sum, [model, row]) => sum + Math.max(0, row[wire] - (number(prevMu[model]?.[wire]) || 0)), 0);
        const observed = [...rows.values()].reduce((sum, row) => sum + (row[field] || 0), 0);
        if (prevUnknown[wire] > 0) {
          // Earlier unmodeled measurements overlap this new cumulative summary.
          // Its historical model split cannot be reconstructed from a total.
          const remainder = Math.max(0, growth - prevUnknown[wire] - observed);
          if (remainder > 0) add({ model: null, [field]: remainder });
        } else {
          const unknown = rows.get("unknown");
          if (unknown?.[field] > 0) {
            const confirmed = [...rows.values()].filter(row => row.model).reduce((sum, row) => sum + (row[field] || 0), 0);
            const knownObservations = sources.filter(row => row.model).reduce((sum, row) => sum + (row[field] || 0), 0);
            unknown[field] = Math.max(0, unknown[field] - Math.max(0, confirmed - knownObservations));
          }
        }
      }
    }
    const totals = () => Object.fromEntries(Object.keys(FIELDS).map(field => [field, [...rows.values()].reduce((sum, row) => sum + (row[field] || 0), 0)]));
    const observedTotals = totals();
    const usage = ev?.usage;
    // Result totals overlap message observations. Only record their unobserved
    // remainder. A mixed-model remainder has no trustworthy model identity.
    const remainder = { model: rows.size === 0 ? fallbackModel : rows.size === 1 ? [...rows.values()][0].model : null };
    for (const [field, wire] of Object.entries(FIELDS)) {
      const value = number(usage?.[wire]);
      if (value !== undefined && value > observedTotals[field]) remainder[field] = value - observedTotals[field];
    }
    if (Object.keys(remainder).length > 1 || !rows.size) add(remainder);
    const previousCost = handle?.lastTotalCostUsd || 0;
    let costUsd = totalCost === undefined ? undefined : Math.max(0, totalCost - previousCost);
    if (handle && rawTotalCost !== undefined) handle.lastTotalCostUsd = Math.max(previousCost, rawTotalCost);
    const modelCost = [...rows.values()].reduce((sum, row) => sum + (row.costUsd || 0), 0);
    if (costUsd === undefined && [...rows.values()].some(row => row.costUsd !== undefined)) {
      costUsd = modelCost;
      if (handle) handle.lastTotalCostUsd = previousCost + modelCost;
    }
    if (costUsd !== undefined) {
      // Inconsistent model summaries cannot replace the authoritative process
      // dollars. Keep an unattributed remainder instead of guessing a split.
      if (modelCost > costUsd + 1e-9) for (const row of rows.values()) delete row.costUsd;
      const remainderCost = Math.max(0, costUsd - (modelCost > costUsd + 1e-9 ? 0 : modelCost));
      if (remainderCost > 0) add({ model: rows.size === 1 ? [...rows.values()][0].model : null, costUsd: remainderCost });
    }
    // Sparse result summaries can appear only on later turns. Retain the
    // measurements already billed on this process as their baseline too.
    if (handle) {
      const baseline = Object.fromEntries(Object.entries(prevMu).map(([model, row]) => [model, { ...row }]));
      for (const row of rows.values()) {
        if (!row.model) continue;
        const before = baseline[row.model] || {};
        const next = { ...before };
        for (const [field, wire] of Object.entries(MODEL_FIELDS)) {
          if (row[field] !== undefined) next[wire] = (number(before[wire]) || 0) + row[field];
        }
        baseline[row.model] = next;
      }
      if (rawMu) for (const [model, snapshot] of Object.entries(rawMu)) {
        if (!modelName(model)) continue;
        const next = baseline[model] || {};
        for (const wire of Object.values(MODEL_FIELDS)) {
          if (number(snapshot?.[wire]) !== undefined) next[wire] = Math.max(number(next[wire]) || 0, snapshot[wire]);
        }
        baseline[model] = next;
      }
      handle.unattributedModelUsage = Object.fromEntries(Object.entries(MODEL_FIELDS).map(([field, wire]) => [wire,
        completeModelField(wire, rawMu) ? 0 : (prevUnknown[wire] || 0) + (rows.get("unknown")?.[field] || 0),
      ]));
      handle.lastModelUsage = baseline;
    }
    const unknown = rows.get("unknown");
    if (unknown && Object.keys(MODEL_FIELDS).every(field => !(unknown[field] > 0)) && rows.size > 1) rows.delete("unknown");
    for (const row of rows.values()) {
      if (totalCost !== undefined || row.costUsd !== undefined) row.costReported = true;
    }
    const unavailableFields = [];
    const tokenRows = [...rows.values()].filter(row => Object.keys(FIELDS).some(field => row[field] !== undefined));
    for (const [field, wire] of Object.entries(FIELDS)) {
      if (number(usage?.[wire]) === undefined && (!tokenRows.length || tokenRows.some(row => row[field] === undefined))) unavailableFields.push(field);
    }
    if (costUsd === undefined || (totalCost === undefined && [...rows.values()].some(row => row.costUsd === undefined))) unavailableFields.push("costUsd");
    return { rows: [...rows.values()], ...totals(), costUsd: costUsd || 0,
      accounting: { status: ev ? "complete" : "partial", unavailableFields, sources } };
  }
  return { observe, finish };
}
module.exports = { createClaudeUsage, normalizeClaudeCheckpoint, claudeCheckpointFromHandle };
