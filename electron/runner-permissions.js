"use strict";

// createRunner seam: permission prompts, agent questions, persisted plan
// approvals, and the host-only CI workflow sign-off (#1447, seam 10). Follows
// the seam convention in the header of electron/runner-watchdogs.js.
// pushDetail (runner.js) calls getPendingPermission and startRun reads
// ciWorkflowSignOffs, both through this factory's return.

const { randomUUID, createHash } = require("node:crypto");
const services = require("./services.js");
const { truncate, INPUT_TRUNCATE } = require("./claude.js");
const { pendingFromInput } = require("./codexInput.js");
const {
  classifyServerRequest,
  pendingFromCommand,
  pendingFromFileChange,
  pendingFromMcp,
  pendingFromApproval,
  approvalResponse,
  mapSolentaDecision,
  unsupportedError,
} = require("./codexApprovals.js");
const { mapOpencodeDecision } = require("./opencodeApprovals.js");
const {
  getProvider,
  snapPermissionMode,
  planActSwitchNote,
} = require("./providers.js");
const { classifyTool } = require("./guardrails.js");
const { evaluate, threadPolicy } = require("./governance.js");
const { appendAudit } = require("./governanceAudit.js");
const {
  extractCommand,
  resolveEditedCommand,
  ruleLabel,
  sessionAllowRule,
} = require("./permissionCommand.js");
const { normalizeQuestions } = require("./questions.js");
const threadSecrets = require("./threadSecrets.js");
const { writeGrants } = require("./projectFolders.js");
const {
  PLAN_TRUNCATE,
  planText,
  questionInfo,
  replyCodexJsonRpc,
  replyCodexJsonRpcError,
  sanitizeAttachments,
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
    return pendingPermissionsFor(threadId)[0] || null;
  }

  /**
   * Every unanswered prompt of the thread, oldest first. The thread view
   * shows only the head; the approval inbox (#291) lists them all, and
   * respondPermission finds any of them by requestId.
   * @param {string} threadId
   */
  function pendingPermissionsFor(threadId) {
    const ci = ciWorkflowSignOffs.get(threadId);
    if (ci && !ci.approved) {
      if (ci.card) {
        return [{
          requestId: ci.id, toolName: ci.card.toolName, summary: ci.card.summary,
          input: ci.input, command: null, acceptAlways: false,
          questions: null, plan: null,
          guardrail: { rule: ci.card.rule, reason: ci.card.reason },
        }];
      }
      return [{
        requestId: ci.id, toolName: "CI workflow merge",
        summary: "Sign off the workflow patch and merge destination",
        input: ci.input, command: null, acceptAlways: false,
        questions: null, plan: null,
        guardrail: { rule: "CI_WORKFLOW", reason: "Accept signs off only this patch and destination, then resumes orchestration. Changes require a new sign-off." },
      }];
    }
    const e = active.get(threadId);
    if (
      e &&
      (e.kind === "claude" || e.kind === "codex" || e.kind === "opencode" || e.kind === "generic") &&
      Array.isArray(e.pendingPermissions) &&
      e.pendingPermissions.length > 0
    ) {
      return e.pendingPermissions.map(cardOf);
    }
    const saved = store.getThread(threadId)?.pendingApproval;
    if (saved && saved.card) {
      // The CLI that asked is gone: Allow resumes the session instead
      // (respondPersistedApproval), so no command edits or session rules.
      return [{
        ...saved.card,
        commandEditable: false,
        acceptAlways: false,
        folderGrant: null,
        restored: true,
      }];
    }
    const plan = pendingPlanAsPermission(threadId);
    return plan ? [plan] : [];
  }

  /**
   * The approval inbox (#291): every pending prompt across all threads,
   * tagged with its thread. Oldest thread run first; within a thread, the
   * provider's own order.
   */
  function listPendingApprovals() {
    const out = [];
    for (const t of store.getThreads()) {
      if (t.archived) continue;
      for (const p of pendingPermissionsFor(t.id)) {
        out.push({
          ...p,
          threadId: t.id,
          threadTitle: t.title,
          projectId: t.projectId,
          provider: t.provider,
          since: t.runStartedAt ?? t.updatedAt ?? null,
        });
      }
    }
    return out.sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
  }

  /** Renderer shape of one live prompt (no rawInput). */
  function cardOf(p) {
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
      fileChange: p.fileChange || null,
      plan: planText(p.toolName, p.rawInput),
      guardrail: p.guardrail || null,
      folderGrant: p.folderGrant || null,
      alwaysRules:
        p.suggestedRules && p.suggestedRules.length > 0
          ? p.suggestedRules.map((r) => ruleLabel(p.toolName, r))
          : null,
    };
  }

  /** Identity of one tool call, for the one-shot grant after a restart. */
  function actionKey(toolName, rawInput) {
    return createHash("sha256")
      .update(JSON.stringify([String(toolName), rawInput ?? null]))
      .digest("hex");
  }

  /**
   * Mirror the live head prompt onto the thread so a quit or crash cannot
   * lose it (issue #349). Runs from pushDetail, which every prompt change
   * already ends in. A card kept from an earlier run (a machine turn started
   * over it) is only replaced by a newer live ask, never cleared by this run.
   * MCP elicitations are skipped: their request dies with the MCP server.
   * @param {string} threadId
   */
  function syncPersistedApproval(threadId) {
    const e = active.get(threadId);
    if (!e || !Array.isArray(e.pendingPermissions)) return;
    const thread = store.getThread(threadId);
    if (!thread) return;
    const saved = thread.pendingApproval || null;
    const p = e.pendingPermissions[0];
    if (p && !p.inputRequest) {
      if (saved && saved.id === p.id) return;
      const card = cardOf(p);
      if (typeof card.command === "string") card.command = truncate(card.command, INPUT_TRUNCATE);
      if (card.fileChange) card.fileChange = { ...card.fileChange, diff: truncate(String(card.fileChange.diff || ""), PLAN_TRUNCATE) };
      delete card.inputRequest;
      store.updateThread(threadId, {
        pendingApproval: {
          id: p.id,
          runId: e.runId || null,
          askedAt: Date.now(),
          // Plans and questions need their answer, not a re-run: no grant.
          grantKey: card.plan || card.questions ? null : actionKey(p.toolName, p.rawInput),
          card,
        },
      });
      store.save();
    } else if (saved && saved.runId === (e.runId || null)) {
      store.updateThread(threadId, { pendingApproval: null });
      store.save();
    }
  }

  /**
   * After Allow on a restored card the agent re-issues the call; that exact
   * call runs without a second card. Spent by the first gated ask, match or
   * not, so it cannot linger into later work.
   * ponytail: claude + codex only; opencode re-asks once, add if it matters.
   * @param {string} threadId
   * @param {string} toolName
   * @param {unknown} rawInput
   * @returns {boolean}
   */
  function takeRestartGrant(threadId, toolName, rawInput) {
    const grant = store.getThread(threadId)?.restartGrant;
    if (!grant) return false;
    store.updateThread(threadId, { restartGrant: null });
    store.save();
    return grant === actionKey(toolName, rawInput);
  }

  /** Commands remembered per thread by Always allow; oldest drop first. */
  const ALWAYS_ALLOW_CAP = 50;

  /** Identity of an always-allowed command: tool + command text only. */
  function commandKey(toolName, command) {
    return createHash("sha256")
      .update(JSON.stringify([String(toolName), String(command).trim()]))
      .digest("hex");
  }

  /**
   * Always allow on a command also remembers that exact command on the
   * thread. The CLI's session rule alone is not enough: it dies with the
   * process (idle reap, restart, a settings respawn), and the CLI re-asks
   * some commands whatever the rule says (a `cd … && git …` compound, writes
   * outside the project). ponytail: exact text only; the CLI rule covers
   * variants while its process lives.
   * @param {string} threadId
   * @param {string} toolName
   * @param {string} command
   */
  function rememberAlwaysAllow(threadId, toolName, command) {
    const key = commandKey(toolName, command);
    const keys = store.getThread(threadId)?.alwaysAllowKeys;
    const prev = Array.isArray(keys) ? keys.filter((k) => k !== key) : [];
    store.updateThread(threadId, {
      alwaysAllowKeys: [...prev, key].slice(-ALWAYS_ALLOW_CAP),
    });
  }

  /**
   * Whether this ask is a command the user already always-allowed here.
   * @param {string} threadId
   * @param {string} toolName
   * @param {unknown} rawInput
   */
  function isAlwaysAllowed(threadId, toolName, rawInput) {
    const command = extractCommand(rawInput);
    if (!command || !command.trim()) return false;
    const keys = store.getThread(threadId)?.alwaysAllowKeys;
    return Array.isArray(keys) && keys.includes(commandKey(toolName, command));
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
   * kind=command and fileChange (#1189) become pendingPermission; unknown
   * methods fail closed.
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
    // The ask carries no diff (#1189): show the item/started fileChange
    // with the same itemId, or fail closed rather than approve blind.
    const changes =
      classified.action === "fileChange" && e.codexFileChanges
        ? e.codexFileChanges.get(msg.params && msg.params.itemId)
        : null;
    if (classified.action === "fileChange" && !changes) {
      replyCodexJsonRpcError(e, id, unsupportedError(method, `${method}: no item/started for itemId`));
      return true;
    }
    if (!["command", "fileChange", "approval", "mcp", "input"].includes(classified.action)) {
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

    const live = store.getThread(threadId);
    const worktreePath = (live && live.worktreePath) || null;
    // Display root: the run's cwd (codex.js runs in the project without a worktree).
    const runRoot = worktreePath || (live && store.getProject(live.projectId)?.path) || null;
    let pending;
    try {
      pending = classified.action === "input" ? pendingFromInput(id, method, msg.params)
        : classified.action === "fileChange" ? pendingFromFileChange(id, msg.params, changes, runRoot)
        : classified.action === "approval" ? pendingFromApproval(id, method, msg.params)
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
    // A file change is one Edit per touched path (and move target / grantRoot);
    // the worst verdict wins.
    const inputs = classified.action === "fileChange"
      ? [
          ...pending.rawInput.changes.flatMap((c) => [c.path, c.kind && c.kind.move_path]),
          pending.rawInput.grantRoot,
        ].filter((p) => typeof p === "string" && p).map((file_path) => ({ file_path }))
      : [pending.rawInput];
    try {
      for (const input of inputs) {
        const v = classifyTool({ toolName: pending.toolName, input, worktreePath });
        if (v && v.decision === "deny") { verdict = v; break; }
        if (v && v.decision === "ask" && !verdict) verdict = v;
      }
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

    if (!pending.inputRequest && takeRestartGrant(threadId, pending.toolName, pending.rawInput)) {
      replyCodexJsonRpc(e, id, approvalResponse(pending.method,
        mapSolentaDecision("allow", pending.availableDecisions), pending.grant));
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
    }
    // Every prompt: the approval inbox (#291) only hears threads:changed.
    pushThreadsChanged();
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
    const content = pending.inputRequest && mapped === "accept" ? pending.validateInput(input.inputValues) : pending.grant;
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
    // Codex's JSON-RPC reply has no room for a message (#1762): deny, then
    // queue the redirect so it runs as the next turn once this one ends.
    if (decision === "deny" && !pending.inputRequest && input && typeof input.redirect === "string" && input.redirect.trim()) {
      const redirect = input.redirect.trim();
      const redirectAttachments = sanitizeAttachments(input.attachments);
      appendMessage(threadId, "user", redirect, null, null, redirectAttachments);
      services.setQueued(store, {
        threadId,
        prompt: redirect,
        attachments: redirectAttachments || undefined,
        posted: true,
      });
    }
    if (e.pendingPermissions.length === 0) {
      store.updateThread(threadId, { awaitingInput: false });
    }
    store.save();
    pushDetail(threadId, e.codexState || null);
    pushThreadsChanged();
  }

  /**
   * opencode serve (#451): POST /permission/:id/reply; an ACP agent (#272):
   * session/request_permission's response. The prompt leaves the card now;
   * a failed reply is logged, and the turn's own error ends the run.
   */
  function respondOpencodePermission(e, threadId, input) {
    const { requestId, decision } = input || {};
    const pending = e.pendingPermissions.find((p) => p.id === requestId);
    if (!pending) throw new Error("Permission request no longer pending");
    const reply = mapOpencodeDecision(decision);
    e.pendingPermissions = e.pendingPermissions.filter((p) => p !== pending);
    const runId = e.runId;
    void e.handle.replyPermission(pending.id, reply).then((ok) => {
      if (ok) return;
      const who = e.kind === "generic" ? "The agent" : "OpenCode";
      appendMessage(threadId, "event", `${who} did not take the reply: ${pending.summary}`, runId);
      store.save();
      pushDetail(threadId, e.opencodeState || null);
    });
    appendMessage(
      threadId,
      "event",
      reply === "reject"
        ? `Denied: ${pending.summary}`
        : reply === "always"
          ? `Allowed for session: ${pending.summary}`
          : `Allowed: ${pending.summary}`,
      runId,
    );
    // opencode/ACP replies are once/always/reject only, no message (#1762):
    // deny, then queue the redirect for the next turn.
    if (reply === "reject" && input && typeof input.redirect === "string" && input.redirect.trim()) {
      const redirect = input.redirect.trim();
      const redirectAttachments = sanitizeAttachments(input.attachments);
      appendMessage(threadId, "user", redirect, null, null, redirectAttachments);
      services.setQueued(store, {
        threadId,
        prompt: redirect,
        attachments: redirectAttachments || undefined,
        posted: true,
      });
    }
    if (e.pendingPermissions.length === 0) {
      store.updateThread(threadId, { awaitingInput: false });
    }
    store.save();
    pushDetail(threadId, e.opencodeState || null);
    pushThreadsChanged();
  }

  /**
   * Answer a pending permission prompt. For question prompts, `answers`
   * (question text -> chosen label) rides back as updatedInput.answers.
   * `updatedCommand` (#509) replaces the shell command in updatedInput.
   * Allow-always on a command keys the session rule on `alwaysRule` (#479:
   * the user's glob, or "*" for the whole tool), else on the prefix of the
   * command that runs. Codex JSON-RPC ignores both (the reply cannot rewrite
   * the command; acceptForSession is Codex's own exact-command cache).
   * @param {{ threadId: string, requestId: string, decision: "allow" | "allowAlways" | "allowFolder" | "deny", answers?: Record<string, string>, updatedCommand?: string, alwaysRule?: string }} input
   */
  function respondPermission(input) {
    const { threadId, requestId, decision, answers, updatedCommand, alwaysRule } =
      input || {};
    // "Keep planning" may carry the user's notes for the next plan (#1501).
    const feedback =
      decision === "deny" && input && typeof input.feedback === "string"
        ? input.feedback.trim()
        : "";
    // Composer redirect (#1762): sending a normal message while a plain
    // tool-permission card is open declines it and hands the typed text to
    // the agent as the new direction, instead of queuing behind the card.
    // ThreadView only sets this on a plain card (no questions, no plan,
    // no inputRequest) — the deny branches below still re-check the pending
    // tool's shape before honouring it.
    const redirect =
      decision === "deny" && input && typeof input.redirect === "string"
        ? input.redirect.trim()
        : "";
    const ci = ciWorkflowSignOffs.get(threadId);
    if (ci && !ci.approved && ci.id === requestId) {
      if (decision !== "allow" && decision !== "deny") {
        throw new Error("CI workflow sign-off requires a one-time Accept or Deny");
      }
      if (decision === "allow" && ci.card) {
        ci.approved = true;
        services.setQueued(store, { threadId, prompt: ci.card.resume });
      } else if (decision === "allow") {
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
      const what = ci.card ? ci.card.toolName : "CI workflow merge";
      appendMessage(threadId, "event", decision === "allow" ? `${what} signed off` : `${what} sign-off denied`);
      store.updateThread(threadId, { awaitingInput: getPendingPermission(threadId) != null });
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      if (decision === "allow") maybeDrainQueued(threadId);
      return;
    }
    const e = active.get(threadId);
    const saved = store.getThread(threadId)?.pendingApproval;
    if (
      saved && saved.id === requestId &&
      !(e && Array.isArray(e.pendingPermissions) && e.pendingPermissions.some((p) => p.id === requestId))
    ) {
      return respondPersistedApproval(threadId, saved, decision, answers, feedback);
    }
    if (!e || !e.handle) {
      return respondPersistedPlan(threadId, requestId, decision, feedback);
    }
    if (e.kind === "codex") {
      return respondCodexPermission(e, threadId, input);
    }
    // An ACP custom CLI (#272) takes the same once/always/reject reply.
    if ((e.kind === "opencode" || e.kind === "generic") && Array.isArray(e.pendingPermissions)) {
      return respondOpencodePermission(e, threadId, input);
    }
    if (e.kind !== "claude") {
      return respondPersistedPlan(threadId, requestId, decision, feedback);
    }
    const idx = e.pendingPermissions.findIndex((p) => p.id === requestId);
    if (idx < 0) {
      throw new Error("Permission request no longer pending");
    }
    const pending = e.pendingPermissions[idx];
    if (pending.inputRequest) {
      // #173 MCP elicitation: the CLI expects { action, content? }.
      const action =
        decision === "cancel" ? "cancel" : decision === "deny" ? "decline" : "accept";
      // Throws (prompt stays pending) when the values fail the schema.
      const content =
        action === "accept" ? pending.validateInput(input.inputValues) : null;
      e.pendingPermissions.splice(idx, 1);
      e.handle.respond(pending.id, content ? { action, content } : { action });
      appendMessage(
        threadId,
        "event",
        `${action === "accept" ? "Answered" : action === "cancel" ? "Cancelled" : "Declined"}: ${pending.summary}`,
        e.runId,
      );
      if (e.pendingPermissions.length === 0) {
        store.updateThread(threadId, { awaitingInput: false });
      }
      store.save();
      pushDetail(threadId, e.claudeState);
      pushThreadsChanged();
      return;
    }
    // #514: "allowFolder" allows this edit and grants the whole secondary
    // folder for the rest of the thread (the next spawn drops its ask rule).
    if (decision === "allowFolder") {
      if (!pending.folderGrant) throw new Error("This request has no folder to grant");
      const t = store.getThread(threadId);
      const grants = writeGrants(t);
      if (!grants.includes(pending.folderGrant)) {
        store.updateThread(threadId, {
          folderWriteGrants: [...grants, pending.folderGrant],
        });
      }
      appendMessage(threadId, "event", `Writes allowed in ${pending.folderGrant}`, e.runId);
      return respondPermission({ ...input, decision: "allow" });
    }
    const resolved = resolveEditedCommand(pending.rawInput, updatedCommand);
    if (
      (decision === "allow" || decision === "allowAlways") &&
      resolved.field &&
      resolved.next === ""
    ) {
      throw new Error("Command cannot be empty");
    }
    const allowing = decision === "allow" || decision === "allowAlways";
    // #262: judge what will actually run, not what was asked. An edit that
    // now hits a deny (builtin, profile, or a path that will not
    // canonicalize) is refused even though the user clicked Allow.
    let recheck = null;
    let governed = false;
    if (pending.governance && allowing) {
      const live = store.getThread(threadId);
      const worktreePath = (live && live.worktreePath) || null;
      let builtin = null;
      try {
        builtin = classifyTool({
          toolName: pending.toolName,
          input: resolved.input,
          worktreePath,
        });
      } catch {
        builtin = null;
      }
      const gov = threadPolicy(store, threadId);
      governed = Boolean(gov.policy && gov.policy.rules.length);
      recheck = evaluate({
        toolName: pending.toolName,
        rawInput: resolved.input,
        worktreePath,
        policy: gov.policy,
        builtin,
        mcpRules: gov.mcpRules,
      });
      const audit = (row) =>
        appendAudit({
          threadId,
          profileId: gov.profileId,
          provider: String((live && live.provider) || "claude"),
          toolName: pending.toolName,
          actionHash: recheck.actionHash,
          declared: pending.governance.declared,
          rule: recheck.rule,
          layer: recheck.layer,
          ...row,
        });
      if (recheck.decision === "deny") {
        e.pendingPermissions.splice(idx, 1);
        const rule = recheck.rule || "policy";
        e.handle.respond(pending.id, {
          behavior: "deny",
          message: `Blocked by Solenta policy (${recheck.layer}: ${rule}): ${recheck.reason}`,
        });
        audit({
          executed: null,
          decision: "deny",
          reason: recheck.reason,
        });
        appendMessage(
          threadId,
          "event",
          `Governance blocked ${pending.toolName}: ${recheck.layer}: ${rule}: ${recheck.reason}`,
          e.runId,
        );
        if (e.pendingPermissions.length === 0) {
          store.updateThread(threadId, { awaitingInput: false });
        }
        store.save();
        pushDetail(threadId, e.claudeState);
        pushThreadsChanged();
        throw new Error(`Blocked by policy (${recheck.layer})`);
      }
      // Question / plan answers skip the matrix: not a governed decision.
      if (recheck.layer !== "builtin" || (builtin && builtin.decision === "ask")) {
        audit({
          executed: recheck.declared,
          decision: "allow",
          reason: "allowed by user",
        });
      }
    }
    e.pendingPermissions.splice(idx, 1);
    const answerMap =
      answers && typeof answers === "object" && !Array.isArray(answers)
        ? answers
        : null;
    const isPlan = pending.toolName === "ExitPlanMode";
    // Only the plain tool card redirects (#1762); a question card's deny
    // is the user dismissing it, not a new instruction.
    const redirectable = Boolean(redirect) && !isPlan && pending.toolName !== "AskUserQuestion";
    const redirectAttachments = redirectable ? sanitizeAttachments(input.attachments) : null;
    // Claude sees the redirect as the tool-denial reason and keeps going in
    // this same turn; attachments cannot ride that message, so they fall
    // back to the queued path like every other provider.
    const redirectInline =
      redirectable && !(redirectAttachments && redirectAttachments.length);
    let response;
    let ruleNote = "";
    if (decision === "allow" || decision === "allowAlways") {
      response = {
        behavior: "allow",
        updatedInput: answerMap
          ? { ...resolved.input, answers: answerMap }
          : resolved.input,
      };
      if (decision === "allowAlways" && recheck) {
        // A session grant cannot mute an always-confirm rule (#262).
        if (recheck.layer !== "profile.ask") {
          if (!e.sessionAllows) e.sessionAllows = new Set();
          e.sessionAllows.add(recheck.actionHash);
        }
      }
      // A governed thread keeps the CLI asking: a Claude session rule would
      // stop can_use_tool for that tool and skip the matrix next time.
      if (decision === "allowAlways" && !governed) {
        // The CLI's own per-subcommand rules for the unedited command, else
        // the prefix of the command that runs (the edit, never the original,
        // #509), unless the user typed a rule; whole tool only on "*" (#479).
        const rule = sessionAllowRule(
          pending.toolName,
          resolved.next,
          alwaysRule,
          resolved.edited ? undefined : pending.suggestedRules,
        );
        response.updatedPermissions = [rule];
        const labels = rule.rules.map((r) => ruleLabel(pending.toolName, r));
        ruleNote = ` (rule: ${truncate(labels.join(", "), 200)})`;
        if (resolved.field && resolved.next) {
          rememberAlwaysAllow(threadId, pending.toolName, resolved.next);
        }
      }
    } else {
      response = {
        behavior: "deny",
        message: isPlan
          ? "Plan rejected by user in Coder; keep planning" +
            (feedback ? `. User feedback on the plan:\n${feedback}` : "")
          : redirectInline
            ? `Denied by user in Coder; the user wants this instead:\n${redirect}`
            : "Denied by user in Coder",
      };
    }
    // A plan written on the plan model is implemented on the act model, in
    // this same live process and session (#1716). set_model goes ahead of
    // the allow so the CLI's next API call already uses it.
    const before = isPlan && decision !== "deny" ? store.getThread(threadId) : null;
    const switchNote = before
      ? planActSwitchNote(getProvider(before.provider), before)
      : null;
    if (switchNote && typeof e.handle.setModel === "function") {
      e.handle.setModel(before.model || null);
      e.handle.modelSwitchedTo = before.model || null;
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
              }: ${truncate(resolved.original, 200)} → ${truncate(resolved.next, 200)}${ruleNote}`
            : decision === "allowAlways"
              ? `Allowed for session: ${pending.summary}${ruleNote}`
              : `Allowed: ${pending.summary}`;
    appendMessage(threadId, "event", label, e.runId);
    if (switchNote) appendMessage(threadId, "event", switchNote, e.runId);
    if (redirectable) {
      if (redirectInline) {
        // Same turn, same runId: the model reads the redirect off the
        // tool-denial message above, so this is just the transcript row.
        appendMessage(threadId, "user", redirect, e.runId, null, redirectAttachments);
      } else {
        // No runId yet: mirrors appendInbound (runId null) until the queued
        // item actually starts its own turn.
        appendMessage(threadId, "user", redirect, null, null, redirectAttachments);
        services.setQueued(store, {
          threadId,
          prompt: redirect,
          attachments: redirectAttachments || undefined,
          posted: true,
        });
      }
    }
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

  /**
   * Ask the user for a secret (issue #1531, #289). Non-blocking like askUser.
   * Only the request (name, title, prompt) goes in the store; the value only
   * ever goes to threadSecrets (its own file, 24h).
   * @param {{ threadId: string, name: string, title?: string, prompt?: string }} input
   */
  function requestSecret(input) {
    const threadId = String((input && input.threadId) || "");
    if (!store.getThread(threadId)) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    const name = String((input && input.name) || "");
    if (!threadSecrets.NAME_RE.test(name)) {
      throw new Error("name must match /^[A-Z_][A-Z0-9_]*$/");
    }
    store.updateThread(
      threadId,
      {
        pendingSecret: {
          id: randomUUID(),
          name,
          title: truncate(String((input && input.title) || ""), 120),
          prompt: truncate(String((input && input.prompt) || ""), 500),
          askedAt: Date.now(),
        },
        awaitingInput: true,
      },
      { touch: true },
    );
    store.save();
    pushThreadsChanged();
    refreshDetail(threadId);
    return { requested: true, name };
  }

  /**
   * Answer (value) or dismiss (value null) the secret card. The value goes to
   * threadSecrets only; the transcript and the next turn see just the name.
   * @param {{ threadId: string, requestId: string, value: string | null }} input
   */
  function answerSecret(input) {
    const threadId = String((input && input.threadId) || "");
    const thread = store.getThread(threadId);
    const pending = thread && thread.pendingSecret;
    if (!pending || pending.id !== (input && input.requestId)) {
      throw new Error("No open secret request for this thread");
    }
    const value = input.value;
    store.updateThread(threadId, {
      pendingSecret: null,
      awaitingInput: Boolean(thread.pendingQuestion || thread.pendingPlan),
    });
    if (typeof value === "string" && value) {
      threadSecrets.set(threadId, pending.name, value);
      appendMessage(threadId, "event", `Secret ${pending.name} provided`);
      const note = `Secret ${pending.name} is now available as $${pending.name}`;
      services.restoreQueuedHead(store, {
        threadId,
        taken: { prompt: note, items: [note] },
      });
    } else {
      appendMessage(threadId, "event", `Secret ${pending.name} declined`);
    }
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();
    maybeDrainQueued(threadId);
  }

  /** Called only by the host merge guard; renderer respondPermission grants it. */
  function requestCiWorkflowSignOff(threadId, review) {
    const input = `Worker: ${review.workerThreadId}\nSource: ${review.sourceBranch} (${review.sourceSha})\n` +
      `Destination: ${review.destinationPath}\nBranch: ${review.destinationBranch} (${review.destinationSha})\n` +
      `Workflow files: ${review.files.join(", ")}\n\n${review.patch || "(No net workflow change at this destination.)"}`;
    return requestHostSignOff(threadId, review, input);
  }

  /**
   * pr_merge's sign-off (#1749), same host-only map: bound to thread, repo,
   * PR, method and head SHA. A moved head or another method opens a new card.
   * @param {string} threadId
   * @param {{ repo: string, number: number, title: string, method: string, headSha: string }} review
   */
  function requestPrMergeSignOff(threadId, review) {
    const input = `Repo: ${review.repo}\nPR: #${review.number} ${review.title}\n` +
      `Method: ${review.method}\nHead: ${review.headSha}`;
    const { repo, number, method, headSha } = review; // title is display-only
    return requestHostSignOff(threadId, { repo, number, method, headSha }, input, {
      toolName: "Merge pull request",
      summary: `Merge ${review.repo}#${review.number} (${review.method})`,
      rule: "PR_MERGE",
      reason: "Accept signs off one merge of this PR at this head commit with this method. A new push or another method needs a new sign-off.",
      resume: `I signed off merging ${review.repo}#${review.number} with ${review.method} at ${review.headSha}. ` +
        `Call pr_merge again with number ${review.number} and method ${review.method}.`,
    });
  }

  /**
   * True once: the user Accepted this exact review and this turn is
   * human-started. Otherwise (re)opens the card and returns false.
   */
  function requestHostSignOff(threadId, review, input, card) {
    const key = JSON.stringify(review);
    const previous = ciWorkflowSignOffs.get(threadId);
    if (previous?.key === key) {
      if (!previous.approved || isAutoTurn(threadId)) return false;
      ciWorkflowSignOffs.delete(threadId); // Single use, including failed merges.
      return true;
    }
    ciWorkflowSignOffs.set(threadId, { id: randomUUID(), key, review, input, approved: false, ...(card ? { card } : {}) });
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
    const switchNote = approved
      ? planActSwitchNote(getProvider(thread.provider), thread)
      : null;
    if (switchNote) appendMessage(threadId, "event", switchNote);
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

  /**
   * Answer a card whose CLI died with the app (issue #349). Allow resumes the
   * session with the decision as the next turn; the agent's re-ask of that
   * exact call passes once (takeRestartGrant). Deny just closes the card.
   * @param {string} threadId
   * @param {{ id: string, grantKey: string | null, card: ReturnType<typeof cardOf> }} saved
   * @param {string} decision
   * @param {Record<string, string> | undefined} answers
   * @param {string} feedback
   */
  function respondPersistedApproval(threadId, saved, decision, answers, feedback) {
    const thread = store.getThread(threadId);
    const { card } = saved;
    const approved = decision !== "deny";
    /** @type {Record<string, unknown>} */
    const patch = {
      pendingApproval: null,
      awaitingInput: Boolean(thread.pendingQuestion || thread.pendingPlan || thread.pendingSecret),
    };
    const answerList =
      answers && typeof answers === "object" && !Array.isArray(answers)
        ? Object.entries(answers).map(([q, a]) => `${q}: ${a}`)
        : [];
    let line = "";
    if (approved && card.plan) {
      patch.plan = truncate(card.plan, PLAN_STORE);
      if (thread.permissionMode === "plan") {
        patch.permissionMode = snapPermissionMode(getProvider(thread.provider), "default");
      }
      line = "[restart] The app restarted while your plan waited for approval. The user approved it: proceed with the plan.";
    } else if (approved && card.questions) {
      line = `[restart] The app restarted while your question waited. The user answered:\n${answerList.join("\n")}`;
    } else if (approved) {
      patch.restartGrant = saved.grantKey || null;
      line = `[restart] The app restarted while ${card.summary} waited for approval. The user approved it: make that exact ${card.toolName} call again now; it will run without asking.`;
    } else if (feedback) {
      line = feedback;
    }
    store.updateThread(threadId, patch);
    appendMessage(
      threadId,
      "event",
      card.plan
        ? approved ? "Plan approved" : "Plan rejected"
        : `${approved ? "Allowed" : "Denied"} after restart: ${card.summary}`,
    );
    const switchNote =
      approved && card.plan
        ? planActSwitchNote(getProvider(thread.provider), thread)
        : null;
    if (switchNote) appendMessage(threadId, "event", switchNote);
    if (line) {
      services.restoreQueuedHead(store, { threadId, taken: { prompt: line, items: [line] } });
    }
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();
    maybeDrainQueued(threadId);
  }

  return {
    ciWorkflowSignOffs,
    syncPersistedApproval,
    takeRestartGrant,
    isAlwaysAllowed,
    getPendingPermission,
    listPendingApprovals,
    handleCodexServerRequest,
    respondPermission,
    askUser,
    requestSecret,
    answerSecret,
    requestCiWorkflowSignOff,
    requestPrMergeSignOff,
    clearQuestion,
    maybePersistPlanApproval,
  };
}

module.exports = { createPermissions };
