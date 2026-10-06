"use strict";

const { buildActivity } = require("./activity.js");
const { collectDigest } = require("./digest.js");
const { collectFleet } = require("./fleet.js");

/** IPC_HANDLERS rows for activity:*, usage:*, insights:*, fleet:*, digest:*; ipc.js spreads them in. */
module.exports = {
  "activity:list": async (ctx) => {
    const threads = ctx.store.getThreads();
    return buildActivity(threads, ctx.store.data.workLogByThread, Date.now());
  },
  "usage:byDay": async (ctx) => {
    return {
      byDay: ctx.store.getUsageByDay(),
      threadsByDay: ctx.store.getUsageThreadsByDay(),
    };
  },
  "usage:providerLimits": async (ctx) => {
    const { fetchProviderLimits } = require("./providerUsage.js");
    return fetchProviderLimits({
      instances: require("./services.js").instanceAuthProbes(ctx.store),
    });
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
