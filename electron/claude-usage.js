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
    const mu = ev?.modelUsage;
    const prevMu = handle?.lastModelUsage || {};
    const prevUnknown = handle?.unattributedModelUsage || {};
    const completeModelField = wire => mu && Object.keys(mu).length > 0 && Object.values(mu).every(row => number(row?.[wire]) !== undefined);
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
    const totalCost = number(ev?.total_cost_usd);
    const previousCost = handle?.lastTotalCostUsd || 0;
    let costUsd = totalCost === undefined ? undefined : Math.max(0, totalCost - previousCost);
    if (handle && totalCost !== undefined) handle.lastTotalCostUsd = Math.max(previousCost, totalCost);
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
      if (mu && typeof mu === "object") for (const [model, snapshot] of Object.entries(mu)) {
        if (!modelName(model)) continue;
        const next = baseline[model] || {};
        for (const wire of Object.values(MODEL_FIELDS)) {
          if (number(snapshot?.[wire]) !== undefined) next[wire] = Math.max(number(next[wire]) || 0, snapshot[wire]);
        }
        baseline[model] = next;
      }
      handle.unattributedModelUsage = Object.fromEntries(Object.entries(MODEL_FIELDS).map(([field, wire]) => [wire,
        completeModelField(wire) ? 0 : (prevUnknown[wire] || 0) + (rows.get("unknown")?.[field] || 0),
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
module.exports = { createClaudeUsage };
