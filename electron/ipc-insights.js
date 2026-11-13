"use strict";

const { buildActivity } = require("./activity.js");
const { collectDigest } = require("./digest.js");
const { collectFleet } = require("./fleet.js");
const cliUsage = require("./cli-session-usage.js").createCliUsageReader();

/**
 * Provider sessions Solenta ran (#2002 follow-up): session id → the owning
 * thread's creation time. An imported CLI session keeps its id, so responses
 * before the import stay outside Solenta. Trashed threads still count: their
 * spend stays in the ledger.
 * ponytail: a Solenta session later resumed from Terminal stays Solenta's;
 * per-response run windows would be needed to split it.
 */
function solentaSessions(threads = []) {
  const owned = { claude: {}, codex: {} };
  const add = (provider, id, since) => {
    if (!owned[provider] || typeof id !== "string" || !id) return;
    owned[provider][id] = Math.min(owned[provider][id] ?? Infinity, since);
  };
  for (const thread of threads || []) {
    if (!thread) continue;
    const since = Number.isFinite(thread.createdAt) ? thread.createdAt : 0;
    add(thread.provider, thread.sessionId, since);
    add("claude", thread.claudeAccounting?.sessionId, since);
  }
  return owned;
}

/** IPC_HANDLERS rows for activity:*, governance:*, usage:*, insights:*, fleet:*, digest:*; ipc.js spreads them in. */
module.exports = {
  // Read-only (#262): nothing in the renderer can append to the audit.
  "governance:listAudit": async (_ctx, input) =>
    require("./governanceAudit.js").listAudit(input || {}),
  "governance:verifyAudit": async () =>
    require("./governanceAudit.js").verifyAudit(),
  "activity:list": async (ctx) => {
    const threads = ctx.store.getThreads();
    return buildActivity(threads, ctx.store.data.workLogByThread, Date.now());
  },
  "usage:byDay": async (ctx, input) => {
    const scope = input?.scope ?? "solenta";
    if (scope !== "solenta" && scope !== "cli" && scope !== "external") throw new Error("Invalid usage scope");
    const homes = input?.homes;
    if (homes !== undefined && (!Array.isArray(homes) || homes.length > 64 || !homes.every((h) => typeof h === "string"))) {
      throw new Error("Invalid usage homes");
    }
    if (scope !== "solenta") {
      // Read-only: the report is computed per request and never enters the spend ledger.
      return cliUsage.read({
        scope,
        homes,
        owned: solentaSessions(ctx.store.getThreads()),
        instances: require("./services.js").instanceAuthProbes(ctx.store, ctx.userDataPath),
        prices: ctx.store.getSettings().modelPrices,
      });
    }
    const { applyModelPrices } = require("./modelPrices.js");
    return applyModelPrices(
      {
        byDay: ctx.store.getUsageByDay(),
        threadsByDay: ctx.store.getUsageThreadsByDay(),
      },
      ctx.store.getSettings().modelPrices,
    );
  },
  "usage:providerLimits": async (ctx) => {
    const { fetchProviderLimits } = require("./providerUsage.js");
    const rows = await fetchProviderLimits({
      cliProxyUsage: ctx.store.getSettings().cliProxyUsage,
      instances: require("./services.js").instanceAuthProbes(ctx.store, ctx.userDataPath),
    });
    // The menu bar (#1859) shows whatever the Usage view last fetched.
    if (ctx.usageMenu) ctx.usageMenu.setUsage(rows.filter((row) => row.source !== "cliproxy"));
    return rows;
  },
  "insights:failureModes": async (ctx) => {
    const { clusterFailureModes } = require("./failuremodes.js");
    return clusterFailureModes({
      threads: ctx.store.getThreads(),
      messagesByThread: ctx.store.data.messagesByThread,
    });
  },
  "fleet:evidence": async (ctx, input) => {
    return collectFleet({
      store: ctx.store,
      nowMs: Date.now(),
      days: input && input.days,
    });
  },
  "digest:list": async (ctx, input) => {
    return collectDigest({
      store: ctx.store,
      sinceMs: input && input.sinceMs,
      nowMs: Date.now(),
    });
  },
  "digest:markSeen": async (ctx, input) => {
    const at =
      input && Number.isFinite(input.atMs) ? input.atMs : Date.now();
    ctx.store.setDigestSeenAt(at);
    ctx.store.save();
    return { seenAt: at };
  },
};
