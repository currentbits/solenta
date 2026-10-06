"use strict";

// createRunner seam: permission prompts, agent questions, persisted plan
// approvals, and the host-only CI workflow sign-off (#1447, seam 10). Follows
// the seam convention in the header of electron/runner-watchdogs.js.
// pushDetail (runner.js) calls getPendingPermission and startRun reads
// ciWorkflowSignOffs, both through this factory's return.

const { randomUUID } = require("node:crypto");
const services = require("./services.js");
const { truncate, INPUT_TRUNCATE } = require("./claude.js");
const { pendingFromInput } = require("./codexInput.js");
const {
  classifyServerRequest,
  pendingFromCommand,
  pendingFromMcp,
  approvalResponse,
  mapSolentaDecision,
  unsupportedError,
} = require("./codexApprovals.js");
const { getProvider, snapPermissionMode } = require("./providers.js");
const { classifyTool } = require("./guardrails.js");
const {
  extractCommand,
  resolveEditedCommand,
  sessionAllowRule,
} = require("./permissionCommand.js");
const { normalizeQuestions } = require("./questions.js");
const {
  PLAN_TRUNCATE,
  planText,
  questionInfo,
  replyCodexJsonRpc,
  replyCodexJsonRpcError,
} = require("./runnerHelpers.js");

/**
 * Approved plan kept on the thread for its plan card. Tighter than the prompt's
 * budget: this one rides every threads:changed push, for every thread.
 */
