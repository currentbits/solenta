"use strict";

/**
 * Custom CLI provider (#458): a providerInstances row with provider
 * "generic" is a user-defined agent binary, run best-effort through the
 * raw-stdout generic runner.
 *
 * Run: node --test electron/test/custom-cli-provider.test.js
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
const inst = require("../providerInstances.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

function waitFor(predicate, { timeoutMs = 15000 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("custom CLI rows parse", () => {
  it("needs a command, keeps argv verbatim, and reserves built-in names", () => {
    const [row] = inst.validateProviderInstances([
      { id: "goose", name: "Goose", provider: "generic", configDir: "/ignored", command: ["goose", "run", "-t"] },
    ]);
    assert.deepEqual(row, {
      id: "goose",
      name: "Goose",
      provider: "generic",
      configDir: null,
      env: {},
      extraArgs: [],
      command: ["goose", "run", "-t"],
      fullAccessArgs: [],
      cwd: null,
      transcript: "stdout",
    });
    assert.throws(
      () => inst.validateProviderInstances([{ id: "x", name: "X", provider: "generic", command: ["x"], transcript: "tty" }]),
      /Transcript/,
    );
    assert.throws(
      () => inst.validateProviderInstances([{ id: "x", name: "X", provider: "generic", command: [] }]),
      /command cannot be empty/,
    );
    assert.throws(
      () => inst.validateProviderInstances([{ id: "x", name: "X", provider: "generic", command: "goose run" }]),
      /command cannot be empty/,
    );
    for (const name of ["Claude Code", "codex", "OPENCODE"]) {
      assert.throws(
        () => inst.validateProviderInstances([{ id: "x", name, provider: "generic", command: ["x"] }]),
        /reserved/,
      );
    }
    // A Claude instance may still be called "codex": it says "Claude Code (codex)".
    assert.equal(
      inst.validateProviderInstances([{ id: "x", name: "codex", provider: "claude" }]).length,
      1,
    );
    // Lenient load drops a broken row instead of failing the store.
    assert.deepEqual(
      inst.normalizeProviderInstances([{ id: "x", name: "X", provider: "generic" }]),
      [],
    );
  });
});

describe("ACP sign-in hint (#272)", () => {
  it("names the agent's terminal login, else its description", () => {
    const { signInHint } = require("../acp.js");
    // Shapes from kimi 0.39.1 and opencode 1.17.12 `acp` initialize.
    assert.equal(
      signInHint([{ id: "login", name: "Login with Kimi account", _meta: { "terminal-auth": { command: "kimi", args: ["login"] } } }]),
      "run `kimi login` in a terminal",
    );
    assert.equal(
      signInHint([{ id: "opencode-login", name: "Login with opencode", description: "Run `opencode auth login` in the terminal" }]),
      "Run `opencode auth login` in the terminal",
    );
    assert.equal(signInHint(undefined), "");
  });
});

describe("custom CLI threads", () => {
  let tmpDir;
  let store;
  let runner;
  let project;
  let bin;
  const saved = {};
  const KEYS = ["CODER_SIMULATE", "CODER_AGENT_CMD"];

  beforeEach(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-custom-cli-"));
    // Prints its argv tail and one env var: the transcript IS stdout.
    bin = writeFakeBin(
      path.join(tmpDir, "fake-agent"),
      `"use strict";
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  key: process.env.FAKE_AGENT_KEY || null,
  cwd: process.cwd(),
  tty: Boolean(process.stdout.isTTY),
}));
`,
    );
    store = new Store(path.join(tmpDir, "store.json"));
    store.setSettings({
      providerInstances: [
        {
          id: "fake",
          name: "Fake Agent",
          provider: "generic",
          configDir: null,
          env: { FAKE_AGENT_KEY: "k-123" },
          command: [bin, "run", "-t"],
          fullAccessArgs: ["--yolo"],
        },
      ],
    });
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: tmpDir });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function replies(threadId) {
    return store
      .getMessages(threadId)
      .filter((m) => m.role === "assistant")
      .map((m) => JSON.parse(m.text));
  }

  it("lists as a best-effort row with only the modes it maps", async () => {
    const list = await services.listProvidersForApi(store, {
      which: () => "/bin/true",
      env: {},
      includeSimulate: false,
    });
    const row = list.find((p) => p.id === "generic:fake");
    assert.ok(row, "custom CLI is listed");
    assert.equal(list.at(-1), row, "after every first-class provider");
    assert.equal(list.some((p) => p.id === "generic"), false, "no bare base row");
    assert.equal(row.name, "Fake Agent");
    assert.equal(row.available, true);
    assert.equal(row.bestEffort, true);
    assert.equal(row.supportsResume, false);
    assert.deepEqual(row.models, []);
    assert.deepEqual(row.permissionModes, ["default", "bypassPermissions"]);

    const [only] = store.getSettings().providerInstances;
    store.setSettings({ providerInstances: [{ ...only, fullAccessArgs: [], command: ["/no/such/agent"] }] });
    const again = (await services.listProvidersForApi(store, { env: {}, includeSimulate: false }))
      .find((p) => p.id === "generic:fake");
    assert.deepEqual(again.permissionModes, [], "the CLI handles permissions: no picker");
    assert.equal(again.available, false);
  });

  it("is reachable only through its ref", () => {
    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "generic:fake" });
    assert.equal(t.provider, "generic");
    assert.equal(t.providerInstance, "fake");
    assert.throws(
      () => services.setProvider(store, { threadId: t.id, provider: "generic" }),
      /Unknown provider instance/,
    );
    const bare = services.createThread(store, { projectId: project.id, title: "b", provider: "generic" });
    assert.equal(bare.provider, "claude", "bare generic falls through like an unknown id");
  });

  it("never snaps a switched-in thread up to full access", () => {
    for (const mode of ["acceptEdits", "auto", "plan"]) {
      const t = services.createThread(store, { projectId: project.id, title: mode });
      services.setPermissionMode(store, { threadId: t.id, mode });
      const moved = services.setProvider(store, { threadId: t.id, provider: "generic:fake" });
      assert.equal(moved.permissionMode, "default", `${mode} must not become --yolo`);
    }
  });

  it("runs argv + prompt last with its env; full access adds its flags", async () => {
    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "generic:fake" });
    await runner.startRun({ threadId: t.id, prompt: "hello agent" });
    await waitFor(() => store.getThread(t.id).status === "done");
    let [first] = replies(t.id);
    assert.deepEqual(first.args.slice(0, 2), ["run", "-t"]);
    assert.match(first.args.at(-1), /hello agent/, "prompt is the last argument");
    assert.equal(first.args.includes("--yolo"), false);
    assert.equal(first.key, "k-123");
    assert.equal(process.env.FAKE_AGENT_KEY, undefined, "never written to process.env");
    assert.equal(store.getThread(t.id).replayContext, true, "next turn replays the tail");

    services.setPermissionMode(store, { threadId: t.id, mode: "bypassPermissions" });
    await runner.startRun({ threadId: t.id, prompt: "second" });
    await waitFor(() => replies(t.id).length === 2 && store.getThread(t.id).status === "done");
    const second = replies(t.id)[1];
    assert.deepEqual(second.args.slice(0, 3), ["run", "-t", "--yolo"]);
    assert.match(second.args.at(-1), /hello agent/, "no session: the prior turn is replayed");
    assert.match(second.args.at(-1), /second/);
  });

  async function send(threadId, prompt) {
    const before = replies(threadId).length;
    await runner.startRun({ threadId, prompt });
    await waitFor(
      () => replies(threadId).length > before && store.getThread(threadId).status === "done",
    );
    return replies(threadId).at(-1);
  }

  function patchRow(patch) {
    const [only] = store.getSettings().providerInstances;
    store.setSettings({ providerInstances: [{ ...only, ...patch }] });
  }

  it("runs in a working folder inside the worktree; a missing one fails clearly", async () => {
    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "generic:fake" });
    const first = await send(t.id, "where");
    assert.equal(first.tty, false, "pipes by default");
    const sub = path.join(first.cwd, "packages", "app");
    patchRow({ cwd: "packages/app" });
    await assert.rejects(runner.startRun({ threadId: t.id, prompt: "x" }), /working folder not found/);
    fs.mkdirSync(sub, { recursive: true });
    const second = await send(t.id, "again");
    assert.equal(fs.realpathSync(second.cwd), fs.realpathSync(sub));
  });

  it("a PTY row runs on a terminal and the reply has no escape codes", { skip: process.platform === "win32" && "node-pty cannot exec a shebang script" }, async () => {
    writeFakeBin(
      bin,
      `"use strict";
process.stdout.write("\\x1b[32mtty=" + Boolean(process.stdout.isTTY) + "\\x1b[0m\\n");
process.stdout.write("working 10%\\rworking 100%\\n");
process.stderr.write("warn: from stderr\\n");
`,
    );
    patchRow({ transcript: "pty" });
    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "generic:fake" });
    await runner.startRun({ threadId: t.id, prompt: "hi" });
    await waitFor(() => store.getThread(t.id).status === "done");
    const text = store.getMessages(t.id).filter((m) => m.role === "assistant").at(-1).text;
    assert.equal(text, "tty=true\nworking 100%\nwarn: from stderr\n");
  });

  /** A fake ACP agent: FAKE_ACP_LOAD advertises loadSession; session "dead" fails to load. */
  function writeFakeAcp() {
    writeFakeBin(
      bin,
      `"use strict";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (u) => send({ method: "session/update", params: { sessionId: "s1", update: u } });
let promptId = null;
let loaded = "none";
let head = "";
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: Boolean(process.env.FAKE_ACP_LOAD) } } });
    else if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1" } });
    else if (msg.method === "session/load") {
      if (msg.params.sessionId === "dead") send({ id: msg.id, error: { code: -32002, message: "Resource not found" } });
      else {
        loaded = msg.params.sessionId;
        // History replay: the client must not count it as this turn's reply.
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY " } });
        send({ id: msg.id, result: {} });
      }
    } else if (msg.method === "session/prompt") {
      promptId = msg.id;
      const text = msg.params.prompt[0].text;
      head = "got " + (/hello acp/.test(text) ? "tail" : "turn") + "; loaded=" + loaded + "; ";
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run tests", kind: "execute", status: "pending", rawInput: { command: "npm test" } });
      send({ id: 99, method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "t1", title: "Run tests", kind: "execute", rawInput: { command: "npm test" } }, options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ] } });
    } else if (msg.id === 99) {
      const o = msg.result.outcome;
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: head + "perm=" + (o.optionId || o.outcome) } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
      send({ id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`,
    );
  }

  const lastReply = (threadId) =>
    store.getMessages(threadId).filter((m) => m.role === "assistant").at(-1).text;

  it("an ACP row (#272) streams chunks, steps tool calls, and asks on the permission card in Default", async () => {
    writeFakeAcp();
    patchRow({ transcript: "acp", fullAccessArgs: [] });
    const row = (await services.listProvidersForApi(store, { which: () => "/bin/true", env: {}, includeSimulate: false }))
      .find((p) => p.id === "generic:fake");
    assert.deepEqual(row.permissionModes, ["default", "bypassPermissions"], "ACP asks per call: both modes apply");

    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "generic:fake" });
    const answered = async (prompt, decision) => {
      await runner.startRun({ threadId: t.id, prompt });
      await waitFor(() => runner.getPendingPermission(t.id) != null);
      const card = runner.getPendingPermission(t.id);
      assert.equal(card.summary, "Run tests");
      assert.equal(card.command, "npm test");
      assert.equal(card.acceptAlways, true);
      assert.equal(store.getThread(t.id).awaitingInput, true);
      assert.ok(
        runner.listPendingApprovals().some((p) => p.threadId === t.id && p.requestId === card.requestId),
        "the Approvals inbox (#291) lists the ACP ask",
      );
      runner.respondPermission({ threadId: t.id, requestId: card.requestId, decision });
      await waitFor(() => store.getThread(t.id).status === "done");
      assert.equal(store.getThread(t.id).awaitingInput, false);
      return lastReply(t.id);
    };
    assert.equal(await answered("hello acp", "allow"), "got tail; loaded=none; perm=yes");
    const labels = store.getWorkLog(t.id).map((w) => `${w.label}:${w.done}`);
    assert.ok(labels.includes("Run tests:true"), labels.join(", "));
    assert.equal(await answered("two", "deny"), "got tail; loaded=none; perm=no", "no loadSession: the tail is replayed");
    assert.ok(store.getMessages(t.id).some((m) => m.role === "event" && m.text === "Denied: Run tests"));

    services.setPermissionMode(store, { threadId: t.id, mode: "bypassPermissions" });
    await runner.startRun({ threadId: t.id, prompt: "three" });
    await waitFor(() => store.getThread(t.id).status === "done");
    assert.equal(lastReply(t.id), "got tail; loaded=none; perm=yes", "full access answers itself");
    assert.equal(store.getThread(t.id).sessionId ?? null, null, "nothing to resume");
  });

  it("Stop answers an open ACP permission request and clears the card", async () => {
    writeFakeAcp();
    patchRow({ transcript: "acp" });
    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "generic:fake" });
    await runner.startRun({ threadId: t.id, prompt: "hi" });
    await waitFor(() => runner.getPendingPermission(t.id) != null);
    await runner.stopRun({ threadId: t.id });
    await waitFor(() => store.getThread(t.id).status === "idle");
    assert.equal(runner.getPendingPermission(t.id), null);
    assert.equal(store.getThread(t.id).awaitingInput, false);
  });

  it("an ACP agent with loadSession resumes its own session instead of replaying", async () => {
    writeFakeAcp();
    patchRow({ transcript: "acp", env: { FAKE_ACP_LOAD: "1" } });
    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "generic:fake" });
    services.setPermissionMode(store, { threadId: t.id, mode: "bypassPermissions" });
    const send = async (prompt, status = "done") => {
      await runner.startRun({ threadId: t.id, prompt });
      await waitFor(() => store.getThread(t.id).status === status);
    };
    await send("hello acp");
    assert.equal(store.getThread(t.id).sessionId, "s1");
    assert.equal(store.getThread(t.id).replayContext, false);
    await send("second");
    assert.equal(lastReply(t.id), "got turn; loaded=s1; perm=yes", "loaded, no tail, no replayed history");

    // A session the agent no longer has fails once, then falls back to replay.
    store.updateThread(t.id, { sessionId: "dead" });
    await send("third", "failed");
    assert.match(store.getThread(t.id).lastError, /could not resume/);
    assert.equal(store.getThread(t.id).sessionId, null);
    assert.equal(store.getThread(t.id).replayContext, true);
    await send("fourth");
    assert.equal(lastReply(t.id), "got tail; loaded=none; perm=yes");
  });

  it("an ACP CLI that never answers initialize times out", async () => {
    writeFakeBin(bin, `process.stdin.resume();\n`);
    const { runAcpAgent } = require("../acp.js");
    const err = await new Promise((resolve) => {
      runAcpAgent({
        command: bin,
        args: [],
        cwd: tmpDir,
        env: process.env,
        prompt: "hi",
        fullAccess: false,
        handshakeTimeoutMs: 200,
        onChunk() {},
        onDone: (code) => resolve(new Error(`done ${code}`)),
        onError: resolve,
      });
    });
    assert.match(err.message, /No ACP handshake within/);
  });

  it("an ACP row whose CLI exits without speaking ACP fails the run", async () => {
    patchRow({ transcript: "acp" });
    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "generic:fake" });
    await runner.startRun({ threadId: t.id, prompt: "hi" });
    await waitFor(() => store.getThread(t.id).status === "failed");
  });

  it("fails the send clearly when the row or binary is gone", async () => {
    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "generic:fake" });
    const [only] = store.getSettings().providerInstances;
    store.setSettings({ providerInstances: [{ ...only, command: ["/no/such/agent"] }] });
    await assert.rejects(runner.startRun({ threadId: t.id, prompt: "hi" }), /binary not found/);
    store.setSettings({ providerInstances: [] });
    await assert.rejects(runner.startRun({ threadId: t.id, prompt: "hi" }), /custom CLI was removed/);
  });
});
