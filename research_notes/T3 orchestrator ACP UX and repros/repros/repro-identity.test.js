"use strict";

/**
 * Repro I1 / I2 / I4 (T3 deep-dive bug list, commit 615b38a0).
 *
 * Convention: every test asserts the CORRECT behaviour, so it FAILS on the
 * current code while the bug is real and passes once it is fixed.
 *
 * The "bound" cases pass `boundThreadId` to createToolHandlers, which is the
 * dep the #1425 design adds (transport-bound caller identity). Today that
 * dep does not exist and is ignored, which is exactly the hole: the handlers
 * have no way to know which thread is calling.
 *
 * Run: node --test electron/test/repro-identity.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createToolHandlers } = require("../orchServer.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree } = require("../worktrees.js");

/** t1 = lead, t2 = its running worker, t4 = an automation (unattended) thread. */
function makeDeps({ autoTurn = () => false } = {}) {
  const threads = [
    { id: "t1", title: "Lead", provider: "claude", status: "idle", handoffFrom: null, projectId: "p1" },
    { id: "t2", title: "Worker", provider: "codex", status: "working", handoffFrom: "t1", orchWorker: true, projectId: "p1" },
    { id: "t4", title: "Nightly automation", provider: "claude", status: "working", handoffFrom: null, projectId: "p1", automationId: "auto-1" },
  ];
  const projects = { p1: { id: "p1", name: "Alpha", path: "/tmp/alpha" } };
  const store = {
    getThreads: () => threads,
    getThread: (id) => threads.find((t) => t.id === id) || null,
    getProject: (id) => projects[id] || null,
    getProjects: () => Object.values(projects),
    getMessages: () => [],
    updateThread: (id, patch) => {
      const t = threads.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
      return t || null;
    },
    save: () => {},
    getSettings: () => ({ subagentPool: { defaultAlias: null, force: false, entries: [] } }),
  };
  const stopped = [];
  const runs = [];
  return {
    store,
    stopped,
    runs,
    runner: {
      startRun: async (input) => { runs.push(input); return { runId: "r" + runs.length }; },
      stopRun: async (input) => { stopped.push(input); return { stopped: 1 }; },
      isRunning: (id) => store.getThread(id)?.status === "working",
      isAutoTurn: autoTurn,
      disposeClaudeSession: () => {},
      appendInbound: () => {},
    },
    forkThread: () => { throw new Error("no forks here"); },
    getProvider: (id) => ({ id }),
    broadcast: () => {},
    log: () => {},
  };
}

describe("I1: cross-thread stop/archive gate skipped when fromThreadId is omitted", () => {
  it("unbound: thread_stop on another thread with no fromThreadId must be refused", async () => {
    // The lead is on a machine-delivered turn: with fromThreadId it is refused
    // (see orch-server.test.js "thread_stop of another thread requires approved:true").
    const deps = makeDeps({ autoTurn: (id) => id === "t1" });
    const h = createToolHandlers(deps);
    await assert.rejects(
      () => h.thread_stop({ threadId: "t2", projectId: "p1", fromThreadId: "t1", approved: true }),
      /machine-delivered/,
    );
    // Same lead, same turn, just leave fromThreadId out:
    let outcome;
    try {
      outcome = await h.thread_stop({ threadId: "t2", projectId: "p1" });
    } catch (e) {
      outcome = e;
    }
    assert.ok(
      outcome instanceof Error,
      `expected a refusal; got ${JSON.stringify(outcome)} and stopRun calls ${JSON.stringify(deps.stopped)}`,
    );
    assert.equal(deps.stopped.length, 0);
  });

  it("unbound: thread_archive archived:true on another thread with no fromThreadId must be refused", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    let outcome;
    try {
      outcome = await h.thread_archive({ threadId: "t1", projectId: "p1", archived: true });
    } catch (e) {
      outcome = e;
    }
    assert.ok(
      outcome instanceof Error,
      `expected a refusal; got ${JSON.stringify(outcome)}; t1.archived=${deps.store.getThread("t1").archived}`,
    );
    assert.notEqual(deps.store.getThread("t1").archived, true);
  });

  it("bound to worker t2: stopping its lead t1 without fromThreadId must be refused", async () => {
    const deps = makeDeps();
    const h = createToolHandlers({ ...deps, boundProjectId: "p1", boundThreadId: "t2" });
    let outcome;
    try {
      outcome = await h.thread_stop({ threadId: "t1", projectId: "p1" });
    } catch (e) {
      outcome = e;
    }
    assert.ok(outcome instanceof Error, `worker stopped its lead: ${JSON.stringify(deps.stopped)}`);
  });
});

