/**
 * Round 30: real reasoning effort in main.
 *
 * Covers buildArgs per provider (with/without effort), empty-efforts providers
 * never emit a flag, setReasoningEffort reject/accept, store migration, the
 * prompt-stays-last rule for EVERY provider, and runner wiring into buildArgs.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const {
  PROVIDERS,
  getProvider,
  listProviders,
} = require("../providers.js");
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

/** Unique prompt tokens so a missing prompt cannot be satisfied by flag names. */
const PROMPT_CLAUDE = "PROMPT_CLAUDE_r30_sentinel_zz9";
const PROMPT_CODEX = "PROMPT_CODEX_r30_sentinel_zz9";
const PROMPT_GROK = "PROMPT_GROK_r30_sentinel_zz9";
const PROMPT_OPENCODE = "PROMPT_OPENCODE_r30_sentinel_zz9";
const PROMPT_KIMI = "PROMPT_KIMI_r30_sentinel_zz9";

/**
 * Prompt must be the LAST argv element, appear exactly once, and never be the
 * value of an effort flag.
 * @param {string[]} args
 * @param {string} prompt
 * @param {{ effortFlag?: string, effortValue?: string }} [opts]
 */
function assertPromptLast(args, prompt, opts = {}) {
  const hits = args.filter((a) => a === prompt);
  assert.equal(
    hits.length,
    1,
    `prompt must appear exactly once in argv, got ${JSON.stringify(args)}`,
  );
  assert.equal(
    args[args.length - 1],
    prompt,
    `prompt must be the LAST argv element, got ${JSON.stringify(args)}`,
  );
  if (opts.effortFlag && opts.effortValue) {
    const fi = args.indexOf(opts.effortFlag);
    assert.ok(
      fi >= 0,
      `missing effort flag ${opts.effortFlag} in ${JSON.stringify(args)}`,
    );
    assert.equal(args[fi + 1], opts.effortValue);
    assert.notEqual(args[fi + 1], prompt);
    // Effort pair must sit strictly before the trailing prompt.
    assert.ok(fi + 1 < args.length - 1);
  }
}

