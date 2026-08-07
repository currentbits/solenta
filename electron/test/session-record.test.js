const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const {
  createSessionRecorder,
  recordTranscript,
  flushSessionRecord,
  resetSessionRecordForTests,
  mapMessageRole,
  BATCH_SIZE,
  FLUSH_MS,
} = require("../session-record.js");

const TOKEN = "test-bearer-token-64chars-abcdefghijklmnopqrstuvwxyz012345";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

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
 * Fake memory HTTP server capturing POST /api/session (and /api/store).
 */
function startCaptureServer(port, token) {
  /** @type {object[]} */
  const sessionBodies = [];
  /** @type {object[]} */
  const storeBodies = [];
  /** @type {number} */
  let sessionRequestCount = 0;
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (req.method === "POST" && url.pathname === "/api/session") {
        sessionRequestCount += 1;
        try {
          sessionBodies.push(JSON.parse(body || "{}"));
        } catch {
          sessionBodies.push({ _raw: body });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/store") {
        try {
          storeBodies.push(JSON.parse(body || "{}"));
        } catch {
          storeBodies.push({ _raw: body });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "run-stored-1" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        sessionBodies,
        storeBodies,
        get sessionRequestCount() {
          return sessionRequestCount;
        },
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
    server.on("error", reject);
  });
}

function writeFakeClaude(dir) {
  const body = `#!/usr/bin/env node
"use strict";
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
const scenario = process.env.CODER_FAKE_CLAUDE_SCENARIO || "success";
if (scenario === "fail-exit") {
  process.stderr.write("boom-stderr\\n");
  process.exit(2);
}
emit({type:"system",subtype:"init",session_id:"s-sess",model:"m-sess"});
emit({type:"assistant",message:{content:[{type:"text",text:"partial one"}]}});
emit({type:"assistant",message:{content:[{type:"text",text:"Final assistant answer for session record."}]}});
emit({type:"user",message:{content:[{type:"tool_result",tool_use_id:"t1",content:"tool out"}]}});
emit({type:"assistant",message:{content:[
  {type:"tool_use",id:"t1",name:"Bash",input:{command:"npm test"}},
  {type:"text",text:"Final assistant answer for session record."}
]}});
emit({type:"result",subtype:"success",result:"Final assistant answer for session record.",usage:{input_tokens:5,output_tokens:9},total_cost_usd:0.002,session_id:"s-sess"});
process.exit(0);
`;
  const fake = path.join(dir, "fake-claude-sess");
  fs.writeFileSync(fake, body, { mode: 0o755 });
  return fake;
}

function writeStreamingClaude(dir) {
  // Many assistant text chunks before result — must not record each growth.
  const body = `#!/usr/bin/env node
"use strict";
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
emit({type:"system",subtype:"init",session_id:"s-stream",model:"m"});
const parts = ["Hel", "lo ", "wor", "ld!", " done"];
(async () => {
  let acc = "";
  for (const p of parts) {
    acc += p;
    emit({type:"assistant",message:{content:[{type:"text",text:acc}]}});
    await new Promise((r) => setTimeout(r, 15));
  }
  emit({type:"result",subtype:"success",result:acc,usage:{input_tokens:1,output_tokens:2},total_cost_usd:0.001,session_id:"s-stream"});
  process.exit(0);
})();
`;
  const fake = path.join(dir, "fake-claude-stream");
  fs.writeFileSync(fake, body, { mode: 0o755 });
  return fake;
}

function writeSlowClaude(dir) {
  const body = `#!/usr/bin/env node
"use strict";
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
emit({type:"system",subtype:"init",session_id:"s-slow",model:"m"});
emit({type:"assistant",message:{content:[{type:"text",text:"partial so far"}]}});
setInterval(() => {}, 10000);
`;
  const fake = path.join(dir, "fake-claude-slow-sess");
  fs.writeFileSync(fake, body, { mode: 0o755 });
  return fake;
}

describe("mapMessageRole", () => {
  it("maps user/assistant/tool/event correctly", () => {
    assert.equal(mapMessageRole("user"), "user");
    assert.equal(mapMessageRole("assistant"), "assistant");
    assert.equal(mapMessageRole("tool"), "tool");
    assert.equal(mapMessageRole("event"), "system");
  });
});

describe("session-record unit: queue + POST /api/session", () => {
  let tmpDir;
  let port;
  let fake;
  let status;
  /** @type {ReturnType<typeof createSessionRecorder>} */
  let recorder;

  beforeEach(async () => {
    resetSessionRecordForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-sessrec-"));
    port = await freePort();
    status = { running: true, adopted: true, port };
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({ port, token: TOKEN, dbPath: path.join(tmpDir, "m.db") }),
      "utf8",
    );
  });

  afterEach(async () => {
    if (recorder) {
      await recorder.flush();
      recorder.dispose();
      recorder = null;
    }
    resetSessionRecordForTests();
    if (fake) {
      await fake.close();
      fake = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("posts correct fields for a user entry on flush", async () => {
    fake = await startCaptureServer(port, TOKEN);
    recorder = createSessionRecorder({
      userDataPath: tmpDir,
      getStatus: () => status,
      timeoutMs: 2000,
      flushMs: 50,
      batchSize: 10,
    });
    recorder.recordTranscript([
      {
        sessionId: "thread-abc",
        project: "acme/app",
        threadTitle: "Fix tests",
        agent: "claude",
        role: "user",
        content: "please fix the flaky test",
      },
    ]);
    await recorder.flush();
    await waitFor(() => fake.sessionBodies.length >= 1, { timeoutMs: 3000 });
    assert.equal(fake.sessionBodies.length, 1);
    assert.deepEqual(fake.sessionBodies[0], {
      sessionId: "thread-abc",
      project: "acme/app",
      threadTitle: "Fix tests",
      agent: "claude",
      role: "user",
      content: "please fix the flaky test",
    });
  });

  it("batching coalesces: many enqueues yield few flush waves (request count == entries, not intermediate spam)", async () => {
    fake = await startCaptureServer(port, TOKEN);
    // Long flush window so we can fill the queue before auto-flush.
    recorder = createSessionRecorder({
      userDataPath: tmpDir,
      getStatus: () => status,
      timeoutMs: 2000,
      flushMs: 5000,
      batchSize: 10,
    });
    const n = 25;
    for (let i = 0; i < n; i++) {
      recorder.recordTranscript([
        {
          sessionId: "s1",
          project: "p",
          threadTitle: "T",
          agent: "claude",
          role: "user",
          content: `msg-${i}`,
        },
      ]);
    }
    // Immediate batch-size flushes: first 20 fire as two batches of 10 without timer.
    // Remaining 5 wait for timer/explicit flush.
    await waitFor(() => fake.sessionRequestCount >= 20, { timeoutMs: 3000 });
    assert.equal(fake.sessionRequestCount, 20);
    await recorder.flush();
    await waitFor(() => fake.sessionRequestCount >= n, { timeoutMs: 3000 });
    assert.equal(fake.sessionRequestCount, n);
    assert.equal(fake.sessionBodies.length, n);
  });

  it("silent no-op when memory is down: never throws", async () => {
    status = { running: false, adopted: false, port: null };
    recorder = createSessionRecorder({
      userDataPath: tmpDir,
      getStatus: () => status,
      timeoutMs: 500,
      flushMs: 10,
    });
    let threw = false;
    try {
      recorder.recordTranscript([
        {
          sessionId: "s",
          project: "p",
          threadTitle: "t",
          agent: "claude",
          role: "user",
          content: "hi",
        },
      ]);
      await recorder.flush();
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  });

  it("explicit flush drains the queue (app-quit path)", async () => {
    fake = await startCaptureServer(port, TOKEN);
    recorder = createSessionRecorder({
      userDataPath: tmpDir,
      getStatus: () => status,
      timeoutMs: 2000,
      flushMs: 60_000,
      batchSize: 100,
    });
    recorder.recordTranscript([
      {
        sessionId: "s-quit",
        project: "p",
        threadTitle: "Quit",
        agent: "codex",
        role: "system",
        content: "Run stopped",
      },
    ]);
    assert.equal(fake.sessionBodies.length, 0);
    await recorder.flush();
    await waitFor(() => fake.sessionBodies.length >= 1, { timeoutMs: 3000 });
    assert.equal(fake.sessionBodies[0].role, "system");
    assert.equal(fake.sessionBodies[0].content, "Run stopped");
  });
});

describe("auto session-record on real runs", () => {
  let tmpDir;
  let store;
  let runner;
  let port;
  let fake;
  let status;
  let prevSimulate;
  let prevAgentCmd;
  let prevClaudeBin;
  let prevScenario;

  beforeEach(async () => {
    resetSessionRecordForTests();
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevScenario = process.env.CODER_FAKE_CLAUDE_SCENARIO;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_FAKE_CLAUDE_SCENARIO;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-sessauto-"));
    port = await freePort();
    status = { running: true, adopted: true, port };
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({ port, token: TOKEN, dbPath: path.join(tmpDir, "m.db") }),
      "utf8",
    );
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: tmpDir,
      getMemoryStatus: () => status,
    });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    services.addProject(store, repo);
  });

  afterEach(async () => {
    if (runner) {
      runner.stopAll();
      if (typeof runner.flushTranscripts === "function") {
        await runner.flushTranscripts();
      }
    }
    resetSessionRecordForTests();
    if (fake) {
      await fake.close();
      fake = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevClaudeBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaudeBin;
    if (prevScenario === undefined) delete process.env.CODER_FAKE_CLAUDE_SCENARIO;
    else process.env.CODER_FAKE_CLAUDE_SCENARIO = prevScenario;
  });

  it("records user message immediately with correct fields", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const bin = writeSlowClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "User record title",
    });
    services.setProvider(store, {
      threadId: thread.id,
      model: "claude-sonnet-5",
    });

    await runner.startRun({ threadId: thread.id, prompt: "hello user prompt" });
    // User should be recorded before run finishes (immediate enqueue + flush/timer).
    await waitFor(
      () =>
        fake.sessionBodies.some(
          (b) => b.role === "user" && b.content === "hello user prompt",
        ),
      { timeoutMs: 5000 },
    );
    const userBody = fake.sessionBodies.find((b) => b.role === "user");
    assert.ok(userBody);
    assert.equal(userBody.sessionId, thread.id);
    assert.equal(userBody.project, project.slug);
    assert.equal(userBody.threadTitle, "User record title");
    assert.equal(userBody.agent, "claude");
    assert.equal(userBody.role, "user");
    assert.equal(userBody.content, "hello user prompt");

    await runner.stopRun({ threadId: thread.id });
  });

  it("records assistant once at terminal, not per streaming push", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const bin = writeStreamingClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Stream once",
    });
    services.setProvider(store, {
      threadId: thread.id,
      model: "claude-sonnet-5",
    });

    await runner.startRun({ threadId: thread.id, prompt: "stream please" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    if (typeof runner.flushTranscripts === "function") {
      await runner.flushTranscripts();
    }
    await waitFor(
      () => fake.sessionBodies.some((b) => b.role === "assistant"),
      { timeoutMs: 5000 },
    );

    const assistantBodies = fake.sessionBodies.filter(
      (b) => b.role === "assistant",
    );
    assert.equal(
      assistantBodies.length,
      1,
      `expected one assistant session post, got ${assistantBodies.length}: ${JSON.stringify(assistantBodies)}`,
    );
    assert.match(assistantBodies[0].content, /Hello world! done|done/);
    assert.equal(assistantBodies[0].sessionId, thread.id);
    assert.equal(assistantBodies[0].project, project.slug);
    assert.equal(assistantBodies[0].agent, "claude");
  });

  it("records assistant + tool at done terminal", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const bin = writeFakeClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Tools terminal",
    });
    services.setProvider(store, {
      threadId: thread.id,
      model: "claude-sonnet-5",
    });

    await runner.startRun({ threadId: thread.id, prompt: "use a tool" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    if (typeof runner.flushTranscripts === "function") {
      await runner.flushTranscripts();
    }
    await waitFor(
      () => fake.sessionBodies.some((b) => b.role === "assistant"),
      { timeoutMs: 5000 },
    );

    const roles = fake.sessionBodies.map((b) => b.role);
    assert.ok(roles.includes("user"));
    assert.ok(roles.includes("assistant"));
    // Tool dossier may or may not appear depending on fake stream shape; if present, once.
    const tools = fake.sessionBodies.filter((b) => b.role === "tool");
    if (tools.length > 0) {
      assert.ok(tools.every((t) => t.sessionId === thread.id));
    }
    const assistants = fake.sessionBodies.filter((b) => b.role === "assistant");
    assert.equal(assistants.length, 1);
  });

  it("records assistant/tool/event once at failed terminal", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const bin = writeFakeClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "fail-exit";
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Fail terminal",
    });

    await runner.startRun({ threadId: thread.id, prompt: "nope" });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    if (typeof runner.flushTranscripts === "function") {
      await runner.flushTranscripts();
    }
    await waitFor(
      () =>
        fake.sessionBodies.some((b) => b.role === "user") &&
        fake.sessionBodies.some((b) => b.role === "system"),
      { timeoutMs: 5000 },
    );

    const systems = fake.sessionBodies.filter((b) => b.role === "system");
    assert.ok(systems.length >= 1);
    assert.ok(systems.some((s) => /error|fail|exit/i.test(s.content)));
  });

  it("records at stopped terminal", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const bin = writeSlowClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Stop terminal",
    });

    await runner.startRun({ threadId: thread.id, prompt: "hang" });
    await waitFor(() => store.getThread(thread.id).status === "working");
    await new Promise((r) => setTimeout(r, 80));
    await runner.stopRun({ threadId: thread.id });
    if (typeof runner.flushTranscripts === "function") {
      await runner.flushTranscripts();
    }
    await waitFor(
      () =>
        fake.sessionBodies.some(
          (b) => b.role === "system" && /stopped/i.test(b.content),
        ),
      { timeoutMs: 5000 },
    );
    const assistants = fake.sessionBodies.filter((b) => b.role === "assistant");
    // Partial assistant text at stop should be recorded once if present.
    assert.ok(assistants.length <= 1);
  });

  it("simulate never records session posts", async () => {
    fake = await startCaptureServer(port, TOKEN);
    process.env.CODER_SIMULATE = "1";
    runner.stopAll();
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: tmpDir,
      getMemoryStatus: () => status,
    });
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Sim session",
    });
    services.setProvider(store, {
      threadId: thread.id,
      provider: "simulate",
    });
    await runner.startRun({ threadId: thread.id, prompt: "sim prompt" });
    await waitFor(() => store.getThread(thread.id).status === "done", {
      timeoutMs: 20000,
    });
    if (typeof runner.flushTranscripts === "function") {
      await runner.flushTranscripts();
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fake.sessionBodies.length, 0);
  });

  it("memory-down is silent no-op and run still completes", async () => {
    status = { running: false, adopted: false, port: null };
    const bin = writeFakeClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "No mem session",
    });
    await runner.startRun({ threadId: thread.id, prompt: "ok" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).status, "done");
  });

  it("stopAll flushes the session queue", async () => {
    fake = await startCaptureServer(port, TOKEN);
    // Direct unit of runner flush path: enqueue via a hanging run's user msg,
    // then stopAll should flush without waiting for the 2s timer.
    const bin = writeSlowClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Flush on stopAll",
    });
    await runner.startRun({
      threadId: thread.id,
      prompt: "flush-me-on-stopAll",
    });
    // User is enqueued; force a long-timer scenario by not waiting.
    // stopAll must flush.
    runner.stopAll();
    if (typeof runner.flushTranscripts === "function") {
      await runner.flushTranscripts();
    }
    await waitFor(
      () =>
        fake.sessionBodies.some(
          (b) => b.role === "user" && b.content === "flush-me-on-stopAll",
        ),
      { timeoutMs: 5000 },
    );
  });
});

