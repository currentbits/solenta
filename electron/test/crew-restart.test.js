"use strict";

/**
 * Durable crew notices and consent-gated resume after restart (#1426).
 * Run: node --test electron/test/crew-restart.test.js
 */
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
const { createOrchNotices } = require("../runner-orch-notices.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function waitFor(predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

const userTexts = (store, id) =>
  (store.getMessages(id) || [])
    .filter((m) => m.role === "user")
    .map((m) => String(m.text || ""));

describe("crew notices survive a restart (#1426)", () => {
  let tmpDir;
  let storePath;
  let store;
  let repo;
  let lead;
  let worker;
  const runners = [];
  let prevSimulate;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-crew-restart-"));
    storePath = path.join(tmpDir, "state", "store.json");
    store = new Store(storePath);
    repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "base"]);
    const project = await services.addProject(store, repo);
    lead = services.createThread(store, { projectId: project.id, title: "Lead" });
    worker = services.forkThread(store, { threadId: lead.id });
    store.updateThread(worker.id, { orchWorker: true, title: "Worker A" });
    store.saveNow();
  });

  afterEach(async () => {
    for (const r of runners.splice(0)) r.stopAll();
    await rmTree(tmpDir);
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
  });

  /** Seam with a real store and a fake `active`, so "busy" is deterministic. */
  function seam(s, active = new Map()) {
    const starts = [];
    const n = createOrchNotices({
      store: s,
      active,
      lastWorkflowByThread: new Map(),
      resolveProvider: () => "simulate",
      looksWriterLock: () => false,
      shortError: (e) => String(e),
      appendMessage: () => {},
      pushDetail: () => {},
      pushThreadsChanged: () => {},
      startRun: async (input) => {
        starts.push(input);
      },
      maybeDrainQueued: () => {},
    });
    return { n, starts, active };
  }

  it("a worker cut off mid-run is reported to its lead only after the user resumes", async () => {
    // Crash state on disk: the worker was mid-run in a dirty worktree.
    fs.writeFileSync(path.join(repo, "wip.txt"), "half done\n");
    store.updateThread(worker.id, {
      status: "working",
      worktreePath: repo,
      branch: "coder/worker-a",
    });
    store.saveNow();

    const booted = new Store(storePath);
    const w = booted.getThread(worker.id);
    assert.equal(w.status, "failed", "boot recovery keeps the failed status");
    assert.equal(w.interruptedBy, "restart");

    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    const runner = createRunner({ store: booted, core, pushFn() {}, tickMs: 15 });
    runners.push(runner);
    assert.equal(booted.getThread(lead.id).heldNotices, 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(userTexts(booted, lead.id), [], "held: no wake before resume");

    // A second boot adds nothing: the interruption is already noticed.
    booted.saveNow();
    const again = new Store(storePath);
    runners.push(createRunner({ store: again, core, pushFn() {}, tickMs: 15 }));
    assert.equal(again.data.orchNoticesByThread[lead.id].length, 1);

    runner.resumeCrew({ threadId: lead.id });
    assert.equal(booted.getThread(lead.id).heldNotices, null);
    await waitFor(() => userTexts(booted, lead.id).length > 0);
    const [text] = userTexts(booted, lead.id);
    assert.match(text, new RegExp(`Worker thread ${worker.id} \\("Worker A"\\) was interrupted by an app restart`));
    assert.match(text, /branch coder\/worker-a/);
    assert.match(text, /Last commit: [0-9a-f]+ base/);
    assert.match(text, /1 uncommitted change\b/);
  });

  it("a worker that finished before the crash still wakes its lead after restart", async () => {
    const { n, starts, active } = seam(store);
    active.set(lead.id, { kind: "simulate" }); // lead busy: the notice waits
    store.appendMessage(worker.id, { role: "user", text: "go", runId: "run-1" });
    store.appendMessage(worker.id, { role: "assistant", text: "Built the API", runId: "run-1" });
    n.queueOrchNotice(worker.id, "done");
    assert.equal(starts.length, 0);

    // Crash: nothing after the notice reached disk except the notice itself.
    const booted = new Store(storePath);
    assert.equal(booted.getThread(lead.id).heldNotices, 1);
    const after = seam(booted);
    after.n.flushOrchNotices(lead.id);
    await new Promise((r) => setImmediate(r));
    assert.equal(after.starts.length, 0, "held until the user resumes");

    after.n.resumeCrew({ threadId: lead.id });
    await waitFor(() => after.starts.length === 1);
    assert.match(after.starts[0].prompt, /finished with status done\. Last reply: Built the API/);
    assert.equal(after.starts[0].fromNotice, true);
    assert.equal(booted.data.orchNoticesByThread[lead.id], undefined);
  });

  it("the same finish processed twice wakes the lead once", async () => {
    const { n, starts, active } = seam(store);
    active.set(lead.id, { kind: "simulate" });
    store.appendMessage(worker.id, { role: "assistant", text: "done", runId: "run-7" });
    n.queueOrchNotice(worker.id, "done");
    n.queueOrchNotice(worker.id, "done");
    assert.equal(store.data.orchNoticesByThread[lead.id].length, 1);

    // The dedupe key is on disk too: a replay after restart is still a no-op.
    const booted = new Store(storePath);
    seam(booted).n.queueOrchNotice(worker.id, "done");
    assert.equal(booted.data.orchNoticesByThread[lead.id].length, 1);

    active.delete(lead.id);
    n.flushOrchNotices(lead.id);
    await waitFor(() => starts.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(starts.length, 1);
  });
});
