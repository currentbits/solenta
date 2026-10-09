"use strict";

// createRunner seam: Kimi provider run (#1447, seam 11).
// Follows the seam convention in the header of electron/runner-watchdogs.js.

const { resolveBin } = require("./providers.js");
const { truncate } = require("./claude.js");
const path = require("node:path");
const threadSecrets = require("./threadSecrets.js");
const kimiParse = require("./kimi.js");
const { materializeKimiHome, deployKimiGuardrailOverlay, runKimi } = kimiParse;
const { kimiMcpServersForRun } = require("./memory-sup.js");
const { guardrailsEnabled } = require("./guardrails.js");
const { guardrailNotice } = require("./guardrail-hook-core.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createKimiRun(ctx) {
  const {
    assertProviderBinary,
    THINKING_TRUNCATE,
    PUSH_THROTTLE_MS,
    assignContextUsage,
    crossesBoundary,
    resolveSpawn,
    formatRunExitError,
    abortIfCancelled,
    store,
    beginWorkLogStep,
    stampPreparingSteps,
    pushThreadsChanged,
    pushDetail,
    claimPreparingRun,
    completeWorkLogStep,
    settleCancelledLaunch,
    active,
    appendMessage,
    userDataPath,
    persistToolImages,
    noteToolSpan,
    clearRun,
    notifyRunTerminal,
    lastAssistantText,
    markRunFailed,
    appendDoneWorkLog,
  } = ctx;

  /**
   * Start a Kimi stream-json (with plain-text fallback) session turn.
   * After a successful turn, sessionId is the captured resume id, or the
   * prior real id. A hint-less turn stores null (never the old "cwd"
   * sentinel): -c is per-directory, so two no-worktree kimi threads in the
   * same project would resume each other's session (issue #220).
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} providerEntry
   */
  function startKimiRun(threadId, prompt, runId, providerEntry) {
    if (abortIfCancelled(threadId, runId)) return { runId };
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry, project);

    const kimiState = {
      __kimi: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");
    stampPreparingSteps(threadId, runId, { startingId, workingId });

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, kimiState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    /** @type {string | null} */
    let thinkingMsgId = null;
    /** @type {string} */
    let thinkingText = "";
    let sawUsage = false;
    let usageReported = false;
    let costReported = false;
    let lastPushAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let pushTimer = null;
    /** Run-local usage for memory footers (not cumulative store totals). */
    const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    const runStartedMs = Date.now();
    /**
     * Stream usage.record lines are per-step. Accumulate and apply once so
     * the Solenta turn counts as one turn (#696).
     * @type {{ inputTokens: number, outputTokens: number, cachedInputTokens: number, cacheWriteTokens: number, contextTokens?: number, costUsd?: number } | null}
     */
    let pendingUsage = null;
    /**
     * Real session id from the stream's meta resume hint. Null when the
     * CLI emits none: we do not invent a per-cwd sentinel (issue #220).
     * @type {string | null}
     */
    let capturedKimiSessionId = null;

    const localCwd = thread.worktreePath || project.path;
    const binary = resolveBin(providerEntry);
    const args = providerEntry.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
      reasoningEffort: thread.reasoningEffort || null,
      webSearch: thread.webSearch === true,
      fast: thread.fast === true,
    });

    if (abortIfCancelled(threadId, runId)) return { runId };
    const entry = claimPreparingRun(threadId, runId, {
      kind: "kimi",
      startingId,
      workingId,
      kimiState,
      runUsage,
    });
    if (!entry) {
      completeWorkLogStep(threadId, startingId);
      completeWorkLogStep(threadId, workingId);
      settleCancelledLaunch(threadId, runId);
      return { runId };
    }
    Object.defineProperty(entry, "workflow", {
      get() {
        return kimiState;
      },
      enumerable: true,
      configurable: true,
    });

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "kimi") return null;
      return e;
    }

    function flushPush() {
      pushTimer = null;
      lastPushAt = Date.now();
      if (!guard()) return;
      store.save();
      pushDetail(threadId, kimiState);
    }

    function upsertKimiThinking() {
      const body = truncate(thinkingText, THINKING_TRUNCATE) || "Thinking…";
      if (!thinkingMsgId) {
        if (!thinkingText) return;
        thinkingMsgId = appendMessage(
          threadId,
          "event",
          body,
          runId,
          null,
          null,
          { thinking: true },
        );
        return;
      }
      store.updateMessage(threadId, thinkingMsgId, { text: body });
    }

    function throttledPush() {
      const now = Date.now();
      const elapsed = now - lastPushAt;
      if (elapsed >= PUSH_THROTTLE_MS) {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        flushPush();
        return;
      }
      if (!pushTimer) {
        pushTimer = setTimeout(flushPush, PUSH_THROTTLE_MS - elapsed);
      }
    }

    function ensureAssistant(text) {
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(threadId, "assistant", text, runId);
      } else {
        store.updateMessage(threadId, assistantMsgId, { text });
      }
    }

    function mergePendingUsage(info) {
      if (!info) return;
      if (!pendingUsage) {
        pendingUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
        };
      }
      pendingUsage.inputTokens += Number(info.inputTokens) || 0;
      pendingUsage.outputTokens += Number(info.outputTokens) || 0;
      pendingUsage.cachedInputTokens += Number(info.cachedInputTokens) || 0;
      pendingUsage.cacheWriteTokens += Number(info.cacheWriteTokens) || 0;
      if (info.contextTokens != null) {
        pendingUsage.contextTokens = info.contextTokens;
      }
      if (info.costUsd != null) {
        pendingUsage.costUsd =
          (Number(pendingUsage.costUsd) || 0) + (Number(info.costUsd) || 0);
      }
    }

    function applyUsage(usageInfo, opts = {}) {
      if (!usageInfo) return;
      const prev = store.getUsage(threadId) || {
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: 0,
      };
      const costPresent = usageInfo.costUsd != null;
      const costDelta = costPresent ? Number(usageInfo.costUsd) || 0 : 0;
      const inDelta = Number(usageInfo.inputTokens) || 0;
      const outDelta = Number(usageInfo.outputTokens) || 0;
      const cachedDelta = Number(usageInfo.cachedInputTokens) || 0;
      const writeDelta = Number(usageInfo.cacheWriteTokens) || 0;
      runUsage.tokensIn += inDelta;
      runUsage.tokensOut += outDelta;
      runUsage.costUsd += costDelta;
      const nextUsage = {
        model: prev.model || thread.model || null,
        inputTokens: prev.inputTokens + inDelta,
        outputTokens: prev.outputTokens + outDelta,
        costUsd: prev.costUsd + costDelta,
        turns: prev.turns + 1,
      };
      // Moonshot four-bucket usage.record is a full prompt; billable in/out
      // alone still leaves contextTokens unset (#317, #696).
      assignContextUsage(
        nextUsage,
        prev,
        usageInfo.contextTokens,
        usageInfo.contextWindow,
      );
      store.setUsage(threadId, nextUsage);
      if (costDelta > 0) {
        store.recordSpend(costDelta);
      }
      store.recordUsage({
        provider: thread.provider,
        model: prev.model || thread.model || null,
        costUsd: costDelta,
        inputTokens: inDelta,
        cachedInputTokens: cachedDelta,
        cacheWriteTokens: writeDelta,
        outputTokens: outDelta,
        threadId,
        projectId: thread.projectId,
        projectName: store.getProject(thread.projectId)?.name,
        title: thread.title,
      });
      sawUsage = true;
      if (!opts.fallback) {
        usageReported = true;
        if (costPresent) costReported = true;
      }
    }

    function terminalUsage() {
      return {
        tokensIn: usageReported ? runUsage.tokensIn : undefined,
        tokensOut: usageReported ? runUsage.tokensOut : undefined,
        costUsd: costReported ? runUsage.costUsd : undefined,
      };
    }

    function settleKimiUsage() {
      if (pendingUsage) {
        applyUsage(pendingUsage);
        return;
      }
      const prior =
        thread.sessionId && thread.sessionId !== "cwd"
          ? thread.sessionId
          : null;
      const sessionId = capturedKimiSessionId || prior;
      if (!sessionId) return;
      const home =
        (kimiEnv && kimiEnv.KIMI_CODE_HOME) ||
        process.env.KIMI_CODE_HOME ||
        path.join(require("node:os").homedir(), ".kimi-code");
      try {
        const harvested = kimiParse.harvestKimiSessionUsage(home, sessionId, {
          sinceMs: prior ? runStartedMs : undefined,
        });
        if (harvested) applyUsage(harvested);
      } catch {
        // harvest is best-effort; the zero fallback still records the turn
      }
    }

    completeWorkLogStep(threadId, startingId);

    // Isolated KIMI_CODE_HOME so this turn cannot inherit other projects'
    // MCP servers or workspaces (issue #671). Local: overlay on this host.
    // ssh/WSL: deploy PreToolUse onto the far side and pass KIMI_CODE_HOME
    // through wrapCommand (#834).
    /** @type {NodeJS.ProcessEnv | undefined} */
    let kimiEnv;
    if (userDataPath && !crossesBoundary(project)) {
      try {
        const os = require("node:os");
        const dest = path.join(userDataPath, "kimi-homes", threadId);
        const sourceHome =
          process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
        materializeKimiHome({
          dest,
          sourceHome,
          cwd: localCwd,
          mcpServers: kimiMcpServersForRun({
            projectId: thread.projectId,
            projectPath: localCwd || project.path,
          }),
        });
        kimiEnv = { KIMI_CODE_HOME: dest };
      } catch {
        // Overlay is best-effort; a failed isolate must not block the turn.
      }
    } else if (crossesBoundary(project) && guardrailsEnabled()) {
      try {
        const dest = deployKimiGuardrailOverlay({ project, threadId });
        if (dest) kimiEnv = { KIMI_CODE_HOME: dest };
      } catch {
        // Deploy miss must not kill the run; stream notice remains.
      }
    }
    const spawn = resolveSpawn(project, binary, args, localCwd, kimiEnv);

    if (abortIfCancelled(threadId, runId)) return { runId };
    const handle = runKimi({
      binary: spawn.binary,
      args: spawn.args,
      cwd: spawn.cwd,
      env: threadSecrets.withEnv(threadId, kimiEnv),
      // No argv route for kimi effort; runKimi flips config.toml (effortVia).
      reasoningEffort: thread.reasoningEffort || null,
      onEvent: (ev) => {
        if (!guard()) return;

        const sid = kimiParse.extractSessionId(ev);
        if (sid) {
          capturedKimiSessionId = sid;
        }

        const thinking = kimiParse.extractThinking(ev);
        if (thinking) {
          thinkingText += thinking;
          upsertKimiThinking();
          throttledPush();
        }

        const text = kimiParse.extractAssistantText(ev);
        if (text) {
          assistantText += text;
          ensureAssistant(assistantText);
          throttledPush();
        }

        for (const tool of kimiParse.extractToolEvents(ev)) {
          if (tool.phase === "start") {
            const summary = tool.input
              ? `${tool.name}: ${tool.input.length > 80 ? `${tool.input.slice(0, 80)}…` : tool.input}`
              : tool.name;
            const existingId = toolMsgById.get(tool.id);
            if (existingId) {
              const existing = store
                .getMessages(threadId)
                .find((m) => m.id === existingId);
              if (existing && existing.tool) {
                store.updateMessage(threadId, existingId, {
                  text: summary,
                  tool: {
                    ...existing.tool,
                    name: tool.name,
                    input: tool.input || existing.tool.input,
                  },
                });
              }
            } else {
              thinkingMsgId = null;
              thinkingText = "";
              const toolMeta = {
                id: tool.id,
                name: tool.name,
                input: tool.input,
                output: null,
                isError: false,
                done: false,
              };
              const msgId = appendMessage(
                threadId,
                "tool",
                summary,
                runId,
                toolMeta,
              );
              toolMsgById.set(tool.id, msgId);
              const notice = guardrailNotice(
                tool.name,
                tool.input,
                thread.worktreePath || project.path,
              );
              if (notice) appendMessage(threadId, "event", notice, runId);
              // Post-tool text starts a fresh message below the tool call.
              assistantMsgId = null;
              assistantText = "";
            }
          } else if (tool.phase === "end") {
            let msgId = toolMsgById.get(tool.id);
            if (!msgId) {
              const toolMeta = {
                id: tool.id,
                name: tool.name,
                input: tool.input,
                output: null,
                isError: false,
                done: false,
              };
              msgId = appendMessage(
                threadId,
                "tool",
                tool.name,
                runId,
                toolMeta,
              );
              toolMsgById.set(tool.id, msgId);
              assistantMsgId = null;
              assistantText = "";
            }
            const existing = store
              .getMessages(threadId)
              .find((m) => m.id === msgId);
            if (existing && existing.tool) {
              store.updateMessage(threadId, msgId, {
                tool: {
                  ...existing.tool,
                  input: tool.input || existing.tool.input,
                  output: tool.output,
                  isError: tool.isError,
                  done: true,
                  ...persistToolImages(threadId, tool.images),
                },
              });
              noteToolSpan(threadId, runId, tool.id, tool.name, tool.isError);
            }
          } else {
            // single fire-and-complete
            const toolMeta = {
              id: tool.id,
              name: tool.name,
              input: tool.input,
              output: tool.output,
              isError: tool.isError,
              done: true,
              ...persistToolImages(threadId, tool.images),
            };
            appendMessage(threadId, "tool", tool.name, runId, toolMeta);
            // Post-tool text starts a fresh message below the tool call.
            assistantMsgId = null;
            assistantText = "";
          }
          throttledPush();
        }

        const usageInfo = kimiParse.extractUsage(ev);
        if (usageInfo) {
          mergePendingUsage(usageInfo);
          throttledPush();
        }
      },
      onExit: ({ code, stderr, fullStdout, gotJson }) => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "kimi") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        // Hard fallback: no parsable JSON -> entire stdout as plain text.
        if (!gotJson && fullStdout && fullStdout.length > 0) {
          assistantText = fullStdout.replace(/\s+$/, "");
          ensureAssistant(assistantText);
        }

        settleKimiUsage();
        if (!sawUsage && code === 0) {
          applyUsage({ inputTokens: 0, outputTokens: 0 }, { fallback: true });
        }

        if (code === 0) {
          // Prefer the real session id from the resume hint (-S on later
          // turns); keep a prior REAL id. Never stamp "cwd": -c is per
          // directory, not per thread (issue #220).
          const prior =
            thread.sessionId && thread.sessionId !== "cwd"
              ? thread.sessionId
              : null;
          store.updateThread(
            threadId,
            {
              status: "done",
              sessionId: capturedKimiSessionId || prior,
              runStartedAt: null,
            },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, kimiState);
          pushThreadsChanged();
          notifyRunTerminal(
            threadId,
            "done",
            assistantText || lastAssistantText(threadId, runId),
            terminalUsage(),
          );
          return;
        }

        const errText = formatRunExitError(code, stderr);
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, kimiState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, terminalUsage());
      },
      onError: (err) => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "kimi") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, kimiState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, terminalUsage());
      },
    });

    entry.handle = handle;
    store.save();
    pushDetail(threadId, kimiState);

    return { runId };
  }

  return { startKimiRun };
}

module.exports = { createKimiRun };
