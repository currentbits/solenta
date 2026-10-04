"use strict";

// createRunner seam: memory-server session recording (#1447, seam 5).
// Follows the seam convention in the header of electron/runner-watchdogs.js.
// The factory owns the recorder and returns it so stopAll and
// flushTranscripts can flush it.

const {
  createSessionRecorder,
  mapMessageRole,
} = require("./session-record.js");
const { shouldRecordSession } = require("./runnerHelpers.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createSessionRecording(ctx) {
  const { store, userDataPath, getMemStatus } = ctx;

  /** Batched session transcript recorder (POST /api/session). */
  const sessionRecorder = createSessionRecorder({
    userDataPath,
    getStatus: getMemStatus,
  });

  /**
   * Build base session fields from thread + project at record time.
   * @param {object} thread
   */
  function sessionBaseFields(thread) {
    const project = store.getProject(thread.projectId);
    return {
      sessionId: thread.id,
      // Raw repo path; the memory server canonicalizes it (see project-key.js there).
      project: project && project.path ? String(project.path) : null,
      threadTitle: thread.title != null ? String(thread.title) : "",
      agent: thread.provider != null ? String(thread.provider) : "unknown",
    };
  }

  /**
   * Record user/event messages immediately on append (batched HTTP).
   * Assistant/tool are deferred to run-terminal (see notifyRunTerminal).
   * @param {string} threadId
   * @param {string} role
   * @param {string} text
   */
  function recordSessionOnAppend(threadId, role, text) {
    try {
      if (role !== "user" && role !== "event") return;
      const thread = store.getThread(threadId);
      if (!shouldRecordSession(thread)) return;
      const mapped = mapMessageRole(role);
      if (!mapped) return;
      const content = text == null ? "" : String(text);
      if (!content) return;
      sessionRecorder.recordTranscript([
        {
          ...sessionBaseFields(thread),
          role: mapped,
          content,
        },
      ]);
    } catch {
      // never affect the run path
    }
  }

  /**
   * Record final assistant + tool messages for a run once at terminal.
   * @param {string} threadId
   * @param {string | null | undefined} runId
   * @param {object} thread
   */
  function recordSessionAtTerminal(threadId, runId, thread) {
    try {
      if (!shouldRecordSession(thread)) return;
      const base = sessionBaseFields(thread);
      const msgs = store.getMessages(threadId) || [];
      /** @type {object[]} */
      const entries = [];
      for (const m of msgs) {
        if (!m || (m.role !== "assistant" && m.role !== "tool")) continue;
        // Prefer this run's messages when runId is known.
        if (runId && m.runId && m.runId !== runId) continue;
        if (runId && !m.runId) continue;
        const mapped = mapMessageRole(m.role);
        if (!mapped) continue;
        const content = m.text == null ? "" : String(m.text);
        if (!content) continue;
        entries.push({
          ...base,
          role: mapped,
          content,
        });
      }
      if (entries.length > 0) {
        sessionRecorder.recordTranscript(entries);
      }
    } catch {
      // never affect the run path
    }
  }

  return {
    sessionRecorder,
    recordSessionOnAppend,
    recordSessionAtTerminal,
  };
}

module.exports = { createSessionRecording };
