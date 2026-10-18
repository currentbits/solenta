"use strict";

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
const {
  createThrashTracker,
  commandKey,
  failureSignature,
  isEditTool,
} = require("../thrash.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

const FAIL = "Exit code 1\nTypeError: foo is not a function\n    at run (12ms)";

describe("thrash tracker (#391)", () => {
  it("fires on the third identical failure with an edit before each retry", () => {
    const t = createThrashTracker();
    assert.equal(t.noteFailure("a", "Bash: npm test", FAIL), null);
    t.noteEdit("a");
    assert.equal(t.noteFailure("a", "Bash: npm test", FAIL.replace("12ms", "40ms")), null);
    t.noteEdit("a");
    const hit = t.noteFailure("a", "Bash: npm test", FAIL);
    assert.equal(hit.count, 3);
    assert.equal(hit.key, "Bash: npm test");
    assert.match(hit.signature, /TypeError: foo is not a function/);
    // Fired once; the count starts over.
    t.noteEdit("a");
    assert.equal(t.noteFailure("a", "Bash: npm test", FAIL), null);
  });

  it("ignores re-runs without an edit, and restarts on a new error or a pass", () => {
    const t = createThrashTracker();
    t.noteFailure("a", "k", FAIL);
    for (let i = 0; i < 5; i++) assert.equal(t.noteFailure("a", "k", FAIL), null);
    t.noteEdit("a");
    t.noteFailure("a", "k", FAIL); // 2
    t.noteEdit("a");
    t.noteFailure("a", "k", "Error: something else"); // progress → 1
    t.noteEdit("a");
    assert.equal(t.noteFailure("a", "k", "Error: something else"), null); // 2
    t.noteOk("a", "k");
    t.noteEdit("a");
    assert.equal(t.noteFailure("a", "k", "Error: something else"), null); // 1
    // Other threads are separate.
    assert.equal(t.noteFailure("b", "k", FAIL), null);
  });

  it("tracks one recovery per problem", () => {
    const t = createThrashTracker();
    assert.equal(t.recovered("a"), false);
    t.markRecovered("a");
    assert.equal(t.recovered("a"), true);
    t.noteSuccess("a");
    assert.equal(t.recovered("a"), false);
  });

  it("keys a command without its description and keeps distinct errors apart", () => {
    assert.equal(
      commandKey("Bash", JSON.stringify({ command: "npm  test", description: "try 1" }, null, 2)),
      commandKey("Bash", JSON.stringify({ command: "npm test", description: "try 2" })),
    );
    assert.equal(commandKey("Command", "npm test"), "Command: npm test");
    assert.notEqual(
      failureSignature("Error: Cannot find module 'a'"),
      failureSignature("Error: Cannot find module 'b'"),
    );
    assert.ok(isEditTool("Edit") && isEditTool("apply_patch") && !isEditTool("Bash"));
  });
});

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
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
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Claude that edits, runs the same failing test three times, then hangs. */
function writeThrashingClaude(dir) {
  return writeFakeBin(
    path.join(dir, "fake-claude.js"),
    `"use strict";
const fs = require("fs");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "sess-thrash", model: "m" });
if (process.env.CODER_FAKE_THRASH_EDIT_ONLY) {
  // One "fix" per turn; the verify gate does the failing.
  emit({ type: "assistant", message: { content: [
    { type: "tool_use", id: "edit-" + Date.now(), name: "Edit", input: { file_path: "a.js" } } ] } });
  emit({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "edit-" + Date.now(), content: "ok" } ] } });
  emit({ type: "result", subtype: "success", result: "fixed", session_id: "sess-thrash",
    usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
for (let i = 0; i < 3; i++) {
  fs.writeFileSync("dirty.txt", "attempt " + i);
  emit({ type: "assistant", message: { content: [
    { type: "tool_use", id: "edit-" + i, name: "Edit", input: { file_path: "a.js" } } ] } });
  emit({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "edit-" + i, content: "ok" } ] } });
  emit({ type: "assistant", message: { content: [
    { type: "tool_use", id: "bash-" + i, name: "Bash", input: { command: "npm test", description: "try " + i } } ] } });
  emit({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "bash-" + i, is_error: true, content: ${JSON.stringify(FAIL)} } ] } });
}
setTimeout(() => process.exit(0), 30000);
`,
  );
}

describe("thrash detector in the runner (#391)", () => {
  let tmpDir;
  let store;
  let runner;
  let worktree;
  let checkpoint;
  const saved = {};
  const ENV = ["CODER_CLAUDE_BIN", "CODER_OPENCODE_BIN", "CODER_SIMULATE", "CODER_FAKE_THRASH_EDIT_ONLY"];

  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-thrash-"));
    process.env.CODER_CLAUDE_BIN = writeThrashingClaude(tmpDir);
    process.env.CODER_OPENCODE_BIN = writeFakeBin(
      path.join(tmpDir, "fake-opencode.js"),
      "process.exit(0);\n",
    );
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15, userDataPath: tmpDir });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "a.js"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, { projectId: project.id, title: "Thrash" });

    // A worktree with one finished turn to roll back to.
    worktree = path.join(tmpDir, "worktrees", "wt");
    git(repo, ["worktree", "add", "-b", "thrash", worktree]);
    fs.writeFileSync(path.join(worktree, "a.js"), "good\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "coder-checkpoint: turn 1"]);
    checkpoint = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree }).toString().trim();
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { worktreePath: worktree, provider: "claude" });
    services.setSettings(store, { quotaFailover: ["opencode"] });
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("stops the loop, rolls back, and retries on another provider", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "make the tests pass" });

    await waitFor(() =>
      store.getMessages(thread.id).some((m) => String(m.text).startsWith("[thrash detector]")),
    );
    const msgs = store.getMessages(thread.id);
    const note = msgs.find((m) => m.role === "event" && String(m.text).startsWith("Thrash detector:"));
    assert.ok(note, "no explanation event");
    assert.match(note.text, /Claude Code hit the same failure 3 times/);
    assert.match(note.text, /Failing: Bash: npm test/);
    assert.match(note.text, /TypeError: foo is not a function/);
    assert.match(note.text, /Rolled the worktree back to turn 1/);
    assert.match(note.text, /Retrying on OpenCode/);

    assert.equal(store.getThread(thread.id).provider, "opencode");
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree }).toString().trim(),
      checkpoint,
    );
    assert.equal(fs.existsSync(path.join(worktree, "dirty.txt")), false);

    const retry = msgs.find((m) => m.role === "user" && String(m.text).startsWith("[thrash detector]"));
    assert.match(retry.text, /Original request:\nmake the tests pass/);
  });

  it("hands a verify loop that keeps failing the same way to another provider", async () => {
    process.env.CODER_FAKE_THRASH_EDIT_ONLY = "1";
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { verifyCommand: "echo 'Error: still broken'; exit 1" });
    await runner.startRun({ threadId: thread.id, prompt: "fix the build" });

    await waitFor(() =>
      store.getMessages(thread.id).some((m) => String(m.text).startsWith("[thrash detector]")),
    );
    const msgs = store.getMessages(thread.id);
    assert.equal(
      msgs.filter((m) => String(m.text).startsWith("Verification failed:")).length,
      3,
    );
    const note = msgs.find((m) => m.role === "event" && String(m.text).startsWith("Thrash detector:"));
    assert.match(note.text, /Failing: verify: echo/);
    assert.match(note.text, /Error: still broken/);
    // Never verified green, so nothing to roll back to.
    assert.match(note.text, /No green checkpoint/);
    assert.equal(store.getThread(thread.id).provider, "opencode");
  });
});
