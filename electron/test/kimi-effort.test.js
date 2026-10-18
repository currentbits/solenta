"use strict";

/**
 * Kimi effort rides KIMI_MODEL_THINKING_EFFORT on the child env (#451),
 * replacing the old config.toml flip. KIMI_CODE_HOME points at a temp dir
 * so the runner test never touches the user's real ~/.kimi-code.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const { kimiEffortEnv } = require("../kimi.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { rmTree } = require("./support/rmTree.js");

const CONFIG = `default_model = "kimi-code/k3"

[thinking]
enabled = true
effort = "high"
`;

let tmpHome;
let prevHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "coder-kimi-home-"));
  prevHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = tmpHome;
  fs.writeFileSync(path.join(tmpHome, "config.toml"), CONFIG);
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = prevHome;
  await rmTree(tmpHome);
});

describe("kimiEffortEnv", () => {
  it("sets the env only for an effort the model declares", () => {
    assert.deepEqual(kimiEffortEnv("low", ["low", "high", "max"]), {
      KIMI_MODEL_THINKING_EFFORT: "low",
    });
    // The env bypasses kimi's own support_efforts check, so an undeclared
    // level must never reach the wire.
    assert.equal(kimiEffortEnv("max", []), null);
    assert.equal(kimiEffortEnv("medium", ["low", "high", "max"]), null);
    assert.equal(kimiEffortEnv(null, ["low"]), null);
    assert.equal(kimiEffortEnv("", ["low"]), null);
  });
});

describe("runner wires thread.reasoningEffort to KIMI_MODEL_THINKING_EFFORT", () => {
  // startKimiRun -> kimiEffortEnv is the feature's ONLY connection to the
  // app; nulling it must turn this red (round 35 review, mutation M8b).
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

  /**
   * Run one kimi turn through the real runner with a fake CLI that records
   * the effort env it was spawned with. `patch` lands on the thread after
   * the effort is set (a model switch can leave a stale effort behind).
   * @param {{ effort: string, patch?: object }} opts
   * @returns {Promise<string>} what the child saw ("unset" when absent)
   */
  async function seenEffort({ effort, patch }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-kimi-run-"));
    const seenFile = path.join(tmpDir, "seen-effort.txt");
    const fakeKimi = writeFakeBin(
      path.join(tmpDir, "fake-kimi"),
      `#!/usr/bin/env node
"use strict";
const fs = require("fs");
fs.writeFileSync(
  process.env.CODER_FAKE_KIMI_SEEN_FILE,
  process.env.KIMI_MODEL_THINKING_EFFORT || "unset",
);
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "text", text: "ok" });
emit({ type: "usage", input_tokens: 1, output_tokens: 1 });
`,
    );

    const prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_FAKE_KIMI_SEEN_FILE: process.env.CODER_FAKE_KIMI_SEEN_FILE,
      KIMI_MODEL_THINKING_EFFORT: process.env.KIMI_MODEL_THINKING_EFFORT,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.KIMI_MODEL_THINKING_EFFORT;
    process.env.CODER_KIMI_BIN = fakeKimi;
    process.env.CODER_FAKE_KIMI_SEEN_FILE = seenFile;

    let runner;
    try {
      const projectDir = path.join(tmpDir, "proj");
      fs.mkdirSync(projectDir);
      git(projectDir, ["init"]);
      git(projectDir, ["config", "user.email", "t@t.com"]);
      git(projectDir, ["config", "user.name", "t"]);
      fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
      git(projectDir, ["add", "."]);
      git(projectDir, ["commit", "-m", "init"]);

      const store = new Store(path.join(tmpDir, "store.json"));
      const core = await loadCore();
      runner = createRunner({ store, core, pushFn() {}, tickMs: 15 });
      const project = await services.addProject(store, projectDir);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Kimi Effort",
      });
      services.setProvider(store, { threadId: thread.id, provider: "kimi" });
      services.setReasoningEffort(store, { threadId: thread.id, effort });
      if (patch) store.updateThread(thread.id, patch);

      await runner.startRun({ threadId: thread.id, prompt: "check effort" });
      await waitFor(() => store.getThread(thread.id).status === "done");
      return fs.readFileSync(seenFile, "utf8");
    } finally {
      if (runner) runner.stopAll();
      await rmTree(tmpDir);
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("a kimi thread's effort reaches the child env and config.toml is untouched", async () => {
    assert.equal(await seenEffort({ effort: "low" }), "low");
    assert.equal(
      fs.readFileSync(path.join(tmpHome, "config.toml"), "utf8"),
      CONFIG,
      "effort no longer edits the user's config",
    );
  });

  it("a model without that effort gets no env (stale effort after a model switch)", async () => {
    assert.equal(
      await seenEffort({
        effort: "max",
        patch: { model: "kimi-code/kimi-for-coding-highspeed" },
      }),
      "unset",
    );
  });
});
