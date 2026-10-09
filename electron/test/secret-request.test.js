"use strict";

/**
 * Issue #1531: secret_request. The value the user types must reach the next
 * run's env and nothing else: not the store file, the transcript, the MCP
 * result or any other file under userData.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { createToolHandlers } = require("../orchServer.js");
const threadSecrets = require("../threadSecrets.js");
const { rmTree } = require("./support/rmTree.js");

const SECRET = "hunter2-s3cr3t-value";

function waitFor(predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Every file under dir whose bytes contain needle. */
function filesContaining(dir, needle) {
  const hits = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = path.join(e.parentPath, e.name);
    if (fs.readFileSync(p).includes(needle)) hits.push(p);
  }
  return hits;
}

describe("secret_request (#1531)", () => {
  const prevEnv = { ...process.env };
  let tmpDir;
  let runner;

  afterEach(async () => {
    if (runner) runner.stopAll();
    runner = null;
    for (const k of ["CODER_SIMULATE", "CODER_AGENT_CMD", "SECRET_ENV_OUT"]) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (tmpDir) await rmTree(tmpDir);
  });

  it("puts the value in the next run's env and nowhere else", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-secret-"));
    const userData = path.join(tmpDir, "userData");
    fs.mkdirSync(userData);
    // Outside userData: the one place the value is allowed to land.
    const envOut = path.join(tmpDir, "env-seen.txt");
    const agent = path.join(tmpDir, "agent.js");
    fs.writeFileSync(
      agent,
      "require('fs').appendFileSync(process.env.SECRET_ENV_OUT," +
        "(process.env.DB_PASSWORD||'<unset>')+'\\n');process.stdout.write('ok');",
    );
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} ${agent}`;
    process.env.SECRET_ENV_OUT = envOut;

    const store = new Store(path.join(userData, "coder-store.json"));
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15 });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id, title: "Secrets" });
    const h = createToolHandlers({ store, runner });

    await assert.rejects(
      () => h.secret_request({ threadId: thread.id, projectId: project.id, name: "db-pass" }),
      /name must match/,
    );

    const out = await h.secret_request({
      threadId: thread.id,
      projectId: project.id,
      name: "DB_PASSWORD",
      prompt: "Staging database password",
    });
    assert.equal(out.requested, true);
    assert.match(out.note, /End your turn/);
    const card = store.getThread(thread.id).pendingSecret;
    assert.equal(card.name, "DB_PASSWORD");
    assert.equal(store.getThread(thread.id).awaitingInput, true);

    assert.throws(
      () => runner.answerSecret({ threadId: thread.id, requestId: "stale", value: SECRET }),
      /No open secret request/,
    );
    runner.answerSecret({ threadId: thread.id, requestId: card.id, value: SECRET });
    assert.equal(store.getThread(thread.id).pendingSecret, null);

    // The answer starts the next turn, and that run sees the value.
    await waitFor(() => fs.existsSync(envOut) && store.getThread(thread.id).status === "done");
    assert.equal(fs.readFileSync(envOut, "utf8"), `${SECRET}\n`);
    const texts = store.getMessages(thread.id).map((m) => m.text);
    assert.ok(texts.includes("Secret DB_PASSWORD is now available as $DB_PASSWORD"));
    assert.ok(texts.includes("Secret DB_PASSWORD provided"));

    await runner.flushTranscripts();
    store.saveNow();
    assert.ok(!JSON.stringify(out).includes(SECRET), "MCP result");
    assert.ok(!JSON.stringify(store.getMessages(thread.id)).includes(SECRET), "transcript");
    assert.ok(!JSON.stringify(store.getThread(thread.id)).includes(SECRET), "thread row");
    assert.deepEqual(filesContaining(userData, SECRET), [], "files under userData");
    assert.ok(fs.readFileSync(path.join(userData, "coder-store.json")).length > 0);

    // Archive / settle / delete (retireAgent) drops it from later runs.
    threadSecrets.clear(thread.id);
    assert.equal(threadSecrets.withEnv(thread.id, undefined), undefined);
  });

  it("an agent that prints the secret leaves only [secret:NAME] behind", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-secret-echo-"));
    const userData = path.join(tmpDir, "userData");
    fs.mkdirSync(userData);
    const agent = path.join(tmpDir, "agent.js");
    // The leak the env-only design cannot stop by itself: `echo $DB_PASSWORD`.
    fs.writeFileSync(
      agent,
      "process.stdout.write('the password is '+(process.env.DB_PASSWORD||'<unset>'));",
    );
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} ${agent}`;

    const store = new Store(path.join(userData, "coder-store.json"));
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    const pushed = [];
    runner = createRunner({
      store,
      core,
      pushFn: (channel, payload) => pushed.push(JSON.stringify(payload)),
      tickMs: 15,
    });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id, title: "Echo" });
    const h = createToolHandlers({ store, runner });
    await h.secret_request({ threadId: thread.id, projectId: project.id, name: "DB_PASSWORD" });
    const card = store.getThread(thread.id).pendingSecret;
    runner.answerSecret({ threadId: thread.id, requestId: card.id, value: SECRET });

    await waitFor(() => store.getThread(thread.id).status === "done");
    const transcript = JSON.stringify(store.getMessages(thread.id));
    assert.match(transcript, /the password is \[secret:DB_PASSWORD\]/, "agent output redacted");
    assert.ok(!transcript.includes(SECRET), "transcript");
    assert.ok(pushed.length > 0);
    assert.ok(!pushed.some((p) => p.includes(SECRET)), "no detail push carries it");
    await runner.flushTranscripts();
    store.saveNow();
    assert.deepEqual(filesContaining(userData, SECRET), [], "files under userData");
    threadSecrets.clear(thread.id);
  });

  it("declining drops the card without starting a turn", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-secret-"));
    const store = new Store(path.join(tmpDir, "coder-store.json"));
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15 });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id, title: "Decline" });

    const { name } = runner.requestSecret({ threadId: thread.id, name: "API_KEY" });
    assert.equal(name, "API_KEY");
    const card = store.getThread(thread.id).pendingSecret;
    runner.answerSecret({ threadId: thread.id, requestId: card.id, value: null });
    const after = store.getThread(thread.id);
    assert.equal(after.pendingSecret, null);
    assert.equal(after.awaitingInput, false);
    assert.equal(after.queued ?? null, null);
    assert.equal(threadSecrets.withEnv(thread.id, undefined), undefined);
  });
});
