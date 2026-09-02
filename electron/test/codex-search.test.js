/**
 * Issue #174 / #799: per-thread Codex live web search.
 * Codex 0.152.0 rejects `--search` after `exec`; pass `-c web_search=live`.
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
const { writeFakeBin } = require("./support/fakeBin.js");

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

const PROMPT = "PROMPT_CODEX_SEARCH_sentinel_zz9";

function assertPromptLast(args, prompt) {
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
}

describe("codex search: provider capability", () => {
  it("only Codex advertises supportsSearch", () => {
    const list = listProviders({ which: () => null, includeSimulate: true });
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    assert.equal(byId.codex.supportsSearch, true);
    for (const p of list) {
      if (p.id === "codex") continue;
      assert.equal(
        p.supportsSearch,
        false,
        `${p.id} must not advertise supportsSearch`,
      );
    }
    assert.equal(getProvider("codex").supportsSearch, true);
    for (const entry of PROVIDERS) {
      if (entry.id === "codex") continue;
      assert.ok(
        !entry.supportsSearch,
        `${entry.id} registry must not set supportsSearch`,
      );
    }
  });
});

describe("codex search: buildArgs", () => {
  it("omits live search unless webSearch is true", () => {
    const entry = getProvider("codex");
    for (const opts of [{}, { webSearch: false }, { webSearch: null }]) {
      const args = entry.buildArgs({ prompt: PROMPT, ...opts });
      assert.ok(
        !args.includes("--search"),
        `must omit --search for ${JSON.stringify(opts)}: ${JSON.stringify(args)}`,
      );
      assert.ok(
        !args.includes("web_search=live"),
        `must omit web_search=live for ${JSON.stringify(opts)}: ${JSON.stringify(args)}`,
      );
      assertPromptLast(args, PROMPT);
    }
  });

  it("fresh and resume pass -c web_search=live, never --search (issue #799)", () => {
    const entry = getProvider("codex");
    const fresh = entry.buildArgs({ prompt: PROMPT, webSearch: true });
    assert.ok(
      !fresh.includes("--search"),
      `fresh must not pass --search after exec: ${JSON.stringify(fresh)}`,
    );
    assert.ok(
      fresh.includes("web_search=live"),
      `fresh must pass -c web_search=live: ${JSON.stringify(fresh)}`,
    );
    assert.equal(fresh[fresh.indexOf("web_search=live") - 1], "-c");
    assertPromptLast(fresh, PROMPT);
    assert.deepEqual(fresh.slice(0, 3), [
      "exec",
      "--json",
      "--skip-git-repo-check",
    ]);

    const resume = entry.buildArgs({
      prompt: PROMPT,
      sessionId: "sess-search-9",
      webSearch: true,
    });
    assert.equal(resume[0], "exec");
    assert.equal(resume[1], "resume");
    assert.ok(
      !resume.includes("--search"),
      `resume must not pass --search: ${JSON.stringify(resume)}`,
    );
    assert.ok(
      resume.includes("web_search=live"),
      `resume must pass -c web_search=live: ${JSON.stringify(resume)}`,
    );
    assert.equal(resume[resume.indexOf("web_search=live") - 1], "-c");
    assertPromptLast(resume, PROMPT);
  });

  it("keeps live search when model and effort are also set", () => {
    const args = getProvider("codex").buildArgs({
      prompt: PROMPT,
      model: "gpt-5.5",
      reasoningEffort: "high",
      webSearch: true,
    });
    assert.ok(!args.includes("--search"));
    assert.ok(args.includes("web_search=live"));
    assert.equal(args[args.indexOf("web_search=live") - 1], "-c");
    assert.ok(args.includes("model_reasoning_effort=high"));
    const mIdx = args.indexOf("-m");
    assert.ok(mIdx >= 0);
    assert.equal(args[mIdx + 1], "gpt-5.5");
    assertPromptLast(args, PROMPT);
  });

  it("other providers never emit --search even when webSearch is true", () => {
    for (const entry of PROVIDERS) {
      if (entry.id === "codex") continue;
      const args = entry.buildArgs({
        prompt: "p",
        permissionMode: "default",
        webSearch: true,
      });
      assert.ok(
        !args.includes("--search"),
        `${entry.id} must not emit --search: ${JSON.stringify(args)}`,
      );
      assert.ok(
        !args.includes("web_search=live"),
        `${entry.id} must not emit web_search=live: ${JSON.stringify(args)}`,
      );
    }
  });
});

describe("codex search: setWebSearch service", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-search-svc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createThread defaults webSearch to false", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.webSearch, false);
    assert.equal(store.getThread(thread.id).webSearch, false);
  });

  it("accepts true on Codex and persists it", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    const updated = services.setWebSearch(store, {
      threadId: thread.id,
      webSearch: true,
    });
    assert.equal(updated.webSearch, true);
    assert.equal(store.getThread(thread.id).webSearch, true);
  });

  it("accepts false on any provider", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    const updated = services.setWebSearch(store, {
      threadId: thread.id,
      webSearch: false,
    });
    assert.equal(updated.webSearch, false);
  });

  it("rejects true on a provider that does not support search", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.throws(
      () =>
        services.setWebSearch(store, {
          threadId: thread.id,
          webSearch: true,
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Claude Code/i);
        assert.match(err.message, /web search/i);
        return true;
      },
    );
    assert.equal(store.getThread(thread.id).webSearch, false);
  });

  it("rejects unknown threads", () => {
    assert.throws(
      () =>
        services.setWebSearch(store, {
          threadId: "missing",
          webSearch: true,
        }),
      /Unknown thread/,
    );
  });

  it("clears webSearch when switching away from Codex", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    services.setWebSearch(store, { threadId: thread.id, webSearch: true });
    const updated = services.setProvider(store, {
      threadId: thread.id,
      provider: "claude",
    });
    assert.equal(updated.webSearch, false);
    assert.equal(store.getThread(thread.id).webSearch, false);
  });

  it("keeps webSearch when switching between Codex models", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    services.setWebSearch(store, { threadId: thread.id, webSearch: true });
    const updated = services.setProvider(store, {
      threadId: thread.id,
      model: "gpt-5.5",
    });
    assert.equal(updated.webSearch, true);
  });

  it("does not bump updatedAt", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    store.updateThread(thread.id, { updatedAt: 1_700_000_000_000 });
    const updated = services.setWebSearch(store, {
      threadId: thread.id,
      webSearch: true,
    });
    assert.equal(updated.updatedAt, 1_700_000_000_000);
  });
});

describe("codex search: store migration", () => {
  it("heals a missing webSearch field to false without bumping updatedAt", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-search-mig-"));
    const filePath = path.join(tmpDir, "s.json");
    try {
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          projects: [],
          threads: [
            {
              id: "t-old",
              projectId: "p1",
              title: "old",
              status: "idle",
              createdAt: 1,
              updatedAt: 42,
              provider: "codex",
              permissionMode: "default",
            },
          ],
          messagesByThread: {},
          workLogByThread: {},
        }),
        "utf8",
      );
      const store = new Store(filePath);
      const thread = store.getThread("t-old");
      assert.equal(thread.webSearch, false);
      assert.equal(thread.updatedAt, 42);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("codex search: IPC seam + runner wiring", () => {
  it("preload exposes setWebSearch and main handles the channel", () => {
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
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-search-ipc-"));
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
          typeof bridge.coder.threads.setWebSearch,
          "function",
          "preload must expose threads.setWebSearch",
        );
        assert.ok(
          handlers.has("threads:setWebSearch"),
          "main must handle threads:setWebSearch",
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      Module._load = origLoad;
    }
  });

  it("runner passes -c web_search=live into codex argv when the thread has webSearch", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-search-run-"));
    const argvFile = path.join(tmpDir, "argv.json");
    const fakeCodex = writeFakeBin(
      path.join(tmpDir, "fake-codex"),
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
emit({ type: "thread.started", thread_id: "codex-search-sess" });
emit({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text: "ok" },
});
emit({
  type: "turn.completed",
  usage: { input_tokens: 1, output_tokens: 1 },
});
`,
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
        userDataPath: tmpDir,
      });
      const repo = path.join(tmpDir, "app");
      fs.mkdirSync(repo);
      git(repo, ["init"]);
      const project = await services.addProject(store, repo);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Search Run",
      });
      services.setProvider(store, { threadId: thread.id, provider: "codex" });
      services.setWebSearch(store, { threadId: thread.id, webSearch: true });

      const prompt = "PROMPT_RUNNER_SEARCH_r174";
      await runner.startRun({ threadId: thread.id, prompt });
      await waitFor(() => store.getThread(thread.id).status === "done");

      assert.ok(fs.existsSync(argvFile), "fake codex must write argv file");
      const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      assert.ok(
        !argv.includes("--search"),
        `runner must not pass --search after exec, got ${JSON.stringify(argv)}`,
      );
      assert.ok(
        argv.includes("web_search=live"),
        `runner must pass -c web_search=live, got ${JSON.stringify(argv)}`,
      );
      assert.equal(argv[argv.indexOf("web_search=live") - 1], "-c");
      assert.equal(
        argv[argv.length - 1],
        prompt,
        `runner prompt must stay last after live search: ${JSON.stringify(argv)}`,
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
