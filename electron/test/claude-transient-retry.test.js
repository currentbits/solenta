/**
 * Transient Claude failures (529 overloaded, 5xx, Cloudflare pages) retry the
 * same turn in place on the same session; everything else fails at once.
 * Run: node --test electron/test/claude-transient-retry.test.js
 */
const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { Store } = require("../store.js");
const services = require("../services.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { createRunner, classifyClaudeTransient } = require("../runner.js");

const OVERLOADED =
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

describe("classifyClaudeTransient", () => {
  it("matches overloaded, API 5xx and Cloudflare edge pages", () => {
    assert.equal(classifyClaudeTransient({ result: OVERLOADED }), "overloaded");
    assert.equal(classifyClaudeTransient({ errors: ["Overloaded"] }), "overloaded");
    assert.equal(classifyClaudeTransient({ result: "API Error: 500 Internal server error" }), "unavailable");
    assert.equal(classifyClaudeTransient({ errors: ["API Error: 503 upstream connect error"] }), "unavailable");
    assert.equal(
      classifyClaudeTransient({ result: "API Error: 403 <!DOCTYPE html><title>Attention Required! | Cloudflare</title>" }),
      "unavailable",
    );
    assert.equal(
      classifyClaudeTransient({ result: "API Error: 502 <html><body>cloudflare</body></html>" }),
      "unavailable",
    );
  });

  it("never matches auth, quota, rate limits, session loss or cancels", () => {
    for (const result of [
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}',
      "Invalid API key · Please run /login",
      "API Error: 403 Forbidden: your organization does not have access",
      "API Error: 429 rate_limit_error",
      "Claude AI usage limit reached|1763060400",
      "5-hour limit reached ∙ resets 3pm",
      "No conversation found with session ID: abc",
      "cancelled",
      "Write failed: file is locked",
      "",
    ]) {
      assert.equal(classifyClaudeTransient({ result }), null, result);
    }
    assert.equal(classifyClaudeTransient({ errors: ["cancelled"], result: OVERLOADED }), null);
    assert.equal(classifyClaudeTransient(undefined), null);
  });
});

