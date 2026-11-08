"use strict";

const { localDayKey, coerceFiniteNumber, coerceUsageCell, unpricedUsage } = require("./store-util.js");

/** Track only measurements not covered by a provider USD report (including zero). */
function addUnpriced(prev, delta) {
  const tokens = unpricedUsage(prev);
  // Homogeneous legacy-shaped cells need no extra storage. Materialize the
  // split when coverage changes, or zero USD must explicitly cover tokens.
  if (!prev.unpricedTokens && delta.costReported !== true &&
      (!Object.keys(tokens).some(field => prev[field] > 0) || (prev.costUsd > 0) === (delta.costUsd > 0))) return undefined;
  if (delta.costReported !== true && !(delta.costUsd > 0)) {
    for (const field of Object.keys(tokens)) tokens[field] += coerceFiniteNumber(delta[field]);
  }
  return tokens;
}

/** Keep original deltas separate from last-seen thread labels. */
function threadAttribution(row, provider, model, delta) {
  const byProviderModel = { ...(row && row.byProviderModel) };
  const models = { ...byProviderModel[provider] };
  const cell = coerceUsageCell(models[model]);
  const unpricedTokens = addUnpriced(cell, delta);
  for (const key of Object.keys(cell)) if (key !== "unpricedTokens") cell[key] += delta[key] || 0;
  if (unpricedTokens) cell.unpricedTokens = unpricedTokens;
  models[model] = cell;
  byProviderModel[provider] = models;
  // Old thread totals have no trustworthy split. Keep them without guessing
  // from the last-seen model, including when the next turn changes provider.
  const unattributed = row && (row.unattributed || (!row.byProviderModel && coerceUsageCell(row)));
  return { byProviderModel, ...(unattributed ? { unattributed } : {}) };
}

/** Store usage/spend ledger methods; store.js copies them onto Store.prototype. */
class StoreUsageMethods {
  /**
   * @param {string} threadId
   * @returns {{ model: string | null, inputTokens: number, outputTokens: number, costUsd: number, turns: number } | null}
   */
  getUsage(threadId) {
    return this.data.usageByThread[threadId] || null;
  }

  /**
   * @param {string} threadId
   * @param {object | null} usage
   */
  setUsage(threadId, usage) {
    if (usage == null) {
      delete this.data.usageByThread[threadId];
    } else {
      // Runners rebuild usage each turn; recordUsage owns costByModel (#1725).
      const prev = this.data.usageByThread[threadId];
      if (prev && prev.costByModel && !usage.costByModel) {
        usage = { ...usage, costByModel: prev.costByModel };
      }
      this.data.usageByThread[threadId] = usage;
    }
  }

  /**
   * Add a cost delta to today's local-day spend bucket.
   * Zero/negative/non-finite deltas are ignored.
   * @param {number} deltaUsd
   * @param {Date} [now] - injectable clock for tests
   */
  recordSpend(deltaUsd, now = new Date()) {
    const n = Number(deltaUsd);
    if (!Number.isFinite(n) || n <= 0) return;
    if (!this.data.spendByDay || typeof this.data.spendByDay !== "object") {
      this.data.spendByDay = {};
    }
    const key = localDayKey(now);
    this.data.spendByDay[key] = (Number(this.data.spendByDay[key]) || 0) + n;
  }

  /**
   * @param {Date} [now]
   * @returns {number}
   */
  getSpendToday(now = new Date()) {
    if (!this.data.spendByDay || typeof this.data.spendByDay !== "object") {
      return 0;
    }
    const key = localDayKey(now);
    const v = this.data.spendByDay[key];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }

