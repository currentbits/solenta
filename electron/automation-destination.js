"use strict";

/** Missing mode keeps legacy new-thread-per-run definitions unchanged. */
function destinationFields(input, base = {}) {
  const sessionMode = input.sessionMode === undefined
    ? (base.sessionMode || "new-thread") : input.sessionMode;
  if (!["new-thread", "continue", "fresh"].includes(sessionMode)) {
    throw new Error("Invalid automation session mode");
  }
  const raw = input.destinationThreadId === undefined
    ? base.destinationThreadId : input.destinationThreadId;
  const destinationThreadId = sessionMode === "new-thread" ? null : String(raw || "").trim();
  if (sessionMode !== "new-thread" && !destinationThreadId) {
    throw new Error("Destination thread is required");
  }
  return { sessionMode, destinationThreadId };
}

/** Save validates identity and authority; execution additionally requires an idle target. */
function destinationThread(store, auto, runner, staticOnly = false) {
  const { sessionMode, destinationThreadId } = destinationFields(auto);
  if (sessionMode === "new-thread") return null;
  const t = store.getThread(destinationThreadId);
  if (!t || t.projectId !== auto.projectId) {
    throw new Error("Automation destination must exist in its project");
  }
  if (t.archived || t.trashedAt || t.deletedAt || t.teleportedTo ||
      t.memoryConsolidate || t.ask || t.pendingFork) {
    throw new Error("Automation destination is unavailable");
  }
  if (!staticOnly && (runner?.isRunning?.(t.id) ||
      t.status === "working" || t.status === "quota-wait" ||
      t.quotaWaitUntil || t.quotaFailoverPending || t.pendingPlan ||
      t.pendingQuestion || t.pendingApproval || t.pendingSecret || t.awaitingInput ||
      t.runQueue || t.queued || t.interruptedAt || t.btw?.length ||
      runner?.getPendingPermission?.(t.id))) {
    throw Object.assign(
      new Error("Automation destination has unfinished work or pending input; run skipped"),
      { code: "AUTOMATION_DESTINATION_BUSY" },
    );
  }
  // Fixed destinations retain identity, but cannot lend their additional authority.
  if (t.provider !== auto.provider || (t.model || null) !== (auto.model || null) ||
      t.providerInstance || t.agentProfileId || t.autoApprove ||
      (t.permissionMode && t.permissionMode !== "default") ||
      t.folderWriteGrants?.length || t.restartGrant || t.alwaysAllowKeys?.length ||
      t.alwaysAllowRules?.length || t.route || auto.tier) {
    throw new Error("Automation destination must match provider/model with default permissions, no account override, grants, or routing");
  }
  if (!staticOnly && t.freshContextPending && sessionMode !== "fresh") {
    throw new Error("Automation destination is waiting for a user message after fresh context");
  }
  return t;
}

module.exports = { destinationFields, destinationThread };