/** Fake claude: fails the first $CODER_FAKE_FAILS user lines with $CODER_FAKE_ERR. */
function fakeClaude(dir) {
  return writeFakeBin(
    path.join(dir, "fake-claude"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
fs.appendFileSync(process.env.CODER_FAKE_SPAWNS, JSON.stringify(process.argv.slice(2)) + "\\n");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "s1", model: "m" });
let buf = "";
let n = 0;
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    n++;
    fs.appendFileSync(process.env.CODER_FAKE_SENDS, JSON.stringify(msg.message.content) + "\\n");
    const err = process.env.CODER_FAKE_ERR;
    // Counted across processes, so a respawned CLI continues the sequence.
    const total = fs.readFileSync(process.env.CODER_FAKE_SENDS, "utf8").trim().split("\\n").length;
    if (total <= Number(process.env.CODER_FAKE_FAILS)) {
      emit({ type: "assistant", error: "server_error", message: { model: "<synthetic>", content: [{ type: "text", text: err }] } });
      emit({ type: "result", subtype: "success", is_error: true, result: err, session_id: "s1",
        usage: { input_tokens: 0, output_tokens: 0 } });
      if (process.env.CODER_FAKE_EXIT_ON_FAIL) setImmediate(() => process.exit(1));
    } else {
      emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
      emit({ type: "result", subtype: "success", result: "ok", session_id: "s1",
        usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        total_cost_usd: 0.01 });
    }
  }
});
setInterval(() => {}, 500);
`,
  );
}

describe("Claude runner: transient retry", () => {
  const ENV = ["CODER_SIMULATE", "CODER_AGENT_CMD", "CODER_CLAUDE_BIN", "CODER_FAKE_SPAWNS",
    "CODER_FAKE_SENDS", "CODER_FAKE_FAILS", "CODER_FAKE_ERR", "CODER_FAKE_EXIT_ON_FAIL"];
  const saved = {};
  let tmpDir;
  let runner;
  let store;
  let thread;

  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-transient-"));
    process.env.CODER_CLAUDE_BIN = fakeClaude(tmpDir);
    process.env.CODER_FAKE_SPAWNS = path.join(tmpDir, "spawns");
    process.env.CODER_FAKE_SENDS = path.join(tmpDir, "sends");
    process.env.CODER_FAKE_ERR = OVERLOADED;
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: tmpDir });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "t" });
    store.saveNow();
    // Only setTimeout: the runner's tick interval and child I/O stay real.
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    mock.timers.reset();
    if (runner) runner.stopAll();
    // rmSync: async rm's retry timer can stall after a mocked-timer test.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 7, retryDelay: 50 });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const sends = () => {
    try {
      return fs.readFileSync(process.env.CODER_FAKE_SENDS, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const spawns = () => fs.readFileSync(process.env.CODER_FAKE_SPAWNS, "utf8").trim().split("\n").length;
  const events = () => store.getMessages(thread.id).filter((m) => m.role === "event").map((m) => m.text);
  const status = () => store.getThread(thread.id).status;
  /** Poll on setImmediate: setTimeout is mocked. */
  async function until(cond, what) {
    const deadline = Date.now() + 15000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(events())}`);
      await new Promise((r) => setImmediate(r));
    }
  }
  /** Wait for the backoff note of attempt `n`, then fire its timer. */
  async function backoff(n, ms) {
    await until(() => sends().length === n && events().some((t) => t.includes(`retrying in ${ms / 1000}s`)), `retry ${n}`);
    mock.timers.tick(ms - 1);
    assert.equal(sends().length, n, "no resend before the backoff elapses");
    mock.timers.tick(1);
  }

  it("retries an overloaded turn in place with backoff, then succeeds", async () => {
    process.env.CODER_FAKE_FAILS = "2";
    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await backoff(1, 5000);
    assert.equal(status(), "working", "the turn stays live through the backoff");
    await backoff(2, 15000);
    await until(() => status() === "done", "done");

    assert.deepEqual(sends().map((s) => JSON.parse(s)), ["hello", "hello", "hello"]);
    assert.equal(spawns(), 1, "same Claude process and session, no restart");
    const msgs = store.getMessages(thread.id);
    assert.equal(msgs.filter((m) => m.role === "user").length, 1);
    assert.deepEqual(msgs.filter((m) => m.role === "assistant").map((m) => m.text), ["ok"]);
    assert.ok(!msgs.some((m) => m.text.includes("API Error")), "no raw CLI error in the transcript");
    assert.equal(events().filter((t) => t.includes("retrying in")).length, 1, "one status line, updated in place");
    const usage = store.getUsage(thread.id);
    assert.equal(usage.turns, 1, "failed attempts do not count as turns");
    assert.equal(usage.inputTokens, 3);
  });

  it("fails in plain language with the original detail after three retries", async () => {
    process.env.CODER_FAKE_FAILS = "99";
    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await backoff(1, 5000);
    await backoff(2, 15000);
    await backoff(3, 45000);
    await until(() => status() === "failed", "failed");
    assert.equal(sends().length, 4);
    const last = events().at(-1);
    assert.match(last, /^Claude is still overloaded after 3 retries\. Send your message again/);
    assert.match(last, /overloaded_error/);
  });

  it("Stop during backoff cancels the retry", async () => {
    process.env.CODER_FAKE_FAILS = "99";
    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await until(() => events().some((t) => t.includes("retrying in 5s")), "first backoff");
    // stopRun itself waits on (mocked) kill timers: keep the clock moving.
    let stopped = false;
    const stopping = runner.stopRun({ threadId: thread.id }).then(() => { stopped = true; });
    while (!stopped) {
      mock.timers.tick(1000);
      await new Promise((r) => setImmediate(r));
    }
    await stopping;
    mock.timers.tick(60000);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(sends().length, 1);
    assert.notEqual(status(), "working");
  });

  it("a first turn whose CLI exits during backoff respawns resuming the captured session", async () => {
    process.env.CODER_FAKE_FAILS = "1";
    process.env.CODER_FAKE_EXIT_ON_FAIL = "1";
    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await until(() => events().some((t) => t.includes("retrying in 5s")), "first backoff");
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    mock.timers.tick(5000);
    await until(() => status() === "done", "done");
    const argvs = fs.readFileSync(process.env.CODER_FAKE_SPAWNS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(argvs.length, 2, "the exited CLI was replaced");
    assert.ok(!argvs[0].includes("--resume"), "the first turn started without a session");
    const at = argvs[1].indexOf("--resume");
    assert.ok(at >= 0 && argvs[1][at + 1] === "s1", `respawn resumes s1: ${JSON.stringify(argvs[1])}`);
  });

  it("never retries a non-transient error", async () => {
    process.env.CODER_FAKE_FAILS = "99";
    process.env.CODER_FAKE_ERR = "Invalid API key · Please run /login";
    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await until(() => status() === "done" || status() === "failed", "terminal");
    mock.timers.tick(60000);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(sends().length, 1);
    assert.ok(!events().some((t) => t.includes("retrying")));
  });
});
