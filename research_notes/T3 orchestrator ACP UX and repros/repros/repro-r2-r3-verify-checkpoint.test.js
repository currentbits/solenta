"use strict";

/**
 * Repro R2 (verify window) and R3 (checkpoint vs next queued turn),
 * commit 615b38a0.
 *
 * R2: afterSuccessfulTurn sets status "working" and runs the verify command
 *     (runner.js:1496-1516) without an `active` entry, so a notice can start
 *     a run mid-verify, verify then writes status over that run
 *     (1707-1711), and Stop cannot cancel verify.
 * R3: the no-verify path fires `void maybeCreateCheckpoint` and drains the
 *     queued follow-up in the same tick (runner.js:1526-1532), so the next
 *     turn's edits can land in the previous turn's checkpoint commit.
 *
 * Generic provider (CODER_AGENT_CMD) with an injected runAgentFn so each
 * turn's timing is under test control. Real git, real verify command.
 * Convention: asserts the CORRECT behaviour, so it FAILS while the bug is real.
 * Run: node --test electron/test/repro-r2-r3-verify-checkpoint.test.js
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
const { setupWorktree } = require("../worktrees.js");
const { createRunner } = require("../runner.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function waitFor(predicate, { timeoutMs = 8000, intervalMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("R2/R3: verify window and checkpoint race", () => {
  let tmpDir, store, runner, thread, wtPath, prev, runs, behaviours;

  beforeEach(async () => {
    prev = { sim: process.env.CODER_SIMULATE, cmd: process.env.CODER_AGENT_CMD };
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e 0`; // provider "generic"; runAgentFn replaces the spawn
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-r2r3-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "T"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "init"]);
    const project = await services.addProject(store, repo);
    const t = services.createThread(store, { projectId: project.id, title: "Gate thread" });
    wtPath = setupWorktree({ store, threadId: t.id, worktreeBase: path.join(tmpDir, "worktrees"), broadcast: () => {} }).worktreePath;
    thread = store.getThread(t.id);
    runs = [];
    behaviours = [];
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      userDataPath: tmpDir,
      bootstrapMemory: async () => ({}),
      runAgentFn: (opts) => {
        const run = {
          n: runs.length + 1,
          cwd: opts.cwd,
          prompt: String(opts.prompt || ""),
          finish: (text = `turn ${runs.length} done`) => setImmediate(() => opts.onDone(0, text, "")),
        };
        runs.push(run);
        const b = behaviours[run.n - 1];
        if (b) b(run);
        return { kill() { run.killed = true; } };
      },
    });
  });

  afterEach(async () => {
    for (const r of runs) if (!r.killed) r.finish();
    if (runner) runner.stopAll();
    await sleep(50);
    await rmTree(tmpDir);
    if (prev.sim === undefined) delete process.env.CODER_SIMULATE; else process.env.CODER_SIMULATE = prev.sim;
    if (prev.cmd === undefined) delete process.env.CODER_AGENT_CMD; else process.env.CODER_AGENT_CMD = prev.cmd;
  });

  const events = () => (store.getMessages(thread.id) || []).filter((m) => m.role === "event").map((m) => m.text);
  const inVerifyWindow = () =>
    runs.length === 1 && !runner.isRunning(thread.id) && store.getThread(thread.id).status === "working";

  it("R2: a notice delivered during verify must not start a run, and verify must not overwrite a live run's status", async () => {
    store.updateThread(thread.id, { verifyCommand: "sleep 1.5; echo verify-ok" });
    behaviours[0] = (run) => run.finish(); // turn 1 ends at once -> verify starts
    // behaviours[1] unset: the notice turn stays open until we finish it.
    await runner.startRun({ threadId: thread.id, prompt: "do work" });
    await waitFor(inVerifyWindow);

    runner.deliverNotice({ threadId: thread.id, line: `[peer from w1 ("backend")] contract.md is ready` });
    await sleep(100);
    const facts = {
      runStartedDuringVerify: runs.length === 2,
      isRunningDuringVerify: runner.isRunning(thread.id),
    };
    await waitFor(() => store.getThread(thread.id).verify, { timeoutMs: 5000 });
    const t = store.getThread(thread.id);
    facts.verifyOk = t.verify.ok;
    facts.statusAfterVerify = t.status;
    facts.noticeRunStillActive = runner.isRunning(thread.id);
    facts.runStartedAtAfterVerify = t.runStartedAt;
    console.log("R2 facts:", JSON.stringify(facts));
    assert.equal(facts.runStartedDuringVerify, false, "a run started while verify was running");
    assert.ok(!(facts.noticeRunStillActive && facts.statusAfterVerify !== "working"), `verify wrote status=${facts.statusAfterVerify} over a live run`);
  });

  it("R2: Stop during verify must cancel it, and a queued follow-up must stay parked (#1203 contract)", async () => {
    store.updateThread(thread.id, { verifyCommand: "sleep 1.5; echo verify-ok" });
    behaviours[0] = (run) => {
      services.setQueued(store, { threadId: thread.id, prompt: "follow-up typed during the run" });
      run.finish();
    };
    behaviours[1] = (run) => run.finish();
    await runner.startRun({ threadId: thread.id, prompt: "do work" });
    await waitFor(inVerifyWindow);
    await runner.stopRun({ threadId: thread.id });
    const statusAfterStop = store.getThread(thread.id).status;
    await sleep(2500);
    const t = store.getThread(thread.id);
    const facts = {
      statusAfterStop,
      verifyRanToCompletion: Boolean(t.verify),
      verifiedEvent: events().some((e) => /^Verified:/.test(e)),
      runStoppedEvent: events().includes("Run stopped"),
      followUpDrained: runs.length === 2 || !t.queued,
      finalStatus: t.status,
    };
    console.log("R2 stop facts:", JSON.stringify(facts));
    assert.equal(facts.verifyRanToCompletion, false, "verify kept running after Stop");
    assert.equal(facts.followUpDrained, false, "Stop during verify let the queued follow-up start");
  });

  it("R3: the turn-1 checkpoint must not contain the queued turn-2 edits or name turn 2's message", async () => {
    behaviours[0] = (run) => {
      fs.writeFileSync(path.join(run.cwd, "turn1.txt"), "turn 1\n");
      services.setQueued(store, { threadId: thread.id, prompt: "turn two" }); // type-ahead
      run.finish("turn one reply");
    };
    behaviours[1] = (run) => {
      // A fast CLI's first edit, made the moment turn 2 launches.
      fs.writeFileSync(path.join(run.cwd, "turn2.txt"), "turn 2 partial\n");
    };
    await runner.startRun({ threadId: thread.id, prompt: "turn one" });
    await waitFor(() => /coder-checkpoint:/.test(git(wtPath, ["log", "-1", "--format=%s"])) && runs.length === 2);
    const sha = git(wtPath, ["log", "-1", "--grep=coder-checkpoint:", "--format=%H"]);
    const files = git(wtPath, ["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean);
    const trailer = (git(wtPath, ["log", "-1", "--format=%b", sha]).match(/Solenta-Message-Id: (\S+)/) || [])[1] || null;
    const msgs = store.getMessages(thread.id) || [];
    const named = msgs.find((m) => m.id === trailer);
    const facts = {
      checkpointSubject: git(wtPath, ["log", "-1", "--format=%s", sha]),
      checkpointFiles: files,
      trailerNamesRole: named ? named.role : null,
      trailerNamesText: named ? String(named.text).slice(0, 40) : null,
      turn1ReplyId: (msgs.find((m) => m.role === "assistant" && /turn one reply/.test(String(m.text))) || {}).id || null,
      trailer,
    };
    console.log("R3 facts:", JSON.stringify(facts));
    assert.deepEqual(facts.checkpointFiles, ["turn1.txt"], "turn-2 edits captured in turn-1 checkpoint");
    assert.equal(facts.trailer, facts.turn1ReplyId, "checkpoint trailer does not name turn 1's last message");
  });
});
