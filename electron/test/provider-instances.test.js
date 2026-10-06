"use strict";

/**
 * Named provider instances (#453 / #1512 I1): parsing, every path a
 * provider id flows through, and the guarantee that an instance's env
 * reaches its own spawns and nobody else's.
 *
 * Run: node --test electron/test/provider-instances.test.js
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
const { nextQuotaFailover } = require("../quotaWait.js");
const { createSecrets } = require("../secrets.js");
const providerAuth = require("../providerAuth.js");
const { fetchProviderLimits } = require("../providerUsage.js");
const { ejectCommand } = require("../providers.js");
const { materializeCodexGuardrailHome } = require("../codex-guardrail.js");
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

const WORK = {
  id: "work",
  name: "work",
  provider: "claude",
  configDir: null, // set per test
  env: { ANTHROPIC_BASE_URL: "https://router.example", SOLENTA_TEST_SECRET: "sk-work-123" },
};

describe("providerInstances parsing", () => {
  it("parses refs and builds them back", () => {
    assert.deepEqual(inst.parseProviderRef("claude"), { provider: "claude", instance: null });
    assert.deepEqual(inst.parseProviderRef("claude:work"), { provider: "claude", instance: "work" });
    assert.equal(inst.providerRef("codex", "a1"), "codex:a1");
    assert.equal(inst.threadProviderRef({ provider: "claude", providerInstance: null }), "claude");
    assert.equal(inst.threadProviderRef({ provider: "claude", providerInstance: "w" }), "claude:w");
  });

  it("validates strictly and heals leniently", () => {
    assert.throws(
      () => inst.validateProviderInstances([{ id: "x", name: "x", provider: "grok" }]),
      /not supported/,
    );
    assert.throws(
      () => inst.validateProviderInstances([{ id: "x", name: "x", provider: "claude", configDir: "rel/dir" }]),
      /absolute/,
    );
    assert.throws(
      () => inst.validateProviderInstances([{ id: "x", name: "x", provider: "claude", env: { "BAD-KEY": "v" } }]),
      /Invalid env var name/,
    );
    // The folder field owns the config-dir var.
    assert.throws(
      () => inst.validateProviderInstances([{ id: "x", name: "x", provider: "codex", env: { CODEX_HOME: "/x" } }]),
      /config folder/,
    );
    assert.throws(
      () => inst.validateProviderInstances([
        { id: "x", name: "a", provider: "claude" },
        { id: "x", name: "b", provider: "codex" },
      ]),
      /Duplicate/,
    );
    const healed = inst.normalizeProviderInstances([
      { id: "ok", name: "Work", provider: "claude", configDir: "~/.claude-work", env: { A: "1", "B C": "2", CLAUDE_CONFIG_DIR: "/x" } },
      { id: "BAD ID", name: "x", provider: "claude" },
      "junk",
    ]);
    assert.deepEqual(healed, [
      { id: "ok", name: "Work", provider: "claude", configDir: "~/.claude-work", env: { A: "1" } },
    ]);
  });

  it("builds the env overlay, expanding ~ and creating the folder", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "inst-home-"));
    try {
      const env = inst.instanceEnv(
        { id: "c", name: "c", provider: "codex", configDir: "~/.codex-work", env: { K: "v" } },
        home,
      );
      assert.deepEqual(env, { K: "v", CODEX_HOME: path.join(home, ".codex-work") });
      // Codex refuses a CODEX_HOME that does not exist.
      assert.equal(fs.existsSync(path.join(home, ".codex-work")), true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to run a thread whose instance was removed", () => {
    assert.equal(inst.threadInstanceEnv({ providerInstances: [] }, { provider: "claude" }), undefined);
    assert.throws(
      () => inst.threadInstanceEnv({ providerInstances: [] }, { provider: "claude", providerInstance: "gone" }),
      /instance was removed/,
    );
    // An id under another base provider is not a match.
    assert.throws(
      () => inst.threadInstanceEnv(
        { providerInstances: [{ ...WORK, provider: "codex" }] },
        { provider: "claude", providerInstance: "work" },
      ),
      /instance was removed/,
    );
  });
});

describe("threads on a named instance", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-instances-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
    store.setSettings({
      providerInstances: [{ ...WORK, configDir: path.join(tmpDir, "claude-work") }],
    });
  });

  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("settings round-trip through save and load", () => {
    store.saveNow();
    const again = new Store(path.join(tmpDir, "store.json"));
    assert.deepEqual(again.getSettings().providerInstances, store.getSettings().providerInstances);
  });

  it("setProvider takes a ref; another instance drops the session but keeps the model", () => {
    const t = services.createThread(store, { projectId: project.id, title: "t" });
    services.setProvider(store, { threadId: t.id, provider: "claude", model: "opus" });
    store.updateThread(t.id, { sessionId: "sess-1" });

    const moved = services.setProvider(store, { threadId: t.id, provider: "claude:work" });
    assert.equal(moved.provider, "claude");
    assert.equal(moved.providerInstance, "work");
    assert.equal(moved.model, "opus", "same harness: the model survives");
    assert.equal(moved.sessionId, null, "another config dir: the session cannot follow");
    assert.equal(store.getThread(t.id).replayContext, true);

    const back = services.setProvider(store, { threadId: t.id, provider: "claude" });
    assert.equal(back.providerInstance, null);

    assert.throws(
      () => services.setProvider(store, { threadId: t.id, provider: "claude:nope" }),
      /Unknown provider instance/,
    );
    assert.throws(
      () => services.setProvider(store, { threadId: t.id, provider: "codex:work" }),
      /Unknown provider instance/,
    );
  });

  it("createThread honours a ref from input, the global default and project defaults", () => {
    const a = services.createThread(store, { projectId: project.id, title: "a", provider: "claude:work" });
    assert.equal(a.provider, "claude");
    assert.equal(a.providerInstance, "work");

    store.setSettings({ defaultProvider: "claude:work" });
    const b = services.createThread(store, { projectId: project.id, title: "b" });
    assert.equal(b.providerInstance, "work");

    // A removed instance falls through to the plain default.
    store.setSettings({ defaultProvider: "claude:gone" });
    const c = services.createThread(store, { projectId: project.id, title: "c" });
    assert.equal(c.provider, "claude");
    assert.equal("providerInstance" in c, false);
  });

  it("project defaults and last-used record the instance", () => {
    store.setProjects(
      store.getProjects().map((p) => ({ ...p, threadDefaults: { lastUsed: true } })),
    );
    const t = services.createThread(store, { projectId: project.id, title: "t" });
    services.setProvider(store, { threadId: t.id, provider: "claude:work" });
    assert.equal(services.recordLastUsedDefaults(store, t.id), true);
    assert.equal(store.getProject(project.id).threadDefaults.provider, "claude:work");

    // projectDefaultsFor checks the CLI is installed; pin the default
    // explicitly so the test does not depend on this machine's PATH.
    process.env.CODER_CLAUDE_BIN = process.execPath;
    try {
      const next = services.createThread(store, { projectId: project.id, title: "n" });
      assert.equal(next.providerInstance, "work");
    } finally {
      delete process.env.CODER_CLAUDE_BIN;
    }
  });

  it("a fork stays on the source's instance unless told otherwise", () => {
    const t = services.createThread(store, { projectId: project.id, title: "t", provider: "claude:work" });
    const fork = services.forkThread(store, { threadId: t.id });
    assert.equal(fork.providerInstance, "work");
    const plain = services.forkThread(store, { threadId: t.id, provider: "claude" });
    assert.equal(plain.providerInstance ?? null, null);
  });

  it("lists each instance after its base, with the base's capabilities", async () => {
    const list = await services.listProvidersForApi(store, {
      which: () => "/bin/true",
      env: {},
      includeSimulate: false,
    });
    const i = list.findIndex((p) => p.id === "claude");
    const row = list[i + 1];
    assert.equal(row.id, "claude:work");
    assert.equal(row.name, "Claude Code (work)");
    assert.equal(row.baseProvider, "claude");
    assert.equal(row.instanceId, "work");
    assert.deepEqual(row.efforts, list[i].efforts);
  });
});

describe("spawn env stays with its instance", () => {
  let tmpDir;
  let store;
  let runner;
  let project;
  let envLog;
  const saved = {};
  const KEYS = [
    "CODER_SIMULATE",
    "CODER_AGENT_CMD",
    "CODER_CLAUDE_BIN",
    "CODER_GROK_MCP_DISABLE",
    "CODER_GROK_BIN",
    "CODER_FAKE_ENV_LOG",
    "CLAUDE_CONFIG_DIR",
  ];

  beforeEach(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-instances-spawn-"));
    envLog = path.join(tmpDir, "env.log");
    process.env.CODER_FAKE_ENV_LOG = envLog;
    // Interactive fake: logs the env it was born with, answers every turn.
    process.env.CODER_CLAUDE_BIN = writeFakeBin(
      path.join(tmpDir, "fake-claude"),
      `"use strict";
const fs = require("fs");
fs.appendFileSync(process.env.CODER_FAKE_ENV_LOG, JSON.stringify({
  dir: process.env.CLAUDE_CONFIG_DIR || null,
  url: process.env.ANTHROPIC_BASE_URL || null,
  secret: process.env.SOLENTA_TEST_SECRET || null,
}) + "\\n");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "s-" + process.pid, model: "m" });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    emit({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.5, num_turns: 1, session_id: "s-" + process.pid });
  }
});
setInterval(() => {}, 500);
`,
    );
    store = new Store(path.join(tmpDir, "store.json"));
    store.setSettings({
      providerInstances: [{ ...WORK, configDir: path.join(tmpDir, "claude-work") }],
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

  function spawns() {
    return fs.existsSync(envLog)
      ? fs.readFileSync(envLog, "utf8").trim().split("\n").map((l) => JSON.parse(l))
      : [];
  }

  async function turn(threadId, n) {
    await runner.startRun({ threadId, prompt: `turn ${n}` });
    await waitFor(() => store.getThread(threadId).status === "done");
  }

  it("the instance thread gets its env; a base thread next to it does not", async () => {
    const work = services.createThread(store, { projectId: project.id, title: "w", provider: "claude:work" });
    const base = services.createThread(store, { projectId: project.id, title: "b" });
    await turn(work.id, 1);
    await turn(base.id, 1);
    const [w, b] = spawns();
    assert.deepEqual(w, {
      dir: path.join(tmpDir, "claude-work"),
      url: "https://router.example",
      secret: "sk-work-123",
    });
    assert.deepEqual(b, { dir: null, url: null, secret: null });
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, "never written to process.env");

    // Spend is recorded per instance.
    const day = Object.values(store.getUsageByDay())[0];
    assert.ok(day["claude:work"], "instance spend has its own row");
    assert.ok(day.claude, "base spend stays separate");
  });

  it("moving a thread off its instance respawns without the env", async () => {
    const t = services.createThread(store, { projectId: project.id, title: "w", provider: "claude:work" });
    await turn(t.id, 1);
    services.setProvider(store, { threadId: t.id, provider: "claude" });
    await turn(t.id, 2);
    const log = spawns();
    assert.equal(log.length, 2, "the kept-alive CLI is not reused across instances");
    assert.equal(log[1].dir, null);
    assert.equal(log[1].secret, null);
  });

  it("a removed instance fails the send instead of using the default account", async () => {
    const t = services.createThread(store, { projectId: project.id, title: "w", provider: "claude:work" });
    store.setSettings({ providerInstances: [] });
    await assert.rejects(
      runner.startRun({ threadId: t.id, prompt: "hi" }),
      /instance was removed/,
    );
    assert.equal(spawns().length, 0);
  });

  it("codex runs on the instance's CODEX_HOME, through the guardrail overlay", async () => {
    const codexHome = path.join(tmpDir, "codex-work");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    store.setSettings({
      providerInstances: [
        { id: "cw", name: "work", provider: "codex", configDir: codexHome, env: { OPENAI_BASE_URL: "https://x" } },
      ],
    });
    /** @type {any[]} */
    const seen = [];
    runner.stopAll();
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    process.env.CODER_CODEX_BIN = process.execPath;
    try {
      runner = createRunner({
        store,
        core,
        pushFn() {},
        tickMs: 15,
        userDataPath: tmpDir,
        runCodexFn: (opts) => {
          seen.push(opts.envExtra);
          setImmediate(() => opts.onExit({ code: 0, stderr: "" }));
          return { kill() {}, respondJsonRpc() {}, respondJsonRpcError() {} };
        },
      });
      const t = services.createThread(store, { projectId: project.id, title: "c", provider: "codex:cw" });
      await runner.startRun({ threadId: t.id, prompt: "hi" });
      await waitFor(() => seen.length === 1);
      const env = seen[0];
      assert.equal(env.OPENAI_BASE_URL, "https://x");
      // Guardrails on: CODEX_HOME is the per-thread overlay, linked to the
      // instance home, so auth.json is the instance's login.
      assert.equal(
        fs.realpathSync(path.join(env.CODEX_HOME, "auth.json")),
        fs.realpathSync(path.join(codexHome, "auth.json")),
      );
    } finally {
      delete process.env.CODER_CODEX_BIN;
    }
  });
});

