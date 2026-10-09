"use strict";

// createRunner seam: OpenCode provider run (#1447, seam 11).
// Follows the seam convention in the header of electron/runner-watchdogs.js.

const { resolveBin } = require("./providers.js");
const { guardrailsEnabled } = require("./guardrails.js");
const {
  deployOpencodeGuardrailOverlay,
  materializeOpencodeGuardrailDir,
} = require("./opencode-guardrail.js");
const path = require("node:path");
const threadSecrets = require("./threadSecrets.js");
const opencodeParse = require("./opencode.js");
const { runOpencode } = opencodeParse;
const { guardrailNotice } = require("./guardrail-hook-core.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createOpencodeRun(ctx) {
  const {
    assertProviderBinary,
    crossesBoundary,
    resolveSpawn,
    PUSH_THROTTLE_MS,
    upsertThinkingCard,
    formatRunExitError,
    abortIfCancelled,
    store,
    beginWorkLogStep,
    stampPreparingSteps,
    pushThreadsChanged,
    pushDetail,
    userDataPath,
    claimPreparingRun,
    completeWorkLogStep,
    settleCancelledLaunch,
    active,
    appendMessage,
    persistToolImages,
    noteToolSpan,
    clearRun,
    lastAssistantText,
    notifyRunTerminal,
    markRunFailed,
    appendDoneWorkLog,
  } = ctx;

  /**
   * Start an OpenCode NDJSON (--format json) session turn with resume via -s.
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} providerEntry
   * @param {string[]} [files] - image/file paths for native `-f` (issue #176)
   */
  function startOpencodeRun(threadId, prompt, runId, providerEntry, files) {
    if (abortIfCancelled(threadId, runId)) return { runId };
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry, project);

    const opencodeState = {
      __opencode: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");
    stampPreparingSteps(threadId, runId, { startingId, workingId });

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, opencodeState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** Ordered part ids for text reconstruction. */
    /** @type {string[]} */
    const partOrder = [];
    /** @type {Map<string, string>} */
    const partTextById = new Map();
    let anonPartSeq = 0;
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    const thinking = { id: null, text: "" };
    /** @type {string[]} */
    const thinkingPartOrder = [];
    /** @type {Map<string, string>} */
    const thinkingPartById = new Map();
    /** @type {string | null} */
    let capturedSessionId = thread.sessionId || null;
    /** @type {string | null} */
    let terminalError = null;
    let lastPushAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let pushTimer = null;
    /** Run-local usage for memory footers (not cumulative store totals). */
    const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

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
      files,
    });
    /** @type {NodeJS.ProcessEnv | undefined} */
    let opencodeEnv;
    // #813: OPENCODE_CONFIG_DIR plugin. Local overlay stays on this host.
    // ssh/WSL deploys a remote overlay (#835) and prefixes wrapCommand
    // with env OPENCODE_CONFIG_DIR= via boundaryArgv.
    if (crossesBoundary(project) && guardrailsEnabled()) {
      try {
        const dest = deployOpencodeGuardrailOverlay({ project, threadId });
        if (dest) {
          opencodeEnv = {
            OPENCODE_CONFIG_DIR: dest,
            SOLENTA_WORKTREE: project.remotePath || localCwd,
          };
        }
      } catch {
        // Deploy miss must not kill the run; stream notice remains.
      }
    } else if (userDataPath && !crossesBoundary(project) && guardrailsEnabled()) {
      try {
        const dest = path.join(userDataPath, "opencode-guardrails");
        materializeOpencodeGuardrailDir(dest);
        opencodeEnv = {
          OPENCODE_CONFIG_DIR: dest,
          SOLENTA_WORKTREE: localCwd,
        };
      } catch {
        // Overlay is best-effort; a failed isolate must not block the turn.
      }
    }
    const spawn = resolveSpawn(project, binary, args, localCwd, opencodeEnv);

    if (abortIfCancelled(threadId, runId)) return { runId };
    const entry = claimPreparingRun(threadId, runId, {
      kind: "opencode",
      startingId,
      workingId,
      opencodeState,
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
        return opencodeState;
      },
      enumerable: true,
      configurable: true,
    });

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "opencode") return null;
      return e;
    }

    function rebuildAssistantText() {
      return partOrder.map((id) => partTextById.get(id) || "").join("");
    }

    function flushPush() {
      pushTimer = null;
      lastPushAt = Date.now();
      if (!guard()) return;
      store.save();
      pushDetail(threadId, opencodeState);
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

    function applyUsage(usageInfo) {
      if (!usageInfo) return;
      const prev = store.getUsage(threadId) || {
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: 0,
      };
      const costDelta = Number(usageInfo.costUsd) || 0;
      const inDelta = Number(usageInfo.inputTokens) || 0;
      const outDelta = Number(usageInfo.outputTokens) || 0;
      runUsage.tokensIn += inDelta;
      runUsage.tokensOut += outDelta;
      runUsage.costUsd += costDelta;
      store.setUsage(threadId, {
        model: usageInfo.model || prev.model || thread.model || null,
        inputTokens: prev.inputTokens + inDelta,
        outputTokens: prev.outputTokens + outDelta,
        costUsd: prev.costUsd + costDelta,
        turns: prev.turns + 1,
      });
      if (costDelta > 0) {
        store.recordSpend(costDelta);
      }
      store.recordUsage({
        provider: thread.provider,
        model: usageInfo.model || prev.model || thread.model || null,
        costUsd: costDelta,
        inputTokens: inDelta,
        outputTokens: outDelta,
        threadId,
        projectId: thread.projectId,
        projectName: store.getProject(thread.projectId)?.name,
        title: thread.title,
      });
    }

    completeWorkLogStep(threadId, startingId);

    if (abortIfCancelled(threadId, runId)) return { runId };
    const handle = runOpencode({
      binary: spawn.binary,
      args: spawn.args,
      cwd: spawn.cwd,
      env: threadSecrets.withEnv(threadId, opencodeEnv),
      onEvent: (ev) => {
        if (!guard()) return;

        const structuredError = opencodeParse.extractTerminalError(ev);
        if (structuredError) terminalError = structuredError;

        const sid = opencodeParse.extractSessionId(ev);
        if (sid && !capturedSessionId) {
          capturedSessionId = sid;
          store.updateThread(threadId, { sessionId: sid });
          store.save();
          pushThreadsChanged();
          throttledPush();
        } else if (sid && sid !== capturedSessionId) {
          capturedSessionId = sid;
          store.updateThread(threadId, { sessionId: sid });
          store.save();
          pushThreadsChanged();
        }

        const textPart = opencodeParse.extractTextPart(ev);
        if (textPart) {
          const partId =
            textPart.id != null && textPart.id !== ""
              ? textPart.id
              : `__anon_${anonPartSeq++}`;
          if (!partTextById.has(partId)) {
            partOrder.push(partId);
          }
          // Dedupe: repeating part.id with fuller text replaces that contribution.
          const prev = partTextById.get(partId) || "";
          if (
            !prev ||
            textPart.text.length >= prev.length ||
            !prev.startsWith(textPart.text)
          ) {
            partTextById.set(partId, textPart.text);
          }
          ensureAssistant(rebuildAssistantText());
          throttledPush();
        }

        const thinkPart = opencodeParse.extractThinkingPart(ev);
        if (thinkPart) {
          const partId =
            thinkPart.id != null && thinkPart.id !== ""
              ? thinkPart.id
              : `__think_${anonPartSeq++}`;
          if (!thinkingPartById.has(partId)) thinkingPartOrder.push(partId);
          const prev = thinkingPartById.get(partId) || "";
          if (
            !prev ||
            thinkPart.text.length >= prev.length ||
            !prev.startsWith(thinkPart.text)
          ) {
            thinkingPartById.set(partId, thinkPart.text);
          }
          const full = thinkingPartOrder
            .map((id) => thinkingPartById.get(id) || "")
            .join("");
          upsertThinkingCard(
            appendMessage,
            store,
            threadId,
            runId,
            thinking,
            full,
            true,
          );
          throttledPush();
        }

        const tool = opencodeParse.extractToolEvent(ev);
        if (tool) {
          if (tool.phase === "start") {
            thinking.id = null;
            thinking.text = "";
            thinkingPartOrder.length = 0;
            thinkingPartById.clear();
            const toolMeta = {
              id: tool.id,
              name: tool.name,
              input: tool.input,
              output: null,
              isError: false,
              done: false,
            };
            const summary = tool.input
              ? `${tool.name}: ${tool.input.length > 80 ? `${tool.input.slice(0, 80)}…` : tool.input}`
              : tool.name;
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
            // Clearing parts is safe: opencode completes text parts before tools.
            assistantMsgId = null;
            partOrder.length = 0;
            partTextById.clear();
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
              partOrder.length = 0;
              partTextById.clear();
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
            // Clearing parts is safe: opencode completes text parts before tools.
            assistantMsgId = null;
            partOrder.length = 0;
            partTextById.clear();
          }
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
        if (e.kind !== "opencode") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        let assistantText =
          rebuildAssistantText() || lastAssistantText(threadId, runId);

        // Hard fallback: zero JSON lines parse -> whole stdout as text.
        if (!gotJson && fullStdout && fullStdout.length > 0) {
          assistantText = fullStdout.replace(/\s+$/, "");
          ensureAssistant(assistantText);
        }

        // Usage unknown: estimate tokens like text kind.
        if (code === 0 && !terminalError) {
          const tokens = Math.ceil((assistantText || "").length / 4) || 0;
          applyUsage({
            inputTokens: 0,
            outputTokens: tokens,
            costUsd: 0,
            model: thread.model || null,
          });

          store.updateThread(
            threadId,
            {
              status: "done",
              sessionId: capturedSessionId || thread.sessionId || null,
              runStartedAt: null,
            },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, opencodeState);
          pushThreadsChanged();
          notifyRunTerminal(
            threadId,
            "done",
            assistantText || lastAssistantText(threadId, runId),
            {
              tokensIn: runUsage.tokensIn,
              tokensOut: runUsage.tokensOut,
              costUsd: runUsage.costUsd,
            },
          );
          return;
        }

        const errText = formatRunExitError(code, terminalError || stderr);
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, opencodeState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
      },
      onError: (err) => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "opencode") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, opencodeState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
      },
    });

    entry.handle = handle;
    store.save();
    pushDetail(threadId, opencodeState);

    return { runId };
  }

  return { startOpencodeRun };
}

module.exports = { createOpencodeRun };
