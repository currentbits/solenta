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
  recordRunOutcome,
  buildRunTitle,
  buildRunBody,
} = require("../memory-record.js");
const { writeFakeBin } = require("./support/fakeBin.js");

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
 * Fake memory HTTP server that captures POST /api/store bodies.
 */
function startCaptureServer(port, token) {
  /** @type {object[]} */
  const bodies = [];
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
      if (req.method === "POST" && url.pathname === "/api/store") {
        try {
          bodies.push(JSON.parse(body || "{}"));
        } catch {
          bodies.push({ _raw: body });
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
        bodies,
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
emit({type:"system",subtype:"init",session_id:"s-rec",model:"m-rec"});
emit({type:"assistant",message:{content:[{type:"text",text:"Final answer from assistant about the task."}]}});
emit({type:"result",subtype:"success",result:"Final answer from assistant about the task.",usage:{input_tokens:11,output_tokens:22},total_cost_usd:0.012,session_id:"s-rec"});
process.exit(0);
`;
  return writeFakeBin(path.join(dir, "fake-claude-rec"), body);
}

function writeSlowClaude(dir) {
  const body = `#!/usr/bin/env node
"use strict";
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
emit({type:"system",subtype:"init",session_id:"s-slow",model:"m"});
emit({type:"assistant",message:{content:[{type:"text",text:"partial so far"}]}});
setInterval(() => {}, 10000);
`;
  return writeFakeBin(path.join(dir, "fake-claude-slow"), body);
}

function writeWorkflowFake(dir) {
  const fixed = `#!/usr/bin/env node
"use strict";
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
const prompt = process.argv[process.argv.length - 1] || "";
let text = "generic phase output";
if (/final self-contained answer|Using the plan/i.test(prompt)) {
  text = "Synthesized final answer for the user.";
} else if (/Produce a concise plan|key questions/i.test(prompt)) {
  text = "seed plan";
} else if (/Deep-dive|implementation approach/i.test(prompt)) {
  text = "analysis notes";
}
emit({type:"system",subtype:"init",session_id:"wf-s",model:"wf-m"});
emit({type:"assistant",message:{content:[{type:"text",text}]}});
emit({type:"result",subtype:"success",result:text,usage:{input_tokens:3,output_tokens:5},total_cost_usd:0.001,session_id:"wf-s"});
process.exit(0);
`;
  return writeFakeBin(path.join(dir, "fake-claude-wf"), fixed);
}

describe("memory-record helpers", () => {
  it("buildRunTitle truncates to 80 chars", () => {
    const longTitle = "T".repeat(100);
    const title = buildRunTitle({
      provider: "claude",
      threadTitle: longTitle,
    });
    assert.ok(title.length <= 80);
    assert.ok(title.startsWith("claude run: "));
  });

  it("buildRunBody truncates text to 1200 and appends footer", () => {
    const text = "x".repeat(2000);
    const body = buildRunBody({
      text,
      provider: "codex",
      model: "o3",
      status: "done",
      tokensIn: 1,
      tokensOut: 2,
      costUsd: 0.5,
    });
    assert.ok(body.includes("x".repeat(1200)));
    assert.ok(!body.includes("x".repeat(1201)));
    assert.match(
      body,
      /provider=codex model=o3 status=done tokens_in=1 tokens_out=2 cost_usd=0\.5/,
    );
  });
});

describe("recordRunOutcome unit", () => {
  let tmpDir;
  let port;
  let fake;
  let status;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-memrec-"));
    port = await freePort();
    status = { running: true, adopted: true, port };
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({ port, token: TOKEN, dbPath: path.join(tmpDir, "m.db") }),
      "utf8",
    );
  });

  afterEach(async () => {
    if (fake) {
      await fake.close();
      fake = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("posts type run with title, body footer, and canonical project key", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const thread = {
      id: "t1",
      title: "Fix the flaky test",
      provider: "claude",
      model: "claude-sonnet-5",
    };
    const project = { id: "p1", slug: "acme/app", name: "app", path: "/code/app-fork" };
    await recordRunOutcome(
      {
        thread,
        project,
        outcome: {
          status: "done",
          text: "All green now.",
          tokensIn: 10,
          tokensOut: 20,
          costUsd: 0.03,
        },
      },
      {
        userDataPath: tmpDir,
        getStatus: () => status,
        timeoutMs: 2000,
      },
    );
    await waitFor(() => fake.bodies.length >= 1, { timeoutMs: 3000 });
    assert.equal(fake.bodies.length, 1);
    const body = fake.bodies[0];
    assert.equal(body.type, "run");
    // The app sends the repo PATH raw; the memory server canonicalizes it.
    // Fixture deliberately differs from the slug tail ("app") so a
    // slug-based regression cannot pass by coincidence.
    assert.equal(body.project, "/code/app-fork");
    assert.equal(body.title, "claude run: Fix the flaky test");
    assert.match(body.body, /^All green now\./);
    assert.match(
      body.body,
      /provider=claude model=claude-sonnet-5 status=done tokens_in=10 tokens_out=20 cost_usd=0\.03/,
    );
  });

  it("silent no-op when memory server is not running (never throws)", async () => {
    status = { running: false, adopted: false, port: null };
    let threw = false;
    try {
      await recordRunOutcome(
        {
          thread: { title: "T", provider: "claude", model: null },
          project: { slug: "p" },
          outcome: { status: "done", text: "hi" },
        },
        { userDataPath: tmpDir, getStatus: () => status },
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  });
});

describe("auto-record on real run terminals", () => {
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
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevScenario = process.env.CODER_FAKE_CLAUDE_SCENARIO;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_FAKE_CLAUDE_SCENARIO;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-autorec-"));
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
    // Remote-ish slug via folder name
    const project = await services.addProject(store, repo);
    // Force a stable slug for assertions if needed
    void project;
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
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

  it("records done for a single-turn claude run with correct shape", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const bin = writeFakeClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Single turn record test with a somewhat long title that should truncate if needed",
    });
    services.setProvider(store, {
      threadId: thread.id,
      model: "claude-sonnet-5",
    });

    await runner.startRun({ threadId: thread.id, prompt: "do the thing" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    await waitFor(() => fake.bodies.length >= 1, { timeoutMs: 5000 });

    const body = fake.bodies[0];
    assert.equal(body.type, "run");
    // The app posts the repo PATH; the memory server canonicalizes it to the
    // repo-root basename (see memory-server/src/project-key.js). Asserting the
    // path here keeps this test about what the app SENDS; the canonicalization
    // contract is pinned by memory-server/test/project-key.test.js.
    assert.equal(body.project, project.path);
    assert.ok(body.title.length <= 80);
    assert.ok(body.title.startsWith("claude run: "));
    assert.match(body.body, /Final answer from assistant/);
    assert.match(
      body.body,
      /provider=claude model=claude-sonnet-5 status=done tokens_in=\d+ tokens_out=\d+ cost_usd=/,
    );
  });

  it("records failed for a single-turn failure", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const bin = writeFakeClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "fail-exit";
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Fail me",
    });

    await runner.startRun({ threadId: thread.id, prompt: "nope" });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    await waitFor(() => fake.bodies.length >= 1, { timeoutMs: 5000 });

    const body = fake.bodies[0];
    assert.equal(body.type, "run");
    assert.match(body.body, /status=failed/);
    // The app posts the repo PATH; the memory server canonicalizes it to the
    // repo-root basename (see memory-server/src/project-key.js). Asserting the
    // path here keeps this test about what the app SENDS; the canonicalization
    // contract is pinned by memory-server/test/project-key.test.js.
    assert.equal(body.project, project.path);
  });

  it("records stopped when user stops a run", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const bin = writeSlowClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Stop me",
    });

    await runner.startRun({ threadId: thread.id, prompt: "hang" });
    await waitFor(() => store.getThread(thread.id).status === "working");
    // Give the stream a moment to emit partial text
    await new Promise((r) => setTimeout(r, 80));
    await runner.stopRun({ threadId: thread.id });
    await waitFor(() => fake.bodies.length >= 1, { timeoutMs: 5000 });

    const body = fake.bodies[0];
    assert.equal(body.type, "run");
    assert.match(body.body, /status=stopped/);
    // The app posts the repo PATH; the memory server canonicalizes it to the
    // repo-root basename (see memory-server/src/project-key.js). Asserting the
    // path here keeps this test about what the app SENDS; the canonicalization
    // contract is pinned by memory-server/test/project-key.test.js.
    assert.equal(body.project, project.path);
  });

  it("no-op without memory: run still completes, no crash", async () => {
    status = { running: false, adopted: false, port: null };
    const bin = writeFakeClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "No mem",
    });
    await runner.startRun({ threadId: thread.id, prompt: "ok" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).status, "done");
  });

  it("does not record simulate-provider runs", async () => {
    fake = await startCaptureServer(port, TOKEN);
    process.env.CODER_SIMULATE = "1";
    // Recreate runner under simulate
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
      title: "Sim",
    });
    // set provider simulate only when env allows
    services.setProvider(store, {
      threadId: thread.id,
      provider: "simulate",
    });
    await runner.startRun({ threadId: thread.id, prompt: "sim" });
    await waitFor(() => store.getThread(thread.id).status === "done", {
      timeoutMs: 20000,
    });
    // Give any accidental post a moment
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fake.bodies.length, 0);
  });

  it("records done for a workflow run with synthesize body", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const bin = writeWorkflowFake(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Workflow record",
    });

    // Use a minimal 1-phase template if standard is multi-phase and slow —
    // standard is fine with our fast fake.
    await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "build this feature",
    });
    await waitFor(() => store.getThread(thread.id).status === "done", {
      timeoutMs: 30000,
    });
    await waitFor(() => fake.bodies.length >= 1, { timeoutMs: 5000 });

    const body = fake.bodies[0];
    assert.equal(body.type, "run");
    // The app posts the repo PATH; the memory server canonicalizes it to the
    // repo-root basename (see memory-server/src/project-key.js). Asserting the
    // path here keeps this test about what the app SENDS; the canonicalization
    // contract is pinned by memory-server/test/project-key.test.js.
    assert.equal(body.project, project.path);
    assert.ok(body.title.startsWith("claude run:") || /run:/.test(body.title));
    assert.match(body.body, /Synthesized final answer|status=done/);
    assert.match(body.body, /status=done/);
    assert.match(body.body, /provider=/);
  });

  it("records failed for a workflow failure", async () => {
    fake = await startCaptureServer(port, TOKEN);
    // Fake that always fails
    const failBody = `#!/usr/bin/env node
"use strict";
process.stderr.write("wf-fail\\n");
process.exit(2);
`;
    const bin = writeFakeBin(path.join(tmpDir, "fake-claude-wffail"), failBody);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "WF fail",
    });
    await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "will fail",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed", {
      timeoutMs: 30000,
    });
    await waitFor(() => fake.bodies.length >= 1, { timeoutMs: 5000 });
    assert.match(fake.bodies[0].body, /status=failed/);
  });

  it("records stopped for a stopped workflow", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const bin = writeSlowClaude(tmpDir);
    process.env.CODER_CLAUDE_BIN = bin;
    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "WF stop",
    });
    await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "hang workflow",
    });
    await waitFor(() => store.getThread(thread.id).status === "working");
    await new Promise((r) => setTimeout(r, 100));
    await runner.stopRun({ threadId: thread.id });
    await waitFor(() => fake.bodies.length >= 1, { timeoutMs: 5000 });
    assert.match(fake.bodies[0].body, /status=stopped/);
  });

  it("codex done footer includes non-zero tokens_in and tokens_out from applyUsage", async () => {
    fake = await startCaptureServer(port, TOKEN);
    const prevCodex = process.env.CODER_CODEX_BIN;
    const bin = path.join(tmpDir, "fake-codex-rec");
    // turn.completed usage must be non-zero so the footer is not all zeros.
    const body = `#!/usr/bin/env node
"use strict";
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
emit({type:"thread.started",thread_id:"codex-sess-rec"});
emit({type:"item.completed",item:{id:"m1",type:"agent_message",text:"Hello from codex with usage"}});
emit({type:"turn.completed",usage:{input_tokens:30,output_tokens:12,total_cost_usd:0.004}});
process.exit(0);
`;
    const resolved = writeFakeBin(bin, body);
    process.env.CODER_CODEX_BIN = resolved;

    try {
      const project = store.getProjects()[0];
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Codex usage footer",
      });
      services.setProvider(store, {
        threadId: thread.id,
        provider: "codex",
      });

      await runner.startRun({ threadId: thread.id, prompt: "codex turn" });
      await waitFor(() => store.getThread(thread.id).status === "done");
      await waitFor(() => fake.bodies.length >= 1, { timeoutMs: 5000 });

      const rec = fake.bodies[0];
      assert.equal(rec.type, "run");
      assert.match(rec.body, /provider=codex/);
      assert.match(rec.body, /status=done/);
      // Must be the real turn usage, not silent zeros.
      assert.match(rec.body, /tokens_in=30/);
      assert.match(rec.body, /tokens_out=12/);
      assert.match(rec.body, /cost_usd=0\.004/);
    } finally {
      if (prevCodex === undefined) delete process.env.CODER_CODEX_BIN;
      else process.env.CODER_CODEX_BIN = prevCodex;
    }
  });
});

describe("codex listed model flows into -m", () => {
  let tmpDir;
  let store;
  let runner;
  let prevSimulate;
  let prevAgentCmd;
  let prevCodexBin;
  let argvFile;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevCodexBin = process.env.CODER_CODEX_BIN;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-m-"));
    argvFile = path.join(tmpDir, "argv.json");
    const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_CODEX_ARGV_FILE) {
  fs.writeFileSync(process.env.CODER_FAKE_CODEX_ARGV_FILE, JSON.stringify(process.argv.slice(1)), "utf8");
}
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
emit({type:"thread.started",thread_id:"sess-m"});
emit({type:"item.completed",item:{id:"1",type:"agent_message",text:"ok"}});
emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}});
process.exit(0);
`;
    const fake = writeFakeBin(path.join(tmpDir, "fake-codex"), body);
    process.env.CODER_CODEX_BIN = fake;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;

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
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Codex M",
    });
    services.setProvider(store, {
      threadId: thread.id,
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevCodexBin === undefined) delete process.env.CODER_CODEX_BIN;
    else process.env.CODER_CODEX_BIN = prevCodexBin;
    delete process.env.CODER_FAKE_CODEX_ARGV_FILE;
  });

  it("passes -m <listed model> for codex", async () => {
    const thread = store.getThreads()[0];
    assert.equal(thread.model, "gpt-5.5");
    await runner.startRun({ threadId: thread.id, prompt: "hi" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const idx = argv.indexOf("-m");
    assert.ok(idx >= 0, `expected -m in ${JSON.stringify(argv)}`);
    assert.equal(argv[idx + 1], "gpt-5.5");
  });
});
