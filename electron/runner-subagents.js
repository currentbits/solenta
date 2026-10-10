"use strict";

// createRunner seam: in-session subagent rows on the thread record (#1447,
// seam 4). Follows the seam convention in the header of
// electron/runner-watchdogs.js.

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createSubagents(ctx) {
  const { store, pushDetail, pushThreadsChanged } = ctx;

  function hasRunningSubagent(threadId) {
    return subagentRows(threadId).some((r) => r.status === "running");
  }

  /**
   * In-session subagents spawned via the Agent tool (issue #21). The CLI
   * runs them internally, so the only trace is its stream: the spawning
   * tool_use, its tool_result, and — for background agents — a later
   * <task-notification> user text. Rows live on the thread record (keyed by
   * tool_use id) so the Agents panel can list them; capped to the newest 20
   * so a long thread never accumulates unbounded rows.
   */
  const SUBAGENT_ROWS_MAX = 20;

  function subagentRows(threadId) {
    const thread = store.getThread(threadId);
    return thread && Array.isArray(thread.subagents) ? thread.subagents : [];
  }

  function addSubagentRow(threadId, row) {
    if (!store.getThread(threadId)) return;
    store.updateThread(threadId, {
      subagents: [...subagentRows(threadId), row].slice(-SUBAGENT_ROWS_MAX),
    });
  }

  /**
   * Cursor Task/Agent is the same in-CLI subagent as Claude's Agent tool
   * (issue #685). Track it on the thread so the Agents panel lists it as a
   * subagent instead of looking like the parent model.
   * @param {string} threadId
   * @param {{ id: string, name: string }} tool
   * @param {Record<string, unknown> | null} args
   * @param {"running" | "done" | "failed"} status
   */
  function noteCursorSubagent(threadId, tool, args, status) {
    if (tool.name !== "Task" && tool.name !== "Agent") return;
    const description =
      typeof args?.description === "string" && args.description
        ? args.description
        : tool.name;
    const agentType =
      typeof args?.subagent_type === "string"
        ? args.subagent_type
        : typeof args?.subagentType === "string"
          ? args.subagentType
          : null;
    const rows = subagentRows(threadId);
    if (!rows.some((r) => r.id === tool.id)) {
      addSubagentRow(threadId, {
        id: tool.id,
        description,
        agentType,
        status,
      });
      return;
    }
    if (status !== "running") {
      setSubagentStatus(threadId, tool.id, status);
    }
  }

  /** Flip a running row's status; false when no such row (not a subagent). */
  function setSubagentStatus(threadId, toolUseId, status) {
    const rows = subagentRows(threadId);
    if (!rows.some((r) => r.id === toolUseId && r.status === "running")) {
      return false;
    }
    store.updateThread(threadId, {
      subagents: rows.map((r) =>
        r.id === toolUseId ? { ...r, status } : r,
      ),
    });
    return true;
  }

  /**
   * A <task-notification> block pairs back to the Agent call that spawned
   * the finished background agent via its <tool-use-id>.
   */
  function applyTaskNotifications(threadId, text) {
    let changed = false;
    const blocks = text.matchAll(
      /<task-notification>([\s\S]*?)<\/task-notification>/g,
    );
    for (const [, body] of blocks) {
      const id = body.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
      if (!id) continue;
      const status = body.match(/<status>\s*([^<\s]+)\s*<\/status>/);
      const failed = status ? /fail|error|cancel|kill/i.test(status[1]) : false;
      changed =
        setSubagentStatus(threadId, id[1], failed ? "failed" : "done") ||
        changed;
    }
    return changed;
  }

  /**
   * Scan a stream-json user event for <task-notification> blocks and settle
   * matching running subagent rows. Claude keeps the CLI alive so these can
   * land between turns (guard() is null then). Cursor Task rows otherwise
   * stay running until tool_call/completed or run exit (#708).
   */
  function ingestTaskNotifications(threadId, ev, workflow) {
    if (!ev || ev.type !== "user" || !ev.message) return false;
    const c = ev.message.content;
    const texts =
      typeof c === "string"
        ? [c]
        : Array.isArray(c)
          ? c
              .filter(
                (b) =>
                  b && b.type === "text" && typeof b.text === "string",
              )
              .map((b) => b.text)
          : [];
    let changed = false;
    for (const t of texts) {
      if (t.includes("<task-notification>")) {
        changed = applyTaskNotifications(threadId, t) || changed;
      }
    }
    if (changed) {
      store.save();
      pushDetail(threadId, workflow);
      // Between turns nothing else pushes the list, and the sidebar files a
      // done thread with running subagents on Working until they settle.
      pushThreadsChanged();
      // The last one settled: an idle Claude CLI it pinned is reapable again
      // (#1443). Assigned onto ctx after this seam is built, so read lazily.
      if (!hasRunningSubagent(threadId) && ctx.scheduleClaudeIdleReap) {
        ctx.scheduleClaudeIdleReap(threadId);
      }
    }
    return changed;
  }

  /**
   * Live progress from a background subagent (#1522). The CLI reports it as
   * system task_started / task_progress / task_notification events keyed by
   * the spawning Agent call's tool_use_id (2.1.283), and stamps the agent's
   * own messages with parent_tool_use_id. Between turns these are the only
   * sign of life, so fold them onto the matching running row as `activity`
   * (the Agents panel's last-activity line) and settle on task_notification.
   * @returns {boolean} true when the event belonged to a running subagent
   */
  function ingestSubagentEvent(threadId, ev, workflow) {
    if (!ev || typeof ev !== "object") return false;
    const system = ev.type === "system";
    const id = system ? ev.tool_use_id : ev.parent_tool_use_id;
    if (typeof id !== "string" || !id) return false;
    const rows = subagentRows(threadId);
    const row = rows.find((r) => r.id === id && r.status === "running");
    if (!row) return false;
    if (system && ev.subtype === "task_notification") {
      setSubagentStatus(
        threadId,
        id,
        ev.status === "completed" ? "done" : "failed",
      );
      store.save();
      pushDetail(threadId, workflow);
      pushThreadsChanged();
      if (!hasRunningSubagent(threadId) && ctx.scheduleClaudeIdleReap) {
        ctx.scheduleClaudeIdleReap(threadId);
      }
      return true;
    }
    let text = null;
    if (system && (ev.subtype === "task_progress" || ev.subtype === "task_started")) {
      text =
        (typeof ev.summary === "string" && ev.summary) ||
        (typeof ev.last_tool_name === "string" && ev.last_tool_name
          ? `Using ${ev.last_tool_name}`
          : null);
    } else if (!system && ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      const tool = ev.message.content.findLast((b) => b && b.type === "tool_use");
      if (tool && typeof tool.name === "string") text = `Using ${tool.name}`;
    }
    if (text) {
      store.updateThread(threadId, {
        subagents: rows.map((r) =>
          r === row ? { ...r, activity: { text, at: Date.now() } } : r,
        ),
      });
      store.save();
      pushDetail(threadId, workflow);
    }
    return true;
  }

  /**
   * CLI death (idle reap, param change, thread delete, quit, crash) takes its
   * background subagents with it — settle any still-running rows so the
   * panel never shows a live badge for a dead agent. Killed work is
   * "failed", never "done" (#1443); a run that exits normally passes "done".
   * @param {string} threadId
   * @param {"done" | "failed"} [status]
   */
  function finishRunningSubagents(threadId, status = "failed") {
    if (!hasRunningSubagent(threadId)) return;
    store.updateThread(threadId, {
      subagents: subagentRows(threadId).map((r) =>
        r.status === "running" ? { ...r, status } : r,
      ),
    });
    store.save();
    pushDetail(threadId, null);
    pushThreadsChanged();
  }

  return {
    hasRunningSubagent,
    addSubagentRow,
    noteCursorSubagent,
    setSubagentStatus,
    ingestTaskNotifications,
    ingestSubagentEvent,
    finishRunningSubagents,
  };
}

module.exports = { createSubagents };