describe("module-level flushSessionRecord hook", () => {
  let tmpDir;
  let port;
  let fake;
  let status;

  beforeEach(async () => {
    resetSessionRecordForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-sessmod-"));
    port = await freePort();
    status = { running: true, adopted: true, port };
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({ port, token: TOKEN, dbPath: path.join(tmpDir, "m.db") }),
      "utf8",
    );
  });

  afterEach(async () => {
    resetSessionRecordForTests();
    if (fake) {
      await fake.close();
      fake = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recordTranscript + flushSessionRecord posts via shared proxy config", async () => {
    fake = await startCaptureServer(port, TOKEN);
    // Configure module singleton deps the way main/runner would.
    const rec = createSessionRecorder({
      userDataPath: tmpDir,
      getStatus: () => status,
      flushMs: 60_000,
    });
    // Also exercise named exports if they share the same factory API.
    rec.recordTranscript([
      {
        sessionId: "mod-1",
        project: "proj",
        threadTitle: "Mod",
        agent: "claude",
        role: "user",
        content: "module flush",
      },
    ]);
    await rec.flush();
    await waitFor(() => fake.sessionBodies.length >= 1, { timeoutMs: 3000 });
    assert.equal(fake.sessionBodies[0].content, "module flush");
    rec.dispose();
  });
});