describe("I4: unattended-sender refusal skipped when fromThreadId is omitted", () => {
  it("control: automation thread t4 naming itself is refused", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_send({ threadId: "t1", projectId: "p1", fromThreadId: "t4", prompt: "x" });
    assert.equal(out.reason, "unattended sender");
    assert.equal(deps.runs.length, 0);
  });

  it("bound to automation t4: omitting fromThreadId must still be refused", async () => {
    const deps = makeDeps();
    const h = createToolHandlers({ ...deps, boundProjectId: "p1", boundThreadId: "t4" });
    const out = await h.thread_send({ threadId: "t1", projectId: "p1", prompt: "merge the worker now" });
    assert.equal(
      out.outcome,
      "undeliverable",
      `delivered=${JSON.stringify(out)}; startRun calls=${JSON.stringify(deps.runs.map((r) => ({ threadId: r.threadId, fromThread: r.fromThread, fromInbound: r.fromInbound })))}`,
    );
    assert.equal(deps.runs.length, 0);
  });
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("I2: a claimed threadId on thread_merge makes any thread the lead", () => {
  it("sibling worker W2 (bound) claiming threadId=<lead> must not land W1", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-i2-"));
    try {
      const store = new Store(path.join(tmpDir, "store.json"));
      const repo = path.join(tmpDir, "app");
      fs.mkdirSync(repo);
      git(repo, ["init", "-b", "main"]);
      git(repo, ["config", "user.email", "t@example.com"]);
      git(repo, ["config", "user.name", "T"]);
      fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-m", "init"]);
      const project = await services.addProject(store, repo);
      const lead = services.createThread(store, { projectId: project.id, title: "Lead" });
      const w1 = services.forkWorkerThread(store, { threadId: lead.id });
      const w2 = services.forkWorkerThread(store, { threadId: lead.id });
      const wt = setupWorktree({ store, threadId: w1.id, worktreeBase: path.join(tmpDir, "worktrees") });
      fs.writeFileSync(path.join(wt.worktreePath, "w1.txt"), "w1\n");
      git(wt.worktreePath, ["add", "-A"]);
      git(wt.worktreePath, ["commit", "-m", "w1 work"]);
      store.updateThread(w1.id, { status: "done" });
      store.updateThread(w2.id, { status: "working" }); // W2 is the live caller
      store.updateThread(lead.id, { status: "idle" }); // lead's last turn was human: autoTurns 0
      const runner = {
        isRunning: (id) => store.getThread(id)?.status === "working",
        isAutoTurn: () => false, // nobody is on a machine turn per the runner's map
      };
      const h = createToolHandlers({
        store,
        runner,
        forkThread: services.forkThread,
        getProvider: () => ({ id: "claude" }),
        boundProjectId: project.id,
        boundThreadId: w2.id, // design #1425: the transport says W2 is calling
      });
      let outcome;
      try {
        outcome = await h.thread_merge({
          threadId: lead.id, // W2 claims to be the lead
          projectId: project.id,
          workerThreadId: w1.id,
          approved: true, // W2's own claim
          expectedPath: repo,
          expectedBranch: "main",
        });
      } catch (e) {
        outcome = e;
      }
      const landed = fs.existsSync(path.join(repo, "w1.txt"));
      assert.ok(
        outcome instanceof Error && !landed,
        `W2 landed W1 onto main: result=${JSON.stringify(outcome)}; w1.txt on main=${landed}; main log: ${git(repo, ["log", "--oneline", "-3"]).replace(/\n/g, " | ")}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