  /**
   * Add a per-turn usage delta into today's local-day / provider / model bucket.
   * A named provider is enough — zeros stay zeros. Kimi reports no usage at
   * all; dropping those turns hid the provider (#556). Simulate is ignored
   * so fixture runs do not pollute the ledger.
   * When threadId is a non-empty string, the same numbers accumulate into
   * usageThreadsByDay, with original provider/model buckets retained.
   * Project/title/provider/model remain last-seen display labels.
   * @param {{ provider?: unknown, model?: unknown, costUsd?: unknown, costReported?: boolean, turns?: number, inputTokens?: unknown, cachedInputTokens?: unknown, cacheWriteTokens?: unknown, outputTokens?: unknown, threadId?: unknown, projectId?: unknown, projectName?: unknown, title?: unknown }} input
   * @param {Date} [now] - injectable clock for tests
   */
  recordUsage(input, now = new Date()) {
    const provider =
      input && typeof input.provider === "string" ? input.provider : "";
    if (!provider || provider === "simulate") return;
    const costUsd = coerceFiniteNumber(input && input.costUsd);
    const inputTokens = coerceFiniteNumber(input && input.inputTokens);
    const cachedInputTokens = coerceFiniteNumber(input && input.cachedInputTokens);
    const cacheWriteTokens = coerceFiniteNumber(input && input.cacheWriteTokens);
    const outputTokens = coerceFiniteNumber(input && input.outputTokens);
    const turns = input?.turns === undefined ? 1 : input.turns;
    if (!Number.isSafeInteger(turns) || turns < 0) throw new Error("Usage turns must be a non-negative integer");
    if (!this.data.usageByDay || typeof this.data.usageByDay !== "object") {
      this.data.usageByDay = {};
    }
    const day = localDayKey(now);
    const dayMap = this.data.usageByDay[day] && typeof this.data.usageByDay[day] === "object"
      ? this.data.usageByDay[day]
      : (this.data.usageByDay[day] = {});
    const providerMap = dayMap[provider] && typeof dayMap[provider] === "object"
      ? dayMap[provider]
      : (dayMap[provider] = {});
    const model = typeof input.model === "string" && input.model ? input.model : "unknown";
    const prev = coerceUsageCell(providerMap[model]);
    providerMap[model] = {
      ...prev,
      ...(addUnpriced(prev, input) ? { unpricedTokens: addUnpriced(prev, input) } : {}),
      costUsd: prev.costUsd + costUsd,
      inputTokens: prev.inputTokens + inputTokens,
      cachedInputTokens: prev.cachedInputTokens + cachedInputTokens,
      cacheWriteTokens: prev.cacheWriteTokens + cacheWriteTokens,
      outputTokens: prev.outputTokens + outputTokens,
      turns: prev.turns + turns,
    };

    const threadId =
      input && typeof input.threadId === "string" ? input.threadId : "";
    const session = threadId ? this.data.usageByThread[threadId] : null;
    if (session && costUsd > 0) {
      // Header cost tooltip (#1725): the same deltas, split by model.
      const key = typeof model === "string" ? model : "unknown";
      const byModel = { ...(session.costByModel || {}) };
      byModel[key] = (Number(byModel[key]) || 0) + costUsd;
      session.costByModel = byModel;
    }
    if (threadId) {
      // Side-file change marker (#1475): the cells below mutate in place.
      this._usageThreadsGen += 1;
      if (!this.data.usageThreadsByDay || typeof this.data.usageThreadsByDay !== "object") {
        this.data.usageThreadsByDay = {};
      }
      const threadsDay =
        this.data.usageThreadsByDay[day] && typeof this.data.usageThreadsByDay[day] === "object"
          ? this.data.usageThreadsByDay[day]
          : (this.data.usageThreadsByDay[day] = {});
      const prevThread = coerceUsageCell(threadsDay[threadId]);
      threadsDay[threadId] = {
        ...prevThread,
        ...threadAttribution(threadsDay[threadId], provider, model, {
          costUsd, inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, turns, costReported: input.costReported,
        }),
        ...(addUnpriced(prevThread, input) ? { unpricedTokens: addUnpriced(prevThread, input) } : {}),
        costUsd: prevThread.costUsd + costUsd,
        inputTokens: prevThread.inputTokens + inputTokens,
        cachedInputTokens: prevThread.cachedInputTokens + cachedInputTokens,
        cacheWriteTokens: prevThread.cacheWriteTokens + cacheWriteTokens,
        outputTokens: prevThread.outputTokens + outputTokens,
        turns: prevThread.turns + turns,
        projectId: typeof input.projectId === "string" ? input.projectId : "",
        projectName: typeof input.projectName === "string" ? input.projectName : "",
        title: typeof input.title === "string" ? input.title : "",
        provider,
        model: typeof model === "string" ? model : "unknown",
      };
    }
  }

