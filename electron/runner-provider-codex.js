"use strict";

// createRunner seam: Codex provider run (#1447, seam 11).
// Follows the seam convention in the header of electron/runner-watchdogs.js.

const {
  sessionIdForResume,
  resolveBin,
  honouredEfforts,
  codexModelAcceptsImages,
} = require("./providers.js");
const services = require("./services.js");
const { codexWorkspaceWriteArgs } = require("./codexWorkspaceWrite.js");
const { getCodexMcpArgs, getCodexMcpEnv } = require("./memory-sup.js");
const { guardrailsEnabled } = require("./guardrails.js");
const { threadInstanceEnv, threadProviderRef } = require("./providerInstances.js");
const {
  deployCodexGuardrailOverlay,
  materializeCodexGuardrailHome,
} = require("./codex-guardrail.js");
const path = require("node:path");
const threadSecrets = require("./threadSecrets.js");
const { truncate, INPUT_TRUNCATE, OUTPUT_TRUNCATE } = require("./claude.js");
const codexParse = require("./codex.js");
const { isCodexChildThread } = require("./codex-appserver.js");
const { isNativeCompactTurn, recordCompaction } = require("./compaction.js");
const { guardrailNotice } = require("./guardrail-hook-core.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createCodexRun(ctx) {
  const {
    assertProviderBinary,
    crossesBoundary,
    resolveSpawn,
    THINKING_TRUNCATE,
    assignContextUsage,
    formatRunExitError,
    trackLiveCodexPid,
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
    runCodexFn,
    handleCodexServerRequest,
    savePlanSteps,
    clearRun,
    notifyRunTerminal,
    lastAssistantText,
    markRunFailed,
    appendDoneWorkLog,
  } = ctx;

  /**
   * Start a Codex interactive turn over a private app-server (#1170).
   * Workflow / ask / commitmsg stay on `runCodex` exec --json.
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} providerEntry
   * @param {string[]} [images] - absolute paths for UserInput localImage
   */
  function startCodexRun(threadId, prompt, runId, providerEntry, images) {
    if (abortIfCancelled(threadId, runId)) return { runId };
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry, project);

    const codexState = {
      __codex: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");
    stampPreparingSteps(threadId, runId, { startingId, workingId });

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, codexState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** command item id -> message id */
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    /** reasoning item id -> thinking message id */
    /** @type {Map<string, string>} */
    const thinkingMsgById = new Map();
    const resumeId = sessionIdForResume(
      providerEntry,
      thread,
      store.getUsage(threadId),
    );
    const startedFresh = Boolean(thread.sessionId) && !resumeId;
    /** @type {string | null} */
    let capturedSessionId = resumeId;
    let sawTerminalUsage = false;
    let finishedFromStream = false;
    /** @type {string | null} */
    let terminalError = null;
    /** Run-local usage for memory footers (not cumulative store totals). */
    const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    /** @type {number | undefined} ring size when a compaction item started */
    let compactBefore;

    const localCwd = thread.worktreePath || project.path;
    const binary = resolveBin(providerEntry);
    // Private per-turn app-server. Do not use the user-global daemon
    // (writer lock with Codex Desktop). Prompt is turn/start input, not argv.
    const args = ["app-server", "--listen", "stdio://"];
    const effortLevel = thread.reasoningEffort || null;
    const allowedEffort = honouredEfforts(providerEntry, thread.model || null);
    if (effortLevel && allowedEffort.includes(String(effortLevel))) {
      args.push("-c", `model_reasoning_effort=${effortLevel}`);
    }
    if (thread.webSearch === true) {
      args.push("-c", "web_search=live");
    }
    // MCP / Planboard -c sit after `app-server` (same values as exec).
    // Bearer tokens ride the child's env, never argv (issue #125).
    const planboardNote = services.planboardNoteFor(localCwd, {
      provider: thread.provider,
      permissionMode: thread.permissionMode || "default",
    });
    const codexExecConfig = [
      ...codexWorkspaceWriteArgs({
        cwd: localCwd,
        permissionMode: thread.permissionMode || "default",
        allowNetwork: planboardNote === services.PLANBOARD_NOTE,
      }),
      ...getCodexMcpArgs({
        projectPath: localCwd,
        projectId: thread.projectId,
      }),
    ];
    if (codexExecConfig.length) args.push(...codexExecConfig);
    /** @type {Record<string, string>} */
    // Named instance (#453): its CODEX_HOME and env ride this child only.
    const instEnv = threadInstanceEnv(store.getSettings(), thread) || {};
    const codexMcpEnv = { ...instEnv, ...getCodexMcpEnv() };
    // #813: isolated CODEX_HOME PreToolUse. Local overlay stays on this
    // host. ssh/WSL deploys a remote overlay (#835) and prefixes
    // wrapCommand with env CODEX_HOME= via boundaryArgv.
    /** @type {Record<string, string> | undefined} */
    let codexWrapEnv;
    if (crossesBoundary(project) && guardrailsEnabled()) {
      try {
        const dest = deployCodexGuardrailOverlay({ project, threadId });
        if (dest) {
          // Isolated overlay + hooks=true. Do not pass
          // --dangerously-bypass-hook-trust: that flag is exec-only and
          // live Codex app-server exits 2 on it (#1309). Trust is written
          // into the overlay config.toml (#1311).
          args.push("-c", "features.hooks=true");
          codexWrapEnv = {
            CODEX_HOME: dest,
            SOLENTA_WORKTREE: project.remotePath || localCwd,
          };
        }
      } catch {
        // Deploy miss must not kill the run; stream notice remains.
      }
    } else if (userDataPath && !crossesBoundary(project) && guardrailsEnabled()) {
      try {
        const dest = path.join(userDataPath, "codex-homes", threadId);
        const sourceHome =
          instEnv.CODEX_HOME ||
          process.env.CODEX_HOME ||
          path.join(require("node:os").homedir(), ".codex");
        materializeCodexGuardrailHome({ dest, sourceHome });
        // Isolated overlay + hooks=true. Do not pass
        // --dangerously-bypass-hook-trust: that flag is exec-only and
        // live Codex app-server exits 2 on it (#1309). Trust is written
        // into the overlay config.toml (#1311).
        args.push("-c", "features.hooks=true");
        codexMcpEnv.CODEX_HOME = dest;
        codexMcpEnv.SOLENTA_WORKTREE = localCwd;
      } catch {
        // Overlay is best-effort; a failed isolate must not block the turn.
      }
    }
    const spawn = resolveSpawn(project, binary, args, localCwd, codexWrapEnv);

    if (abortIfCancelled(threadId, runId)) return { runId };
    const entry = claimPreparingRun(threadId, runId, {
      kind: "codex",
      startingId,
      workingId,
      codexState,
      runUsage,
      sessionId: resumeId,
      /**
       * App-server ServerRequests awaiting a user decision (issue #1171).
       * Empty on exec --json; filled when #1170 attaches JSON-RPC.
       */
      pendingPermissions: [],
    });
    if (!entry) {
      completeWorkLogStep(threadId, startingId);
      completeWorkLogStep(threadId, workingId);
      settleCancelledLaunch(threadId, runId);
      return { runId };
    }
    Object.defineProperty(entry, "workflow", {
      get() {
        return codexState;
      },
      enumerable: true,
      configurable: true,
    });

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "codex") return null;
      return e;
    }

    function ensureAssistant(text) {
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(threadId, "assistant", text, runId);
      } else {
        store.updateMessage(threadId, assistantMsgId, { text });
      }
    }

    function upsertThinking(id, text) {
      const body = truncate(text || "", THINKING_TRUNCATE) || "Thinking…";
      const existingId = thinkingMsgById.get(id);
      if (existingId) {
        store.updateMessage(threadId, existingId, { text: body });
        return;
      }
      if (!text) return;
      const msgId = appendMessage(
        threadId,
        "event",
        body,
        runId,
        null,
        null,
        { thinking: true },
      );
      thinkingMsgById.set(id, msgId);
    }

    function ingestCodexTool(live) {
      const id = live.id;
      const name = live.name || "tool";
      const summary = live.summary || name;
      const input = truncate(live.input || "", INPUT_TRUNCATE);
      const output =
        live.output != null ? truncate(live.output, OUTPUT_TRUNCATE) : null;
      const existingId = toolMsgById.get(id);
      if (existingId) {
        const existing = store
          .getMessages(threadId)
          .find((m) => m.id === existingId);
        if (existing && existing.tool) {
          store.updateMessage(threadId, existingId, {
            text: summary,
            tool: {
              ...existing.tool,
              name,
              input: input || existing.tool.input,
              output: output != null ? output : existing.tool.output,
              isError: Boolean(live.isError),
              done: Boolean(live.done),
              ...persistToolImages(threadId, live.images),
            },
          });
          if (live.done) {
            noteToolSpan(
              threadId,
              runId,
              existing.tool.id,
              name,
              Boolean(live.isError),
            );
          }
        }
        return;
      }
      const tool = {
        id,
        name,
        input,
        output,
        isError: Boolean(live.isError),
        done: Boolean(live.done),
        ...persistToolImages(threadId, live.images),
      };
      const msgId = appendMessage(threadId, "tool", summary, runId, tool);
      toolMsgById.set(id, msgId);
      assistantMsgId = null;
      assistantText = "";
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
      // token_count.total_token_usage is session-cumulative. Replacing
      // rather than adding is what stops the ring from double-counting (#317).
      const snapshot = Boolean(usageInfo.snapshot);
      if (snapshot) {
        runUsage.tokensIn = inDelta;
        runUsage.tokensOut = outDelta;
        runUsage.costUsd += costDelta;
      } else {
        runUsage.tokensIn += inDelta;
        runUsage.tokensOut += outDelta;
        runUsage.costUsd += costDelta;
      }
      const nextUsage = {
        model: usageInfo.model || prev.model || thread.model || null,
        inputTokens: snapshot ? inDelta : prev.inputTokens + inDelta,
        outputTokens: snapshot ? outDelta : prev.outputTokens + outDelta,
        costUsd: prev.costUsd + costDelta,
        turns: snapshot && prev.turns > 0 ? prev.turns : prev.turns + 1,
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
      const billedIn = snapshot
        ? Math.max(0, inDelta - prev.inputTokens)
        : inDelta;
      const billedOut = snapshot
        ? Math.max(0, outDelta - prev.outputTokens)
        : outDelta;
      store.recordUsage({
        provider: threadProviderRef(thread),
        model: usageInfo.model || prev.model || thread.model || null,
        costUsd: costDelta,
        inputTokens: billedIn,
        outputTokens: billedOut,
        threadId,
        projectId: thread.projectId,
        projectName: store.getProject(thread.projectId)?.name,
        title: thread.title,
      });
      sawTerminalUsage = true;
    }

    const nativeImages =
      Array.isArray(images) && codexModelAcceptsImages(thread.model)
        ? images.filter((p) => typeof p === "string" && p)
        : [];
    if (abortIfCancelled(threadId, runId)) return { runId };
    const handle = runCodexFn({
      binary: spawn.binary,
      args: spawn.args,
      cwd: spawn.cwd,
      envExtra: threadSecrets.withEnv(threadId, codexMcpEnv),
      prompt,
      images: nativeImages,
      sessionId: resumeId,
      model: thread.model || null,
      reasoningEffort: thread.reasoningEffort || null,
      permissionMode: thread.permissionMode || "default",
      compact: isNativeCompactTurn("codex", prompt, resumeId),
      onServerRequest: (req) => handleCodexServerRequest(threadId, req),
      onEvent: (ev) => {
        if (!guard()) return;

        // Native compaction (thread/compact/start or auto). Usage for the
        // compacted context lands between started and completed, so the
        // "before" size is read at started.
        const compactItem = ev.item && ev.item.type === "contextCompaction";
        if (compactItem && ev.type === "item.started") {
          compactBefore = (store.getUsage(threadId) || {}).contextTokens;
          return;
        }
        if (compactItem && ev.type === "item.completed") {
          const after = (store.getUsage(threadId) || {}).contextTokens;
          recordCompaction({ store, appendMessage }, threadId, runId, {
            pre: compactBefore,
            post: after !== compactBefore ? after : null,
            auto: !isNativeCompactTurn("codex", prompt, resumeId),
          });
          store.save();
          pushDetail(threadId, codexState);
          return;
        }

        if (ev.type === "server_request.resolved") {
          const live = active.get(threadId);
          live.pendingPermissions = live.pendingPermissions.filter((p) => p.rpcId !== ev.requestId);
          store.updateThread(threadId, { awaitingInput: live.pendingPermissions.length > 0 });
          store.save();
          pushDetail(threadId, codexState);
          pushThreadsChanged();
          return;
        }

        const structuredError = codexParse.extractTerminalError(ev);
        if (structuredError) terminalError = structuredError;

        // Session / thread id. Only the root thread.started is a resume
        // target: child thread/started and turn.started carry a different
        // id and would poison the next thread/resume.
        if (codexParse.isSessionStartEvent(ev)) {
          const sid = codexParse.extractSessionId(ev);
          if (sid && !isCodexChildThread(ev.thread || { id: sid })) {
            capturedSessionId = sid;
            const live = active.get(threadId);
            if (live && live.kind === "codex") live.sessionId = sid;
            store.updateThread(
              threadId,
              startedFresh
                ? { sessionId: sid, ejected: false }
                : { sessionId: sid },
            );
            completeWorkLogStep(threadId, startingId);
            store.save();
            pushDetail(threadId, codexState);
            pushThreadsChanged();
          }
        }

        // Agent message growth (replace with latest full text when item.completed,
        // append deltas when msg carries delta only).
        const agentText = codexParse.extractAgentMessageText(ev);
        if (agentText != null) {
          const type = String(ev.type || "");
          const isDelta =
            (ev.msg &&
              typeof ev.msg === "object" &&
              /delta/i.test(String(ev.msg.type || ""))) ||
            /delta/i.test(type);
          if (isDelta) {
            assistantText += agentText;
          } else if (
            type === "item.completed" ||
            type === "item_completed" ||
            (ev.item && ev.item.type === "agent_message")
          ) {
            // Full message on completed item
            assistantText = agentText;
          } else if (!assistantText) {
            assistantText = agentText;
          } else if (!assistantText.endsWith(agentText)) {
            assistantText += agentText;
          }
          ensureAssistant(assistantText);
          store.save();
          pushDetail(threadId, codexState);
        }

        // Command execution -> tool messages
        const cmd = codexParse.extractCommandItem(ev);
        if (cmd) {
          if (cmd.phase === "started") {
            const tool = {
              id: cmd.id,
              name: "Command",
              input: truncate(cmd.command, INPUT_TRUNCATE),
              output: null,
              isError: false,
              done: false,
            };
            const summary = cmd.command
              ? `Command: ${cmd.command.length > 80 ? `${cmd.command.slice(0, 80)}…` : cmd.command}`
              : "Command";
            const msgId = appendMessage(
              threadId,
              "tool",
              summary,
              runId,
              tool,
            );
            toolMsgById.set(cmd.id, msgId);
            const notice = guardrailNotice(
              "Bash",
              { command: cmd.command },
              thread.worktreePath || project.path,
            );
            if (notice) appendMessage(threadId, "event", notice, runId);
            // Post-tool text starts a fresh message below the tool call.
            assistantMsgId = null;
            assistantText = "";
          } else if (cmd.phase === "completed") {
            let msgId = toolMsgById.get(cmd.id);
            if (!msgId) {
              const tool = {
                id: cmd.id,
                name: "Command",
                input: truncate(cmd.command, INPUT_TRUNCATE),
                output: null,
                isError: false,
                done: false,
              };
              const summary = cmd.command
                ? `Command: ${cmd.command.length > 80 ? `${cmd.command.slice(0, 80)}…` : cmd.command}`
                : "Command";
              msgId = appendMessage(threadId, "tool", summary, runId, tool);
              toolMsgById.set(cmd.id, msgId);
              assistantMsgId = null;
              assistantText = "";
            }
            const existing = store
              .getMessages(threadId)
              .find((m) => m.id === msgId);
            if (existing && existing.tool) {
              const isError =
                cmd.exitCode != null && Number(cmd.exitCode) !== 0;
              store.updateMessage(threadId, msgId, {
                tool: {
                  ...existing.tool,
                  input: truncate(
                    cmd.command || existing.tool.input,
                    INPUT_TRUNCATE,
                  ),
                  output: truncate(cmd.output || "", OUTPUT_TRUNCATE),
                  isError,
                  done: true,
                },
              });
              noteToolSpan(
                threadId,
                runId,
                existing.tool.id,
                existing.tool.name,
                isError,
              );
            }
          }
          store.save();
          pushDetail(threadId, codexState);
        }

        const live = codexParse.extractLiveItem(ev);
        if (live) {
          if (live.kind === "reasoning") {
            upsertThinking(live.id, live.text);
          } else {
            ingestCodexTool(live);
            if (live.kind === "todo_list" && live.todos) {
              savePlanSteps(threadId, live.todos);
            }
          }
          store.save();
          pushDetail(threadId, codexState);
        }

        // Usage
        const usageInfo = codexParse.extractUsage(ev);
        if (usageInfo) {
          applyUsage(usageInfo);
          store.save();
          pushDetail(threadId, codexState);
        }
      },
      onExit: ({ code, stderr }) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "codex") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        if (capturedSessionId) {
          store.updateThread(
            threadId,
            startedFresh
              ? { sessionId: capturedSessionId, ejected: false }
              : { sessionId: capturedSessionId },
          );
        }

        // If we never saw usage, still count a turn with zero tokens when ok
        if (!sawTerminalUsage && code === 0 && !terminalError) {
          applyUsage({ inputTokens: 0, outputTokens: 0, model: thread.model });
        }

        if (code === 0 && !terminalError) {
          store.updateThread(
            threadId,
            {
              status: "done",
              sessionId: capturedSessionId,
              runStartedAt: null,
            },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, codexState);
          pushThreadsChanged();
          finishedFromStream = true;
          notifyRunTerminal(
            threadId,
            "done",
            lastAssistantText(threadId, runId),
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
        pushDetail(threadId, codexState);
        pushThreadsChanged();
        void finishedFromStream;
        notifyRunTerminal(threadId, "failed", failure.text, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
      },
      onError: (err) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "codex") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, codexState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
      },
    });

    entry.handle = handle;
    if (handle && handle.pid) trackLiveCodexPid(handle.pid);
    store.save();
    pushDetail(threadId, codexState);

    return { runId };
  }

  return { startCodexRun };
}

module.exports = { createCodexRun };