const PLAN_STORE = 4000;

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createPermissions(ctx) {
  const {
    store,
    active,
    appendMessage,
    pushDetail,
    pushThreadsChanged,
    refreshDetail,
    lastAssistantText,
    maybeDrainQueued,
    isAutoTurn,
  } = ctx;

  // Host-only, across turns. Restart fails closed and requires a fresh click;
  // neither agent-editable store data nor MCP arguments can mint a sign-off.
  const ciWorkflowSignOffs = new Map();
  /**
   * Threads whose live ExitPlanMode prompt was already answered this turn.
   * Blocks the post-run fallback card so a claude deny does not reopen a
   * "plan" made of the result string (issue #707).
   * @type {Set<string>}
   */
  const planPromptHandled = new Set();

  /**
   * Oldest unanswered permission prompt of the thread's active run, shaped
   * for the renderer (no rawInput), or null.
   * @param {string} threadId
   * @returns {{
   *   requestId: string,
   *   toolName: string,
   *   summary: string,
   *   input: string,
   *   command: string | null,
   *   questions: ReturnType<typeof questionInfo>,
   *   plan: ReturnType<typeof planText>,
   *   guardrail: { rule: string | null, reason: string } | null,
   * } | null}
   */
  function getPendingPermission(threadId) {
    const ci = ciWorkflowSignOffs.get(threadId);
    if (ci && !ci.approved) {
      return {
        requestId: ci.id, toolName: "CI workflow merge",
        summary: "Sign off the workflow patch and merge destination",
        input: ci.input, command: null, acceptAlways: false,
        questions: null, plan: null,
        guardrail: { rule: "CI_WORKFLOW", reason: "Accept signs off only this patch and destination, then resumes orchestration. Changes require a new sign-off." },
      };
    }
    const e = active.get(threadId);
    if (
      e &&
      (e.kind === "claude" || e.kind === "codex") &&
      Array.isArray(e.pendingPermissions)
    ) {
      const p = e.pendingPermissions[0];
      if (p) {
        return {
          requestId: p.id,
          toolName: p.toolName,
          summary: p.summary,
          input: p.input,
          command:
            p.command !== undefined ? p.command : extractCommand(p.rawInput),
          commandEditable: p.commandEditable !== false,
          acceptAlways: p.acceptAlways !== false,
          questions: questionInfo(p.toolName, p.rawInput),
          inputRequest: p.inputRequest || null,
          plan: planText(p.toolName, p.rawInput),
          guardrail: p.guardrail || null,
        };
      }
    }
    return pendingPlanAsPermission(threadId);
  }

  /**
   * Synthesize the live PlanPrompt shape from a persisted pendingPlan so
   * the renderer and respondPermission stay on one channel (issue #707).
   * @param {string} threadId
   */
  function pendingPlanAsPermission(threadId) {
    const thread = store.getThread(threadId);
    const pending = thread && thread.pendingPlan;
    if (!pending || typeof pending.plan !== "string" || !pending.plan) {
      return null;
    }
    return {
      requestId: String(pending.id || "plan"),
      toolName: "ExitPlanMode",
      summary: "Plan approval",
      input: "",
      command: null,
      questions: null,
      plan: pending.plan,
      guardrail: null,
    };
  }

  /**
   * Inbound Codex app-server ServerRequest (issue #1171). Command
   * kind=command becomes pendingPermission; unknown methods fail closed.
   * #1170 attaches this to the long-lived JSON-RPC session. Exec --json
   * never emits these.
   *
   * @param {string} threadId
   * @param {{ id?: unknown, method?: string, params?: unknown }} msg
   * @returns {boolean} true if this request is handled (replied or queued)
   */
  function handleCodexServerRequest(threadId, msg) {
    const e = active.get(threadId);
    const id = msg && Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
    const method = msg && typeof msg.method === "string" ? msg.method : "";
    if (!e || e.kind !== "codex" || e.stopping || !e.handle) {
      return false;
    }
    if (id === undefined || id === null) return false;

    const classified = classifyServerRequest(method, msg && msg.params);
    if (!["command", "mcp", "input"].includes(classified.action)) {
      try {
        replyCodexJsonRpcError(
          e,
          id,
          unsupportedError(classified.method, classified.reason),
        );
      } catch {
        return false;
      }
      return true;
    }

    let pending;
    try {
      pending = classified.action === "input" ? pendingFromInput(id, method, msg.params)
        : classified.action === "mcp" ? pendingFromMcp(id, msg.params) : pendingFromCommand(id, msg.params);
    } catch {
      replyCodexJsonRpcError(e, id, unsupportedError(method, `${method}: unsupported input schema or URL`));
      return true;
    }
    let inputStr = pending.input;
    try {
      inputStr = truncate(pending.input, INPUT_TRUNCATE);
    } catch {
      inputStr = pending.input;
    }
    pending.input = inputStr;

    /** @type {{ decision: string, rule: string | null, reason: string } | null} */
    let verdict = null;
    try {
      const live = store.getThread(threadId);
      const worktreePath = (live && live.worktreePath) || null;
      verdict = classifyTool({
        toolName: pending.toolName,
        input: pending.rawInput,
        worktreePath,
      });
    } catch {
      verdict = null;
    }

    if (verdict && verdict.decision === "deny") {
      const rule = verdict.rule || "policy";
      const reason = verdict.reason || "blocked";
      try {
        replyCodexJsonRpc(e, id, approvalResponse(pending.method,
          mapSolentaDecision("deny", pending.availableDecisions)));
      } catch {
        return false;
      }
      appendMessage(
        threadId,
        "event",
        `Guardrail blocked command: ${rule}: ${reason}`,
        e.runId,
      );
      store.save();
      pushDetail(threadId, e.codexState || null);
      return true;
    }

    if (verdict && verdict.decision === "ask") {
      pending.guardrail = {
        rule: verdict.rule,
        reason: verdict.reason,
      };
    }

    if (!Array.isArray(e.pendingPermissions)) e.pendingPermissions = [];
    e.pendingPermissions.push(pending);
    if (e.pendingPermissions.length === 1) {
      store.updateThread(threadId, { awaitingInput: true }, { touch: true });
      pushThreadsChanged();
    }
    store.save();
    pushDetail(threadId, e.codexState || null);
    return true;
  }

  function respondCodexPermission(e, threadId, input) {
    const { requestId, decision } = input || {};
    if (!Array.isArray(e.pendingPermissions)) {
      throw new Error("Permission request no longer pending");
    }
    const idx = e.pendingPermissions.findIndex((p) => p.id === requestId);
    if (idx < 0) {
      throw new Error("Permission request no longer pending");
    }
    const pending = e.pendingPermissions[idx];
    const mapped = mapSolentaDecision(decision, pending.availableDecisions);
    const content = pending.inputRequest && mapped === "accept" ? pending.validateInput(input.inputValues) : undefined;
    replyCodexJsonRpc(
      e,
      pending.rpcId !== undefined ? pending.rpcId : pending.id,
      approvalResponse(pending.method, mapped, content),
    );
    e.pendingPermissions.splice(idx, 1);
    const label =
      pending.inputRequest ? `${mapped === "accept" ? "Answered" : mapped === "cancel" ? "Cancelled" : "Declined"}: ${pending.summary}` : decision === "deny"
        ? `Denied: ${pending.summary}`
        : mapped === "acceptForSession"
          ? `Allowed for session: ${pending.summary}`
          : `Allowed: ${pending.summary}`;
    appendMessage(threadId, "event", label, e.runId);
    if (e.pendingPermissions.length === 0) {
      store.updateThread(threadId, { awaitingInput: false });
    }
    store.save();
    pushDetail(threadId, e.codexState || null);
    pushThreadsChanged();
  }

  /**
   * Answer a pending permission prompt. For question prompts, `answers`
   * (question text -> chosen label) rides back as updatedInput.answers.
   * `updatedCommand` (#509) replaces the shell command in updatedInput;
   * allow-always after an edit keys the session rule on the edited prefix.
   * Codex JSON-RPC ignores `updatedCommand` (the reply cannot rewrite the
   * command).
   * @param {{ threadId: string, requestId: string, decision: "allow" | "allowAlways" | "deny", answers?: Record<string, string>, updatedCommand?: string }} input
   */
  function respondPermission(input) {
    const { threadId, requestId, decision, answers, updatedCommand } =
      input || {};
    // "Keep planning" may carry the user's notes for the next plan (#1501).
    const feedback =
      decision === "deny" && input && typeof input.feedback === "string"
        ? input.feedback.trim()
        : "";
    const ci = ciWorkflowSignOffs.get(threadId);
    if (ci && !ci.approved && ci.id === requestId) {
      if (decision !== "allow" && decision !== "deny") {
        throw new Error("CI workflow sign-off requires a one-time Accept or Deny");
      }
      if (decision === "allow") {
        ci.approved = true;
        const r = ci.review;
        services.setQueued(store, { threadId, prompt:
          `I signed off the CI workflow patch from worker ${r.workerThreadId} (${r.sourceSha}) ` +
          `into ${r.destinationPath} on ${r.destinationBranch} (${r.destinationSha}). ` +
          `Resume thread_merge with approved:true, workerThreadId ${r.workerThreadId}, ` +
          `expectedPath ${JSON.stringify(r.destinationPath)}, expectedBranch ${JSON.stringify(r.destinationBranch)}. ` +
          "This approval covers only that worker and destination; changed inputs require fresh sign-off.",
        });
      } else {
        ciWorkflowSignOffs.delete(threadId);
      }
      appendMessage(threadId, "event", decision === "allow" ? "CI workflow merge signed off" : "CI workflow merge sign-off denied");
      store.updateThread(threadId, { awaitingInput: getPendingPermission(threadId) != null });
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      if (decision === "allow") maybeDrainQueued(threadId);
      return;
    }
    const e = active.get(threadId);
    if (!e || !e.handle) {
      return respondPersistedPlan(threadId, requestId, decision, feedback);
    }
    if (e.kind === "codex") {
      return respondCodexPermission(e, threadId, input);
    }
    if (e.kind !== "claude") {
      return respondPersistedPlan(threadId, requestId, decision, feedback);
    }
    const idx = e.pendingPermissions.findIndex((p) => p.id === requestId);
    if (idx < 0) {
      throw new Error("Permission request no longer pending");
    }
    const pending = e.pendingPermissions[idx];
    const resolved = resolveEditedCommand(pending.rawInput, updatedCommand);
    if (
      (decision === "allow" || decision === "allowAlways") &&
      resolved.field &&
      resolved.next === ""
    ) {
      throw new Error("Command cannot be empty");
    }
    e.pendingPermissions.splice(idx, 1);
    const answerMap =
      answers && typeof answers === "object" && !Array.isArray(answers)
        ? answers
        : null;
    const isPlan = pending.toolName === "ExitPlanMode";
    let response;
    if (decision === "allow" || decision === "allowAlways") {
      response = {
        behavior: "allow",
        updatedInput: answerMap
          ? { ...resolved.input, answers: answerMap }
          : resolved.input,
      };
      if (decision === "allowAlways") {
        // Unedited: whole-tool session rule (matches today's Accept all).
        // Edited: prefix of the *edited* command, never the original (#509).
        response.updatedPermissions = [
          sessionAllowRule(pending.toolName, resolved.next, {
            edited: resolved.edited,
          }),
        ];
      }
    } else {
      response = {
        behavior: "deny",
        message: isPlan
          ? "Plan rejected by user in Coder; keep planning" +
            (feedback ? `. User feedback on the plan:\n${feedback}` : "")
          : "Denied by user in Coder",
      };
    }
    e.handle.respond(pending.id, response);
    if (isPlan) planPromptHandled.add(threadId);
    if (isPlan && decision !== "deny") {
      const t = store.getThread(threadId);
      const patch = {};
      // The approved plan outlives this prompt: the thread's plan card shows
      // it once the prompt is answered and gone (issue #75).
      const approved = planText(pending.toolName, pending.rawInput);
      if (approved) patch.plan = truncate(approved, PLAN_STORE);
      // Approving the plan leaves plan mode, so the next run must not re-enter
      // it — the CLI only exits for the process that asked.
      if (t && t.permissionMode === "plan") patch.permissionMode = "default";
      if (t && Object.keys(patch).length > 0) {
        store.updateThread(threadId, patch);
      }
    }
    const label = isPlan
      ? decision === "deny"
        ? feedback
          ? `Plan rejected: ${truncate(feedback, 200)}`
          : "Plan rejected"
        : "Plan approved"
      : decision === "deny"
        ? `Denied: ${pending.summary}`
        : answerMap
          ? `Answered: ${truncate(Object.values(answerMap).join("; "), 200)}`
          : resolved.edited
            ? `${
                decision === "allowAlways"
                  ? "Allowed for session (edited)"
                  : "Allowed (edited)"
              }: ${truncate(resolved.original, 200)} → ${truncate(resolved.next, 200)}`
            : decision === "allowAlways"
              ? `Allowed for session: ${pending.summary}`
              : `Allowed: ${pending.summary}`;
    appendMessage(threadId, "event", label, e.runId);
    if (e.pendingPermissions.length === 0) {
      store.updateThread(threadId, { awaitingInput: false });
    }
    store.save();
    pushDetail(threadId, e.claudeState);
    pushThreadsChanged();
  }

  /**
   * Post an agent question that outlives the run (issue #647).
   *
   * claude asks over the permission channel and BLOCKS, so its questions ride
   * on the ephemeral pendingPermissions list. No other CLI can do that:
   * headless `grok -p` answers its own ask_user_question with "No user is
   * available", and `kimi -p` forbids its question tool outright. Their turn
   * therefore ENDS with the question unanswered, so it is persisted on the
   * thread and the answer arrives as the next turn (sessions resume, so the
   * agent still has its context). Cleared by startRun / setQueued: any user
   * message supersedes the card.
   *
   * @param {{ threadId: string, questions: unknown }} input
   * @returns {{ asked: true, questions: number }}
   */
  function askUser(input) {
    const threadId = String((input && input.threadId) || "");
    const thread = store.getThread(threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    const questions = normalizeQuestions(input && input.questions);
    if (!questions) {
      throw new Error(
        "questions must be a non-empty array of " +
          "{ question, options: [{ label, description }] }",
      );
    }
    store.updateThread(
      threadId,
      {
        pendingQuestion: {
          id: randomUUID(),
          questions,
          askedAt: Date.now(),
        },
        // Same badge as a permission prompt: the thread needs the user.
        awaitingInput: true,
      },
      { touch: true },
    );
    store.save();
    pushThreadsChanged();
    refreshDetail(threadId);
    return { asked: true, questions: questions.length };
  }

  /** Called only by the host merge guard; renderer respondPermission grants it. */
  function requestCiWorkflowSignOff(threadId, review) {
    const key = JSON.stringify(review);
    const previous = ciWorkflowSignOffs.get(threadId);
    if (previous?.key === key) {
      if (!previous.approved || isAutoTurn(threadId)) return false;
      ciWorkflowSignOffs.delete(threadId); // Single use, including failed merges.
      return true;
    }
    const input = `Worker: ${review.workerThreadId}\nSource: ${review.sourceBranch} (${review.sourceSha})\n` +
      `Destination: ${review.destinationPath}\nBranch: ${review.destinationBranch} (${review.destinationSha})\n` +
      `Workflow files: ${review.files.join(", ")}\n\n${review.patch || "(No net workflow change at this destination.)"}`;
    ciWorkflowSignOffs.set(threadId, { id: randomUUID(), key, review, input, approved: false });
    store.updateThread(threadId, { awaitingInput: true });
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();
    return false;
  }

  /**
   * Drop the question card without answering it (the Dismiss button).
   * @param {{ threadId: string }} input
   */
  function clearQuestion(input) {
    const threadId = String((input && input.threadId) || "");
    const thread = store.getThread(threadId);
    if (!thread || !thread.pendingQuestion) return;
    store.updateThread(threadId, {
      pendingQuestion: null,
      awaitingInput: false,
    });
    store.save();
    pushThreadsChanged();
    refreshDetail(threadId);
  }

  /**
   * After a plan-mode turn with no ExitPlanMode prompt, persist the last
   * assistant text as an approval card (issue #707).
   * @param {string} threadId
   * @param {string} [text]
   */
  function maybePersistPlanApproval(threadId, text) {
    if (planPromptHandled.has(threadId)) {
      planPromptHandled.delete(threadId);
      return;
    }
    const thread = store.getThread(threadId);
    if (!thread) return;
    if (thread.permissionMode !== "plan") return;
    if (thread.pendingQuestion) return;
    // Prefer this turn's last assistant message. A cancelled turn with no
    // new prose must not reuse an earlier answer, and notifyRunTerminal's
    // fallback label "Run stopped" is not a plan (issue #707).
    const msgs = store.getMessages(threadId) || [];
    let thisRunId;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        thisRunId = msgs[i].runId;
        break;
      }
    }
    const fromMsgs = String(lastAssistantText(threadId, thisRunId) || "").trim();
    const fromNotify = String(text || "").trim();
    const plan =
      fromMsgs ||
      (fromNotify && fromNotify !== "Run stopped" ? fromNotify : "");
    if (!plan) return;
    store.updateThread(
      threadId,
      {
        pendingPlan: {
          id: randomUUID(),
          plan: truncate(plan, PLAN_TRUNCATE),
          askedAt: Date.now(),
        },
        awaitingInput: true,
      },
      { touch: true },
    );
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();
  }

  /**
   * Answer a persisted plan card. Same decisions as ExitPlanMode: allow
   * stores the plan and leaves plan mode; deny keeps planning.
   * @param {string} threadId
   * @param {string} requestId
   * @param {string} decision
   * @param {string} [feedback] - deny only: sent as the next planning turn
   */
  function respondPersistedPlan(threadId, requestId, decision, feedback = "") {
    const thread = store.getThread(threadId);
    const pending = thread && thread.pendingPlan;
    if (
      !pending ||
      String(pending.id) !== String(requestId) ||
      typeof pending.plan !== "string" ||
      !pending.plan
    ) {
      throw new Error("No active agent run for this thread");
    }
    /** @type {Record<string, unknown>} */
    const patch = {
      pendingPlan: null,
      awaitingInput: false,
    };
    const approved = decision !== "deny";
    if (approved) {
      patch.plan = truncate(pending.plan, PLAN_STORE);
      // Snap to a mode the provider honours: cursor has no asking "default"
      // (#177), so leaving plan lands on bypassPermissions there.
      if (thread.permissionMode === "plan") {
        patch.permissionMode = snapPermissionMode(
          getProvider(thread.provider),
          "default",
        );
      }
    }
    store.updateThread(threadId, patch);
    appendMessage(
      threadId,
      "event",
      approved ? "Plan approved" : "Plan rejected",
    );
    // No live CLI to hear the notes: they go first in line as the next
    // turn, still in plan mode, and the drain below sends them.
    if (!approved && feedback) {
      services.restoreQueuedHead(store, {
        threadId,
        taken: { prompt: feedback, items: [feedback] },
      });
    }
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();
    maybeDrainQueued(threadId);
  }

  return {
    ciWorkflowSignOffs,
    getPendingPermission,
    handleCodexServerRequest,
    respondPermission,
    askUser,
    requestCiWorkflowSignOff,
    clearQuestion,
    maybePersistPlanApproval,
  };
}

module.exports = { createPermissions };
