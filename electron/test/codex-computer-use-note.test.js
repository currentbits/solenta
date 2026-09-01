/**
 * Issue #800: gpt-5.6-sol invents a Solenta "enable automation / agentmux"
 * toggle when Computer Use tools are missing. Official Computer Use is a
 * Codex Desktop plugin, not a CLI flag and not a Solenta setting.
 *
 * The product fix is a Codex-only standing dispatch note. Do not add
 * `--enable computer_use` to buildArgs — the feature flag is already on.
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
const { getProvider } = require("../providers.js");

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

describe("codexComputerUseNoteFor", () => {
  it("is silent for every provider except Codex", () => {
    assert.equal(services.codexComputerUseNoteFor("claude"), "");
    assert.equal(services.codexComputerUseNoteFor("grok"), "");
    assert.equal(services.codexComputerUseNoteFor("cursor"), "");
    assert.equal(services.codexComputerUseNoteFor(null), "");
    assert.equal(services.codexComputerUseNoteFor(undefined), "");
  });

  it("tells Codex the truth: no Solenta toggle, install from Desktop", () => {
    const note = services.codexComputerUseNoteFor("codex");
    assert.match(note, /\[Computer use\]/);
    assert.match(note, /codex exec/);
    assert.match(note, /Desktop/);
    assert.match(note, /do not invent/i);
    assert.doesNotMatch(note, /--enable computer_use/);
    assert.equal(note, services.CODEX_COMPUTER_USE_NOTE);
  });
});

describe("codex buildArgs does not fake a computer-use flag", () => {
  it("fresh and resume omit computer_use / --enable", () => {
    const fresh = getProvider("codex").buildArgs({ prompt: "p" });
    const resume = getProvider("codex").buildArgs({
      prompt: "p",
      sessionId: "sess-1",
    });
    for (const args of [fresh, resume]) {
      assert.ok(
        !args.includes("computer_use"),
        `must not mention computer_use: ${JSON.stringify(args)}`,
      );
    }
  });
});

describe("computer-use note on dispatch", () => {
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cu-note-"));
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

  it("appends the note to the CLI prompt, not the stored user message", async () => {
    const thread = store.getThreads()[0];
    // Generic dump CLI (CODER_AGENT_CMD). Spy the note so we observe
    // wiring without spawning real Codex.
    const seen = [];
    const orig = services.codexComputerUseNoteFor;
    services.codexComputerUseNoteFor = (provider) => {
      seen.push(provider);
      return "\n\n[Computer use] SENTINEL";
    };
    try {
      await runner.startRun({
        threadId: thread.id,
        prompt: "click the login button",
      });
      await waitFor(() => {
        const t = store.getThread(thread.id);
        return t && (t.status === "done" || t.status === "failed");
      });
    } finally {
      services.codexComputerUseNoteFor = orig;
    }

    assert.equal(seen.length, 1, "startRun must call codexComputerUseNoteFor");
    assert.equal(seen[0], store.getThread(thread.id).provider);
    const dumped = fs.readFileSync(promptFile, "utf8");
    assert.match(dumped, /click the login button/);
    assert.match(dumped, /\[Computer use\] SENTINEL/);

    const user = store
      .getMessages(thread.id)
      .find((m) => m && m.role === "user");
    assert.ok(user);
    assert.equal(user.text, "click the login button");
    assert.doesNotMatch(String(user.text), /Computer use/);
  });

  it("does not inject the note on non-Codex threads", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "just ship it" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const dumped = fs.readFileSync(promptFile, "utf8");
    assert.match(dumped, /just ship it/);
    assert.doesNotMatch(dumped, /\[Computer use\]/);
  });
});
