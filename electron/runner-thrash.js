"use strict";

// createRunner seam: thrash detector (#391). Follows the seam convention in
// the header of electron/runner-watchdogs.js. stopRun and startRun are read
// lazily from ctx: they re-enter the hub.
//
// Every provider closes its tool calls through noteToolSpan, and the verify
// gate reports its failures here, so this is the one place that sees an
// agent retry the same failing fix. On a hit: stop the run, roll the worktree
// back to the last green checkpoint, switch to a different provider and
// retry with a plain-language account of what happened. Once per problem; a
// second hit before a turn lands green stops and explains instead.

const services = require("./services.js");
const { PROVIDERS, getProvider } = require("./providers.js");
const {
  parseProviderRef,
  threadProviderRef,
  findInstance,
} = require("./providerInstances.js");
const {
  createThrashTracker,
  commandKey,
  isEditTool,
} = require("./thrash.js");

const RETRY_TAG = "[thrash detector]";
/** How far back to look for the tool message a span closes. */
const TOOL_LOOKBACK = 200;

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createThrash(ctx) {
  const { store, active, appendMessage, pushDetail, pushThreadsChanged, shortError } =
    ctx;
  const tracker = createThrashTracker();
  /** Threads mid-recovery, so a burst of hits cannot start two. */
  const recovering = new Set();

  function providerName(ref) {
    const { provider } = parseProviderRef(ref);
    const entry = getProvider(provider);
    return (entry && entry.name) || provider || "the agent";
  }

  function findTool(threadId, toolId) {
    const msgs = store.getMessages(threadId) || [];
    const stop = Math.max(0, msgs.length - TOOL_LOOKBACK);
    for (let i = msgs.length - 1; i >= stop; i--) {
      const m = msgs[i];
      if (m && m.tool && m.tool.id === toolId) return m.tool;
    }
    return null;
  }

  /**
   * Called from noteToolSpan for every finished tool call. Never throws.
   */
  function noteTool(threadId, runId, toolId, name, isError) {
    try {
      if (isEditTool(name)) {
        if (!isError) tracker.noteEdit(threadId);
        return;
      }
      const tool = findTool(threadId, toolId);
      if (!tool) return;
      const key = commandKey(name, tool.input);
      if (!isError) {
        tracker.noteOk(threadId, key);
        return;
      }
      const hit = tracker.noteFailure(threadId, key, tool.output);
      if (!hit) return;
      // Out of the adapter's stream handler before stopping its run.
      void Promise.resolve().then(() => interrupt(threadId, hit, runId));
    } catch {
      // never break the runner
    }
  }

  /**
   * The verify gate's failure. Returns the hit so the gate can hand the
   * thread over instead of queueing another fix prompt.
   * @returns {import('./thrash.js').ThrashHit | null}
   */
  function noteVerifyFailure(threadId, command, log) {
    try {
      return tracker.noteFailure(threadId, `verify: ${command}`, log);
    } catch {
      return null;
    }
  }

  /** First runnable provider that is not this one: the quota failover chain, then install order. */
  function pickProvider(thread) {
    const settings = store.getSettings();
    const chain = [
      ...(Array.isArray(settings.quotaFailover) ? settings.quotaFailover : []),
      ...PROVIDERS.map((p) => p.id),
    ];
    for (const ref of chain) {
      const { provider, instance } = parseProviderRef(ref);
      // Another account on the same CLI is the same model making the same fix.
      if (!provider || provider === thread.provider) continue;
      if (!getProvider(provider)) continue;
      if (instance && !findInstance(settings, provider, instance)) continue;
      if (!ctx.providerBinAvailable(provider)) continue;
      return ref;
    }
    return null;
  }

  /** Last verified-green checkpoint, else (no verify command) the last finished turn. */
  async function rollbackTarget(thread) {
    const { listCheckpoints } = require("./worktrees.js");
    const list = await listCheckpoints({ store, threadId: thread.id });
    const green = thread.lastGreenSha
      ? list.find((c) => c.sha === thread.lastGreenSha)
      : null;
    if (green) return { ...green, label: `turn ${green.turn} (last verified green)` };
    if (thread.verifyCommand) return null;
    return list[0] ? { ...list[0], label: `turn ${list[0].turn} (last finished turn)` } : null;
  }

  function originalRequest(threadId) {
    const msgs = store.getMessages(threadId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role !== "user") continue;
      const text = String(m.text || "");
      if (text.startsWith(RETRY_TAG) || text.startsWith("[verification failed]")) continue;
      return m;
    }
    return null;
  }

  function settle(threadId, status, lastError) {
    store.updateThread(
      threadId,
      { status, runStartedAt: null, ...(lastError ? { lastError: shortError(lastError) } : {}) },
      { touch: true },
    );
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();
  }

  /**
   * @param {string} threadId
   * @param {import('./thrash.js').ThrashHit} hit
   * @param {string | null} [runId] - only stop this run; null for the verify gate
   */
  async function interrupt(threadId, hit, runId = null) {
    if (recovering.has(threadId)) return;
    recovering.add(threadId);
    try {
      const entry = active.get(threadId);
      if (runId && (!entry || entry.runId !== runId)) return; // already over
      if (entry) await ctx.stopRun({ threadId, cascadeCrew: false });

      const thread = store.getThread(threadId);
      if (!thread) return;
      const from = threadProviderRef(thread) || thread.provider;
      const lines = [
        `Thrash detector: ${providerName(from)} hit the same failure ${hit.count} times, changing code before each retry, so Solenta stopped it.`,
        `Failing: ${hit.key}`,
        `Error: ${hit.signature || "(no output)"}`,
      ];

      if (tracker.recovered(threadId)) {
        lines.push(
          "This was already the retry on another provider, so Solenta is not trying again. Read the error above and steer the agent by hand.",
        );
        appendMessage(threadId, "event", lines.join("\n"));
        settle(threadId, "failed", "Thrash detector: same failure after a provider switch");
        return;
      }

      let rolledBack = null;
      try {
        const target = await rollbackTarget(thread);
        if (target) {
          const { restoreCheckpoint } = require("./worktrees.js");
          await restoreCheckpoint({
            store,
            threadId,
            sha: target.sha,
            isRunning: (id) => active.has(id),
            // Keep the transcript: the user needs to see what happened.
            rewindConversation: false,
          });
          rolledBack = target;
          lines.push(
            `Rolled the worktree back to ${target.label}, ${target.sha.slice(0, 7)}. The discarded edits are in a safety commit: git reflog in the worktree.`,
          );
        } else {
          lines.push("No green checkpoint to roll back to, so the worktree is unchanged.");
        }
      } catch (err) {
        lines.push(`Rollback skipped: ${err && err.message ? err.message : err}`);
      }

      const next = pickProvider(thread);
      if (!next) {
        lines.push(
          "No other provider is installed, so Solenta did not retry. Install another agent CLI or steer this one by hand.",
        );
        appendMessage(threadId, "event", lines.join("\n"));
        settle(threadId, "failed", "Thrash detector: no other provider to retry on");
        return;
      }
      // setProvider refuses a "working" row; the verify gate leaves one.
      settle(threadId, "idle");
      services.setProvider(store, { threadId, provider: next });
      tracker.markRecovered(threadId);
      lines.push(`Retrying on ${providerName(next)} with a fresh session.`);
      appendMessage(threadId, "event", lines.join("\n"));

      const request = originalRequest(threadId);
      const prompt = [
        `${RETRY_TAG} The previous attempt on ${providerName(from)} kept retrying the same fix and was stopped.`,
        `\`${hit.key}\` failed ${hit.count} times with: ${hit.signature || "(no output)"}`,
        rolledBack
          ? `The worktree was rolled back to ${rolledBack.label}, so those edits are gone.`
          : "The worktree was not rolled back; its current state includes those edits.",
        "Take a different approach. Do not repeat the fix that kept failing.",
        request ? `\nOriginal request:\n${request.text}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      try {
        await ctx.startRun({
          threadId,
          prompt,
          attachments: request && request.attachments,
        });
      } catch (err) {
        const reason = err && err.message ? String(err.message) : String(err);
        appendMessage(threadId, "event", `Thrash detector: retry not delivered: ${reason}`);
        // A run the user started meanwhile owns the status.
        if (!active.has(threadId)) {
          settle(threadId, "failed", `Thrash detector: retry not delivered: ${reason}`);
        }
      }
    } catch {
      // never break the runner
    } finally {
      recovering.delete(threadId);
    }
  }

  return {
    noteThrashTool: noteTool,
    noteThrashVerifyFailure: noteVerifyFailure,
    noteThrashSuccess: (threadId) => tracker.noteSuccess(threadId),
    thrashInterrupt: interrupt,
  };
}

module.exports = { createThrash };
