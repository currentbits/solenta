"use strict";

/**
 * Idle compaction (#1765) claims a thread with idleCompactedAt so a slow
 * tick cannot double-fire. Any OTHER turn must clear that claim (the guard
 * added to electron/runner.js startRunFolded) so the thread is eligible
 * again next time it goes idle. This is the one piece of the feature that
 * lives inside the shared startRun path rather than idleCompact.js, so it
 * gets its own real-runner integration test instead of a stubbed one.
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

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

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

/** Fake claude: one assistant line, then a result event. */
function writeFakeClaude(dir) {
  const scriptPath = path.join(dir, "fake-claude.js");
  const body = `#!/usr/bin/env node
"use strict";
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
emit({ type: "system", subtype: "init", session_id: "sess-idle-compact", model: "m" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
emit({
  type: "result",
  subtype: "success",
  result: "ok",
  session_id: "sess-idle-compact",
  usage: { input_tokens: 10, output_tokens: 5 },
  total_cost_usd: 0.001,
  errors: [],
});
process.exit(0);
`;
  return writeFakeBin(scriptPath, body);
}

describe("idle-compact claim is cleared by any other turn (#1765)", () => {
  let tmpDir;
  let store;
  let runner;
  let prevBin;

  beforeEach(async () => {
    prevBin = process.env.CODER_CLAUDE_BIN;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-idle-compact-runner-"));
    store = new Store(path.join(tmpDir, "store.json"));
    process.env.CODER_CLAUDE_BIN = writeFakeClaude(tmpDir);

    const core = await loadCore();
    runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15 });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    await services.addProject(store, repo);
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    if (prevBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevBin;
  });

  it("an ordinary user turn clears a stale idleCompactedAt claim", async () => {
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Idle thread",
    });
    // Simulate a prior idle-compact claim that was never cleared.
    store.updateThread(thread.id, { idleCompactedAt: Date.now() - 1000 });
    assert.ok(store.getThread(thread.id).idleCompactedAt != null);

    await runner.startRun({ threadId: thread.id, prompt: "a normal message" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(
      store.getThread(thread.id).idleCompactedAt,
      null,
      "a real turn re-arms idle compaction",
    );
  });

  it("the idle-compact call itself (fromIdleCompact) does not erase its own claim", async () => {
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Idle thread",
    });
    const claimedAt = Date.now() - 1000;
    store.updateThread(thread.id, { idleCompactedAt: claimedAt });

    await runner.startRun({
      threadId: thread.id,
      prompt: "/compact",
      fromIdleCompact: true,
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(store.getThread(thread.id).idleCompactedAt, claimedAt);
  });
});
