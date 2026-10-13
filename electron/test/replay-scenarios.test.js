"use strict";

/**
 * Replay scenarios (#1428): recorded `claude` 2.1.283 transcripts played
 * through the REAL runner, stream normalizer, store and pushDetail. Only
 * the CLI process is fake (support/replayCli.js), and it asserts every
 * stdin line the runner writes. Fixtures: fixtures/replay/, recorded with
 * support/recordCli.js. Re-record when the Claude CLI bumps its format.
 *
 * Run: node --test electron/test/replay-scenarios.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { useReplay, waitFor } = require("./support/replay.js");
const { rmTree } = require("./support/rmTree.js");

const V = "claude-2.1.283";

async function boot(dir) {
  const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
  const storeFile = path.join(dir, "store.json");
  const store = new Store(storeFile);
  const runner = createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: dir });
  const repo = path.join(dir, "app");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const project = await services.addProject(store, repo);
  const lead = services.createThread(store, { projectId: project.id, title: "Lead" });
  store.saveNow();
  return { core, store, storeFile, runner, lead };
}

function rows(store, threadId, role) {
  return (store.getMessages(threadId) || []).filter((m) => m.role === role);
}

describe("replay: recorded claude transcripts through the real runner (#1428)", () => {
  let replay;
  let runner;

  afterEach(async () => {
    if (runner) runner.stopAll();
    runner = null;
    await rmTree(replay.dir);
    replay.restore();
  });

  describe("a worker finishing wakes its lead", () => {
    beforeEach(() => {
      replay = useReplay([`${V}-wake-lead.ndjson`, `${V}-wake-worker.ndjson`]);
    });

    it("delivers the worker's notice to the kept-alive lead process", async () => {
      const env = await boot(replay.dir);
      runner = env.runner;
      const { store, lead } = env;
      await runner.startRun({ threadId: lead.id, prompt: "You are a lead. Reply with exactly: planned" });
      await waitFor(() => store.getThread(lead.id).status === "done");

      const worker = services.forkThread(store, { threadId: lead.id });
      store.updateThread(worker.id, { orchWorker: true, title: "Worker A" });
      store.saveNow();
      await runner.startRun({ threadId: worker.id, prompt: "Worker task A: reply with exactly: built it" });

      await waitFor(() => replay.finished(`${V}-wake-lead.ndjson`));
      await waitFor(() => store.getThread(lead.id).status === "done" && !runner.isRunning(lead.id));
      const notice = rows(store, lead.id, "user")[1];
      assert.match(notice.text, new RegExp(`Worker thread ${worker.id} \\("Worker A"\\) finished with status done\\. Last reply: built it`));
      assert.equal(store.getThread(worker.id).status, "done");
      const lastReply = rows(store, lead.id, "assistant").at(-1).text;
      assert.match(lastReply, /^Worker A finished\./);
      assert.ok(rows(store, lead.id, "tool").some((m) => /git log/.test(m.text)), "lead's tool calls are stored");
      replay.assertClean();
    });
  });

  describe("a permission prompt", () => {
    beforeEach(() => {
      replay = useReplay([`${V}-permission.ndjson`]);
    });

    it("waits on the user without tripping the stall sweep, then resumes on allow", async () => {
      const env = await boot(replay.dir);
      runner = env.runner;
      const { store, lead } = env;
      await runner.startRun({
        threadId: lead.id,
        prompt: "Use the Bash tool to run exactly this command: ls > listing.txt . Then reply with exactly: listed",
      });
      await waitFor(() => store.getThread(lead.id).awaitingInput === true);
      const pending = runner.getPendingPermission(lead.id);
      assert.equal(pending.command, "ls > listing.txt");

      process.env.CODER_STALL_MS = "1";
      await new Promise((r) => setTimeout(r, 20));
      runner.checkStalls();
      assert.equal(store.getThread(lead.id).stalledAt ?? null, null, "a prompt waiting on the user is not a stall");
      assert.equal(store.getThread(lead.id).status, "working");

      runner.respondPermission({ threadId: lead.id, requestId: pending.requestId, decision: "allow" });
      await waitFor(() => store.getThread(lead.id).status === "done");
      assert.equal(store.getThread(lead.id).awaitingInput, false);
      assert.equal(rows(store, lead.id, "assistant").at(-1).text, "listed");
      assert.ok(rows(store, lead.id, "event").some((m) => m.text === "Allowed: Bash: ls > listing.txt"));
      replay.assertClean();
    });
  });

  describe("steering a live run", () => {
    beforeEach(() => {
      replay = useReplay([`${V}-steer.ndjson`]);
    });

    async function steer() {
      const env = await boot(replay.dir);
      runner = env.runner;
      const { store, lead } = env;
      await runner.startRun({
        threadId: lead.id,
        prompt: "Do not use any tools. In your reply text, write the numbers 1 to 200 as words, one per line, nothing else.",
      });
      // The fixture blocks on its second expect: the steer line.
      await waitFor(() => replay.log().some((e) => e.waiting === "expect" && e.cursor > 1));
      await runner.steerRun({ threadId: lead.id, prompt: "Change of plan: stop and reply with exactly: steered" });
      await waitFor(() => replay.finished(`${V}-steer.ndjson`));
      await waitFor(() => store.getThread(lead.id).status === "done");
      return env;
    }

    it("writes the steer to the live CLI's stdin and stores it on the same run", async () => {
      const { store, lead } = await steer();
      const [first, steered] = rows(store, lead.id, "user");
      assert.equal(steered.steer, true);
      assert.equal(steered.runId, first.runId);
      assert.match(rows(store, lead.id, "assistant")[0].text, /^one\ntwo\n/);
      replay.assertClean();
    });

    // claude 2.1.283 answers a steer that lands mid-text as a SECOND turn
    // after the first result (new system/init + result "steered"). The run
    // already ended on the first result, so that reply is dropped (#1608).
    it("keeps the reply to a steer that the CLI answers as its own turn", { todo: "#1608" }, async () => {
      const { store, lead } = await steer();
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(rows(store, lead.id, "assistant").some((m) => m.text === "steered"));
    });
  });

  describe("a restart mid-run", () => {
    beforeEach(() => {
      replay = useReplay([`${V}-restart-before.ndjson`, `${V}-restart-resumed.ndjson`]);
    });

    it("marks the run interrupted at quit and resumes the same session on relaunch", async () => {
      const env = await boot(replay.dir);
      runner = env.runner;
      const { store, lead, core, storeFile } = env;
      await runner.startRun({ threadId: lead.id, prompt: "Write the numbers 1 to 200 as words, one per line, nothing else." });
      await waitFor(() => replay.finished(`${V}-restart-before.ndjson`));
      await waitFor(() => rows(store, lead.id, "assistant").length > 0);
      const sessionId = store.getThread(lead.id).sessionId;
      assert.equal(sessionId, "d179eae5-2be9-4fa1-868f-082ee632c677");

      runner.stopAll(); // app quit; the recorded CLI is still mid-stream
      // A relaunch starts after the old process is gone: wait for the CLI's
      // exit and the old store's last flush so neither writes under store2.
      const { pid } = replay.log().find((e) => e.fixture === `${V}-restart-before.ndjson` && e.start);
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      await store.flushPending();
      store.saveNow();
      const store2 = new Store(storeFile);
      assert.equal(store2.getThread(lead.id).status, "idle");
      assert.ok(Number.isFinite(store2.getThread(lead.id).interruptedAt));
      services.setSettings(store2, { resumeInterruptedRuns: true });
      runner = createRunner({ store: store2, core, pushFn() {}, tickMs: 15, userDataPath: replay.dir });

      // Fast polls: a replayed turn can end before a 1s poll ever sees it.
      const resumed = await runner.resumeInterruptedRuns({
        pollMs: 5,
        startGraceMs: 2000,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      assert.deepEqual(resumed, [lead.id]);
      await waitFor(() => store2.getThread(lead.id).status === "done");
      const events = rows(store2, lead.id, "event").map((m) => m.text);
      assert.ok(events.includes("Run interrupted by app quit"), JSON.stringify(events));
      assert.ok(events.includes("Resumed after restart"), JSON.stringify(events));
      assert.equal(store2.getThread(lead.id).sessionId, sessionId);
      assert.match(rows(store2, lead.id, "assistant").at(-1).text, /\ntwo hundred$/);
      replay.assertClean();
    });
  });
});
