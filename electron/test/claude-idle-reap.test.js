"use strict";

/**
 * Kept-alive Claude CLIs (#8) are reaped after CLAUDE_IDLE_REAP_MS of idle
 * and capped at CLAUDE_IDLE_MAX idle processes, least recently used first
 * (#36). Safety net for the createRunner split (#1447). The 30-minute window
 * runs on mock.timers (setTimeout only): the test polls with setImmediate and
 * reads real Date.now, so only the runner's timeouts are faked.
 *
 * Run: node --test electron/test/claude-idle-reap.test.js
 */

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

const REAP_MS = 30 * 60 * 1000; // runner.js CLAUDE_IDLE_REAP_MS

/** Poll on setImmediate: setTimeout is mocked while a test runs. */
function waitFor(predicate, { timeoutMs = 15000 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setImmediate(tick);
    };
    tick();
  });
}

/** Real-time pause that does not depend on the mocked setTimeout. */
function settle(ms = 150) {
  const until = Date.now() + ms;
  return waitFor(() => Date.now() >= until);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Interactive fake CLI: appends its pid per spawn, answers every turn. */
function writeKeepAliveFakeClaude(dir) {
  return writeFakeBin(
    path.join(dir, "fake-claude"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
fs.appendFileSync(process.env.CODER_FAKE_CLAUDE_SPAWNS, process.pid + "\\n");
emit({ type: "system", subtype: "init", session_id: "sess-idle", model: "m" });
let buf = "";
let turn = 0;
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    turn += 1;
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "reply " + turn }] },
    });
    emit({
      type: "result",
      subtype: "success",
      result: "reply " + turn,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      num_turns: 1,
      session_id: "sess-idle",
    });
  }
});
setInterval(() => {}, 500);
`,
  );
}

const ENV_KEYS = [
  "CODER_SIMULATE",
  "CODER_AGENT_CMD",
  "CODER_CLAUDE_BIN",
  "CODER_GROK_MCP_DISABLE",
  "CODER_GROK_BIN",
  "CODER_FAKE_CLAUDE_SPAWNS",
];

describe("Claude keep-alive idle reap and LRU cap (#8, #36)", () => {
  let tmpDir;
  let store;
  let runner;
  let project;
  let spawnsFile;
  let prevEnv;

  beforeEach(async () => {
    prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-idle-"));
    spawnsFile = path.join(tmpDir, "spawns");
    process.env.CODER_CLAUDE_BIN = writeKeepAliveFakeClaude(tmpDir);
    process.env.CODER_FAKE_CLAUDE_SPAWNS = spawnsFile;

    store = new Store(path.join(tmpDir, "store.json"));
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      userDataPath: tmpDir,
    });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
    store.saveNow();
    // Armed before any turn: the reap timer is set when a turn settles.
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(async () => {
    mock.timers.reset();
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function newThread(title) {
    return services.createThread(store, { projectId: project.id, title }).id;
  }

  function spawns() {
    return fs.existsSync(spawnsFile)
      ? fs.readFileSync(spawnsFile, "utf8").trim().split("\n").map(Number)
      : [];
  }

  async function turn(threadId, n) {
    await runner.startRun({ threadId, prompt: `turn ${n}` });
    await waitFor(() =>
      store.getThread(threadId).status === "done" &&
      store.getMessages(threadId).some((m) => m.role === "assistant" && m.text === `reply ${n}`),
    );
  }

  it("reaps an idle CLI after the window; the next turn spawns a fresh one", async () => {
    const id = newThread("Idle");
    await turn(id, 1);
    const [pid] = spawns();

    mock.timers.tick(REAP_MS - 1);
    await settle();
    assert.equal(alive(pid), true, "still inside the idle window");

    mock.timers.tick(1);
    await waitFor(() => !alive(pid));

    // The new process starts its own turn count, hence "reply 1".
    await turn(id, 1);
    const after = spawns();
    assert.equal(after.length, 2, "a reaped session is replaced, not reused");
    assert.notEqual(after[1], pid);
    assert.equal(alive(after[1]), true);
  });

  it("a reused turn disarms the reaper and restarts the window at settle", async () => {
    const id = newThread("Busy");
    await turn(id, 1);
    const [pid] = spawns();

    mock.timers.tick(REAP_MS - 1);
    await turn(id, 2);
    assert.equal(spawns().length, 1, "warm CLI reused");

    mock.timers.tick(REAP_MS - 1);
    await settle();
    assert.equal(alive(pid), true, "the first window was disarmed on reuse");

    mock.timers.tick(1);
    await waitFor(() => !alive(pid));
  });

  it("evicts the least recently used idle CLI past the cap of 3, not the oldest spawned", async () => {
    const [a, b, c, d] = ["A", "B", "C", "D"].map(newThread);
    await turn(a, 1);
    await turn(b, 1);
    await turn(c, 1);
    // A runs again on its warm CLI, so B is now least recently idled.
    await turn(a, 2);
    const [pidA, pidB, pidC] = spawns();
    assert.equal(spawns().length, 3);
    assert.deepEqual([pidA, pidB, pidC].map(alive), [true, true, true]);

    await turn(d, 1);
    const pidD = spawns()[3];
    await waitFor(() => !alive(pidB));
    await settle();
    assert.deepEqual(
      [pidA, pidC, pidD].map(alive),
      [true, true, true],
      "only the single LRU CLI is evicted",
    );

    // B's next turn cannot reuse the evicted CLI.
    await turn(b, 1);
    assert.equal(spawns().length, 5);
  });
});
