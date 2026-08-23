/**
 * Issue #681: `/feedback` sender and IPC seam.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const feedback = require("../feedback.js");
const { IPC_HANDLERS } = require("../ipc.js");

/** @param {object} [opts] */
function fakeFetch(opts = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (opts.throws) throw new Error("network down");
    return {
      ok: opts.ok !== false,
      status: opts.status || 200,
      json: async () => opts.body || {},
    };
  };
  fn.calls = calls;
  return fn;
}

describe("sendFeedback", () => {
  it("posts the text with version and platform", async () => {
    const fetch = fakeFetch();
    await feedback.sendFeedback(
      { text: "  the sidebar flickers  ", version: "0.11.0", platform: "darwin" },
      { fetch },
    );
    assert.equal(fetch.calls.length, 1);
    const [{ url, init }] = fetch.calls;
    assert.equal(url, feedback.ENDPOINT);
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      text: "the sidebar flickers",
      version: "0.11.0",
      platform: "darwin",
    });
  });

  it("refuses an empty report before touching the network", async () => {
    const fetch = fakeFetch();
    await assert.rejects(
      () => feedback.sendFeedback({ text: "   " }, { fetch }),
      /Feedback is empty/,
    );
    assert.equal(fetch.calls.length, 0);
  });

  it("truncates at the cap the endpoint enforces", async () => {
    const fetch = fakeFetch();
    await feedback.sendFeedback({ text: "x".repeat(9999) }, { fetch });
    assert.equal(
      JSON.parse(fetch.calls[0].init.body).text.length,
      feedback.MAX_TEXT,
    );
  });

  it("turns a network failure into a sentence a person can read", async () => {
    await assert.rejects(
      () => feedback.sendFeedback({ text: "hi" }, { fetch: fakeFetch({ throws: true }) }),
      /Could not reach Solenta/,
    );
  });

  it("surfaces the endpoint's own refusal", async () => {
    await assert.rejects(
      () =>
        feedback.sendFeedback(
          { text: "hi" },
          {
            fetch: fakeFetch({
              ok: false,
              status: 429,
              body: { error: "Too much feedback too fast. Try later." },
            }),
          },
        ),
      /Too much feedback too fast/,
    );
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    });
    await assert.rejects(
      () => feedback.sendFeedback({ text: "hi" }, { fetch }),
      /rejected \(502\)/,
    );
  });
});

describe("app:feedback IPC", () => {
  let tmpDir;
  let store;
  let threadId;
  let broadcasts;
  let ctx;
  let realFetch;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-feedback-ipc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Work",
    }).id;
    broadcasts = [];
    ctx = {
      store,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    };
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends and confirms in the transcript", async () => {
    globalThis.fetch = fakeFetch();
    await IPC_HANDLERS["app:feedback"](ctx, {
      text: "worktrees eat my disk",
      threadId,
    });
    const messages = store.getMessages(threadId);
    const event = messages[messages.length - 1];
    assert.equal(event.role, "event");
    assert.match(event.text, /Feedback sent/);
    assert.ok(broadcasts.some((b) => b.channel === "thread:updated"));
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
  });

  it("leaves no confirmation behind when the send fails", async () => {
    globalThis.fetch = fakeFetch({ throws: true });
    await assert.rejects(
      () => IPC_HANDLERS["app:feedback"](ctx, { text: "hi", threadId }),
      /Could not reach Solenta/,
    );
    assert.equal(store.getMessages(threadId).length, 0);
    assert.equal(broadcasts.length, 0);
  });

  it("rejects an empty report", async () => {
    globalThis.fetch = fakeFetch();
    await assert.rejects(
      () => IPC_HANDLERS["app:feedback"](ctx, { text: "  ", threadId }),
      /Feedback is empty/,
    );
    assert.equal(globalThis.fetch.calls.length, 0);
  });

  it("sends without a thread, and survives one that is gone", async () => {
    globalThis.fetch = fakeFetch();
    await IPC_HANDLERS["app:feedback"](ctx, { text: "no thread here" });
    await IPC_HANDLERS["app:feedback"](ctx, {
      text: "stale thread",
      threadId: "does-not-exist",
    });
    assert.equal(globalThis.fetch.calls.length, 2);
  });
});
