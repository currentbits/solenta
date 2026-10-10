"use strict";

// createRunner seam: Claude (and Grok) provider run (#1447, seam 11).
// Follows the seam convention in the header of electron/runner-watchdogs.js.

const { getProvider, resolveBin, modelSupportsFast } = require("./providers.js");
const {
  truncate,
  INPUT_TRUNCATE,
  toolSummary,
  flattenContent,
  OUTPUT_TRUNCATE,
  runClaude,
} = require("./claude.js");
const { threadInstanceEnv, threadProviderRef } = require("./providerInstances.js");
const { randomUUID, createHash } = require("node:crypto");
const { grokGuardrailNotice } = require("./grok-guardrail-hook.js");
const {
  getClaudeMcpArgs,
  kimiMcpServersForRun,
  ensureGrokMcpConfig,
  whenGrokMcpIdle,
  mergeGrokSpawnEnv,
} = require("./memory-sup.js");
const {
  deployGrokGuardrailOverlay,
  materializeGrokHome,
} = require("./grok.js");
const path = require("node:path");
const threadSecrets = require("./threadSecrets.js");
const { classifyTool } = require("./guardrails.js");
const { isMemoryConsolidateTool } = require("./memory-consolidate.js");
const { saveToolImages, extractImages } = require("./tool-images.js");
const fs = require("node:fs");
const { recordCompaction } = require("./compaction.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createClaudeRun(ctx) {
  const {
    assertProviderBinary,
    PUSH_THROTTLE_MS,
    THINKING_TRUNCATE,
    crossesBoundary,
    resolveSpawn,
    unwrapStreamEvent,
    isPhantomClaudeResult,
    assignContextUsage,
    claudeContextTokens,
    reportedModelUsageWindow,
    classifyClaudeResultError,
    formatRunExitError,
    trackLiveClaudeChild,
    abortIfCancelled,
    store,
    beginWorkLogStep,
    stampPreparingSteps,
    pushThreadsChanged,
    pushDetail,
    appendMessage,
    savePlanSteps,
    askUser,
    addSubagentRow,
    userDataPath,
    completeWorkLogStep,
    markRunFailed,
    appendDoneWorkLog,
    notifyRunTerminal,
    clearRun,
    claimPreparingRun,
    settleCancelledLaunch,
    active,
    scheduleClaudeIdleReap,
    ingestTaskNotifications,
    ingestSubagentEvent,
    setSubagentStatus,
    noteToolSpan,
    lastAssistantText,
    otel,
    claudeSessions,
    launchWasCancelled,
    CLAUDE_ACK_MS,
    disposeClaudeSession,
    finishRunningSubagents,
  } = ctx;
  /** Threads already told Claude refused fast mode (#1529). */
  const fastRefusedNoted = new Set();

  /**
   * Start a Claude Code stream-json session turn.
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} [providerEntry]
   */
  async function startClaudeRun(threadId, prompt, runId, providerEntry) {
    if (abortIfCancelled(threadId, runId)) return { runId };
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    const entryDef = providerEntry || getProvider("claude");
    assertProviderBinary(entryDef, project);

    const claudeState = {
      __claude: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");
    stampPreparingSteps(threadId, runId, { startingId, workingId });

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, claudeState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** tool_use id -> message id */
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    /** Tool ids we already posted a #812 Guardrail event for. */
    const grokGuardrailNoticed = new Set();
    /** @type {string | null} */
    let capturedModel = null;
    /** @type {string | null} */
    let capturedSessionId = thread.sessionId || null;
    let sawResult = false;
    let sawTurnContent = false;
    /** @type {object | null} */
    let heldPhantom = null;
    /** Run-local usage for memory footers (not cumulative store totals). */
    const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

    function discardHeldPhantom() {
      heldPhantom = null;
    }

    function markTurnContent() {
      sawTurnContent = true;
      discardHeldPhantom();
    }

    /** @type {string | null} */
    let thinkingMsgId = null;
    /** @type {string} */
    let thinkingText = "";
    let partialText = false;
    let partialThinking = false;
    /** @type {Map<number, { toolId: string, json: string, name: string }>} */
    const partialTools = new Map();
    /** @type {ReturnType<typeof setTimeout> | null} */
    let partialPushTimer = null;

    function schedulePartialPush() {
      if (partialPushTimer) return;
      partialPushTimer = setTimeout(() => {
        partialPushTimer = null;
        if (!guard()) return;
        store.save();
        pushDetail(threadId, claudeState);
      }, PUSH_THROTTLE_MS);
    }

    function flushPartialPush() {
      if (partialPushTimer) {
        clearTimeout(partialPushTimer);
        partialPushTimer = null;
      }
      store.save();
      pushDetail(threadId, claudeState);
    }

    function upsertThinking() {
      const text = truncate(thinkingText, THINKING_TRUNCATE);
      const body = text || "Thinking…";
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

    function formatToolInput(input) {
      if (typeof input === "string") return truncate(input, INPUT_TRUNCATE);
      try {
        return truncate(JSON.stringify(input, null, 2), INPUT_TRUNCATE);
      } catch {
        return truncate(String(input), INPUT_TRUNCATE);
      }
    }

    /**
     * Create or update a tool card. Side effects (todos, questions, subagents)
     * run only when the row is first created.
     * @param {{ id?: unknown, name?: unknown, input?: unknown }} block
     * @returns {string}
     */
    function ingestToolUse(block) {
      const toolId = String(block.id || randomUUID());
      const toolName = String(block.name || "tool");
      const inputRaw = block.input != null ? block.input : {};
      const inputObj =
        inputRaw && typeof inputRaw === "object" && !Array.isArray(inputRaw)
          ? inputRaw
          : {};
      const inputStr = formatToolInput(inputRaw);
      const summary = toolSummary(
        toolName,
        inputRaw && typeof inputRaw === "object" ? inputRaw : {},
      );
      const existingId = toolMsgById.get(toolId);
      if (existingId) {
        const existing = store
          .getMessages(threadId)
          .find((m) => m.id === existingId);
        if (existing && existing.tool) {
          store.updateMessage(threadId, existingId, {
            text: summary,
            tool: { ...existing.tool, name: toolName, input: inputStr },
          });
        }
        if (toolName === "TodoWrite") {
          savePlanSteps(threadId, inputObj.todos);
        }
        if (toolName === "ask_user_question") {
          try {
            askUser({ threadId, questions: inputObj.questions });
          } catch {
            // Unanswerable shape: the tool card still shows what was asked.
          }
        }
        return toolId;
      }
      markTurnContent();
      const tool = {
        id: toolId,
        name: toolName,
        input: inputStr,
        output: null,
        isError: false,
        done: false,
      };
      const msgId = appendMessage(threadId, "tool", summary, runId, tool);
      toolMsgById.set(toolId, msgId);
      if (entryDef.id === "grok" && !grokGuardrailNoticed.has(toolId)) {
        const notice = grokGuardrailNotice({
          toolName,
          input: inputObj,
          worktreePath: thread.worktreePath || project.path,
        });
        if (notice) {
          grokGuardrailNoticed.add(toolId);
          appendMessage(threadId, "event", notice, runId);
        }
      }
      if (toolName === "TodoWrite") {
        savePlanSteps(threadId, inputObj.todos);
      }
      if (toolName === "ask_user_question") {
        try {
          askUser({ threadId, questions: inputObj.questions });
        } catch {
          // Unanswerable shape: the tool card still shows what was asked.
        }
      }
      if (toolName === "Agent" || toolName === "Task") {
        addSubagentRow(threadId, {
          id: toolId,
          description:
            typeof inputObj.description === "string" && inputObj.description
              ? inputObj.description
              : summary,
          agentType:
            typeof inputObj.subagent_type === "string"
              ? inputObj.subagent_type
              : null,
          status: "running",
        });
      }
      assistantMsgId = null;
      assistantText = "";
      return toolId;
    }

    function upsertAssistantText() {
      if (!assistantText) return;
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(
          threadId,
          "assistant",
          assistantText,
          runId,
        );
      } else {
        store.updateMessage(threadId, assistantMsgId, { text: assistantText });
      }
    }

    /**
     * @param {object} p
     * @returns {boolean} true when consumed as a partial
     */
    function applyPartial(p) {
      if (!p || typeof p !== "object") return false;
      const ptype = p.type;
      if (ptype === "message_start") {
        thinkingMsgId = null;
        thinkingText = "";
        assistantMsgId = null;
        assistantText = "";
        partialText = false;
        partialThinking = false;
        return true;
      }
      if (ptype === "content_block_start") {
        const block = p.content_block && typeof p.content_block === "object"
          ? p.content_block
          : {};
        const index = p.index;
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          thinkingText =
            typeof block.thinking === "string" ? block.thinking : "";
          partialThinking = true;
          if (thinkingText) upsertThinking();
          flushPartialPush();
        } else if (block.type === "tool_use") {
          const toolId = ingestToolUse(block);
          partialTools.set(Number(index), {
            toolId,
            json: "",
            name: String(block.name || "tool"),
          });
          flushPartialPush();
        } else if (block.type === "text") {
          partialText = true;
          if (typeof block.text === "string" && block.text) {
            markTurnContent();
            assistantText += block.text;
            upsertAssistantText();
          }
          flushPartialPush();
        }
        return true;
      }
      if (ptype === "content_block_delta") {
        const delta = p.delta && typeof p.delta === "object" ? p.delta : {};
        const index = p.index;
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          partialThinking = true;
          thinkingText += delta.thinking;
          upsertThinking();
          markTurnContent();
          schedulePartialPush();
        } else if (delta.type === "text_delta" && typeof delta.text === "string") {
          partialText = true;
          if (delta.text) markTurnContent();
          assistantText += delta.text;
          upsertAssistantText();
          schedulePartialPush();
        } else if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          const slot = partialTools.get(Number(index));
          if (slot) {
            slot.json += delta.partial_json;
            let input = slot.json;
            try {
              input = JSON.parse(slot.json);
            } catch {
              // incomplete JSON: show the raw fragment
            }
            ingestToolUse({ id: slot.toolId, name: slot.name, input });
            schedulePartialPush();
          }
        }
        return true;
      }
      if (ptype === "content_block_stop") {
        const slot = partialTools.get(Number(p.index));
        if (slot && slot.json) {
          let input = slot.json;
          try {
            input = JSON.parse(slot.json);
          } catch {
            // keep raw
          }
          ingestToolUse({ id: slot.toolId, name: slot.name, input });
          partialTools.delete(Number(p.index));
          flushPartialPush();
        }
        return true;
      }
      if (ptype === "message_delta" || ptype === "message_stop") {
        return true;
      }
      return false;
    }

    const localCwd = thread.worktreePath || project.path;
    const binary = resolveBin(entryDef);
    const args = entryDef.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
      reasoningEffort: thread.reasoningEffort || null,
      webSearch: thread.webSearch === true,
      fast: thread.fast === true,
      forkSessionAt: thread.forkSessionAt || null,
    });
    // Claude runs interactively: prompt over stdin, permission prompts via
    // the control protocol. Other claude-stream providers (e.g. grok) keep
    // the argv prompt and their own MCP injection.
    const interactive = entryDef.id === "claude";
    const mcpArgs = getClaudeMcpArgs({
      projectPath: localCwd,
      projectId: thread.projectId,
      memoryOnly: thread.memoryConsolidate === true,
    });
    if (interactive) {
      // No trailing prompt in interactive argv, so appending is safe.
      args.push(...mcpArgs);
    }
    /** @type {NodeJS.ProcessEnv | undefined} */
    let grokHomeEnv;
    if (entryDef.id === "grok") {
      // Isolated GROK_HOME so this turn cannot inherit other projects'
      // MCP URLs or a user-global last-write-wins bind (issue #706).
      // Remote homes are deployed on the far side of SSH/WSL.
      if (userDataPath || crossesBoundary(project)) {
        try {
          const os = require("node:os");
          const dest = crossesBoundary(project)
            ? deployGrokGuardrailOverlay({
                project,
                threadId,
                sessionId: thread.sessionId || null,
              })
            : path.join(userDataPath, "grok-homes", threadId);
          if (!crossesBoundary(project)) {
            const sourceHome =
              process.env.GROK_HOME || path.join(os.homedir(), ".grok");
            materializeGrokHome({
              dest,
              sourceHome,
              sessionId: thread.sessionId || null,
              mcpServers: kimiMcpServersForRun({
                projectId: thread.projectId,
                projectPath: localCwd || project.path,
              }),
            });
          }
          grokHomeEnv = {
            GROK_HOME: dest,
            GROK_CLAUDE_MCPS_ENABLED: "false",
            GROK_CURSOR_MCPS_ENABLED: "false",
          };
        } catch (err) {
          completeWorkLogStep(threadId, startingId);
          completeWorkLogStep(threadId, workingId);
          const msg =
            "Grok MCP overlay failed: " +
            (err && err.message ? err.message : String(err));
          const failure = markRunFailed(threadId, msg, runId);
          appendDoneWorkLog(threadId, runId, "Run error");
          store.save();
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          notifyRunTerminal(threadId, "failed", failure.text);
          clearRun(threadId);
          return { runId };
        }
      } else {
        try {
          ensureGrokMcpConfig({
            projectPath: localCwd,
            projectId: thread.projectId,
          });
          await whenGrokMcpIdle();
        } catch {
          // Legacy path without userDataPath; failures stay on the MCP queue logs.
        }
      }
    }
    const spawn = resolveSpawn(project, binary, args, localCwd, grokHomeEnv);

    if (abortIfCancelled(threadId, runId)) return { runId };
    const entry = claimPreparingRun(threadId, runId, {
      kind: "claude",
      startingId,
      workingId,
      claudeState,
      runUsage,
      discardHeldPhantom,
      /**
       * Permission prompts awaiting a user decision, oldest first. Each is
       * { id, toolName, summary, input (pretty), rawInput (original object),
       *   guardrail?: { rule, reason } }.
       * Ephemeral: dies with the run entry; a killed CLI cannot be answered.
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
        return claudeState;
      },
      enumerable: true,
      configurable: true,
    });

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "claude") return null;
      return e;
    }

    /** Held empty leftover result never produced a turn. Surface a failure. */
    function failEmptyPhantom(ev) {
      sawResult = true;
      discardHeldPhantom();
      if (!guard()) return;
      completeWorkLogStep(threadId, startingId);
      completeWorkLogStep(threadId, workingId);
      if (ev && typeof ev.session_id === "string" && ev.session_id) {
        capturedSessionId = ev.session_id;
      }
      const failText = "Run error: no output from agent";
      const failure = markRunFailed(threadId, failText, runId, {
        sessionId: capturedSessionId,
      });
      appendDoneWorkLog(threadId, runId, "Run error");
      store.save();
      clearRun(threadId);
      scheduleClaudeIdleReap(threadId);
      pushDetail(threadId, claudeState);
      pushThreadsChanged();
      notifyRunTerminal(threadId, "failed", failure.text, {
        tokensIn: runUsage.tokensIn,
        tokensOut: runUsage.tokensOut,
        costUsd: runUsage.costUsd,
      });
    }

    /** Assigned below (reused or freshly spawned) before any event fires. */
    let handle;
    /** This turn was delivered to a kept-alive CLI instead of a new spawn. */
    let reused = false;
    /** Any event at all reached this turn (the CLI is really taking it). */
    let sawAnyEvent = false;
    /** The dead-reuse respawn below fires at most once per turn. */
    let respawned = false;

    function disarmAck() {
      const e = active.get(threadId);
      if (e && e.ackTimer) {
        clearTimeout(e.ackTimer);
        e.ackTimer = null;
      }
    }

    const onEvent = (ev) => {
        sawAnyEvent = true;
        disarmAck();
        const type = ev && ev.type;

        // Background-subagent task notifications can land between turns on a
        // kept-alive CLI (guard() is null then), so scan user text first.
        ingestTaskNotifications(threadId, ev, claudeState);
        // Background-subagent progress lands there too: fold it onto its row
        // before the guard drops it (#1522).
        ingestSubagentEvent(threadId, ev, claudeState);

        if (!guard()) {
          // Kept-alive CLI, no active turn (settling/idle): never leave a
          // permission request hanging or aborted — answer with an error the
          // agent can retry, distinct from a user deny ("Denied by user").
          if (type === "control_request" && ev.request_id && handle) {
            handle.respondError(
              String(ev.request_id),
              "No active turn in Solenta (run settling); retry on the next turn",
            );
          }
          return;
        }

        const partial = unwrapStreamEvent(ev);
        if (partial && applyPartial(partial)) return;

        if (type === "control_request") {
          const requestId = String(ev.request_id || "");
          const request = ev.request || {};
          if (request.subtype === "can_use_tool" && requestId) {
            const toolName = String(request.tool_name || "tool");
            const rawInput =
              request.input && typeof request.input === "object"
                ? request.input
                : {};
            let inputStr;
            try {
              inputStr = truncate(
                JSON.stringify(rawInput, null, 2),
                INPUT_TRUNCATE,
              );
            } catch {
              inputStr = truncate(String(rawInput), INPUT_TRUNCATE);
            }
            const e = guard();
            if (!e) return;
            markTurnContent();

            // #409: deny is answered here so an injected agent cannot
            // social-engineer a yes. classifyTool fails open; wrap anyway.
            /** @type {{ decision: string, rule: string | null, reason: string } | null} */
            let verdict = null;
            try {
              const live = store.getThread(threadId);
              const worktreePath =
                (live && live.worktreePath) ||
                (thread && thread.worktreePath) ||
                null;
              verdict = classifyTool({
                toolName,
                input: rawInput,
                worktreePath,
              });
            } catch {
              verdict = null;
            }

            if (verdict && verdict.decision === "deny") {
              const rule = verdict.rule || "policy";
              const reason = verdict.reason || "blocked";
              handle.respond(requestId, {
                behavior: "deny",
                message: `Blocked by Solenta guardrails (${rule}): ${reason}`,
              });
              appendMessage(
                threadId,
                "event",
                `Guardrail blocked ${toolName}: ${rule}: ${reason}`,
                e.runId,
              );
              store.save();
              pushDetail(threadId, claudeState);
              return;
            }

            if (
              thread.memoryConsolidate === true &&
              !isMemoryConsolidateTool(toolName)
            ) {
              handle.respond(requestId, {
                behavior: "deny",
                message:
                  "Memory consolidation may only call coder-memory tools",
              });
              appendMessage(
                threadId,
                "event",
                `Consolidation sandbox blocked ${toolName}`,
                e.runId,
              );
              store.save();
              pushDetail(threadId, claudeState);
              return;
            }

            const pending = {
              id: requestId,
              toolName,
              summary: toolSummary(toolName, rawInput),
              input: inputStr,
              rawInput,
            };
            if (verdict && verdict.decision === "ask") {
              pending.guardrail = {
                rule: verdict.rule,
                reason: verdict.reason,
              };
            }
            e.pendingPermissions.push(pending);
            if (e.pendingPermissions.length === 1) {
              // Run is now blocked on the user: flip the sidebar badge to
              // Waiting. touch: a prompt is real activity (drives unread).
              store.updateThread(
                threadId,
                { awaitingInput: true },
                { touch: true },
              );
              pushThreadsChanged();
            }
            pushDetail(threadId, claudeState);
          } else if (requestId) {
            // Unknown control request: answer so the CLI never hangs on us.
            handle.respondError(
              requestId,
              `Unsupported control request: ${String(request.subtype || "unknown")}`,
            );
          }
          return;
        }

        if (type === "system" && ev.subtype === "init") {
          if (typeof ev.session_id === "string" && ev.session_id) {
            capturedSessionId = ev.session_id;
            // The forked session (#158) has its own id now: the cut is spent.
            store.updateThread(threadId, {
              sessionId: ev.session_id,
              forkSessionAt: null,
            });
          }
          if (typeof ev.model === "string" && ev.model) {
            capturedModel = ev.model;
          }
          // #1529: Fast was asked for but the CLI refused (e.g.
          // extra_usage_disabled). Say so once per thread, not every turn.
          if (
            thread.fast === true &&
            ev.fast_mode_state === "off" &&
            modelSupportsFast(getProvider("claude"), thread.model) &&
            !fastRefusedNoted.has(threadId)
          ) {
            fastRefusedNoted.add(threadId);
            appendMessage(
              threadId,
              "event",
              `Fast mode is off for this run (${String(ev.fast_mode_disabled_reason || "not available")}).`,
            );
          }
          completeWorkLogStep(threadId, startingId);
          store.save();
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          return;
        }

        // Native compaction (manual `/compact` or auto). A manual compact's
        // result is an empty success, so this also keeps it from reading
        // as a phantom result.
        if (type === "system" && ev.subtype === "compact_boundary") {
          markTurnContent();
          const meta = ev.compact_metadata || {};
          recordCompaction({ store, appendMessage }, threadId, runId, {
            pre: meta.pre_tokens,
            post: meta.post_tokens,
            auto: meta.trigger === "auto",
          });
          store.save();
          pushDetail(threadId, claudeState);
          return;
        }

        // #1529: 2.1.283 answers an id it does not know with a synthetic
        // assistant carrying error "model_not_found". When our catalog lists
        // that id, the likely fix is a newer CLI, so say that.
        if (type === "assistant" && ev.error === "model_not_found") {
          const info = (getProvider("claude").modelInfo || []).find(
            (m) => m.id === thread.model,
          );
          if (info) {
            appendMessage(
              threadId,
              "event",
              `Update Claude Code to use ${info.label} (run \`claude update\`). This CLI does not offer ${info.id}, or your account cannot use it.`,
            );
          }
        }

        if (type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
          // Complete assistant restates streamed partials: replace, don't append.
          if (partialText) {
            assistantText = "";
            partialText = false;
          }
          if (partialThinking) {
            thinkingText = "";
            partialThinking = false;
          } else {
            thinkingMsgId = null;
            thinkingText = "";
          }
          for (const block of ev.message.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type === "text" && typeof block.text === "string") {
              if (block.text) markTurnContent();
              assistantText += block.text;
              upsertAssistantText();
              // Chain entry a message-level fork resumes at (#158).
              if (assistantMsgId && typeof ev.uuid === "string" && ev.uuid) {
                store.updateMessage(threadId, assistantMsgId, {
                  claudeUuid: ev.uuid,
                });
              }
            } else if (
              block.type === "thinking" ||
              block.type === "redacted_thinking"
            ) {
              markTurnContent();
              thinkingText +=
                block.type === "thinking" && typeof block.thinking === "string"
                  ? block.thinking
                  : "";
              upsertThinking();
            } else if (block.type === "tool_use") {
              ingestToolUse(block);
            }
          }
          store.save();
          pushDetail(threadId, claudeState);
          return;
        }

        if (type === "user" && ev.message && Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type !== "tool_result") continue;
            markTurnContent();
            const toolUseId = String(block.tool_use_id || "");
            // Subagent lifecycle: a sync Agent's result is its report →
            // done. A background launch acks with "Async agent launched"
            // and stays running until its task-notification (or CLI death).
            if (toolUseId) {
              if (block.is_error) {
                setSubagentStatus(threadId, toolUseId, "failed");
              } else if (
                !/async agent launched/i.test(flattenContent(block.content))
              ) {
                setSubagentStatus(threadId, toolUseId, "done");
              }
            }
            const msgId = toolMsgById.get(toolUseId);
            const existing = msgId
              ? store.getMessages(threadId).find((m) => m.id === msgId)
              : // Fall back: search messages for matching tool.id
                store
                  .getMessages(threadId)
                  .find(
                    (m) =>
                      m.role === "tool" && m.tool && m.tool.id === toolUseId,
                  );
            if (!existing || !existing.tool) continue;
            const output = truncate(
              flattenContent(block.content),
              OUTPUT_TRUNCATE,
            );
            // Screenshots and Read-of-an-image land here as base64 blocks;
            // keep the bytes on disk and the filenames in the message.
            const images = saveToolImages(
              userDataPath,
              extractImages(block.content),
              threadId,
            );
            store.updateMessage(threadId, existing.id, {
              tool: {
                ...existing.tool,
                output,
                isError: Boolean(block.is_error),
                done: true,
                ...(images.length ? { images } : {}),
              },
            });
            noteToolSpan(
              threadId,
              runId,
              existing.tool.id,
              existing.tool.name,
              block.is_error,
            );
          }
          store.save();
          pushDetail(threadId, claudeState);
          return;
        }

        if (type === "result") {
          if (partialPushTimer) {
            clearTimeout(partialPushTimer);
            partialPushTimer = null;
          }
          if (isPhantomClaudeResult(ev, sawTurnContent)) {
            if (heldPhantom) return;
            heldPhantom = ev;
            if (typeof ev.session_id === "string" && ev.session_id) {
              capturedSessionId = ev.session_id;
              store.updateThread(threadId, { sessionId: capturedSessionId });
              store.save();
            }
            return;
          }
          discardHeldPhantom();
          sawResult = true;
          if (!guard()) return;

          completeWorkLogStep(threadId, startingId);
          completeWorkLogStep(threadId, workingId);

          if (typeof ev.session_id === "string" && ev.session_id) {
            capturedSessionId = ev.session_id;
          }
          if (capturedSessionId) {
            store.updateThread(threadId, { sessionId: capturedSessionId });
          }

          // Accumulate usage
          const prev = store.getUsage(threadId) || {
            model: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            turns: 0,
          };
          const usage = ev.usage || {};
          const turnIn = Number(usage.input_tokens) || 0;
          const turnOut = Number(usage.output_tokens) || 0;
          const costDelta = Number(ev.total_cost_usd) || 0;
          runUsage.tokensIn += turnIn;
          runUsage.tokensOut += turnOut;
          runUsage.costUsd += costDelta;
          const inputTokens = prev.inputTokens + turnIn;
          const outputTokens = prev.outputTokens + turnOut;
          const costUsd = prev.costUsd + costDelta;
          const model =
            capturedModel || prev.model || null;
          const nextUsage = {
            model,
            inputTokens,
            outputTokens,
            costUsd,
            turns: prev.turns + 1,
          };
          // inputTokens stay billable (no cache). contextTokens is the full
          // prompt, or stays unset for Claude when cache fields are omitted
          // (#317). Grok is allowed to sum without those keys (#704).
          assignContextUsage(
            nextUsage,
            prev,
            claudeContextTokens(usage, {
              allowMissingCache: thread.provider === "grok",
            }),
            reportedModelUsageWindow(ev),
          );
          store.setUsage(threadId, nextUsage);
          if (costDelta > 0) {
            store.recordSpend(costDelta);
          }
          store.recordUsage({
            provider: threadProviderRef(thread),
            model,
            costUsd: costDelta,
            inputTokens: turnIn,
            cachedInputTokens: Number(usage.cache_read_input_tokens) || 0,
            cacheWriteTokens: Number(usage.cache_creation_input_tokens) || 0,
            outputTokens: turnOut,
            threadId,
            projectId: thread.projectId,
            projectName: store.getProject(thread.projectId)?.name,
            title: thread.title,
          });

          const ok = ev.subtype === "success";
          // Assistant text from stream, or fall back to result field
          // (skip when result merely repeats the last streamed bubble).
          // Error/cancel results are not assistant copy (#549).
          if (
            ok &&
            !assistantText &&
            typeof ev.result === "string" &&
            ev.result &&
            ev.result !== lastAssistantText(threadId, runId)
          ) {
            assistantText = ev.result;
            if (!assistantMsgId) {
              assistantMsgId = appendMessage(
                threadId,
                "assistant",
                assistantText,
                runId,
              );
            } else {
              store.updateMessage(threadId, assistantMsgId, {
                text: assistantText,
              });
            }
          }

          /** @type {"done" | "failed" | "stopped"} */
          let terminalStatus;
          /** @type {string} */
          let terminalText;
          if (ok) {
            store.updateThread(
              threadId,
              {
                status: "done",
                sessionId: capturedSessionId,
                runStartedAt: null,
                lastError: null,
              },
              { touch: true },
            );
            terminalStatus = "done";
            terminalText =
              assistantText ||
              (typeof ev.result === "string" ? ev.result : "") ||
              lastAssistantText(threadId, runId);
          } else {
            const classified = classifyClaudeResultError({
              errors: ev.errors,
              result: typeof ev.result === "string" ? ev.result : "",
              stderr:
                handle && typeof handle.getStderr === "function"
                  ? handle.getStderr()
                  : "",
            });
            if (classified.kind === "stop") {
              appendMessage(threadId, "event", "Run stopped", runId);
              appendDoneWorkLog(threadId, runId, "Run stopped");
              store.updateThread(
                threadId,
                {
                  status: "idle",
                  sessionId: capturedSessionId,
                  runStartedAt: null,
                },
                { touch: true },
              );
              terminalStatus = "stopped";
              terminalText =
                lastAssistantText(threadId, runId) || "Run stopped";
            } else {
              const failText = classified.text;
              const failure = markRunFailed(threadId, failText, runId, {
                sessionId: classified.sessionLost ? null : capturedSessionId,
              });
              appendDoneWorkLog(threadId, runId, "Run error");
              terminalStatus = "failed";
              terminalText = failure.text;
            }
          }

          store.save();
          // Free the thread slot immediately so the next turn can start;
          // onExit will no-op via the runId identity guard.
          clearRun(threadId);
          // Process stays alive (keepAlive); reap it if no turn reuses it.
          scheduleClaudeIdleReap(threadId);
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          notifyRunTerminal(threadId, terminalStatus, terminalText, {
            tokensIn: runUsage.tokensIn,
            tokensOut: runUsage.tokensOut,
            costUsd: runUsage.costUsd,
          });
          return;
        }
    };

    const onExit = ({ code, stderr, gotResult }) => {
        if (partialPushTimer) {
          clearTimeout(partialPushTimer);
          partialPushTimer = null;
        }
        disarmAck();
        if (heldPhantom) {
          failEmptyPhantom(heldPhantom);
          return;
        }
        const e = active.get(threadId);
        // Result already cleared this run, or a newer run owns the slot.
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "claude") return;

        // A kept-alive CLI can be on its way out when this turn's send()
        // lands: the write succeeds (EPIPE is async), nothing reads it, and
        // the exit that follows belongs to the PREVIOUS turn. Nothing of ours
        // ever reached the CLI, so respawn instead of failing a turn the
        // agent never saw. Once only, and never once output has arrived.
        if (reused && !respawned && !sawAnyEvent && !sawResult && !gotResult) {
          respawned = true;
          spawnForTurn();
          return;
        }

        clearRun(threadId);

        // If WE finalized on a result event, close the work-log and stop.
        // gotResult is not that proof: claude.js sets it for any result line
        // including a leftover empty one we deliberately did not finalize on,
        // and trusting it checkmarks both steps with no message, no status and
        // no notification — issue #17's silent black hole.
        if (sawResult) {
          completeWorkLogStep(threadId, e.startingId);
          completeWorkLogStep(threadId, e.workingId);
          store.save();
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          return;
        }

        // Nonzero (or any) exit without result: failed
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        const errText = formatRunExitError(code, stderr);
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, claudeState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
    };

    const onError = (err) => {
        if (partialPushTimer) {
          clearTimeout(partialPushTimer);
          partialPushTimer = null;
        }
        disarmAck();
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "claude") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, claudeState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
    };

    // Claude Code's own OTel metrics (issue #280): pointing it at the same
    // collector our spans go to beats standing up a receiver. Env-only, so a
    // warm CLI predates the setting — hence it joins the reuse key below.
    // undefined rather than {} when export is off: claude.js only replaces the
    // inherited env when this is set, and an empty replacement is not the same.
    // Named instance (#453): its config dir and env ride this child only.
    // Joins the reuse key through spawnEnv, so switching instance respawns.
    const claudeOtel = {
      ...(threadInstanceEnv(store.getSettings(), thread) || {}),
      ...otel.claudeEnv(),
    };
    const otelEnv = Object.keys(claudeOtel).length > 0 ? claudeOtel : undefined;
    const grokMerged =
      entryDef.id === "grok"
        ? mergeGrokSpawnEnv({ ...(otelEnv || {}), ...(grokHomeEnv || {}) })
        : otelEnv;
    // Secret request values (#1531) also join the reuse key: a new secret
    // respawns the warm CLI so the next turn sees it.
    const spawnEnv = threadSecrets.withEnv(
      threadId,
      grokMerged && Object.keys(grokMerged).length > 0 ? grokMerged : undefined,
    );

    // Reuse key: everything a spawn bakes into argv/env EXCEPT the session
    // id (--resume changes after turn one; the live process needs no resume).
    const sessionKey = JSON.stringify({
      cwd: localCwd,
      remote: project.remoteHost || null,
      binary,
      model: thread.model || null,
      permissionMode: thread.permissionMode || "default",
      reasoningEffort: thread.reasoningEffort || null,
      // --settings fastMode is argv: toggling Fast must respawn (#1529).
      fast: thread.fast === true,
      mcp: interactive ? mcpArgs : [],
      // The config path is stable; a warm process has already read its contents.
      mcpHash: interactive
        ? mcpArgs.filter((a) => a.startsWith("--mcp-config="))
          .map((a) => createHash("sha256").update(fs.readFileSync(a.slice("--mcp-config=".length))).digest("hex"))
        : [],
      otelEnv: spawnEnv || null,
    });

    const prevSess = claudeSessions.get(threadId);
    const prevChild =
      prevSess && prevSess.handle ? prevSess.handle.child : null;
    const prevAlive =
      prevChild && prevChild.exitCode === null && !prevChild.killed;

    /**
     * Spawn this turn's own CLI and take ownership of it. Also the respawn
     * path in onExit when a reused kept-alive process was already dying.
     */
    function spawnForTurn() {
      if (launchWasCancelled(threadId, runId)) return;
      if (interactive) {
        const sess = {
          handle: null,
          dispatch: { onEvent, onExit, onError },
          key: sessionKey,
          idleTimer: null,
        };
        claudeSessions.set(threadId, sess);
        handle = runClaude({
          binary: spawn.binary,
          args: spawn.args,
          prompt,
          cwd: spawn.cwd,
          permissionMode: thread.permissionMode || "default",
          sessionId: thread.sessionId || null,
          model: thread.model || null,
          interactive,
          keepAlive: true,
          envExtra: spawnEnv,
          onEvent: (ev) => sess.dispatch.onEvent(ev),
          onExit: (info) => {
            // Process death always retires the session, whatever turn (if
            // any) is current.
            if (claudeSessions.get(threadId) === sess) {
              if (sess.idleTimer) clearTimeout(sess.idleTimer);
              claudeSessions.delete(threadId);
              // A crashed CLI takes its background subagents with it.
              finishRunningSubagents(threadId);
            }
            sess.dispatch.onExit(info);
          },
          onError: (err) => sess.dispatch.onError(err),
        });
        sess.handle = handle;
      } else {
        // Non-interactive claude-stream (e.g. grok): unchanged per-turn CLI.
        handle = runClaude({
          binary: spawn.binary,
          args: spawn.args,
          prompt,
          cwd: spawn.cwd,
          permissionMode: thread.permissionMode || "default",
          sessionId: thread.sessionId || null,
          model: thread.model || null,
          interactive,
          envExtra: spawnEnv,
          onEvent,
          onExit,
          onError,
        });
      }
      trackLiveClaudeChild(handle.child);
      const own = active.get(threadId);
      if (own && own.runId === runId) own.handle = handle;
    }

    if (abortIfCancelled(threadId, runId)) return { runId };
    if (interactive && prevSess && prevAlive && prevSess.key === sessionKey) {
      // Same params, live process: deliver the turn on its stdin. Background
      // tasks from earlier turns keep running; the CLI reports their
      // completion within this session.
      if (prevSess.idleTimer) {
        clearTimeout(prevSess.idleTimer);
        prevSess.idleTimer = null;
      }
      prevSess.dispatch = { onEvent, onExit, onError };
      handle = prevSess.handle;
      reused = handle.send(prompt);
      if (reused) {
        // A reused process emits no second system/init; close the step now.
        completeWorkLogStep(threadId, startingId);
        // ponytail: any line from the CLI counts as the ACK (we deliberately
        // do not correlate per-turn uuids), so a stray background
        // task-notification from an earlier turn could satisfy it and mask
        // a hang (fail-safe direction). Upgrade path is the
        // command_lifecycle correlation id (set uuid on the user line in
        // electron/claude.js sendUser, match command_uuid) if that ever
        // matters.
        const own = active.get(threadId);
        if (own && own.runId === runId) {
          const ackMs = Number(process.env.CODER_CLAUDE_ACK_MS) || CLAUDE_ACK_MS;
          own.ackTimer = setTimeout(() => {
            if (!guard()) return;
            if (sawAnyEvent || sawResult) return;
            disposeClaudeSession(threadId);
          }, ackMs);
          if (typeof own.ackTimer.unref === "function") own.ackTimer.unref();
        }
      }
    }
    if (!reused) {
      // Params changed (cwd/model/mode/effort/mcp), process gone, or its
      // stdin already closed (send failed): replace it.
      if (prevSess) disposeClaudeSession(threadId);
      spawnForTurn();
    }

    entry.handle = handle;
    store.save();
    pushDetail(threadId, claudeState);

    return { runId };
  }

  return { startClaudeRun };
}

module.exports = { createClaudeRun };