describe("reasoning effort: provider modelInfo + efforts", () => {
  it("listProviders exposes modelInfo aligned with models, and efforts arrays", () => {
    const list = listProviders({ which: () => null, includeSimulate: true });
    assert.ok(list.length >= 5);

    for (const p of list) {
      assert.ok(Array.isArray(p.modelInfo), `${p.id} must have modelInfo array`);
      assert.ok(Array.isArray(p.efforts), `${p.id} must have efforts array`);
      assert.equal(
        p.modelInfo.length,
        p.models.length,
        `${p.id}: modelInfo length must match models`,
      );
      for (let i = 0; i < p.models.length; i++) {
        assert.equal(
          p.modelInfo[i].id,
          p.models[i],
          `${p.id}: modelInfo[${i}].id must equal models[${i}]`,
        );
        assert.equal(typeof p.modelInfo[i].label, "string");
        assert.ok(p.modelInfo[i].label.length > 0, `${p.id} model label empty`);
        assert.equal(typeof p.modelInfo[i].description, "string");
        assert.ok(
          p.modelInfo[i].description.length > 0,
          `${p.id} model description empty`,
        );
        assert.equal(typeof p.modelInfo[i].vendor, "string");
        assert.ok(p.modelInfo[i].vendor.length > 0, `${p.id} vendor empty`);
      }
    }

    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    assert.deepEqual(byId.claude.efforts, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.deepEqual(byId.codex.efforts, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.deepEqual(byId.grok.efforts, ["low", "medium", "high"]);
    assert.deepEqual(byId.opencode.efforts, []);
    // kimi's levels come from config.toml support_efforts, not a CLI flag:
    // low/high/max, with no medium. Applied via config flip (effortVia).
    assert.deepEqual(byId.kimi.efforts, ["low", "high", "max"]);
    // effortVia is registry-internal (runner concern), not IPC surface.
    assert.equal(byId.kimi.effortVia, undefined);
    assert.equal(getProvider("kimi").effortVia, "config");
    assert.deepEqual(byId.simulate.efforts, []);
    assert.deepEqual(byId.simulate.modelInfo, []);
  });

  it("registry efforts stay in lockstep with buildArgs allow-lists", () => {
    for (const entry of PROVIDERS) {
      assert.ok(Array.isArray(entry.efforts), `${entry.id} efforts`);
      if (entry.efforts.length === 0) {
        const args = entry.buildArgs({
          prompt: "p",
          reasoningEffort: "high",
        });
        assert.ok(
          !args.includes("--effort") &&
            !args.includes("--reasoning-effort") &&
            !args.includes("--variant") &&
            !args.some((a) => String(a).startsWith("model_reasoning_effort=")),
          `${entry.id} with empty efforts must not emit effort flags: ${JSON.stringify(args)}`,
        );
      } else if (entry.effortVia === "config") {
        // Efforts applied outside argv (kimi config flip): the level must
        // NEVER leak into argv, same assertions as the empty-efforts case.
        const args = entry.buildArgs({
          prompt: "p",
          reasoningEffort: entry.efforts[0],
        });
        assert.ok(
          !args.includes("--effort") &&
            !args.includes("--reasoning-effort") &&
            !args.includes("--variant") &&
            !args.some((a) => String(a).startsWith("model_reasoning_effort=")),
          `${entry.id} with effortVia config must not emit effort flags: ${JSON.stringify(args)}`,
        );
      } else {
        const level = entry.efforts[0];
        const withEffort = entry.buildArgs({
          prompt: "p",
          reasoningEffort: level,
        });
        const joined = withEffort.join("\0");
        assert.ok(
          joined.includes(level),
          `${entry.id} must put supported level ${level} into argv: ${JSON.stringify(withEffort)}`,
        );
      }
    }
  });
});

describe("reasoning effort: buildArgs per provider", () => {
  it("claude: no flag without effort; --effort before trailing prompt", () => {
    const entry = getProvider("claude");
    const bare = entry.buildArgs({
      prompt: PROMPT_CLAUDE,
      permissionMode: "default",
    });
    assert.ok(!bare.includes("--effort"), `no effort flag: ${JSON.stringify(bare)}`);
    assertPromptLast(bare, PROMPT_CLAUDE);

    const withEffort = entry.buildArgs({
      prompt: PROMPT_CLAUDE,
      permissionMode: "default",
      reasoningEffort: "xhigh",
    });
    assertPromptLast(withEffort, PROMPT_CLAUDE, {
      effortFlag: "--effort",
      effortValue: "xhigh",
    });
  });

  it("codex: -c model_reasoning_effort= before trailing prompt", () => {
    const entry = getProvider("codex");
    const bare = entry.buildArgs({ prompt: PROMPT_CODEX });
    assert.ok(
      !bare.some((a) => String(a).includes("model_reasoning_effort")),
      `no effort in ${JSON.stringify(bare)}`,
    );
    assertPromptLast(bare, PROMPT_CODEX);

    const withEffort = entry.buildArgs({
      prompt: PROMPT_CODEX,
      reasoningEffort: "medium",
    });
    assertPromptLast(withEffort, PROMPT_CODEX);
    let found = false;
    for (let i = 0; i < withEffort.length - 1; i++) {
      if (
        withEffort[i] === "-c" &&
        withEffort[i + 1] === "model_reasoning_effort=medium"
      ) {
        found = true;
        assert.ok(
          i + 1 < withEffort.length - 1,
          "effort -c pair must sit before trailing prompt",
        );
      }
    }
    assert.ok(
      found,
      `missing model_reasoning_effort=medium in ${JSON.stringify(withEffort)}`,
    );

    const resume = entry.buildArgs({
      prompt: PROMPT_CODEX,
      sessionId: "sess-1",
      reasoningEffort: "low",
    });
    assertPromptLast(resume, PROMPT_CODEX);
    assert.ok(
      resume.includes("model_reasoning_effort=low"),
      JSON.stringify(resume),
    );
  });

  it("grok: --reasoning-effort before trailing -p prompt", () => {
    const entry = getProvider("grok");
    const bare = entry.buildArgs({
      prompt: PROMPT_GROK,
      permissionMode: "default",
    });
    assert.ok(!bare.includes("--reasoning-effort"));
    assertPromptLast(bare, PROMPT_GROK);
    assert.equal(bare[bare.length - 2], "-p");

    const withEffort = entry.buildArgs({
      prompt: PROMPT_GROK,
      permissionMode: "default",
      reasoningEffort: "low",
    });
    assertPromptLast(withEffort, PROMPT_GROK, {
      effortFlag: "--reasoning-effort",
      effortValue: "low",
    });
    assert.equal(withEffort[withEffort.length - 2], "-p");
  });

  it("opencode: empty efforts never invents a flag; prompt last", () => {
    const entry = getProvider("opencode");
    assert.deepEqual(entry.efforts, []);
    const bare = entry.buildArgs({ prompt: PROMPT_OPENCODE });
    assertPromptLast(bare, PROMPT_OPENCODE);
    assert.ok(!bare.includes("--variant"));

    const forced = entry.buildArgs({
      prompt: PROMPT_OPENCODE,
      reasoningEffort: "high",
    });
    assertPromptLast(forced, PROMPT_OPENCODE);
    assert.ok(!forced.includes("--variant"));
    assert.ok(!forced.includes("--effort"));
    assert.ok(!forced.includes("--reasoning-effort"));
  });

  it("kimi: effort never reaches argv even though efforts are listed", () => {
    // kimi 0.31.1 rejects every effort-shaped flag; the level is applied by
    // flipping [thinking].effort in config.toml (kimi.js), not by argv.
    const entry = getProvider("kimi");
    assert.deepEqual(entry.efforts, ["low", "high", "max"]);
    const forced = entry.buildArgs({
      prompt: PROMPT_KIMI,
      permissionMode: "default",
      reasoningEffort: "high",
    });
    assert.ok(!forced.includes("--effort"));
    assert.ok(!forced.includes("--reasoning-effort"));
    assert.ok(!forced.includes("--variant"));
    assert.ok(
      !forced.some((a) => String(a).includes("model_reasoning_effort")),
    );
    assertPromptLast(forced, PROMPT_KIMI);
    assert.equal(forced[forced.length - 2], "-p");
  });

  it("prompt stays LAST for every provider, with and without every advertised effort", () => {
    // The class of bug: a new flag is appended after the prompt, or a
    // value-taking flag eats the prompt. Pin last element for ALL providers.
    for (const entry of PROVIDERS) {
      const prompt = `PROMPT_LAST_${entry.id}_r30`;
      const levels = [null, ...entry.efforts];
      // Also try a level the provider does not advertise (must still leave
      // prompt last and must not invent a flag for empty-effort providers).
      if (!levels.includes("high")) levels.push("high");
      for (const effort of levels) {
        const args = entry.buildArgs({
          prompt,
          permissionMode: "default",
          reasoningEffort: effort,
        });
        assert.equal(
          args[args.length - 1],
          prompt,
          `${entry.id} effort=${effort}: prompt must be last, got ${JSON.stringify(args)}`,
        );
        assert.equal(
          args.filter((a) => a === prompt).length,
          1,
          `${entry.id} effort=${effort}: prompt must appear once`,
        );
      }
    }
  });
});

describe("reasoning effort: store migration", () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-effort-store-"));
    filePath = path.join(tmpDir, "coder-store.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("old threads missing reasoningEffort migrate to null, not undefined", () => {
    const old = {
      projects: [],
      threads: [
        {
          id: "t-pre-effort",
          projectId: "p1",
          title: "Legacy",
          branch: null,
          prNumber: null,
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
          provider: "claude",
          model: null,
          sessionId: null,
          permissionMode: "default",
          worktreePath: null,
          runStartedAt: null,
          archived: false,
          // reasoningEffort deliberately absent
        },
      ],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");
    const store = new Store(filePath);
    const t = store.getThreads()[0];
    assert.equal(t.reasoningEffort, null);
    assert.ok(
      Object.prototype.hasOwnProperty.call(t, "reasoningEffort"),
      "key must exist after migration",
    );
    assert.notEqual(t.reasoningEffort, undefined);
  });
});

describe("reasoning effort: setReasoningEffort service", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-effort-svc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createThread defaults reasoningEffort to null", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.reasoningEffort, null);
    assert.equal(store.getThread(thread.id).reasoningEffort, null);
  });

  it("accepts null for any provider (provider default)", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "kimi" });
    const updated = services.setReasoningEffort(store, {
      threadId: thread.id,
      effort: null,
    });
    assert.equal(updated.reasoningEffort, null);
  });

  it("accepts a level the provider lists (including xhigh for claude)", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    const updated = services.setReasoningEffort(store, {
      threadId: thread.id,
      effort: "xhigh",
    });
    assert.equal(updated.reasoningEffort, "xhigh");
    assert.equal(store.getThread(thread.id).reasoningEffort, "xhigh");
  });

  it("rejects an unsupported level and names the provider (claude silent-ignore class)", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    // claude would silently ignore "bogus" at the CLI; we must reject first.
    assert.throws(
      () =>
        services.setReasoningEffort(store, {
          threadId: thread.id,
          effort: "bogus",
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Claude Code/i);
        assert.match(err.message, /bogus/);
        return true;
      },
    );
    assert.equal(store.getThread(thread.id).reasoningEffort, null);
  });

  it("rejects grok levels outside low|medium|high and names Grok", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
    assert.throws(
      () =>
        services.setReasoningEffort(store, {
          threadId: thread.id,
          effort: "max",
        }),
      (err) => {
        assert.match(err.message, /Grok/i);
        assert.match(err.message, /max/);
        return true;
      },
    );
  });

  it("clears a stranded effort when the provider changes", () => {
    // A level the NEW provider does not list would never reach its CLI while
    // the picker kept showing it: a setting displayed to the user that does
    // nothing, which is the bug this whole feature removed.
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "claude" });
    services.setReasoningEffort(store, { threadId: thread.id, effort: "max" });
    assert.equal(store.getThread(thread.id).reasoningEffort, "max");

    // grok lists only low, medium, high: max cannot survive the switch.
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
    assert.equal(
      store.getThread(thread.id).reasoningEffort,
      null,
      "an effort the new provider cannot honour must not be kept",
    );
  });

  it("rejects any effort for a provider with empty efforts, naming the provider", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "opencode" });
    assert.throws(
      () =>
        services.setReasoningEffort(store, {
          threadId: thread.id,
          effort: "high",
        }),
      (err) => {
        assert.match(err.message, /OpenCode/i);
        assert.match(err.message, /high/);
        return true;
      },
    );
  });

  it("kimi: accepts its config levels but rejects medium, which it lacks", () => {
    // kimi's set is low/high/max; medium looks plausible (claude and grok
    // both have it) and must fail loudly rather than be stored and ignored.
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "kimi" });
    const updated = services.setReasoningEffort(store, {
      threadId: thread.id,
      effort: "max",
    });
    assert.equal(updated.reasoningEffort, "max");
    assert.throws(
      () =>
        services.setReasoningEffort(store, {
          threadId: thread.id,
          effort: "medium",
        }),
      /Kimi Code does not support reasoning effort "medium"/,
    );
  });

  it("does not bump updatedAt", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });
    const updated = services.setReasoningEffort(store, {
      threadId: thread.id,
      effort: "low",
    });
    assert.equal(updated.updatedAt, 1_700_000_000_000);
  });
});

