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

  it("fails the send clearly when the row or binary is gone", async () => {
    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "generic:fake" });
    const [only] = store.getSettings().providerInstances;
    store.setSettings({ providerInstances: [{ ...only, command: ["/no/such/agent"] }] });
    await assert.rejects(runner.startRun({ threadId: t.id, prompt: "hi" }), /binary not found/);
    store.setSettings({ providerInstances: [] });
    await assert.rejects(runner.startRun({ threadId: t.id, prompt: "hi" }), /custom CLI was removed/);
  });
});
