"use strict";

const { localDayKey, coerceFiniteNumber, coerceUsageCell } = require("./store-util.js");

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
   * usageThreadsByDay; project/title/provider/model are last-seen labels.
   * @param {{ provider?: unknown, model?: unknown, costUsd?: unknown, inputTokens?: unknown, cachedInputTokens?: unknown, cacheWriteTokens?: unknown, outputTokens?: unknown, threadId?: unknown, projectId?: unknown, projectName?: unknown, title?: unknown }} input
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
    const model = (input && input.model) || "unknown";
    const prev = coerceUsageCell(providerMap[model]);
    providerMap[model] = {
      ...prev,
      costUsd: prev.costUsd + costUsd,
      inputTokens: prev.inputTokens + inputTokens,
      cachedInputTokens: prev.cachedInputTokens + cachedInputTokens,
      cacheWriteTokens: prev.cacheWriteTokens + cacheWriteTokens,
      outputTokens: prev.outputTokens + outputTokens,
      turns: prev.turns + 1,
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
      threadsDay[threadId] = {
        ...prevThread,
        costUsd: prevThread.costUsd + costUsd,
        inputTokens: prevThread.inputTokens + inputTokens,
        cachedInputTokens: prevThread.cachedInputTokens + cachedInputTokens,
        cacheWriteTokens: prevThread.cacheWriteTokens + cacheWriteTokens,
        outputTokens: prevThread.outputTokens + outputTokens,
        turns: prevThread.turns + 1,
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
    const model = (input && input.model) || "unknown";
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
