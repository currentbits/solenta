"use strict";

/**
 * #1200: attach #1171 ServerRequest reply path to the #1170 app-server
 * runner. Fake app-server emits item/commandExecution/requestApproval
 * during an in-progress turn; respondPermission must write
 * { decision: "accept" }. Interactive thread/start and turn/start
 * send approvalPolicy on-request (#1208); exec argv still omits it.
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
const { DECISION_ACCEPT, DECISION_CANCEL } = require("../codexApprovals.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function waitFor(predicate, { timeoutMs = 8000, intervalMs = 20 } = {}) {
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

function readRpc(rpcFile) {
  if (!rpcFile || !fs.existsSync(rpcFile)) return [];
  return fs
    .readFileSync(rpcFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Codex app-server command approval attach (#1200)", () => {
  let tmpDir;
  let store;
  let runner;
  let rpcFile;
  let argvFile;
  let prevSimulate;
  let prevCodexBin;
  let prevScenario;
  let prevArgvFile;
  let prevRpcFile;
  let prevGrokMcpDisable;
  let prevGrokBin;
  let prevGuardrails;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevCodexBin = process.env.CODER_CODEX_BIN;
    prevScenario = process.env.CODER_FAKE_CODEX_SCENARIO;
    prevArgvFile = process.env.CODER_FAKE_CODEX_ARGV_FILE;
    prevRpcFile = process.env.CODER_FAKE_CODEX_RPC_FILE;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;
    prevGrokBin = process.env.CODER_GROK_BIN;
    prevGuardrails = process.env.CODER_GUARDRAILS;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_GUARDRAILS;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";
    process.env.CODER_FAKE_CODEX_SCENARIO = "ask-command";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-ask-rpc-"));
    const helper = require.resolve("./support/fakeCodexCli.js");
    const fake = writeFakeBin(
      path.join(tmpDir, "fake-codex"),
      `"use strict";
require(${JSON.stringify(helper)}).main();
`,
    );
    argvFile = path.join(tmpDir, "argv.json");
    rpcFile = path.join(tmpDir, "rpc.jsonl");
    process.env.CODER_CODEX_BIN = fake;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_CODEX_RPC_FILE = rpcFile;

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
      title: "Codex Ask Attach",
    });
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevCodexBin === undefined) delete process.env.CODER_CODEX_BIN;
    else process.env.CODER_CODEX_BIN = prevCodexBin;
    if (prevScenario === undefined) delete process.env.CODER_FAKE_CODEX_SCENARIO;
    else process.env.CODER_FAKE_CODEX_SCENARIO = prevScenario;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_CODEX_ARGV_FILE;
    else process.env.CODER_FAKE_CODEX_ARGV_FILE = prevArgvFile;
    if (prevRpcFile === undefined) delete process.env.CODER_FAKE_CODEX_RPC_FILE;
    else process.env.CODER_FAKE_CODEX_RPC_FILE = prevRpcFile;
    if (prevGrokMcpDisable === undefined) delete process.env.CODER_GROK_MCP_DISABLE;
    else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
    if (prevGuardrails === undefined) delete process.env.CODER_GUARDRAILS;
    else process.env.CODER_GUARDRAILS = prevGuardrails;
  });

  it("queues a command ServerRequest and respondPermission writes accept", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "do work" });
    await waitFor(() => runner.getPendingPermission(thread.id));
    const pending = runner.getPendingPermission(thread.id);
    assert.equal(pending.toolName, "command");
    assert.equal(pending.command, "npm test");
    assert.equal(pending.commandEditable, false);
    assert.equal(pending.requestId, "ask-1");

    const rpcBefore = readRpc(rpcFile);
    const threadStart = rpcBefore.find((m) => m.method === "thread/start");
    assert.ok(threadStart, "expected thread/start");
    assert.equal(threadStart.params.approvalPolicy, "on-request");
    const turnStart = rpcBefore.find((m) => m.method === "turn/start");
    assert.ok(turnStart, "expected turn/start");
    assert.equal(turnStart.params.approvalPolicy, "on-request");
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("app-server"));
    assert.equal(
      argv.includes("on-request"),
      false,
      "on-request is a JSON-RPC param, not an app-server CLI flag",
    );
    assert.equal(argv.includes("exec"), false);

    runner.respondPermission({
      threadId: thread.id,
      requestId: pending.requestId,
      decision: "allow",
      updatedCommand: "rm -rf /",
    });
    await waitFor(() =>
      readRpc(rpcFile).some(
        (m) =>
          m.id === "ask-1" &&
          m.result &&
          m.result.decision === DECISION_ACCEPT,
      ),
    );
    const accept = readRpc(rpcFile).find(
      (m) => m.id === "ask-1" && m.result,
    );
    assert.deepEqual(accept.result, { decision: DECISION_ACCEPT });
    assert.equal(accept.result.updatedCommand, undefined);
    assert.equal(runner.getPendingPermission(thread.id), null);
    await waitFor(() => store.getThread(thread.id).status === "done");
  });

  it("stop cancels an outstanding command ask then kills", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "do work" });
    await waitFor(() => runner.getPendingPermission(thread.id));
    runner.stopRun({ threadId: thread.id });
    await waitFor(() =>
      readRpc(rpcFile).some(
        (m) =>
          m.id === "ask-1" &&
          m.result &&
          m.result.decision === DECISION_CANCEL,
      ),
    );
    assert.equal(runner.getPendingPermission(thread.id), null);
  });
});
