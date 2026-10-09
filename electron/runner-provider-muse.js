"use strict";

// createRunner seam: Muse provider run (#1447, seam 11).
// Follows the seam convention in the header of electron/runner-watchdogs.js.

const { resolveBin } = require("./providers.js");
const path = require("node:path");
const threadSecrets = require("./threadSecrets.js");
const {
  materializeMuseHome,
  museChildEnv,
  deployMuseGuardrailOverlay,
  museRemoteChildEnv,
  toolCardKey,
  runMuse,
  extractSessionId,
  extractThinking,
  extractAssistantText,
  extractToolEvent,
  extractUsage,
} = require("./muse.js");
const { kimiMcpServersForRun } = require("./memory-sup.js");
const { museGuardrailHookCommand } = require("./muse-guardrail-hook.js");
const { guardrailNotice } = require("./guardrail-hook-core.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createMuseRun(ctx) {
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
    completeWorkLogStep,
    markRunFailed,
    appendDoneWorkLog,
    notifyRunTerminal,
    clearRun,
    claimPreparingRun,
    settleCancelledLaunch,
    active,
    appendMessage,
    noteToolSpan,
    lastAssistantText,
  } = ctx;

  /**
   * Start a Muse Code exec --json turn. Overlay fail-closed (grok #706).
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} providerEntry
   */
  async function startMuseRun(threadId, prompt, runId, providerEntry) {
    if (abortIfCancelled(threadId, runId)) return { runId };
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry, project);

    const museState = {
      __muse: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");
    stampPreparingSteps(threadId, runId, { startingId, workingId });

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, museState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    const thinking = { id: null, text: "" };
    let lastPushAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let pushTimer = null;
    /** Run-local usage for memory footers (not cumulative store totals). */
    const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    let usageReported = false;
    let costReported = false;
    /** @type {string | null} */
    let capturedMuseSessionId = null;

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

    /** @type {NodeJS.ProcessEnv | undefined} */
    let museEnv;
    if (userDataPath && !crossesBoundary(project)) {
      const dest = path.join(userDataPath, "muse-homes", threadId);
      const os = require("node:os");
      const xdgConfig =
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
      const xdgData =
        process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
      try {
        materializeMuseHome({
          dest,
          sourceConfigDir: path.join(xdgConfig, "muse"),
          sourceDataDir: path.join(xdgData, "muse"),
          mcpServers: kimiMcpServersForRun({
            projectId: thread.projectId,
            projectPath: localCwd || project.path,
          }),
          hookCommand: museGuardrailHookCommand({
            hookPath: path.join(dest, "muse-guardrail-hook.js"),
          }),
        });
        museEnv = {
          ...museChildEnv(dest),
          SOLENTA_WORKTREE: localCwd,
        };
      } catch (err) {
        completeWorkLogStep(threadId, startingId);
        completeWorkLogStep(threadId, workingId);
        const msg =
          "Muse MCP overlay failed: " +
          (err && err.message ? err.message : String(err));
        const failure = markRunFailed(threadId, msg, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        notifyRunTerminal(threadId, "failed", failure.text);
        pushDetail(threadId, museState);
        store.save();
        pushThreadsChanged();
        clearRun(threadId);
        return { runId };
      }
    } else if (crossesBoundary(project)) {
      try {
        const dest = deployMuseGuardrailOverlay({ project, threadId });
        if (!dest) throw new Error("Muse remote overlay failed");
        museEnv = {
          ...museRemoteChildEnv(dest),
          SOLENTA_WORKTREE: project.remotePath || localCwd,
        };
      } catch (err) {
        completeWorkLogStep(threadId, startingId);
        completeWorkLogStep(threadId, workingId);
        const msg =
          "Muse remote overlay failed: " +
          (err && err.message ? err.message : String(err));
        const failure = markRunFailed(threadId, msg, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        notifyRunTerminal(threadId, "failed", failure.text);
        pushDetail(threadId, museState);
        store.save();
        pushThreadsChanged();
        clearRun(threadId);
        return { runId };
      }
    } else {
      museEnv = { SOLENTA_WORKTREE: localCwd };
    }

    const spawn = resolveSpawn(project, binary, args, localCwd, museEnv);

    if (abortIfCancelled(threadId, runId)) return { runId };
    const entry = claimPreparingRun(threadId, runId, {
      kind: "muse",
      startingId,
      workingId,
      museState,
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
        return museState;
      },
      enumerable: true,
      configurable: true,
    });

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "muse") return null;
      return e;
    }

    function flushPush() {
      pushTimer = null;
      lastPushAt = Date.now();
      if (!guard()) return;
      store.save();
      pushDetail(threadId, museState);
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
      const costPresent = usageInfo.costUsd != null;
      const costDelta = costPresent ? Number(usageInfo.costUsd) || 0 : 0;
      const inDelta = Number(usageInfo.inputTokens) || 0;
      const outDelta = Number(usageInfo.outputTokens) || 0;
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
      store.setUsage(threadId, nextUsage);
      if (costDelta > 0) {
        store.recordSpend(costDelta);
      }
      store.recordUsage({
        provider: thread.provider,
        model: prev.model || thread.model || null,
        costUsd: costDelta,
        inputTokens: inDelta,
        outputTokens: outDelta,
        threadId,
        projectId: thread.projectId,
        projectName: store.getProject(thread.projectId)?.name,
        title: thread.title,
      });
      usageReported = true;
      if (costPresent) costReported = true;
    }

    function terminalUsage() {
      return {
        tokensIn: usageReported ? runUsage.tokensIn : undefined,
        tokensOut: usageReported ? runUsage.tokensOut : undefined,
        costUsd: costReported ? runUsage.costUsd : undefined,
      };
    }

    function ingestTool(tool, ev) {
      const streamId =
        ev && ev.stream && typeof ev.stream.id === "string" ? ev.stream.id : "";
      const key = toolCardKey(streamId, tool.id);
      const summary = tool.input
        ? `${tool.name}: ${String(tool.input).length > 80 ? `${String(tool.input).slice(0, 80)}…` : tool.input}`
        : tool.name;
      if (tool.phase === "start") {
        thinking.id = null;
        thinking.text = "";
        if (toolMsgById.has(key)) return;
        const toolMeta = {
          id: key,
          name: tool.name,
          input: tool.input,
          output: null,
          isError: false,
          done: false,
        };
        const msgId = appendMessage(threadId, "tool", summary, runId, toolMeta);
        toolMsgById.set(key, msgId);
        const notice = guardrailNotice(
          tool.name,
          tool.input,
          thread.worktreePath || project.path,
        );
        if (notice) appendMessage(threadId, "event", notice, runId);
        assistantMsgId = null;
        assistantText = "";
        return;
      }
      if (tool.phase === "end") {
        let msgId = toolMsgById.get(key);
        if (!msgId) {
          const toolMeta = {
            id: key,
            name: tool.name,
            input: tool.input,
            output: null,
            isError: false,
            done: false,
          };
          msgId = appendMessage(threadId, "tool", summary, runId, toolMeta);
          toolMsgById.set(key, msgId);
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
            },
          });
          noteToolSpan(threadId, runId, key, tool.name, tool.isError);
        }
        return;
      }
      const toolMeta = {
        id: key,
        name: tool.name,
        input: tool.input,
        output: tool.output,
        isError: tool.isError,
        done: true,
      };
      appendMessage(threadId, "tool", tool.name, runId, toolMeta);
      assistantMsgId = null;
      assistantText = "";
    }

    completeWorkLogStep(threadId, startingId);

    if (abortIfCancelled(threadId, runId)) return { runId };
    const handle = runMuse({
      binary: spawn.binary,
      args: spawn.args,
      cwd: spawn.cwd,
      env: threadSecrets.withEnv(threadId, museEnv),
      onEvent: (ev) => {
        if (!guard()) return;

        const sid = extractSessionId(ev);
        if (sid) {
          capturedMuseSessionId = sid;
        }

        const think = extractThinking(ev);
        if (think) {
          upsertThinkingCard(
            appendMessage,
            store,
            threadId,
            runId,
            thinking,
            think,
            false,
          );
          throttledPush();
        }

        const text = extractAssistantText(ev);
        if (text) {
          // Echo delta and terminal carry the same full payload.text.
          // Terminal is a snapshot: replace, or skip if already equal.
          if (ev.payload_type === "run.terminal.completed") {
            if (text !== assistantText) {
              assistantText = text;
              ensureAssistant(assistantText);
              throttledPush();
            }
          } else {
            assistantText += text;
            ensureAssistant(assistantText);
            throttledPush();
          }
        }

        const tool = extractToolEvent(ev);
        if (tool) {
          ingestTool(tool, ev);
          throttledPush();
        }

        const usageInfo = extractUsage(ev);
        if (usageInfo) {
          applyUsage(usageInfo);
          throttledPush();
        }
      },
      onExit: ({ code, stderr }) => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "muse") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        if (code === 0) {
          const prior =
            thread.sessionId && thread.sessionId !== "cwd"
              ? thread.sessionId
              : null;
          store.updateThread(
            threadId,
            {
              status: "done",
              sessionId: capturedMuseSessionId || prior,
              runStartedAt: null,
            },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, museState);
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
        pushDetail(threadId, museState);
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
        if (e.kind !== "muse") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, museState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, terminalUsage());
      },
    });

    entry.handle = handle;
    store.save();
    pushDetail(threadId, museState);

    return { runId };
  }

  return { startMuseRun };
}

module.exports = { createMuseRun };
