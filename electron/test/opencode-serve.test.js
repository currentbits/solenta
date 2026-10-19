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
  createEventTranslator,
  promptParts,
  modelRef,
} = require("../opencode-serve.js");
const {
  pendingFromOpencode,
  mapOpencodeDecision,
} = require("../opencodeApprovals.js");
const {
  extractTextPart,
  extractThinkingPart,
  extractToolEvent,
  extractStepUsage,
} = require("../opencode.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

/** Live `opencode serve` 1.19.3 SSE capture (bash permission ask + reply). */
const FIXTURE = path.join(__dirname, "fixtures", "opencode-serve-1.19.3.ndjson");
const FIXTURE_SID = "ses_eaf5f1114ffeHR4PAGAI07S1U4";

function fixtureEvents() {
  return fs
    .readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
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

describe("opencode serve event translation (live 1.19.3 capture)", () => {
  const out = [];
  const translate = createEventTranslator(FIXTURE_SID);
  for (const ev of fixtureEvents()) out.push(...translate(ev));

  it("keeps only assistant text: the echoed user prompt is dropped", () => {
    const texts = out.map(extractTextPart).filter(Boolean);
    assert.ok(texts.length > 0);
    assert.ok(texts.every((t) => !/Run the bash command/.test(t.text)));
    assert.equal(texts[texts.length - 1].text, "DONE");
  });

  it("accumulates reasoning deltas into growing text", () => {
    const thinks = out.map(extractThinkingPart).filter(Boolean);
    assert.equal(
      thinks.findLast((t) => t.text.startsWith("The user wants"))?.text,
      "The user wants me to run a bash command and reply with the single word DONE.",
    );
    for (let i = 1; i < thinks.length; i++) {
      if (thinks[i].id === thinks[i - 1].id) {
        assert.ok(thinks[i].text.startsWith(thinks[i - 1].text));
      }
    }
  });

  it("announces the tool once at running, then ends it with output", () => {
    const tools = out.map(extractToolEvent).filter(Boolean);
    assert.deepEqual(tools.map((t) => t.phase), ["start", "end"]);
    assert.equal(tools[0].name, "bash");
    assert.match(tools[0].input, /echo hi-from-probe/);
    assert.equal(tools[0].id, tools[1].id);
    assert.equal(tools[1].output, "hi-from-probe\n");
    assert.equal(tools[1].isError, false);
  });

  it("step_finish carries real usage, cache reads counted as input", () => {
    const usage = out.map(extractStepUsage).filter(Boolean);
    assert.deepEqual(usage, [
      { inputTokens: 22104, outputTokens: 23, costUsd: 0 },
      { inputTokens: 141 + 22016, outputTokens: 3, costUsd: 0 },
    ]);
  });

  it("ignores other sessions' events (task subagents)", () => {
    const t = createEventTranslator("ses_other");
    assert.deepEqual(fixtureEvents().flatMap((ev) => t(ev)), []);
  });

  it("maps session.error to the run-json error shape", () => {
    const t = createEventTranslator("ses_x");
    const [ev] = t({
      type: "session.error",
      properties: {
        sessionID: "ses_x",
        error: { name: "APIError", data: { message: "OpenCode 1.18.0 or newer is required" } },
      },
    });
    assert.equal(ev.type, "error");
    assert.equal(ev.error.name, "APIError");
  });
});

describe("opencode serve request helpers", () => {
  it("splits provider/model at the first slash", () => {
    assert.deepEqual(modelRef("openrouter/anthropic/claude"), {
      providerID: "openrouter",
      modelID: "anthropic/claude",
    });
    assert.equal(modelRef("nomodel"), null);
    assert.equal(modelRef(null), null);
  });

  it("attaches files as file:// parts after the text", () => {
    const img = path.join(os.tmpdir(), "shot.PNG");
    const src = path.join(os.tmpdir(), "main.rs");
    const parts = promptParts("look", [img, src, ""]);
    assert.deepEqual(parts[0], { type: "text", text: "look" });
    assert.equal(parts[1].mime, "image/png");
    assert.equal(parts[1].url, pathToFileURL(img).href);
    assert.equal(parts[2].mime, "text/plain");
    assert.equal(parts.length, 3);
  });
});

describe("opencode permission mapping", () => {
  it("shapes a bash ask like a command prompt (not editable)", () => {
    const ask = fixtureEvents().find((e) => e.type === "permission.asked").properties;
    const p = pendingFromOpencode(ask);
    assert.equal(p.id, ask.id);
    assert.equal(p.toolName, "bash");
    assert.equal(p.command, "echo hi-from-probe");
    assert.equal(p.summary, "bash: echo hi-from-probe");
    assert.equal(p.commandEditable, false);
  });

  it("shapes a non-bash ask from its patterns", () => {
    const p = pendingFromOpencode({
      id: "per_1",
      permission: "edit",
      patterns: ["src/a.ts"],
      metadata: { filepath: "/w/src/a.ts" },
    });
    assert.equal(p.command, null);
    assert.equal(p.summary, "edit: src/a.ts");
    assert.match(p.input, /filepath/);
  });

  it("maps Solenta buttons onto once/always/reject", () => {
    assert.equal(mapOpencodeDecision("allow"), "once");
    assert.equal(mapOpencodeDecision("allowAlways"), "always");
    assert.equal(mapOpencodeDecision("deny"), "reject");
    assert.equal(mapOpencodeDecision("cancel"), "reject");
  });
});

/**
 * Fake `opencode serve`: Basic auth with OPENCODE_SERVER_PASSWORD, SSE on
 * GET /event, replays the live fixture on prompt_async and holds at
 * permission.asked until POST /permission/:id/reply. Logs every request.
 */
function writeFakeServe(dir) {
  const body = `
"use strict";
const http = require("http");
const fs = require("fs");
const log = process.env.CODER_FAKE_SERVE_LOG;
const scenario = process.env.CODER_FAKE_SERVE_SCENARIO || "fixture";
const fixture = fs.readFileSync(${JSON.stringify(FIXTURE)}, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l));
const SID = ${JSON.stringify(FIXTURE_SID)};
const auth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), env: {
  OPENCODE_CLIENT: process.env.OPENCODE_CLIENT || null,
  OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION || null,
  OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT || null,
  OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR || null,
  OPENCODE_DISABLE_CLAUDE_CODE: process.env.OPENCODE_DISABLE_CLAUDE_CODE || null,
  cwd: process.cwd(),
} }) + "\\n");
const clients = new Set();
let waitReply = null;
const send = (ev) => { for (const c of clients) c.write("data: " + JSON.stringify(ev) + "\\n\\n"); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function replay() {
  if (scenario === "error") {
    send({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
    send({ type: "session.error", properties: { sessionID: SID, error: { name: "APIError", data: { message: "OpenCode 1.18.0 or newer is required to use the free tier" } } } });
    send({ type: "session.idle", properties: { sessionID: SID } });
    return;
  }
  if (scenario === "slow") {
    send({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
    return;
  }
  for (const ev of fixture) {
    if (ev.type === "permission.replied" || ev.type === "session.created") continue;
    await delay(2);
    send(ev);
    if (ev.type === "permission.asked") {
      const reply = await new Promise((r) => { waitReply = r; });
      send({ type: "permission.replied", properties: { sessionID: SID, requestID: ev.properties.id, reply } });
    }
  }
}
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (log) fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null }) + "\\n");
    if (req.headers.authorization !== auth) { res.writeHead(401); res.end(); return; }
    const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.method === "GET" && req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ type: "server.connected", properties: {} }) + "\\n\\n");
      clients.add(res);
      return;
    }
    if (req.method === "POST" && req.url === "/session") return json(200, { id: SID });
    let m;
    if (req.method === "POST" && (m = /^\\/session\\/([^/]+)\\/prompt_async$/.exec(req.url))) {
      if (m[1] !== SID) return json(404, { name: "NotFoundError", data: { message: "Session not found: " + m[1] } });
      res.writeHead(204); res.end();
      void replay();
      return;
    }
    if (req.method === "POST" && (m = /^\\/permission\\/([^/]+)\\/reply$/.exec(req.url))) {
      json(200, true);
      if (waitReply) { const r = waitReply; waitReply = null; r(JSON.parse(raw).reply); }
      return;
    }
    if (req.method === "POST" && /\\/abort$/.test(req.url)) {
      json(200, true);
      send({ type: "session.error", properties: { sessionID: SID, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
      send({ type: "session.idle", properties: { sessionID: SID } });
      return;
    }
    json(404, { name: "NotFoundError" });
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("opencode server listening on http://127.0.0.1:" + server.address().port + "\\n");
});
`;
  return writeFakeBin(path.join(dir, "fake-opencode-serve.js"), body);
}

describe("opencode serve runner integration", () => {
  let tmpDir;
  let store;
  let runner;
  let logFile;
  /** @type {Record<string, string | undefined>} */
  const saved = {};
  const ENV_KEYS = [
    "CODER_OPENCODE_BIN",
    "CODER_OPENCODE_TRANSPORT",
    "CODER_FAKE_SERVE_LOG",
    "CODER_FAKE_SERVE_SCENARIO",
    "CODER_SIMULATE",
    "CODER_AGENT_CMD",
  ];

  function readLog() {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-opencode-serve-"));
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const git = (args) => execFileSync("git", args, { cwd: projectDir, stdio: "ignore" });
    git(["init"]);
    git(["config", "user.email", "t@t.com"]);
    git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);

    logFile = path.join(tmpDir, "serve.log");
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_OPENCODE_TRANSPORT;
    process.env.CODER_OPENCODE_BIN = writeFakeServe(tmpDir);
    process.env.CODER_FAKE_SERVE_LOG = logFile;
    process.env.CODER_FAKE_SERVE_SCENARIO = "fixture";

    store = new Store(path.join(tmpDir, "store.json"));
    const project = await services.addProject(store, projectDir);
    const thread = services.createThread(store, { projectId: project.id, title: "OC serve" });
    services.setProvider(store, { threadId: thread.id, provider: "opencode" });
    store.saveNow();
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({ store, core, pushFn: () => {}, tickMs: 50, userDataPath: tmpDir });
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTree(tmpDir);
  });

  it("asks through the permission card, streams the turn, records real usage", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "run echo" });

    await waitFor(() => runner.getPendingPermission(thread.id) != null);
    const pending = runner.getPendingPermission(thread.id);
    assert.equal(pending.toolName, "bash");
    assert.equal(pending.command, "echo hi-from-probe");
    assert.equal(store.getThread(thread.id).awaitingInput, true);
    runner.respondPermission({ threadId: thread.id, requestId: pending.requestId, decision: "allowAlways" });

    await waitFor(() => store.getThread(thread.id).status === "done");
    const t = store.getThread(thread.id);
    assert.equal(t.sessionId, FIXTURE_SID);
    assert.equal(t.awaitingInput, false);

    const msgs = store.getMessages(thread.id);
    const assistants = msgs.filter((m) => m.role === "assistant");
    assert.equal(assistants[assistants.length - 1].text, "DONE");
    assert.ok(!msgs.some((m) => m.role === "assistant" && /Run the bash command/.test(m.text)));
    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.output, "hi-from-probe\n");
    assert.ok(msgs.some((m) => m.role === "event" && m.text === "Allowed for session: bash: echo hi-from-probe"));

    const usage = store.getUsage(thread.id);
    assert.equal(usage.inputTokens, 22104 + 141 + 22016);
    assert.equal(usage.outputTokens, 26);
    assert.equal(usage.turns, 1);

    const log = readLog();
    const boot = log.find((l) => l.argv);
    assert.deepEqual(boot.argv, ["serve", "--port", "0", "--hostname", "127.0.0.1"]);
    assert.equal(boot.env.OPENCODE_CLIENT, "solenta");
    assert.deepEqual(JSON.parse(boot.env.OPENCODE_PERMISSION), { edit: "ask", bash: "ask" });
    assert.ok(JSON.parse(boot.env.OPENCODE_CONFIG_CONTENT).mcp);
    assert.equal(boot.env.OPENCODE_DISABLE_CLAUDE_CODE, null);
    assert.equal(fs.realpathSync(boot.env.cwd), fs.realpathSync(t.worktreePath || store.getProject(t.projectId).path));
    const reply = log.find((l) => /\/permission\/.*\/reply$/.test(l.url || ""));
    assert.deepEqual(reply.body, { reply: "always" });
    const prompt = log.find((l) => /prompt_async$/.test(l.url || ""));
    assert.equal(prompt.body.parts[0].type, "text");
    assert.match(prompt.body.parts[0].text, /run echo/);
  });

  it("full access answers asks itself and drops OPENCODE_PERMISSION; resume skips POST /session", async () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, {
      permissionMode: "bypassPermissions",
      model: "opencode/big-pickle",
    });
    await runner.startRun({ threadId: thread.id, prompt: "one" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    let log = readLog();
    assert.equal(log.find((l) => l.argv).env.OPENCODE_PERMISSION, null);
    assert.deepEqual(log.find((l) => /reply$/.test(l.url || "")).body, { reply: "once" });
    assert.deepEqual(log.find((l) => /prompt_async$/.test(l.url || "")).body.model, {
      providerID: "opencode",
      modelID: "big-pickle",
    });

    fs.unlinkSync(logFile);
    await runner.startRun({ threadId: thread.id, prompt: "two" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    log = readLog();
    assert.ok(!log.some((l) => l.method === "POST" && l.url === "/session"));
    assert.ok(log.some((l) => l.url === `/session/${FIXTURE_SID}/prompt_async`));
  });

  it("session.error fails the run with the server's message", async () => {
    process.env.CODER_FAKE_SERVE_SCENARIO = "error";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "x" });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    const msgs = store.getMessages(thread.id);
    assert.ok(msgs.some((m) => /APIError: OpenCode 1\.18\.0 or newer/.test(m.text)));
  });

  it("stop aborts the session and kills the server", async () => {
    process.env.CODER_FAKE_SERVE_SCENARIO = "slow";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "x" });
    await waitFor(() => readLog().some((l) => /prompt_async$/.test(l.url || "")));
    await runner.stopRun({ threadId: thread.id });
    await waitFor(() => readLog().some((l) => /\/abort$/.test(l.url || "")));
    assert.equal(store.getThread(thread.id).status, "idle");
  });

  it("CODER_OPENCODE_TRANSPORT=run keeps the old run --format json path", async () => {
    process.env.CODER_OPENCODE_TRANSPORT = "run";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "x" });
    await waitFor(() => readLog().some((l) => l.argv));
    assert.equal(readLog().find((l) => l.argv).argv[0], "run");
  });
});
