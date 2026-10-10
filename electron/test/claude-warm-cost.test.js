"use strict";

/**
 * #1435: Claude's total_cost_usd is a running total per process. Two turns on
 * one kept-alive CLI reporting 0.01 then 0.03 cost 0.03, not 0.04.
 *
 * Run: node --test electron/test/claude-warm-cost.test.js
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
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Kept-alive fake claude: each stdin turn emits the next cumulative total. */
function writeCumulativeFakeClaude(dir) {
  return writeFakeBin(
    path.join(dir, "fake-claude"),
    `#!/usr/bin/env node
"use strict";
const totals = [0.01, 0.03];
let turn = 0;
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
const fs = require("fs");
if (process.env.CODER_FAKE_CLAUDE_SPAWNS) {
  fs.appendFileSync(process.env.CODER_FAKE_CLAUDE_SPAWNS, process.pid + "\\n");
}
emit({ type: "system", subtype: "init", session_id: "sess-cost", model: "m" });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    emit({
      type: "result",
      subtype: "success",
      result: "ok",
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: totals[turn++],
      session_id: "sess-cost",
    });
  }
});
setInterval(() => {}, 500);
`,
  );
}

describe("warm Claude process cost (#1435)", () => {
  let tmpDir;
  let store;
  let runner;
  const saved = {};
  const ENV = ["CODER_SIMULATE", "CODER_AGENT_CMD", "CODER_CLAUDE_BIN", "CODER_FAKE_CLAUDE_SPAWNS"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-warm-cost-"));
    process.env.CODER_CLAUDE_BIN = writeCumulativeFakeClaude(tmpDir);
    process.env.CODER_FAKE_CLAUDE_SPAWNS = path.join(tmpDir, "spawns");
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("bills the growth of the running total, not the total, on a reused process", async () => {
    store = new Store(path.join(tmpDir, "store.json"));
    const spends = [];
    const recordSpend = store.recordSpend.bind(store);
    store.recordSpend = (usd, ...rest) => {
      spends.push(usd);
      return recordSpend(usd, ...rest);
    };
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: tmpDir });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id, title: "t" });
    store.saveNow();

    for (const prompt of ["one", "two"]) {
      const before = store.getUsage(thread.id)?.turns || 0;
      await runner.startRun({ threadId: thread.id, prompt });
      await waitFor(
        () =>
          store.getThread(thread.id).status === "done" &&
          (store.getUsage(thread.id)?.turns || 0) > before,
      );
    }

    const spawns = fs.readFileSync(process.env.CODER_FAKE_CLAUDE_SPAWNS, "utf8").trim().split("\n");
    assert.equal(spawns.length, 1, "both turns must run on one kept-alive process");
    assert.ok(Math.abs(store.getUsage(thread.id).costUsd - 0.03) < 1e-9);
    assert.equal(spends.length, 2);
    assert.ok(Math.abs(spends[0] - 0.01) < 1e-9);
    assert.ok(Math.abs(spends[1] - 0.02) < 1e-9);
  });
});
