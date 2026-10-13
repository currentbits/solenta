"use strict";

// Project opt-in `autoPr`: when a worktree thread's turn finishes, push its
// branch and open a ready-for-review PR, or refresh the open one. Runs after
// the turn's checkpoint commit (and a passing verify), so the PR carries
// everything the turn changed. createPr keeps its own guards: secret scan,
// the prDiffCapLines size cap and "no commits ahead".

const NOTE = "Auto PR";

/**
 * Never throws: a PR failure must not touch the run lifecycle.
 *
 * @param {object} opts
 * @param {any} opts.store
 * @param {string} opts.threadId
 * @param {(threadId: string, role: string, text: string) => void} opts.appendMessage
 * @param {() => void} [opts.onChange] push detail / threads after a write
 * @param {(opts: any) => Promise<{ url: string, created: boolean }>} [opts.createPr] seam for tests
 */
async function maybeAutoPr(opts) {
  const { store, threadId, appendMessage, onChange } = opts;
  try {
    const thread = store.getThread(threadId);
    if (!thread || !thread.worktreePath) return null;
    const project = store.getProject(thread.projectId);
    if (!project || project.autoPr !== true) return null;
    const createPr = opts.createPr || require("./worktrees.js").createPr;
    let pr;
    try {
      pr = await createPr({
        store,
        threadId,
        title: thread.title,
        body:
          "Opened automatically by Solenta when this thread finished a turn " +
          "(project setting: Open a pull request when a thread finishes).",
        draft: false,
      });
    } catch (err) {
      const msg = String((err && err.message) || err);
      // A turn that changed nothing is not news.
      if (/no commits ahead/.test(msg)) return null;
      note(`${NOTE} not opened: ${msg}`);
      return null;
    }
    if (pr && pr.created) note(`${NOTE} opened: ${pr.url}`);
    else if (onChange) onChange();
    return pr;
  } catch {
    return null;
  }

  /** One event per distinct outcome, so a standing error is not repeated every turn. */
  function note(text) {
    const msgs = store.getMessages(threadId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "event" || !String(m.text).startsWith(NOTE)) continue;
      if (m.text === text) return;
      break;
    }
    appendMessage(threadId, "event", text);
    if (onChange) onChange();
  }
}

module.exports = { maybeAutoPr };
