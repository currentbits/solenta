"use strict";

/**
 * Muse Code runner (#873). Fake CLI replays echo-hello.jsonl.
 * Echo has no tool start/result — no tool-card scenario.
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

/**
 * Fake muse CLI. Reads CODER_FAKE_MUSE_ARGV_FILE and CODER_FAKE_MUSE_SCENARIO.
 * @param {string} dir
 * @returns {string} script path
 */
function writeFakeMuse(dir) {
  const scriptPath = path.join(dir, "fake-muse.js");
  const body = `#!/usr/bin/env node
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
      HOME: process.env.HOME || "",
      SOLENTA_WORKTREE: process.env.SOLENTA_WORKTREE || "",
    }),
    "utf8",
  );
}

const scenario = process.env.CODER_FAKE_MUSE_SCENARIO || "success";
const fixture = process.env.CODER_FAKE_MUSE_FIXTURE || "";

if (scenario === "success" || scenario === "resume" || scenario === "bypass") {
  const text = fs.readFileSync(fixture, "utf8");
  for (const line of text.split("\\n")) {
    if (!line.trim()) continue;
    process.stdout.write(line + "\\n");
  }
  process.exit(0);
}

process.stderr.write("unknown scenario\\n");
process.exit(1);
`;
  return writeFakeBin(scriptPath, body);
}

describe("muse runner integration", () => {
  let tmpDir;
  let store;
  let runner;
  let fakeBin;
  let argvFile;
  let prev;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-muse-"));
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    git(projectDir, ["init"]);
    git(projectDir, ["config", "user.email", "t@t.com"]);
    git(projectDir, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
    git(projectDir, ["add", "."]);
    git(projectDir, ["commit", "-m", "init"]);

    fakeBin = writeFakeMuse(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");

    prev = {
      CODER_MUSE_BIN: process.env.CODER_MUSE_BIN,
      CODER_FAKE_MUSE_SCENARIO: process.env.CODER_FAKE_MUSE_SCENARIO,
      CODER_FAKE_MUSE_ARGV_FILE: process.env.CODER_FAKE_MUSE_ARGV_FILE,
      CODER_FAKE_MUSE_FIXTURE: process.env.CODER_FAKE_MUSE_FIXTURE,
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_MUSE_BIN = fakeBin;
    process.env.CODER_FAKE_MUSE_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_MUSE_FIXTURE = ECHO_HELLO;
    process.env.CODER_FAKE_MUSE_SCENARIO = "success";

    const storePath = path.join(tmpDir, "store.json");
    store = new Store(storePath);
    const project = await services.addProject(store, projectDir);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Muse Thread",
    });
    services.setProvider(store, { threadId: thread.id, provider: "muse" });
    store.saveNow();

    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 50,
      userDataPath: tmpDir,
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    for (const [k, v] of Object.entries(prev || {})) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readArgv() {
    return JSON.parse(fs.readFileSync(argvFile, "utf8"));
  }

  function readEnv() {
    return JSON.parse(fs.readFileSync(argvFile + ".env.json", "utf8"));
  }

  it("success: stores session id, assistant text once, argv, and XDG overlay env", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(store.getThread(thread.id).sessionId, ECHO_SESSION_ID);

    const assistants = store
      .getMessages(thread.id)
      .filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, ECHO_TEXT);
    assert.match(assistants[0].text, /hello/i);

    const argv = readArgv();
    assert.ok(argv.includes("exec"), `expected exec in ${JSON.stringify(argv)}`);
    assert.ok(argv.includes("--json"));
    const am = argv.indexOf("--approval-mode");
    assert.ok(am >= 0, `expected --approval-mode in ${JSON.stringify(argv)}`);
    assert.equal(argv[am + 1], "never");
    assert.ok(!argv.includes("--session-id"), "first turn omits --session-id");
    assert.ok(!argv.includes("--yolo"));
    assert.match(String(argv[argv.length - 1]), /hello/);

    const env = readEnv();
    const overlay = path.join(tmpDir, "muse-homes", thread.id);
    assert.equal(env.XDG_CONFIG_HOME, path.join(overlay, "config"));
    assert.ok(
      env.XDG_CONFIG_HOME.startsWith(path.join(tmpDir, "muse-homes", thread.id)),
    );
  });

  it("resume: later turns pass the stored --session-id", async () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { sessionId: ECHO_SESSION_ID });
    store.saveNow();
    process.env.CODER_FAKE_MUSE_SCENARIO = "resume";

    await runner.startRun({ threadId: thread.id, prompt: "hello again" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = readArgv();
    const i = argv.indexOf("--session-id");
    assert.ok(i >= 0, `expected --session-id in ${JSON.stringify(argv)}`);
    assert.equal(argv[i + 1], ECHO_SESSION_ID);
  });

  it("bypass: --disable-approval and no --yolo", async () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { permissionMode: "bypassPermissions" });
    store.saveNow();
    process.env.CODER_FAKE_MUSE_SCENARIO = "bypass";

    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = readArgv();
    assert.ok(
      argv.includes("--disable-approval"),
      `expected --disable-approval in ${JSON.stringify(argv)}`,
    );
    assert.ok(!argv.includes("--yolo"));
    assert.ok(!argv.includes("--approval-mode"));
  });

  it("fails the run when the overlay throws", async () => {
    // inject by making userDataPath a file, not a directory, so mkdirSync fails
    const filePath = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(filePath, "nope\n");
    const core = await loadCore();
    const failRunner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: filePath,
    });
    const thread = store.getThreads()[0];
    try {
      try {
        await failRunner.startRun({ threadId: thread.id, prompt: "hello" });
      } catch {
        // overlay fail-closed may throw after markRunFailed
      }
      await waitFor(() => store.getThread(thread.id).status === "failed");
      assert.equal(store.getThread(thread.id).status, "failed");
      assert.ok(
        store.getMessages(thread.id).some(
          (m) =>
            m.role === "event" && /Muse MCP overlay failed/i.test(m.text),
        ),
        "overlay throw must mark the run failed, not swallow",
      );
    } finally {
      failRunner.stopAll();
    }
  });
});
