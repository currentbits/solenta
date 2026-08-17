/**
 * The seam between the MCP tools (orchServer) and delivery (runner): each
 * side was tested against a fake of the other, so this drives the REAL
 * handlers against a REAL runner. If peer_send or the unblock wake-up ever
 * stops actually starting a run, this is what fails.
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
const { createToolHandlers } = require("../orchServer.js");

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function userTexts(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "user")
    .map((m) => String(m.text || ""));
}

describe("crew tools × runner delivery (issue #277)", () => {
  let tmpDir;
  let store;
  let runner;
  let handlers;
  let projectId;
  let lead;
  let backend;
  let frontend;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-seam-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({ store, core, pushFn() {}, tickMs: 15 });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    projectId = project.id;

    lead = services.createThread(store, { projectId, title: "Lead" });
    backend = services.createThread(store, { projectId, title: "Backend" });
    frontend = services.createThread(store, { projectId, title: "Frontend" });
    for (const w of [backend, frontend]) {
      store.updateThread(w.id, { orchWorker: true, handoffFrom: lead.id });
    }
    store.save();

    handlers = createToolHandlers({
      store,
      runner,
      forkThread: () => {
        throw new Error("not used");
      },
      getProvider: () => ({ id: "simulate" }),
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("peer_send reaches the peer as a run, without touching the lead", async () => {
    const res = await handlers.peer_send({
      threadId: backend.id,
      projectId,
      toThreadId: frontend.id,
      message: "API contract: coder/backend-x:contract.md",
    });
    assert.deepEqual(res, { delivered: true, toThreadId: frontend.id });

    await waitFor(() => userTexts(store, frontend.id).length > 0);
    const text = userTexts(store, frontend.id)[0];
    assert.match(text, new RegExp(`\\[peer from ${backend.id} \\("Backend"\\)\\]`));
    assert.match(text, /coder\/backend-x:contract\.md/);
    assert.deepEqual(userTexts(store, lead.id), [], "the lead is not in the loop");
  });

  it("task_complete wakes the crew root with what it unblocked", async () => {
    await handlers.task_add({
      threadId: lead.id,
      projectId,
      tasks: [{ title: "API contract" }, { title: "Wire the UI", needs: ["t1"] }],
    });
    const claim = await handlers.task_claim({ threadId: backend.id, projectId });
    assert.equal(claim.task.id, "t1");

    // A peer can now find t1 taken and t2 still blocked.
    const blocked = await handlers.task_claim({ threadId: frontend.id, projectId });
    assert.equal(blocked.task, null);
    assert.match(blocked.reason, /waiting on dependencies/);

    await handlers.task_complete({
      threadId: backend.id,
      projectId,
      taskId: "t1",
      note: "coder/backend-x:contract.md",
    });

    await waitFor(() => userTexts(store, lead.id).length > 0);
    const text = userTexts(store, lead.id)[0];
    assert.match(text, /finished t1 \("API contract"\)/);
    assert.match(text, /coder\/backend-x:contract\.md/);
    assert.match(text, /Unblocked: t2/);

    const after = await handlers.task_claim({ threadId: frontend.id, projectId });
    assert.equal(after.task.id, "t2", "the dependent opened with no second write");
  });

  it("a failed worker run hands its claim back with the failure recorded", async () => {
    await handlers.task_add({
      threadId: lead.id,
      projectId,
      tasks: [{ title: "flaky migration" }],
    });
    await handlers.task_claim({ threadId: backend.id, projectId, taskId: "t1" });

    store.updateThread(backend.id, { lastError: "exit code 1" });
    services.releaseCrewTasks(store, {
      threadId: backend.id,
      outcome: "exit code 1",
    });

    const next = await handlers.task_claim({
      threadId: frontend.id,
      projectId,
      taskId: "t1",
    });
    assert.equal(next.task.id, "t1", "a crashed worker does not strand the task");
    assert.deepEqual(
      next.attempts.map((a) => a.outcome),
      ["exit code 1"],
      "the next claimer reads what already failed",
    );
  });
});
