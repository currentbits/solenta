"use strict";

/**
 * Workflow muse phases must persist stream.id on the workflow agent
 * (not thread.sessionId) and emit --session-id on a later spawn of that
 * same agent. Never --last. Overlay throw fails the phase (#873).
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const { spawnPhaseAgent } = require("../workflow.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");

const ECHO_HELLO = path.join(__dirname, "fixtures", "muse", "echo-hello.jsonl");
const ECHO_SESSION_ID = "01a06856-a922-7ec0-a75a-aa6eab933dff";
const ECHO_TEXT =
  "echo: Reply with the single word hello and do not use tools.";

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

function writeDumpingMuse(dir) {
  const argvFile = path.join(dir, "muse-argv.json");
  const fakeMuse = writeFakeBin(
    path.join(dir, "fake-muse"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_MUSE_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_MUSE_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
  fs.writeFileSync(
    process.env.CODER_FAKE_MUSE_ARGV_FILE + ".env.json",
    JSON.stringify({
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || "",
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || "",
    }),
    "utf8",
  );
}
const fixture = process.env.CODER_FAKE_MUSE_FIXTURE || "";
const text = fs.readFileSync(fixture, "utf8");
for (const line of text.split("\\n")) {
  if (!line.trim()) continue;
  process.stdout.write(line + "\\n");
}
`,
  );
  return { fakeMuse, argvFile };
}

function readArgv(argvFile) {
  assert.ok(fs.existsSync(argvFile), "fake muse must dump process.argv");
  return JSON.parse(fs.readFileSync(argvFile, "utf8"));
}

function readEnv(argvFile) {
  const envFile = argvFile + ".env.json";
  assert.ok(fs.existsSync(envFile), "fake muse must dump overlay env");
  return JSON.parse(fs.readFileSync(envFile, "utf8"));
}

function assertNeverLastFlag(argv) {
  assert.ok(
    !argv.includes("--last"),
    `--last must never be emitted: ${JSON.stringify(argv)}`,
  );
}

function spawnMuse(tmpDir, extra) {
  return spawnPhaseAgent({
    providerId: "muse",
    prompt: extra.prompt || "first pass",
    cwd: path.join(tmpDir, "proj"),
    model: null,
    userDataPath: extra.userDataPath !== undefined ? extra.userDataPath : tmpDir,
    threadId: extra.threadId || "tid-muse",
    overlayKey: extra.overlayKey || "phase-a",
    sessionId: extra.sessionId,
  });
}

describe("workflow muse phase session resume (#873)", () => {
  let tmpDir;
  let fakeMuse;
  let argvFile;
  let prev;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-muse-resume-"));
    fs.mkdirSync(path.join(tmpDir, "proj"));
    ({ fakeMuse, argvFile } = writeDumpingMuse(tmpDir));
    prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_MUSE_BIN: process.env.CODER_MUSE_BIN,
      CODER_FAKE_MUSE_ARGV_FILE: process.env.CODER_FAKE_MUSE_ARGV_FILE,
      CODER_FAKE_MUSE_FIXTURE: process.env.CODER_FAKE_MUSE_FIXTURE,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_MUSE_BIN = fakeMuse;
    process.env.CODER_FAKE_MUSE_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_MUSE_FIXTURE = ECHO_HELLO;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("fresh spawn captures stream.id, omits --session-id, never --last, sets XDG overlay", async () => {
    const { done } = spawnMuse(tmpDir, { prompt: "first pass" });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    assert.equal(
      result.sessionId,
      ECHO_SESSION_ID,
      "phase child must surface extractSessionId (stream.id)",
    );
    assert.equal(result.text, ECHO_TEXT, "terminal is a snapshot, not concat");

    const argv = readArgv(argvFile);
    assert.ok(
      !argv.includes("--session-id"),
      `fresh spawn must not --session-id: ${JSON.stringify(argv)}`,
    );
    assertNeverLastFlag(argv);

    const env = readEnv(argvFile);
    const overlay = path.join(tmpDir, "muse-homes", "tid-muse", "phase-a");
    assert.equal(env.XDG_CONFIG_HOME, path.join(overlay, "config"));
  });

  it("retry spawn with a real session id emits --session-id and never --last", async () => {
    const { done } = spawnMuse(tmpDir, {
      prompt: "retry pass",
      sessionId: ECHO_SESSION_ID,
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    assert.equal(result.sessionId, ECHO_SESSION_ID);

    const argv = readArgv(argvFile);
    const sIdx = argv.indexOf("--session-id");
    assert.ok(sIdx >= 0, `expected --session-id: ${JSON.stringify(argv)}`);
    assert.equal(argv[sIdx + 1], ECHO_SESSION_ID);
    assertNeverLastFlag(argv);
  });

  it("cwd sentinel and empty session id never emit --session-id or --last", async () => {
    for (const sessionId of ["cwd", "", null]) {
      if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);
      const { done } = spawnMuse(tmpDir, {
        prompt: "no resume",
        sessionId,
      });
      const result = await done;
      assert.equal(result.ok, true, result.stderr);
      const argv = readArgv(argvFile);
      assert.ok(
        !argv.includes("--session-id"),
        `sessionId=${JSON.stringify(sessionId)} must not --session-id: ${JSON.stringify(argv)}`,
      );
      assertNeverLastFlag(argv);
      assert.ok(
        !argv.includes("cwd"),
        `must not pass cwd as a session: ${JSON.stringify(argv)}`,
      );
    }
  });

  it("overlay throw fails the phase and does not spawn muse", async () => {
    const filePath = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(filePath, "nope\n");
    const { done } = spawnMuse(tmpDir, {
      prompt: "overlay fail",
      userDataPath: filePath,
    });
    const result = await done;
    assert.equal(result.ok, false);
    assert.match(String(result.stderr), /overlay/i);
    assert.ok(
      !fs.existsSync(argvFile),
      "must not spawn muse after overlay throw",
    );
  });

  it("startWorkflowRun stores the id on the agent, not thread.sessionId", async () => {
    const projectDir = path.join(tmpDir, "proj");
    git(projectDir, ["init"]);
    git(projectDir, ["config", "user.email", "t@t.com"]);
    git(projectDir, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
    git(projectDir, ["add", "."]);
    git(projectDir, ["commit", "-m", "init"]);

    const store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    /** @type {object[]} */
    const workflows = [];
    const runner = createRunner({
      store,
      core,
      pushFn(channel, payload) {
        if (payload && payload.workflow) {
          workflows.push(payload.workflow);
        }
      },
      tickMs: 15,
      userDataPath: tmpDir,
    });
    try {
      const project = await services.addProject(store, projectDir);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Muse Resume",
      });
      services.setProvider(store, { threadId: thread.id, provider: "muse" });
      const tmpl = services.saveTemplate(store, {
        name: "Muse resume",
        phases: [
          {
            name: "plan",
            agentCount: 1,
            instruction: "Plan briefly.",
            provider: "muse",
            model: null,
          },
        ],
      });

      await runner.startWorkflowRun({
        threadId: thread.id,
        prompt: "resume task",
        templateId: tmpl.id,
      });
      await waitFor(() => {
        const t = store.getThread(thread.id);
        return t && (t.status === "done" || t.status === "failed");
      });
      assert.equal(store.getThread(thread.id).status, "done");
      assert.equal(
        store.getThread(thread.id).sessionId,
        null,
        "workflow muse session must not land on the parent thread",
      );

      const seenAgent = workflows
        .flatMap((w) => w.phases || [])
        .flatMap((p) => p.agents || [])
        .find((a) => a.sessionId === ECHO_SESSION_ID);
      assert.ok(
        seenAgent,
        "workflow agent must carry the captured session id",
      );

      const argv = readArgv(argvFile);
      assert.ok(!argv.includes("--session-id"), "first spawn of a phase is fresh");
      assertNeverLastFlag(argv);

      const env = readEnv(argvFile);
      assert.ok(
        env.XDG_CONFIG_HOME.startsWith(
          path.join(tmpDir, "muse-homes", thread.id),
        ),
        `XDG_CONFIG_HOME under muse-homes/<threadId>: ${env.XDG_CONFIG_HOME}`,
      );
      assert.match(
        env.XDG_CONFIG_HOME,
        /0-plan-0/,
        "parallel phases isolate overlayKey under the thread overlay",
      );
    } finally {
      runner.stopAll();
    }
  });
});
