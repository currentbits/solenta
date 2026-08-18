/**
 * Issue #269 / #500: spec-mode IPC seam — startSpec / stopSpec / reviewSpec / specArtifact.
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
const { IPC_HANDLERS } = require("../ipc.js");

describe("spec-mode IPC", () => {
  let tmpDir;
  let store;
  let threadId;
  let broadcasts;
  let startRunCalls;
  let ctx;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-spec-ipc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Add spec mode",
    }).id;
    broadcasts = [];
    startRunCalls = [];
    ctx = {
      store,
      runner: {
        startRun: async (input) => {
          startRunCalls.push(input);
          return { id: "run-stub" };
        },
      },
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("threads:startSpec puts the thread in spec mode and broadcasts", async () => {
    const thread = await IPC_HANDLERS["threads:startSpec"](ctx, { threadId });
    assert.ok(thread.spec);
    assert.equal(thread.spec.stage, "requirements");
    assert.equal(thread.spec.awaitingApproval, false);
    assert.equal(store.getThread(threadId).spec.stage, "requirements");
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
    assert.equal(startRunCalls.length, 0);
  });

  it("threads:reviewSpec approve advances the stage and starts one run", async () => {
    services.startSpec(store, { threadId });
    services.submitSpec(store, { threadId });

    const thread = await IPC_HANDLERS["threads:reviewSpec"](ctx, {
      threadId,
      decision: "approve",
    });

    assert.equal(thread.spec.stage, "design");
    assert.equal(thread.spec.awaitingApproval, false);
    assert.equal(store.getThread(threadId).spec.stage, "design");
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
    assert.equal(startRunCalls.length, 1);
    assert.equal(startRunCalls[0].threadId, threadId);
    assert.match(startRunCalls[0].prompt, /\S/);
  });

  it("threads:reviewSpec throws when nothing is awaiting approval", async () => {
    services.startSpec(store, { threadId });
    await assert.rejects(
      () =>
        IPC_HANDLERS["threads:reviewSpec"](ctx, {
          threadId,
          decision: "approve",
        }),
      /awaiting approval/,
    );
    assert.equal(startRunCalls.length, 0);
  });

  it("threads:stopSpec clears spec, broadcasts, and does not start a run", async () => {
    await IPC_HANDLERS["threads:startSpec"](ctx, { threadId });
    assert.ok(store.getThread(threadId).spec);
    broadcasts.length = 0;

    const thread = await IPC_HANDLERS["threads:stopSpec"](ctx, { threadId });
    assert.equal(thread.spec, undefined);
    assert.equal(store.getThread(threadId).spec, undefined);
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
    assert.equal(startRunCalls.length, 0);
  });

  it("threads:specArtifact returns { path, text: null } before the file exists", async () => {
    await IPC_HANDLERS["threads:startSpec"](ctx, { threadId });
    const beforeBroadcasts = broadcasts.length;
    const artifact = await IPC_HANDLERS["threads:specArtifact"](ctx, {
      threadId,
      stage: "requirements",
    });
    assert.equal(artifact.text, null);
    assert.match(artifact.path, /requirements\.md$/);
    assert.equal(broadcasts.length, beforeBroadcasts);
  });

  it("threads:dispatchSpec forks a worker per wave and starts a run on each", async () => {
    services.startSpec(store, { threadId });
    const thread = store.getThread(threadId);
    thread.spec.stage = "build";
    store.updateThread(threadId, { spec: thread.spec });
    const slug = thread.spec.slug;
    const project = store.getProject(thread.projectId);
    const file = path.join(project.path, ".solenta", "specs", slug, "tasks.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      "- [ ] 1. First (`a.ts`) — req 1\n" +
        "- [ ] 2. Second (`b.ts`) — req 2\n" +
        "- [ ] 3. After (`c.ts`) — req 3 — needs: 1, 2\n",
    );

    const result = await IPC_HANDLERS["threads:dispatchSpec"](ctx, { threadId });
    assert.equal(result.dispatched.length, 2);
    assert.equal(startRunCalls.length, 2);
    assert.deepEqual(
      new Set(startRunCalls.map((c) => c.threadId)),
      new Set(result.dispatched.map((d) => d.threadId)),
    );
    for (const call of startRunCalls) {
      assert.notEqual(call.threadId, threadId, "runs land on the workers");
      assert.match(call.prompt, /\[Spec dispatch\]/);
    }
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
  });

  it("threads:convergeSpec starts one run on the spec thread", async () => {
    services.startSpec(store, { threadId });
    const thread = store.getThread(threadId);
    thread.spec.stage = "build";
    store.updateThread(threadId, { spec: thread.spec });

    const out = await IPC_HANDLERS["threads:convergeSpec"](ctx, { threadId });
    assert.equal(out.id, threadId);
    assert.equal(startRunCalls.length, 1);
    assert.equal(startRunCalls[0].threadId, threadId);
    assert.match(startRunCalls[0].prompt, /\[Spec converge\]/);
  });

  it("threads:dispatchSpec throws before build", async () => {
    services.startSpec(store, { threadId });
    await assert.rejects(
      () => IPC_HANDLERS["threads:dispatchSpec"](ctx, { threadId }),
      /after tasks.md is approved/,
    );
    assert.equal(startRunCalls.length, 0);
  });
});