  /**
   * Of cost already recorded by recordUsage, attribute the share spent on a
   * run that ended failed or stopped. Not additive to costUsd.
   * Creates the provider/model (and thread) row if absent — turns stay 0.
   * @param {{ provider?: unknown, model?: unknown, threadId?: unknown, costUsd?: unknown, projectId?: unknown, projectName?: unknown, title?: unknown }} input
   * @param {Date} [now] - injectable clock for tests
   */
  recordWastedSpend(input, now = new Date()) {
    const provider =
      input && typeof input.provider === "string" ? input.provider : "";
    if (!provider || provider === "simulate") return;
    const costUsd = coerceFiniteNumber(input && input.costUsd);
    if (costUsd <= 0) return;
    if (!this.data.usageByDay || typeof this.data.usageByDay !== "object") {
      this.data.usageByDay = {};
    }
    const day = localDayKey(now);
    const dayMap = this.data.usageByDay[day] && typeof this.data.usageByDay[day] === "object"
      ? this.data.usageByDay[day]
      : (this.data.usageByDay[day] = {});
    const providerMap = dayMap[provider] && typeof dayMap[provider] === "object"
      ? dayMap[provider]
      : (dayMap[provider] = {});
    const model = typeof input.model === "string" && input.model ? input.model : "unknown";
    const prev = coerceUsageCell(providerMap[model]);
    providerMap[model] = {
      ...prev,
      wastedUsd: prev.wastedUsd + costUsd,
    };

    const threadId =
      input && typeof input.threadId === "string" ? input.threadId : "";
    if (threadId) {
      // Side-file change marker (#1475): the cells below mutate in place.
      this._usageThreadsGen += 1;
      if (!this.data.usageThreadsByDay || typeof this.data.usageThreadsByDay !== "object") {
        this.data.usageThreadsByDay = {};
      }
      const threadsDay =
        this.data.usageThreadsByDay[day] && typeof this.data.usageThreadsByDay[day] === "object"
          ? this.data.usageThreadsByDay[day]
          : (this.data.usageThreadsByDay[day] = {});
      const prevThread = coerceUsageCell(threadsDay[threadId]);
      const prevRow =
        threadsDay[threadId] && typeof threadsDay[threadId] === "object"
          ? /** @type {UsageThreadCell} */ (threadsDay[threadId])
          : null;
      // Keep labels the turn already recorded; fall back to the caller's when
      // the run burned cost without ever recording a turn, so the breakdown
      // shows a name instead of "Unknown project" and a raw thread id.
      const label = (fromRow, fromInput) =>
        (prevRow && typeof fromRow === "string" && fromRow) ||
        (typeof fromInput === "string" ? fromInput : "");
      threadsDay[threadId] = {
        ...prevThread,
        ...threadAttribution(prevRow, provider, model, { wastedUsd: costUsd }),
        wastedUsd: prevThread.wastedUsd + costUsd,
        projectId: label(prevRow && prevRow.projectId, input.projectId),
        projectName: label(prevRow && prevRow.projectName, input.projectName),
        title: label(prevRow && prevRow.title, input.title),
        provider,
        model: typeof model === "string" ? model : "unknown",
      };
    }
  }

  /**
   * @returns {Record<string, Record<string, Record<string, UsageCell>>>}
   */
  getUsageByDay() {
    const raw = this.data.usageByDay;
    if (!raw || typeof raw !== "object") return {};
    return { ...raw };
  }

  /**
   * Per-thread usage rollup, the input to the project/thread breakdown (#556).
   * @returns {Record<string, Record<string, UsageThreadCell>>}
   */
  getUsageThreadsByDay() {
    const raw = this.data.usageThreadsByDay;
    if (!raw || typeof raw !== "object") return {};
    return { ...raw };
  }
}

module.exports = StoreUsageMethods;
