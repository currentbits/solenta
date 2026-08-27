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

/** No whitespace: parseAgentCommand splits on spaces. */
function quotaScript(message) {
  const hex = Buffer.from(String(message), "utf8").toString("hex");
  return `process.stderr.write(Buffer.from('${hex}','hex'));process.exit(1)`;
}

function successScript() {
  return "process.stdout.write('resumed');setTimeout(()=>process.exit(0),20)";
}

describe("runner quota-wait (#462)", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-quota-"));
    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();
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
      title: "Quota thread",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("parks on a reset clock instead of failing", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${quotaScript(
      "You've hit your limit · resets 11:59pm",
    )}`;
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    await waitFor(() => store.getThread(thread.id).status === "quota-wait");
    const parked = store.getThread(thread.id);
    assert.equal(parked.status, "quota-wait");
    assert.ok(parked.quotaWaitUntil > Date.now());
    assert.match(String(parked.lastError || ""), /usage limit|hit your limit/i);
    assert.ok(
      (store.getMessages(thread.id) || []).some((m) =>
        String(m.text || "").startsWith("Quota wait:"),
      ),
    );
    assert.equal(
      (store.getMessages(thread.id) || []).filter((m) => m.role === "user")
        .length,
      1,
    );
  });

  it("fails exhausted balance with no reset (Kimi / no-clock)", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${quotaScript(
      "account quota or balance is exhausted. Please top up.",
    )}`;
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    assert.equal(store.getThread(thread.id).status, "failed");
    assert.equal(store.getThread(thread.id).quotaWaitUntil, null);
  });

  it("failovers to the next provider on exhausted quota (#711)", async () => {
    services.setSettings(store, { quotaFailover: ["grok"] });
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${quotaScript(
      "account quota or balance is exhausted. Please top up.",
    )}`;
    const thread = store.getThreads()[0];
    assert.equal(thread.provider, "claude");
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t.provider === "grok" && t.status === "failed";
    });
    const after = store.getThread(thread.id);
    assert.equal(after.provider, "grok");
    assert.ok(
      (store.getMessages(thread.id) || []).some((m) =>
        String(m.text || "").startsWith("Quota failover:"),
      ),
    );
    assert.ok(
      Array.isArray(after.quotaFailoverTried) &&
        after.quotaFailoverTried.includes("claude") &&
        after.quotaFailoverTried.includes("grok"),
    );
  });

  it("does not park Solenta's own daily budget (#286)", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${quotaScript(
      "Daily budget of $1.00 reached",
    )}`;
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    assert.equal(store.getThread(thread.id).status, "failed");
  });

  it("honors the global opt-out", async () => {
    services.setSettings(store, { quotaWaitAutoResume: false });
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${quotaScript(
      "You've hit your limit · resets 11:59pm",
    )}`;
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    assert.equal(store.getThread(thread.id).status, "failed");
  });

  it("wakes once and does not park a second quota hit", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${quotaScript(
      "You've hit your limit · resets in 1s",
    )}`;
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    await waitFor(() => store.getThread(thread.id).status === "quota-wait");
    await waitFor(
      () => store.getThread(thread.id).status === "failed",
      { timeoutMs: 20000 },
    );
    const after = store.getThread(thread.id);
    assert.equal(after.status, "failed");
    assert.equal(after.quotaWaitResumed, true);
    const users = (store.getMessages(thread.id) || []).filter(
      (m) => m.role === "user",
    );
    assert.equal(users.length, 1, "resume must not re-append the user prompt");
  });

  it("resumeQuotaWait starts the same prompt without a second user message", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${quotaScript(
      "You've hit your limit · resets 11:59pm",
    )}`;
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    await waitFor(() => store.getThread(thread.id).status === "quota-wait");

    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${successScript()}`;
    await runner.resumeQuotaWait({ threadId: thread.id });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const users = (store.getMessages(thread.id) || []).filter(
      (m) => m.role === "user",
    );
    assert.equal(users.length, 1);
    assert.equal(users[0].text, "keep going");
    assert.equal(store.getThread(thread.id).quotaWaitUntil, null);
    assert.equal(store.getThread(thread.id).quotaWaitResumed, true);
  });
});
