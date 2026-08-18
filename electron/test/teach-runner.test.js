/**
 * Issue #373: the standing Teach note is CLI-only and reaches every provider
 * path because startRun concatenates teachNoteFor onto dispatchPrompt.
 * Generic (CODER_AGENT_CMD) is the cheapest provider to observe.
 *
 * Run: npm run test:electron
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

describe("teach note on dispatch", () => {
  let tmpDir;
  let store;
  let runner;
  let prevSimulate;
  let prevAgentCmd;
  let promptFile;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-teach-run-"));
    promptFile = path.join(tmpDir, "prompt.txt");
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });

    // No spaces: parseAgentCommand whitespace-splits CODER_AGENT_CMD.
    const dump =
      `require('fs').writeFileSync(${JSON.stringify(promptFile)},process.argv[process.argv.length-1]);process.exit(0)`;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${dump}`;
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("appends the Teach note to the CLI prompt, not the stored user message", async () => {
    const thread = store.getThreads()[0];
    services.startTeach(store, { threadId: thread.id });
    await runner.startRun({ threadId: thread.id, prompt: "teach me parsing" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const dumped = fs.readFileSync(promptFile, "utf8");
    assert.match(dumped, /teach me parsing/);
    assert.match(dumped, /\[Teach mode\]/);
    assert.match(dumped, /TODO\(human\)/);

    const user = store
      .getMessages(thread.id)
      .find((m) => m && m.role === "user");
    assert.ok(user);
    assert.equal(user.text, "teach me parsing");
    assert.doesNotMatch(String(user.text), /Teach mode/);
  });

  it("does not inject the note when teach is off", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "just ship it" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const dumped = fs.readFileSync(promptFile, "utf8");
    assert.match(dumped, /just ship it/);
    assert.doesNotMatch(dumped, /\[Teach mode\]/);
  });
});
