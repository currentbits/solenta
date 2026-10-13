/**
 * Subagent model pool (issue #467): normalize, validate, resolve, menu.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store");
const services = require("../services");
const {
  EMPTY_SUBAGENT_POOL,
  normalizeSubagentPool,
  validateSubagentPool,
  resolveSubagentPool,
  formatPoolMenu,
  subagentPoolNoteFor,
  poolFromStore,
  nextPoolEntry,
  isProviderBinaryError,
  startWithPoolFailover,
} = require("../subagentPool");
const {
  registerMcpServer,
  unregisterMcpServer,
} = require("../memory-sup.js");

function entry(over = {}) {
  return {
    alias: "fast",
    provider: "kimi",
    model: "kimi-for-coding-highspeed",
    description: "Fast and cheap. Good for daily refactoring and small edits.",
    ...over,
  };
}

function strong(over = {}) {
  return entry({
    alias: "strong",
    provider: "claude",
    model: null,
    description: "Strong at complex reasoning and deep debugging.",
    ...over,
  });
}

function pool(over = {}) {
  return {
    defaultAlias: "fast",
    force: false,
    entries: [entry(), strong()],
    ...over,
  };
}

describe("normalizeSubagentPool", () => {
  it("absent / junk → empty pool", () => {
    const empty = {
      defaultAlias: null,
      force: false,
      entries: [],
    };
    assert.deepEqual(normalizeSubagentPool(undefined), empty);
    assert.deepEqual(normalizeSubagentPool(null), empty);
    assert.deepEqual(normalizeSubagentPool("nope"), empty);
    assert.deepEqual(normalizeSubagentPool([]), empty);
    assert.deepEqual(normalizeSubagentPool({ entries: null }), empty);
    assert.deepEqual(normalizeSettings({}).subagentPool, empty);
  });

  it("drops invalid entries, dedupes aliases, heals a missing default", () => {
    const n = normalizeSubagentPool({
      defaultAlias: "gone",
      force: true,
      entries: [
        entry(),
        "garbage",
        null,
        { alias: "FAST", provider: "kimi", model: null, description: "dup" },
        { alias: "", provider: "kimi", model: null, description: "x" },
        { alias: "no-provider", provider: "", model: null, description: "x" },
        { alias: "bad-model", provider: "kimi", model: 1, description: "x" },
        { alias: "no-desc", provider: "kimi", model: null, description: "" },
        { alias: "long", provider: "kimi", model: null, description: "x".repeat(161) },
        strong({ description: "  Strong   at   hard   problems.  " }),
      ],
    });
    assert.deepEqual(n.entries, [
      entry(),
      strong({ description: "Strong at hard problems." }),
    ]);
    assert.equal(n.defaultAlias, null);
    assert.equal(n.force, false);
  });

  it("keeps a valid default and only honors force when a default exists", () => {
    const n = normalizeSubagentPool({
      defaultAlias: " Strong ",
      force: true,
      entries: [entry(), strong()],
    });
    assert.equal(n.defaultAlias, "strong");
    assert.equal(n.force, true);
  });
});

describe("validateSubagentPool", () => {
  it("accepts a valid pool and lowercases the alias", () => {
    const next = validateSubagentPool({
      defaultAlias: "FAST",
      force: false,
      entries: [entry({ alias: "FAST" }), strong()],
    });
    assert.equal(next.entries[0].alias, "fast");
    assert.equal(next.defaultAlias, "fast");
  });

  it("rejects each invalid shape", () => {
    const reject = (raw, re) => {
      assert.throws(() => validateSubagentPool(raw), re);
    };
    reject(null, /must be an object/);
    reject([], /must be an object/);
    reject({ entries: "nope" }, /entries must be an array/);
    reject({ entries: [entry(), entry()] }, /Duplicate subagentPool alias/);
    reject({ entries: [{ alias: "Fast!", provider: "kimi", model: null, description: "x" }] }, /lowercase slug/);
    reject({ entries: [entry({ provider: "" })] }, /provider must be a non-empty string/);
    reject({ entries: [entry({ model: 1 })] }, /model must be a string or null/);
    reject({ entries: [entry({ description: "" })] }, /description must be a non-empty string/);
    reject(
      { entries: [entry({ description: "x".repeat(161) })] },
      /at most 160 characters/,
    );
    reject(
      { defaultAlias: "missing", entries: [entry()] },
      /not in entries/,
    );
    reject({ defaultAlias: 1, entries: [entry()] }, /defaultAlias must be a string or null/);
    reject({ force: "yes", entries: [entry()] }, /force must be a boolean/);
  });
});

describe("setSettings subagentPool", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pool-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("round-trips a valid pool across save + reload", () => {
    const store = new Store(filePath);
    const next = services.setSettings(store, { subagentPool: pool() });
    assert.deepEqual(next.subagentPool, pool());
    store.saveNow();
    assert.deepEqual(new Store(filePath).getSettings().subagentPool, pool());
  });

  it("old store file without the key heals to the empty pool", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        projects: [],
        threads: [],
        settings: { dailyBudgetUsd: null },
      }),
    );
    const store = new Store(filePath);
    assert.deepEqual(store.getSettings().subagentPool, {
      defaultAlias: null,
      force: false,
      entries: [],
    });
  });

  it("rejects an invalid patch and leaves the saved pool untouched", () => {
    const store = new Store(filePath);
    services.setSettings(store, { subagentPool: pool() });
    assert.throws(
      () => services.setSettings(store, { subagentPool: { entries: "nope" } }),
      /entries must be an array/,
    );
    assert.deepEqual(store.getSettings().subagentPool, pool());
  });

  it("a patch that omits subagentPool leaves it untouched", () => {
    const store = new Store(filePath);
    services.setSettings(store, { subagentPool: pool() });
    const next = services.setSettings(store, { notifications: false });
    assert.equal(next.notifications, false);
    assert.deepEqual(next.subagentPool, pool());
  });
});

describe("resolveSubagentPool", () => {
  it("empty pool: inherit, or pass through an explicit provider", () => {
    assert.equal(resolveSubagentPool(EMPTY_SUBAGENT_POOL, {}), null);
    assert.deepEqual(resolveSubagentPool(null, { provider: "codex" }), {
      provider: "codex",
      fromPool: false,
    });
    assert.throws(
      () => resolveSubagentPool(EMPTY_SUBAGENT_POOL, { pool: "fast" }),
      /Unknown pool alias: fast/,
    );
  });

  it("omitted pick uses the default alias", () => {
    assert.deepEqual(resolveSubagentPool(pool(), {}), {
      provider: "kimi",
      model: "kimi-for-coding-highspeed",
      alias: "fast",
      fromPool: true,
    });
  });

  it("pool alias wins over an explicit provider", () => {
    assert.deepEqual(
      resolveSubagentPool(pool(), { pool: "strong", provider: "grok" }),
      {
        provider: "claude",
        model: null,
        alias: "strong",
        fromPool: true,
      },
    );
  });

  it("explicit provider wins when no alias is given", () => {
    assert.deepEqual(resolveSubagentPool(pool(), { provider: "grok" }), {
      provider: "grok",
      fromPool: false,
    });
  });

  it("force pins the default and ignores pool and provider", () => {
    const pinned = pool({ force: true });
    assert.deepEqual(
      resolveSubagentPool(pinned, { pool: "strong", provider: "grok" }),
      {
        provider: "kimi",
        model: "kimi-for-coding-highspeed",
        alias: "fast",
        fromPool: true,
      },
    );
  });

  it("unknown alias throws", () => {
    assert.throws(
      () => resolveSubagentPool(pool(), { pool: "nope" }),
      /Unknown pool alias: nope/,
    );
  });

  it("entries without a default inherit unless an alias is given", () => {
    const open = pool({ defaultAlias: null });
    assert.equal(resolveSubagentPool(open, {}), null);
    assert.deepEqual(resolveSubagentPool(open, { pool: "strong" }), {
      provider: "claude",
      model: null,
      alias: "strong",
      fromPool: true,
    });
  });
});

describe("formatPoolMenu / subagentPoolNoteFor", () => {
  it("empty pool produces no menu", () => {
    assert.equal(formatPoolMenu(EMPTY_SUBAGENT_POOL), "");
    assert.equal(formatPoolMenu(null), "");
  });

  it("lists aliases and one-liners, not raw model ids as the pick API", () => {
    const menu = formatPoolMenu(pool());
    assert.match(menu, /Pass pool=<alias>/);
    assert.match(menu, /Omit pool to use "fast"/);
    assert.match(menu, /- fast: Fast and cheap/);
    assert.match(menu, /- strong: Strong at complex reasoning/);
    assert.match(menu, /\(kimi \/ kimi-for-coding-highspeed\)/);
    assert.match(menu, /\(claude \/ default\)/);
    assert.doesNotMatch(menu, /pass a raw model id/i);
  });

  it("hides entries whose provider is unavailable", () => {
    const menu = formatPoolMenu(pool(), {
      isAvailable: (id) => id !== "kimi",
    });
    assert.doesNotMatch(menu, /fast:/);
    assert.match(menu, /strong:/);
    assert.match(menu, /Omit pool to inherit/);
  });

  it("says so when every pool provider is missing", () => {
    const menu = formatPoolMenu(pool(), { isAvailable: () => false });
    assert.match(menu, /No pool providers are installed/);
    assert.doesNotMatch(menu, /fast:/);
  });

  it("force pin falls back to listing remaining when the pin is missing", () => {
    const menu = formatPoolMenu(pool({ force: true }), {
      isAvailable: (id) => id !== "kimi",
    });
    assert.doesNotMatch(menu, /Pinned to "fast"/);
    assert.match(menu, /strong:/);
  });

  it("force menu says the pick is pinned", () => {
    const menu = formatPoolMenu(pool({ force: true }));
    assert.match(menu, /Pinned to "fast"/);
    assert.match(menu, /ignored/);
    assert.doesNotMatch(menu, /^- fast:/m);
  });

  it("note is gated on coder-threads being registered", () => {
    assert.equal(subagentPoolNoteFor(pool()), "");
    assert.equal(
      registerMcpServer({
        name: "coder-threads",
        port: 1234,
        token: "tok",
        userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), "pool-note-")),
      }),
      true,
    );
    try {
      const note = subagentPoolNoteFor(pool());
      assert.match(note, /^\[Worker pool\]/m);
    } finally {
      unregisterMcpServer("coder-threads");
    }
    assert.equal(subagentPoolNoteFor(pool()), "");
  });

  // #1403: the worker CLI runs on the ssh host / inside the WSL distro, so a
  // missing local binary must not hide its alias from the lead.
  it("boundary projects list aliases whose CLI is missing locally", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-remote-"));
    const prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
    };
    process.env.CODER_SIMULATE = "1";
    // registerMcpServer must not touch the developer's real grok/kimi config.
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    process.env.CODER_KIMI_BIN = path.join(tmpDir, "no-kimi");
    const realNote = services.subagentPoolNoteFor;
    const notes = [];
    services.subagentPoolNoteFor = (...args) => {
      const note = realNote(...args);
      notes.push(note);
      return note;
    };
    registerMcpServer({
      name: "coder-threads",
      port: 1234,
      token: "tok",
      userDataPath: tmpDir,
    });
    let runner;
    try {
      const remoteOnly = pool({ entries: [entry()] });
      const forced = pool({ entries: [entry()], force: true });

      // The runner note path, with an injected ssh project.
      const { pathToFileURL } = require("node:url");
      const { execFileSync } = require("node:child_process");
      const { createRunner } = require("../runner.js");
      const core = await import(
        pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
      );
      const store = new Store(path.join(tmpDir, "store.json"));
      runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15 });
      const repo = path.join(tmpDir, "app");
      fs.mkdirSync(repo);
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      const project = await services.addProject(store, repo);
      store.setProjects(
        store
          .getProjects()
          .map((p) =>
            p.id === project.id
              ? { ...p, remoteHost: "dev@box", remotePath: "/srv/app" }
              : p,
          ),
      );
      services.setSettings(store, { subagentPool: remoteOnly });
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "lead",
      });
      await runner.startRun({ threadId: thread.id, prompt: "hi" });
      assert.equal(notes.length, 1);
      assert.match(notes[0], /^- fast: .*\(kimi \/ /m);
      assert.match(notes[0], /checked when the worker starts/);
      assert.doesNotMatch(notes[0], /No pool providers/);

      // Same absent CLI on a local project stays hidden.
      assert.match(
        subagentPoolNoteFor(remoteOnly, { path: repo }),
        /No pool providers are installed on this machine/,
      );

      // WSL distro path, and an accurate force-pinned default.
      const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        const wsl = { path: "\\\\wsl$\\Ubuntu\\home\\me\\repo" };
        assert.match(subagentPoolNoteFor(remoteOnly, wsl), /^- fast: /m);
        assert.match(
          subagentPoolNoteFor(forced, wsl),
          /Pinned to "fast" \(kimi \/ kimi-for-coding-highspeed\)/,
        );
      } finally {
        Object.defineProperty(process, "platform", realPlatform);
      }
    } finally {
      if (runner) runner.stopAll();
      services.subagentPoolNoteFor = realNote;
      unregisterMcpServer("coder-threads");
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("nextPoolEntry / startWithPoolFailover", () => {
  it("skips tried providers and unavailable binaries", () => {
    assert.equal(
      nextPoolEntry(pool(), { skipProviders: ["kimi"], isAvailable: () => true }).alias,
      "strong",
    );
    assert.equal(
      nextPoolEntry(pool(), {
        skipProviders: [],
        isAvailable: (id) => id === "claude",
      }).alias,
      "strong",
    );
    assert.equal(
      nextPoolEntry(pool(), { skipProviders: ["kimi", "claude"] }),
      null,
    );
  });

  it("isProviderBinaryError matches the runner's missing-CLI copy", () => {
    assert.equal(
      isProviderBinaryError("Provider binary not found: grok. Install it or set CODER_GROK_BIN."),
      true,
    );
    assert.equal(isProviderBinaryError("Daily budget of $1.00 reached"), false);
  });

  it("retries a missing-binary start on the next pool entry", async () => {
    const calls = [];
    const worker = { id: "w1", provider: "kimi", poolAlias: "fast" };
    const store = {
      getSettings: () => ({ subagentPool: pool() }),
      getThread: () => worker,
    };
    const out = await startWithPoolFailover({
      store,
      worker,
      prompt: "go",
      startRun: async (input) => {
        calls.push(input.threadId + ":" + worker.provider);
        if (worker.provider === "kimi") {
          throw new Error("Provider binary not found: kimi. Install it or set CODER_KIMI_BIN.");
        }
        return { runId: "r1" };
      },
      setProvider: (_store, input) => {
        worker.provider = input.provider;
        worker.poolAlias = "strong";
      },
      isAvailable: (id) => id === "claude",
    });
    assert.deepEqual(out, { runId: "r1" });
    assert.deepEqual(calls, ["w1:kimi", "w1:claude"]);
    assert.equal(worker.provider, "claude");
  });

  it("skips the local binary filter across an ssh boundary (#1403)", async () => {
    const run = (project) => {
      const worker = { id: "w1", provider: "kimi", poolAlias: "fast" };
      return startWithPoolFailover({
        store: { getSettings: () => ({ subagentPool: pool() }), getThread: () => worker },
        worker,
        prompt: "go",
        startRun: async () => {
          if (worker.provider === "kimi") throw new Error("Provider binary not found: kimi.");
          return { provider: worker.provider };
        },
        setProvider: (_store, input) => {
          worker.provider = input.provider;
        },
        // Nothing installed locally; claude exists only on the remote host.
        isAvailable: () => false,
        project,
      });
    };
    assert.deepEqual(await run({ remoteHost: "dev@box", path: "/srv/app" }), {
      provider: "claude",
    });
    await assert.rejects(() => run({ path: "/tmp/app" }), /Provider binary not found/);
  });

  it("does not retry a non-pool worker or a non-binary error", async () => {
    const worker = { id: "w1", provider: "kimi" };
    await assert.rejects(
      () =>
        startWithPoolFailover({
          store: { getSettings: () => ({ subagentPool: pool() }), getThread: () => worker },
          worker,
          prompt: "go",
          startRun: async () => {
            throw new Error("Provider binary not found: kimi.");
          },
          setProvider: () => {
            throw new Error("should not switch");
          },
        }),
      /Provider binary not found/,
    );
    await assert.rejects(
      () =>
        startWithPoolFailover({
          store: { getSettings: () => ({ subagentPool: pool() }), getThread: () => worker },
          worker: { ...worker, poolAlias: "fast" },
          prompt: "go",
          startRun: async () => {
            throw new Error("Daily budget of $1.00 reached");
          },
          setProvider: () => {
            throw new Error("should not switch");
          },
        }),
      /Daily budget/,
    );
  });
});

describe("poolFromStore", () => {
  it("returns the empty pool when the store has no getSettings", () => {
    assert.deepEqual(poolFromStore(null), {
      defaultAlias: null,
      force: false,
      entries: [],
    });
    assert.deepEqual(poolFromStore({}), {
      defaultAlias: null,
      force: false,
      entries: [],
    });
  });
});

describe("worker privilege narrowing (#1425)", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-narrow-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function leadStore(leadOver = {}, poolOver = {}) {
    const threads = [
      {
        id: "lead",
        projectId: "p1",
        title: "Lead",
        status: "idle",
        provider: "claude",
        permissionMode: "default",
        model: null,
        sessionId: null,
        ...leadOver,
      },
    ];
    const project = { id: "p1", path: dir };
    return {
      getThread: (id) => threads.find((t) => t.id === id) || null,
      getProject: (id) => (id === "p1" ? project : null),
      getThreads: () => threads,
      setThreads: (next) => threads.splice(0, threads.length, ...next),
      setMessages: () => {},
      setWorkLog: () => {},
      updateThread: (id, patch) => {
        const t = threads.find((x) => x.id === id);
        if (!t) return null;
        Object.assign(t, patch);
        return t;
      },
      save: () => {},
      getSettings: () => ({ subagentPool: pool({ defaultAlias: null, ...poolOver }) }),
      threads,
    };
  }

  it("refuses a worker whose snapped mode ranks above its lead's", () => {
    // kimi only honours bypassPermissions; the lead asks first.
    const store = leadStore();
    assert.throws(
      () => services.forkWorkerThread(store, { threadId: "lead", pool: "fast" }),
      (err) => err.code === "runtime_mode_escalation_denied" && /above its lead/.test(err.message),
    );
    assert.equal(store.threads.length, 1, "no worker thread is created");
    // A legacy provider argument cannot escalate either.
    assert.throws(
      () => services.forkWorkerThread(store, { threadId: "lead", provider: "grok" }),
      { code: "runtime_mode_escalation_denied" },
    );
  });

  it("allows same-or-lower modes and a user-flagged pool alias", () => {
    const store = leadStore();
    const same = services.forkWorkerThread(store, { threadId: "lead", pool: "strong" });
    assert.equal(same.permissionMode, "default");
    const bypassLead = leadStore({ permissionMode: "bypassPermissions" });
    services.forkWorkerThread(bypassLead, { threadId: "lead", pool: "fast" });
    const flagged = leadStore({}, { entries: [entry({ allowEscalation: true }), strong()] });
    const w = services.forkWorkerThread(flagged, { threadId: "lead", pool: "fast" });
    assert.equal(w.permissionMode, "bypassPermissions");
  });

  it("pool failover does not switch a worker onto an escalating entry", async () => {
    const store = leadStore({}, { entries: [strong(), entry()] });
    const worker = { id: "w1", provider: "claude", poolAlias: "strong", handoffFrom: "lead" };
    await assert.rejects(
      () =>
        startWithPoolFailover({
          store,
          worker,
          prompt: "go",
          startRun: async () => {
            throw new Error("Provider binary not found: claude.");
          },
          setProvider: () => {
            throw new Error("should not switch");
          },
        }),
      { code: "runtime_mode_escalation_denied" },
    );
  });

  it("allowEscalation must be a boolean and survives normalize", () => {
    assert.throws(
      () => validateSubagentPool({ entries: [entry({ allowEscalation: "yes" })] }),
      /allowEscalation must be a boolean/,
    );
    const n = normalizeSubagentPool({ entries: [entry({ allowEscalation: true })] });
    assert.equal(n.entries[0].allowEscalation, true);
  });
});
