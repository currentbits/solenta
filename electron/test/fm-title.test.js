const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { maybeApplyFmTitle } = require("../fm-title.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Write an executable fake fm that runs `body` as node. */
function writeFakeFm(dir, body) {
  const bin = path.join(dir, "fake-fm");
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function seedFirstTurn(store, threadId, userText, assistantText) {
  store.appendMessage(threadId, {
    id: "m-user",
    role: "user",
    text: userText,
    createdAt: Date.now(),
  });
  store.appendMessage(threadId, {
    id: "m-asst",
    role: "assistant",
    text: assistantText,
    createdAt: Date.now() + 1,
  });
}

describe("maybeApplyFmTitle", () => {
  let tmpDir;
  let store;
  let thread;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fm-title-"));
    store = new Store(path.join(tmpDir, "store.json"));

    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves a sanitised fm title after the first assistant reply", async () => {
    const userText = "Fix the flaky login test in auth.spec.ts";
    seedFirstTurn(store, thread.id, userText, "I'll look at the failing spec.");
    // Production path: startRun already stamped the first prompt line.
    store.updateThread(thread.id, {
      title: userText.slice(0, services.THREAD_TITLE_MAX),
    });

    const bin = writeFakeFm(
      tmpDir,
      `console.log('  "Fix login flake."  \\nextra');`,
    );
    const saved = await maybeApplyFmTitle(store, thread.id, {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    assert.equal(saved, "Fix login flake");
    assert.equal(store.getThread(thread.id).title, "Fix login flake");
    assert.ok(store.getThread(thread.id).fmTitleAt);
  });

  it("leaves the title untouched when fm is unavailable", async () => {
    seedFirstTurn(store, thread.id, "Do a thing", "Done.");
    assert.equal(store.getThread(thread.id).title, "New Thread");

    const saved = await maybeApplyFmTitle(store, thread.id, {
      env: { ...process.env, CODER_FM_BIN: "/nope/fm" },
    });
    assert.equal(saved, null);
    assert.equal(store.getThread(thread.id).title, "New Thread");
  });

  it("never overwrites a user-set title", async () => {
    const titled = services.renameThread(store, {
      threadId: thread.id,
      title: "Ship checklist",
    });
    assert.equal(titled.title, "Ship checklist");
    seedFirstTurn(
      store,
      thread.id,
      "Please walk the release checklist",
      "Starting with the first item.",
    );

    const bin = writeFakeFm(tmpDir, `console.log("Overwrite me");`);
    const saved = await maybeApplyFmTitle(store, thread.id, {
      env: { ...process.env, CODER_FM_BIN: bin },
    });
    assert.equal(saved, null);
    assert.equal(store.getThread(thread.id).title, "Ship checklist");
  });
});
