"use strict";

// createRunner seam: Cursor provider run (#1447, seam 11).
// Follows the seam convention in the header of electron/runner-watchdogs.js.

const { resolveBin } = require("./providers.js");
const {
  materializeCursorPinPlugin,
  cursorPinPluginDir,
} = require("./cursorPinTaskParent.js");
const { guardrailsEnabled } = require("./guardrails.js");
const {
  materializeCursorGuardrailPlugin,
  cursorGuardrailPluginDir,
  deployCursorGuardrailPlugin,
} = require("./cursor-guardrail.js");
const {
  insertBeforeLast,
  guardrailNotice,
} = require("./guardrail-hook-core.js");
const path = require("node:path");
const cursorParse = require("./cursor.js");
const { materializeCursorHome, runCursor } = cursorParse;
const {
  kimiMcpServersForRun,
  ensureCursorMcpConfig,
} = require("./memory-sup.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createCursorRun(ctx) {
  const {
    assertProviderBinary,
    crossesBoundary,
    resolveSpawn,
    PUSH_THROTTLE_MS,
    assignContextUsage,
    upsertThinkingCard,
    cursorToolCardSummary,
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
    ingestTaskNotifications,
    noteCursorSubagent,
    persistToolImages,
    noteToolSpan,
    clearRun,
    finishRunningSubagents,
    notifyRunTerminal,
    lastAssistantText,
    markRunFailed,
    appendDoneWorkLog,
  } = ctx;

  /**
   * Start a Cursor stream-json session turn. Session id comes from
   * extractSessionId (system init and result).
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} providerEntry
   */
  function startCursorRun(threadId, prompt, runId, providerEntry) {
    if (abortIfCancelled(threadId, runId)) return { runId };
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry, project);

    const cursorState = {
      __cursor: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");
    stampPreparingSteps(threadId, runId, { startingId, workingId });

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, cursorState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    const thinking = { id: null, text: "" };
    let sawUsage = false;
    /** True when extractUsage returned a real result event, not the zero fallback. */
    let usageReported = false;
    /** True when that result carried a cost field. Cursor Ultra does not. */
    let costReported = false;
    let lastPushAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let pushTimer = null;
    /** Run-local usage for memory footers (not cumulative store totals). */
    const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    /** @type {string | null} */
    let capturedCursorSessionId = null;

    const localCwd = thread.worktreePath || project.path;
    const binary = resolveBin(providerEntry);
    const args = providerEntry.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
      reasoningEffort: thread.reasoningEffort || null,
      webSearch: thread.webSearch === true,
    });
    // #686: pin Task/Agent workers to the parent model. #813: classifyTool
    // preToolUse. Prompt stays last. Local plugins live here. ssh/WSL:
    // deploy the classifyTool plugin onto the far side and pass
    // --plugin-dir through wrap (#834). Pin-task-parent stays local.
    /** @type {Record<string, string> | undefined} */
    let cursorWrapEnv;
    if (!crossesBoundary(project) && args.length > 0) {
      try {
        const pluginDirs = [
          materializeCursorPinPlugin(cursorPinPluginDir(userDataPath)),
        ];
        if (guardrailsEnabled()) {
          pluginDirs.push(
            materializeCursorGuardrailPlugin(
              cursorGuardrailPluginDir(userDataPath),
            ),
          );
        }
        const extras = [];
        for (const dir of pluginDirs) {
          extras.push("--plugin-dir", dir);
        }
        insertBeforeLast(args, extras);
      } catch {
        // Fail-open: a plugin write error must not block the Cursor turn.
      }
    } else if (crossesBoundary(project) && args.length > 0 && guardrailsEnabled()) {
      try {
        const dest = deployCursorGuardrailPlugin({ project, threadId });
        if (dest) {
          insertBeforeLast(args, ["--plugin-dir", dest]);
          cursorWrapEnv = {
            SOLENTA_WORKTREE: project.remotePath || localCwd,
          };
        }
      } catch {
        // Deploy miss must not kill the run; stream notice remains.
      }
    }
    // Isolated HOME so this turn receives bound Solenta MCP without
    // writing the user's ~/.cursor/mcp.json (issue #700). Skipped for
    // ssh/WSL (the overlay lives on this host) and when userDataPath
    // is unset (tests that do not pass one). Those paths fall back to
    // a merge of ~/.cursor/mcp.json.
    /** @type {NodeJS.ProcessEnv | undefined} */
    let cursorEnv;
    if (userDataPath && !crossesBoundary(project)) {
      try {
        const os = require("node:os");
        const dest = path.join(userDataPath, "cursor-homes", threadId);
        const sourceHome = os.homedir();
        materializeCursorHome({
          dest,
          sourceHome,
          mcpServers: kimiMcpServersForRun({
            projectId: thread.projectId,
            projectPath: localCwd || project.path,
          }),
        });
        cursorEnv = { HOME: dest, SOLENTA_WORKTREE: localCwd };
      } catch {
        // Overlay is best-effort; a failed isolate must not block the turn.
        try {
          ensureCursorMcpConfig({
            projectPath: localCwd || project.path,
            projectId: thread.projectId,
          });
        } catch {
          // ignore
        }
      }
    } else {
      try {
        ensureCursorMcpConfig({
          projectPath: localCwd || project.path,
          projectId: thread.projectId,
        });
      } catch {
        // Overlay is the Solenta-run path; a bind miss on ssh/WSL must
        // not kill the run.
      }
    }
    const spawn = resolveSpawn(project, binary, args, localCwd, cursorWrapEnv);

    if (abortIfCancelled(threadId, runId)) return { runId };
    const entry = claimPreparingRun(threadId, runId, {
      kind: "cursor",
      startingId,
      workingId,
      cursorState,
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
        return cursorState;
      },
      enumerable: true,
      configurable: true,
    });

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "cursor") return null;
      return e;
    }

    function flushPush() {
      pushTimer = null;
      lastPushAt = Date.now();
      if (!guard()) return;
      store.save();
      pushDetail(threadId, cursorState);
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

    completeWorkLogStep(threadId, startingId);

    if (abortIfCancelled(threadId, runId)) return { runId };
    const handle = runCursor({
      binary: spawn.binary,
      args: spawn.args,
      cwd: spawn.cwd,
      env: cursorEnv,
      onEvent: (ev) => {
        // Cursor does not keep the CLI alive between turns, but a background
        // Task can finish via <task-notification> instead of tool_call/completed
        // (#708). Scan before guard() so a late user event still settles the row.
        ingestTaskNotifications(threadId, ev, cursorState);
        if (!guard()) return;

        const sid = cursorParse.extractSessionId(ev);
        if (sid) {
          capturedCursorSessionId = sid;
          // Persist on init, not only on exit 0: Stop+retry must --resume
          // after a hung turn (#691).
          const live = store.getThread(threadId);
          if (live && live.sessionId !== sid) {
            store.updateThread(threadId, { sessionId: sid });
          }
        }

        const think = cursorParse.extractThinking(ev);
        if (think) {
          if (think.done) {
            if (think.text) {
              upsertThinkingCard(
                appendMessage,
                store,
                threadId,
                runId,
                thinking,
                think.text,
                true,
              );
            }
          } else if (think.text) {
            upsertThinkingCard(
              appendMessage,
              store,
              threadId,
              runId,
              thinking,
              think.text,
              false,
            );
          }
          throttledPush();
        }

        const text = cursorParse.extractAssistantText(ev);
        if (text != null) {
          // Deltas carry timestamp_ms. A no-timestamp assistant line is
          // either a complete non-streamed message or the end-of-turn
          // flush of already-accumulated deltas. Skip the flush.
          if (ev.timestamp_ms != null) {
            assistantText += text;
            ensureAssistant(assistantText);
            throttledPush();
          } else if (!assistantText) {
            assistantText = text;
            ensureAssistant(assistantText);
            throttledPush();
          }
        }

        for (const tool of cursorParse.extractToolEvents(ev)) {
          const args = cursorParse.parseToolArgs(tool.input);
          const summary = cursorToolCardSummary(tool.name, tool.input, args);
          if (tool.phase === "start") {
            thinking.id = null;
            thinking.text = "";
            if (toolMsgById.has(tool.id)) {
              throttledPush();
              continue;
            }
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
              args || tool.input,
              thread.worktreePath || project.path,
            );
            if (notice) appendMessage(threadId, "event", notice, runId);
            noteCursorSubagent(threadId, tool, args, "running");
            // Post-tool text starts a fresh message below the tool call.
            assistantMsgId = null;
            assistantText = "";
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
                summary,
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
            noteCursorSubagent(
              threadId,
              tool,
              args,
              tool.isError ? "failed" : "done",
            );
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
            appendMessage(threadId, "tool", summary, runId, toolMeta);
            noteCursorSubagent(
              threadId,
              tool,
              args,
              tool.isError ? "failed" : "done",
            );
            assistantMsgId = null;
            assistantText = "";
          }
          throttledPush();
        }

        const usageInfo = cursorParse.extractUsage(ev);
        if (usageInfo) {
          applyUsage(usageInfo);
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
        if (e.kind !== "cursor") return;

        clearRun(threadId);
        finishRunningSubagents(threadId, "done");
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        if (!gotJson && fullStdout && fullStdout.length > 0) {
          assistantText = fullStdout.replace(/\s+$/, "");
          ensureAssistant(assistantText);
        }

        if (!sawUsage && code === 0) {
          applyUsage({ inputTokens: 0, outputTokens: 0 }, { fallback: true });
        }

        if (code === 0) {
          const prior = thread.sessionId || null;
          store.updateThread(
            threadId,
            {
              status: "done",
              sessionId: capturedCursorSessionId || prior,
              runStartedAt: null,
            },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, cursorState);
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
        pushDetail(threadId, cursorState);
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
        if (e.kind !== "cursor") return;

        clearRun(threadId);
        finishRunningSubagents(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, cursorState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, terminalUsage());
      },
    });

    entry.handle = handle;
    store.save();
    pushDetail(threadId, cursorState);

    return { runId };
  }

  return { startCursorRun };
}

module.exports = { createCursorRun };
