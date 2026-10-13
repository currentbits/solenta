const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const prReview = require("../prReview.js");
const { rmTree } = require("./support/rmTree.js");

function waitFor(predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const userTexts = (store, id) =>
  (store.getMessages(id) || []).filter((m) => m.role === "user").map((m) => String(m.text));

describe("cross-model PR review (#259)", () => {
  let tmpDir;
  let store;
  let author;
  let prevSimulate;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-prreview-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"],
      { cwd: repo, stdio: "ignore" },
    );
    const project = await services.addProject(store, repo);
    author = services.createThread(store, { projectId: project.id, title: "Author" });
    store.updateThread(author.id, { provider: "claude" });
  });

  afterEach(async () => {
    await rmTree(tmpDir);
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
  });

  it("prompt carries the rubric's exclusions verbatim", () => {
    const p = prReview.reviewPrompt({ number: 7, baseBranch: "main" });
    assert.match(p, /git diff main\.\.\.HEAD/);
    assert.ok(p.includes("Do not flag style, formatting, pre-existing issues, or anything a linter would catch."));
    assert.deepEqual(prReview.reviewerCandidates("claude", ["claude", "codex", "grok"]), ["codex", "grok"]);
  });

  it("stays off unless the setting is on and the PR is new", async () => {
    const started = [];
    const runner = { startRun: async (i) => started.push(i) };
    const base = { store, runner, threadId: author.id, availableIds: () => ["claude", "codex"] };
    assert.equal(await prReview.startPrReview({ ...base, pr: { number: 1, created: true } }), null);
    store.setSettings({ prCrossReview: true });
    assert.equal(await prReview.startPrReview({ ...base, pr: { number: 1, created: false } }), null);
    assert.equal(await prReview.startPrReview({ ...base, availableIds: () => ["claude"], pr: { number: 1, created: true } }), null);
    assert.equal(started.length, 0);
  });

  it("forks a clean-context reviewer on another provider", async () => {
    store.setSettings({ prCrossReview: true });
    const started = [];
    const id = await prReview.startPrReview({
      store,
      runner: { startRun: async (i) => started.push(i) },
      threadId: author.id,
      pr: { number: 9, url: "https://github.com/o/r/pull/9", created: true },
      availableIds: () => ["claude", "codex"],
    });
    const reviewer = store.getThread(id);
    assert.equal(reviewer.provider, "codex");
    assert.equal(reviewer.orchWorker, true);
    assert.equal(reviewer.handoffFrom, author.id);
    assert.deepEqual(reviewer.prReviewOf, { pr: 9, url: "https://github.com/o/r/pull/9" });
    assert.equal(store.getMessages(id).length, 0, "no transcript copied");
    assert.equal(started.length, 1);
    assert.equal(started[0].threadId, id);
    assert.match(started[0].prompt, /pull request #9/);
  });

  async function runReviewer(reviewerFrom) {
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    const runner = createRunner({ store, core, pushFn() {}, tickMs: 15 });
    try {
      const reviewer = services.forkThread(store, { threadId: reviewerFrom });
      store.updateThread(reviewer.id, { orchWorker: true, prReviewOf: { pr: 9, url: null } });
      store.saveNow();
      await runner.startRun({ threadId: reviewer.id, prompt: "review" });
      return { runner, reviewer };
    } catch (err) {
      runner.stopAll();
      throw err;
    }
  }

  it("delivers the reviewer's whole reply to the author to filter", async () => {
    const { runner } = await runReviewer(author.id);
    try {
      await waitFor(() => userTexts(store, author.id).length > 0);
      const text = userTexts(store, author.id)[0];
      assert.match(text, /^\[pr review\] .* reviewed PR #9/);
      assert.match(text, /you are the filter/);
      assert.doesNotMatch(text, /thread_merge|Worker thread/);
    } finally {
      runner.stopAll();
    }
  });

  it("relays to the live lead when the author is an archived worker", async () => {
    const worker = services.forkThread(store, { threadId: author.id });
    store.updateThread(worker.id, { orchWorker: true, archived: true });
    const { runner } = await runReviewer(worker.id);
    try {
      await waitFor(() => userTexts(store, author.id).length > 0);
      const text = userTexts(store, author.id)[0];
      assert.match(text, new RegExp(`worker ${worker.id}'s PR #9`));
      assert.match(text, /thread_send/);
      assert.equal(userTexts(store, worker.id).length, 0);
    } finally {
      runner.stopAll();
    }
  });
});
