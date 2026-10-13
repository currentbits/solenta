/**
 * Project opt-in autoPr: a finished worktree turn opens or refreshes a PR.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { maybeAutoPr } = require("../autoPr.js");

function setup({ autoPr = true, worktreePath = "/wt/t1", prResult, prError } = {}) {
  const thread = { id: "t1", projectId: "p1", title: "Fix login", worktreePath };
  const project = { id: "p1", path: "/repo", ...(autoPr ? { autoPr: true } : {}) };
  const messages = [];
  const calls = [];
  const store = {
    getThread: (id) => (id === "t1" ? thread : null),
    getProject: (id) => (id === "p1" ? project : null),
    getMessages: () => messages,
  };
  const run = () =>
    maybeAutoPr({
      store,
      threadId: "t1",
      appendMessage: (_id, role, text) => messages.push({ role, text }),
      createPr: async (opts) => {
        calls.push(opts);
        if (prError) throw new Error(prError);
        return prResult || { url: "https://github.com/o/r/pull/7", created: true };
      },
    });
  return { run, calls, messages };
}

describe("maybeAutoPr", () => {
  it("opens a ready-for-review PR titled after the thread and notes it", async () => {
    const s = setup();
    await s.run();
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].title, "Fix login");
    assert.equal(s.calls[0].draft, false);
    assert.deepEqual(s.messages, [
      { role: "event", text: "Auto PR opened: https://github.com/o/r/pull/7" },
    ]);
  });

  it("refreshes an open PR silently", async () => {
    const s = setup({ prResult: { url: "u", created: false } });
    await s.run();
    assert.equal(s.calls.length, 1);
    assert.deepEqual(s.messages, []);
  });

  it("does nothing when the project is not opted in or the thread has no worktree", async () => {
    for (const opts of [{ autoPr: false }, { worktreePath: null }]) {
      const s = setup(opts);
      await s.run();
      assert.equal(s.calls.length, 0);
    }
  });

  it("stays quiet when there are no commits ahead of base", async () => {
    const s = setup({
      prError: "Branch has no commits ahead of main; nothing to propose in a pull request",
    });
    assert.equal(await s.run(), null);
    assert.deepEqual(s.messages, []);
  });

  it("notes a real failure once, not every turn, and never throws", async () => {
    const s = setup({ prError: "PR too large: 900 lines" });
    await s.run();
    await s.run();
    assert.deepEqual(s.messages, [
      { role: "event", text: "Auto PR not opened: PR too large: 900 lines" },
    ]);
  });
});