describe("reasoning effort: IPC seam + runner wiring", () => {
  it("preload exposes setReasoningEffort and main handles the channel", () => {
    const Module = require("node:module");
    const handlers = new Map();
    const bridge = {};
    const stub = {
      ipcMain: {
        handle(channel, cb) {
          handlers.set(channel, cb);
        },
      },
      ipcRenderer: {
        invoke(channel, ...args) {
          const cb = handlers.get(channel);
          if (!cb) {
            return Promise.reject(
              new Error(`No handler registered for '${channel}'`),
            );
          }
          return Promise.resolve(cb({}, ...args));
        },
        on() {},
        removeListener() {},
      },
      contextBridge: {
        exposeInMainWorld(name, api) {
          bridge[name] = api;
        },
      },
      dialog: {},
      shell: {},
      app: { getPath: () => os.tmpdir() },
    };
    const origLoad = Module._load;
    Module._load = function (request) {
      if (request === "electron") return stub;
      return origLoad.apply(this, arguments);
    };
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-effort-ipc-"));
      try {
        delete require.cache[require.resolve("../ipc.js")];
        delete require.cache[require.resolve("../preload.js")];
        const { registerIpc } = require("../ipc.js");
        const s = new Store(path.join(tmp, "store.json"));
        registerIpc({
          ipcMain: stub.ipcMain,
          dialog: {},
          store: s,
          runner: { start() {}, stop() {}, stopAll() {} },
          broadcast() {},
          worktreeBase: path.join(tmp, "wt"),
          userDataPath: tmp,
        });
        require("../preload.js");
        assert.equal(
          typeof bridge.coder.threads.setReasoningEffort,
          "function",
          "preload must expose threads.setReasoningEffort",
        );
        assert.ok(
          handlers.has("threads:setReasoningEffort"),
          "main must handle threads:setReasoningEffort",
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      Module._load = origLoad;
    }
  });

  it("runner passes thread.reasoningEffort into claude buildArgs (argv evidence)", async () => {
    // The claude-stream call site serves claude AND grok, and claude answers a
    // missing or unknown effort with a warning and its default. So this is the
    // path where losing the argument is invisible, and it had no coverage.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-effort-claude-"));
    const argvFile = path.join(tmpDir, "argv.json");
    const fakeClaude = path.join(tmpDir, "fake-claude");
    fs.writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_CLAUDE_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "system", subtype: "init", session_id: "claude-effort-sess" });
emit({
  type: "assistant",
  message: { content: [{ type: "text", text: "ok" }] },
});
emit({
  type: "result",
  subtype: "success",
  usage: { input_tokens: 1, output_tokens: 1 },
});
`,
      { mode: 0o755 },
    );

    const prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_CLAUDE_BIN: process.env.CODER_CLAUDE_BIN,
      CODER_FAKE_CLAUDE_ARGV_FILE: process.env.CODER_FAKE_CLAUDE_ARGV_FILE,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    delete process.env.CODER_SIMULATE;
    process.env.CODER_CLAUDE_BIN = fakeClaude;
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE = argvFile;
    process.env.CODER_GROK_MCP_DISABLE = "1";

    let runner;
    try {
      const store = new Store(path.join(tmpDir, "store.json"));
      const core = await loadCore();
      runner = createRunner({ store, core, pushFn() {}, tickMs: 15 });
      const repo = path.join(tmpDir, "app");
      fs.mkdirSync(repo);
      git(repo, ["init"]);
      const project = services.addProject(store, repo);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Effort Run Claude",
      });
      services.setProvider(store, { threadId: thread.id, provider: "claude" });
      services.setReasoningEffort(store, {
        threadId: thread.id,
        effort: "xhigh",
      });

      const prompt = "PROMPT_RUNNER_EFFORT_CLAUDE_r30";
      await runner.startRun({ threadId: thread.id, prompt });
      await waitFor(() => store.getThread(thread.id).status === "done");

      assert.ok(fs.existsSync(argvFile), "fake claude must write argv file");
      const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      const at = argv.indexOf("--effort");
      assert.ok(at >= 0, `runner must pass --effort, got ${JSON.stringify(argv)}`);
      assert.equal(
        argv[at + 1],
        "xhigh",
        `--effort must carry the level, got ${JSON.stringify(argv)}`,
      );
      assert.equal(
        argv[argv.length - 1],
        prompt,
        `prompt must stay last after effort inject: ${JSON.stringify(argv)}`,
      );
    } finally {
      if (runner) runner.stopAll();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("runner passes thread.reasoningEffort into codex buildArgs (argv evidence)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-effort-run-"));
    const argvFile = path.join(tmpDir, "argv.json");
    const fakeCodex = path.join(tmpDir, "fake-codex");
    fs.writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_CODEX_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "thread.started", thread_id: "codex-effort-sess" });
emit({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text: "ok" },
});
emit({
  type: "turn.completed",
  usage: { input_tokens: 1, output_tokens: 1 },
});
`,
      { mode: 0o755 },
    );

    const prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_CODEX_BIN: process.env.CODER_CODEX_BIN,
      CODER_FAKE_CODEX_ARGV_FILE: process.env.CODER_FAKE_CODEX_ARGV_FILE,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
    };
    delete process.env.CODER_SIMULATE;
    process.env.CODER_CODEX_BIN = fakeCodex;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok";

    let runner;
    try {
      const store = new Store(path.join(tmpDir, "store.json"));
      const core = await loadCore();
      runner = createRunner({
        store,
        core,
        pushFn() {},
        tickMs: 15,
      });
      const repo = path.join(tmpDir, "app");
      fs.mkdirSync(repo);
      git(repo, ["init"]);
      const project = services.addProject(store, repo);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Effort Run",
      });
      services.setProvider(store, { threadId: thread.id, provider: "codex" });
      services.setReasoningEffort(store, {
        threadId: thread.id,
        effort: "high",
      });

      const prompt = "PROMPT_RUNNER_EFFORT_r30";
      await runner.startRun({ threadId: thread.id, prompt });
      await waitFor(() => store.getThread(thread.id).status === "done");

      assert.ok(fs.existsSync(argvFile), "fake codex must write argv file");
      const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      assert.ok(
        argv.includes("model_reasoning_effort=high"),
        `runner must pass effort into codex argv, got ${JSON.stringify(argv)}`,
      );
      assert.equal(
        argv[argv.length - 1],
        prompt,
        `runner prompt must stay last after effort inject: ${JSON.stringify(argv)}`,
      );
    } finally {
      if (runner) runner.stopAll();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