describe("codex overlay relinks when the instance changes", () => {
  it("drops links into the previous home, even ones the new home lacks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relink-"));
    try {
      const a = path.join(root, "a");
      const b = path.join(root, "b");
      const dest = path.join(root, "overlay");
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      fs.writeFileSync(path.join(a, "auth.json"), "{\"who\":\"a\"}");
      fs.writeFileSync(path.join(a, "history.jsonl"), "");
      fs.writeFileSync(path.join(b, "history.jsonl"), "");
      materializeCodexGuardrailHome({ dest, sourceHome: a });
      assert.equal(fs.readlinkSync(path.join(dest, "auth.json")), path.join(a, "auth.json"));
      // b is signed out: a's auth.json must not survive into its runs.
      materializeCodexGuardrailHome({ dest, sourceHome: b });
      assert.equal(fs.existsSync(path.join(dest, "auth.json")), false);
      assert.equal(fs.readlinkSync(path.join(dest, "history.jsonl")), path.join(b, "history.jsonl"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("quota failover chain with instances", () => {
  const text = "You've hit your usage limit";

  it("treats each instance as its own quota", () => {
    const settings = { quotaFailover: ["claude:work", "claude", "codex"] };
    // On the base: the instance is next.
    assert.deepEqual(
      nextQuotaFailover({ text, thread: { provider: "claude" }, settings }),
      { provider: "claude:work", tried: ["claude", "claude:work"] },
    );
    // On the instance: the base is a different account, so it is next.
    assert.deepEqual(
      nextQuotaFailover({ text, thread: { provider: "claude", providerInstance: "work" }, settings }),
      { provider: "claude", tried: ["claude:work", "claude"] },
    );
  });
});

describe("instance env is a stored secret", () => {
  it("seals every env value at rest and opens it on load", () => {
    const fake = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`x${s}`),
      decryptString: (b) => b.toString().slice(1),
    };
    const secrets = createSecrets({ safeStorage: fake, inElectron: false, log() {} });
    const settings = {
      providerInstances: [{ ...WORK, configDir: "/c" }],
    };
    const sealed = secrets.concealSettings(settings);
    const env = sealed.providerInstances[0].env;
    assert.equal(secrets.isSealed(env.SOLENTA_TEST_SECRET), true);
    assert.equal(sealed.providerInstances[0].configDir, "/c", "the folder is not a secret");
    assert.equal(JSON.stringify(sealed).includes("sk-work-123"), false);
    const { settings: opened } = secrets.revealSettings(sealed);
    assert.deepEqual(opened.providerInstances[0].env, WORK.env);
  });
});

describe("sign-in and quota per instance", () => {
  afterEach(() => {
    providerAuth.setExecFile(null);
    providerAuth.reset();
  });

  it("probes each instance with its own env and caches under the ref", async () => {
    const calls = [];
    providerAuth.setExecFile((bin, args, opts, cb) => {
      calls.push(opts.env.CLAUDE_CONFIG_DIR || null);
      const stdout = JSON.stringify({ loggedIn: Boolean(opts.env.CLAUDE_CONFIG_DIR) });
      cb(opts.env.CLAUDE_CONFIG_DIR ? null : Object.assign(new Error("x"), { code: 1 }), stdout, "");
    });
    await providerAuth.refresh({
      env: { PATH: process.env.PATH },
      instances: [{ ref: "claude:work", provider: "claude", env: { CLAUDE_CONFIG_DIR: "/w" } }],
    });
    assert.equal(providerAuth.get("claude"), "signedOut");
    assert.equal(providerAuth.get("claude:work"), "signedIn");
    assert.ok(calls.includes("/w"));
  });

  it("a newly added instance is probed without waiting out the TTL", async () => {
    providerAuth.setExecFile((bin, args, opts, cb) => cb(null, JSON.stringify({ loggedIn: true }), ""));
    await providerAuth.refresh({ env: {}, now: 1000 });
    assert.equal(providerAuth.get("claude:new"), "unknown");
    await providerAuth.refresh({
      env: {},
      now: 1001,
      instances: [{ ref: "claude:new", provider: "claude", env: {} }],
    });
    assert.equal(providerAuth.get("claude:new"), "signedIn");
  });

  it("the sign-in line carries only the config dir, never other env", () => {
    assert.equal(
      providerAuth.loginCommand("claude", {
        env: { CODER_CLAUDE_BIN: "claude" },
        platform: "darwin",
        configEnv: { CLAUDE_CONFIG_DIR: "/Users/me/claude work" },
      }),
      "CLAUDE_CONFIG_DIR='/Users/me/claude work' claude auth login",
    );
    assert.equal(
      providerAuth.loginCommand("codex", {
        env: { CODER_CODEX_BIN: "codex" },
        platform: "win32",
        configEnv: { CODEX_HOME: "C:\\codex-work" },
      }),
      'set "CODEX_HOME=C:\\codex-work" && codex login',
    );
  });

  it("quota rows come back per instance, fetched under its env", async () => {
    const seen = [];
    const rows = await fetchProviderLimits({
      env: { HOME: "/h" },
      fetchers: Object.fromEntries(
        ["claude", "codex", "grok", "opencode", "kimi", "cursor", "muse"].map((id) => [
          id,
          async (opts) => {
            seen.push([id, opts.env && opts.env.CLAUDE_CONFIG_DIR]);
            return { provider: id, status: "ok", windows: [], fetchedAt: 1 };
          },
        ]),
      ),
      instances: [{ ref: "claude:work", provider: "claude", env: { CLAUDE_CONFIG_DIR: "/w" } }],
    });
    assert.ok(rows.some((r) => r.provider === "claude:work"));
    assert.deepEqual(seen.filter(([id]) => id === "claude"), [["claude", undefined], ["claude", "/w"]]);
  });
});

describe("terminal resume for an instance thread", () => {
  it("prefixes the config dir so the CLI finds the session", () => {
    const { command } = ejectCommand({
      provider: "claude",
      sessionId: "abc",
      cwd: "/repo",
      configEnv: { CLAUDE_CONFIG_DIR: "/Users/me/.claude-work" },
    });
    assert.equal(
      command,
      "cd '/repo' && CLAUDE_CONFIG_DIR='/Users/me/.claude-work' claude --resume 'abc'",
    );
  });
});
