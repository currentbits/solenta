"use strict";

// createRunner seam: the macOS Seatbelt wrap of local agent CLIs (#803).
// Follows the seam convention in the header of electron/runner-watchdogs.js.
// runner.js routes every provider's resolveSpawn through confineSpawn.

const fs = require("node:fs");
const {
  SANDBOX_EXEC,
  seatbeltApplies,
  compileSeatbelt,
  wrapSpawn,
} = require("./seatbelt.js");
const { startSharedProxy, sharedProxyPort } = require("./seatbeltProxy.js");
const { watchDenials } = require("./seatbeltWatch.js");
const { actionHash, networkVerdict, threadPolicy } = require("./governance.js");
const { appendAudit, listAudit } = require("./governanceAudit.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 * @param {{ platform?: NodeJS.Platform, log?: (msg: string) => void }} [opts]
 */
function createSeatbelt(ctx, opts = {}) {
  const { store, appendMessage, pushDetail } = ctx;
  const platform = opts.platform || process.platform;
  const warn = opts.log || ((m) => console.warn(m));
  /** Proxy allows are audited once per thread and host. */
  const auditedAllows = new Set();

  function audit(threadId, row) {
    const t = store.getThread(threadId);
    appendAudit({
      threadId,
      profileId: threadPolicy(store, threadId).profileId,
      provider: (t && t.provider) || "",
      executed: null,
      layer: "seatbelt",
      ...row,
    });
  }

  /**
   * A recent tool-layer allow that the kernel/proxy now contradicts: the
   * matrix (or the user on its card) said yes, Seatbelt said no.
   * ponytail: scans the audit's in-memory last-50 ring.
   */
  function priorAllow(threadId, matches) {
    return (
      listAudit({ threadId }).find(
        (r) =>
          r.decision === "allow" &&
          r.layer !== "seatbelt" &&
          matches(r.executed || r.declared),
      ) || null
    );
  }

  function note(threadId, text) {
    if (!store.getThread(threadId)) return;
    appendMessage(threadId, "event", text);
    store.save();
    pushDetail(threadId);
  }

  /** @param {import("./seatbeltWatch.js").Denial} d */
  function onDenial(d) {
    if (!store.getThread(d.threadId)) return;
    const path = d.op.startsWith("file-") && d.target ? d.target : null;
    const what = `${d.process} ${d.op}${d.target ? ` ${d.target}` : ""}`;
    const prior = path ? priorAllow(d.threadId, (c) => c && c.path === path) : null;
    const declared = { tool: "seatbelt", command: null, path, hosts: [] };
    audit(d.threadId, {
      toolName: d.process,
      actionHash: actionHash(declared),
      declared,
      decision: "deny",
      rule: prior ? "disagreement" : d.op,
      reason: prior
        ? `matrix allowed (${prior.layer}), seatbelt denied: ${what}`
        : what,
    });
    note(d.threadId, `Seatbelt blocked ${what}`);
  }

  function decide(threadId, host) {
    if (!store.getThread(threadId)) {
      return { allow: false, rule: "proxy.identity", reason: "unknown thread" };
    }
    const v = networkVerdict(threadPolicy(store, threadId).policy, host);
    if (v && (v.action === "block" || v.action === "deny")) {
      return { allow: false, rule: v.rule, reason: `${v.action} by profile` };
    }
    return {
      allow: true,
      rule: v ? v.rule : null,
      reason: v ? `${v.action} by profile` : "no network rule",
    };
  }

  function onProxyDecision(threadId, host, v) {
    if (v.allow) {
      const key = `${threadId}\0${host}`;
      if (auditedAllows.has(key)) return;
      auditedAllows.add(key);
    }
    const declared = { tool: "network", command: null, path: null, hosts: [host] };
    const prior = v.allow
      ? null
      : priorAllow(threadId, (c) => c && Array.isArray(c.hosts) && c.hosts.includes(host));
    audit(threadId, {
      toolName: "network",
      actionHash: actionHash(declared),
      declared,
      executed: v.allow ? declared : null,
      decision: v.allow ? "allow" : "deny",
      rule: prior ? "disagreement" : v.rule,
      reason: prior
        ? `matrix allowed (${prior.layer}), seatbelt denied: ${host}`
        : `${v.reason}: ${host}`,
    });
    if (!v.allow) note(threadId, `Seatbelt proxy blocked ${host} (${v.rule})`);
  }

  // Spawn paths are synchronous, so the proxy port must exist before the
  // first wrapped run; start it with the runner.
  if (platform === "darwin") {
    startSharedProxy({ decide, onDecision: onProxyDecision }).catch((err) =>
      warn(`seatbelt: egress proxy failed to start (${err && err.message})`),
    );
  }

  /**
   * Wrap a resolved local spawn in sandbox-exec when the thread's profile
   * has write or network rules. Throws (the run refuses to start) whenever
   * it cannot confine: never falls back to an unconfined child.
   * @param {{ binary: string, args: string[], cwd: string }} spawn
   * @param {{ threadId?: string, project?: object | null, env?: Record<string, string> | null }} at
   * @returns {{ binary: string, args: string[], cwd: string, seatbelt?: string }}
   */
  function confineSpawn(spawn, at) {
    const threadId = at && at.threadId;
    if (!threadId) return spawn;
    const { policy } = threadPolicy(store, threadId);
    if (!seatbeltApplies(policy, at.project, platform)) return spawn;
    const refuse = (why) => {
      const declared = { tool: "seatbelt", command: null, path: spawn.cwd, hosts: [] };
      audit(threadId, {
        toolName: "sandbox-exec",
        actionHash: actionHash(declared),
        declared,
        decision: "deny",
        rule: "seatbelt.compile",
        reason: why,
      });
      throw new Error(`Seatbelt: ${why}; refusing to run unconfined`);
    };
    if (!fs.existsSync(SANDBOX_EXEC)) refuse(`${SANDBOX_EXEC} is missing`);
    let compiled;
    try {
      compiled = compileSeatbelt({ threadId, policy, worktree: spawn.cwd, env: at.env });
    } catch (err) {
      refuse(String((err && err.message) || err).replace(/^Seatbelt: /, ""));
    }
    let proxy = null;
    if (compiled.network) {
      const port = sharedProxyPort();
      if (!port) refuse("the egress proxy is not running");
      proxy = { port, threadId };
    }
    watchDenials(onDenial, { log: warn });
    return { ...wrapSpawn(spawn, compiled.profile, proxy), seatbelt: compiled.hash };
  }

  // The handlers ride along for tests; the runner only uses confineSpawn.
  return { confineSpawn, onDenial, decide, onProxyDecision };
}

module.exports = { createSeatbelt };
