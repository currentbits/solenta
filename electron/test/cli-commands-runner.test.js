/**
 * Runner join for CLI slash expansion (#606): `/commit the tests` stays
 * in the transcript, the grok `-p` prompt is the SKILL.md body.
 *
 * Run: npm run test:electron -- electron/test/cli-commands-runner.test.js
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

describe("runner expands /skill before the CLI sees it", () => {
  let tmpDir;
  let store;
  let runner;
  let argvFile;
  const prevEnv = {};

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cli-run-"));
    argvFile = path.join(tmpDir, "argv.json");
    for (const k of [
      "CODER_SIMULATE",
      "CODER_GROK_BIN",
      "CODER_FAKE_GROK_ARGV_FILE",
      "HOME",
    ]) {
      prevEnv[k] = process.env[k];
    }
    delete process.env.CODER_SIMULATE;
    process.env.HOME = tmpDir;
    process.env.CODER_FAKE_GROK_ARGV_FILE = argvFile;

    const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_GROK_ARGV_FILE) {
  fs.writeFileSync(process.env.CODER_FAKE_GROK_ARGV_FILE, JSON.stringify(process.argv.slice(1)), "utf8");
}
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
emit({type:"system",subtype:"init",session_id:"g-skill-1",model:"grok-4.6"});
emit({type:"assistant",message:{content:[{type:"text",text:"ok"}]}});
emit({type:"result",subtype:"success",is_error:false,result:"ok",usage:{input_tokens:1,output_tokens:2},total_cost_usd:0,num_turns:1,session_id:"g-skill-1"});
process.exit(0);
`;
    process.env.CODER_GROK_BIN = writeFakeBin(
      path.join(tmpDir, "fake-grok"),
      body,
    );

    const skillDir = path.join(tmpDir, ".claude", "skills", "commit");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: commit\ndescription: Commit staged work\n---\n\nLook at git diff --staged and commit.\n",
    );

    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: tmpDir,
    });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Skill",
    });
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
    store.saveNow();
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    runner = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("sends the skill body on -p and keeps /commit in the transcript", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({
      threadId: thread.id,
      prompt: "/commit the tests",
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const users = (store.getMessages(thread.id) || [])
      .filter((m) => m.role === "user")
      .map((m) => m.text);
    assert.ok(users.includes("/commit the tests"));

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const pIdx = argv.indexOf("-p");
    assert.ok(pIdx >= 0, `expected -p in ${JSON.stringify(argv)}`);
    const sent = String(argv[pIdx + 1]);
    assert.match(sent, /Look at git diff --staged and commit/);
    assert.match(sent, /the tests/);
    assert.ok(
      !sent.trimStart().startsWith("/commit"),
      "CLI prompt must be the expanded skill, not the slash token",
    );
  });
});
