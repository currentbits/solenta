"use strict";

/**
 * First-party Planboard MCP tools on coder-threads (#849 / #848).
 * Host-side wrappers around issues.js so sandboxed `gh` is not required.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  createOrchServer,
  createToolHandlers,
  INSTRUCTIONS,
} = require("../orchServer.js");
const { PLANBOARD_NOTE } = require("../services.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { resetMemorySupForTests } = require("../memory-sup.js");

const APP_PATH = path.join(__dirname, "..", "..");

const PLANBOARD_TOOLS = [
  "issue_complete",
  "issue_create",
  "issue_list",
  "issue_set_plan",
];

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo(tmp, name, origin) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["remote", "add", "origin", origin]);
  return repo;
}

function writeFakeGh(tmp, callsPath, body) {
  const bin = writeFakeBin(
    path.join(tmp, "fake-gh"),
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = ${JSON.stringify(callsPath)};
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
prev.push({ args, cwd: process.cwd() });
fs.writeFileSync(file, JSON.stringify(prev));
${body}
`,
  );
  process.env.CODER_GH_BIN = bin;
  return bin;
}

function calls(callsPath) {
  return fs.existsSync(callsPath)
    ? JSON.parse(fs.readFileSync(callsPath, "utf8"))
    : [];
}

function makeStore(projects, threads) {
  const list = threads.slice();
  return {
    getThreads: () => list,
    getThread: (id) => list.find((t) => t.id === id) || null,
    getProject: (id) => projects[id] || null,
    getProjects: () => Object.values(projects),
    getMessages: () => [],
    updateThread: (id, patch) => {
      const t = list.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
      return t || null;
    },
    save: () => {},
    threads: list,
  };
}

function makeDeps(store) {
  return {
    store,
    runner: { startRun: async () => ({}) },
    forkThread: () => ({ id: "fork-1" }),
    getProvider: () => null,
  };
}

async function mcpPost(port, token, message, { query = "" } = {}) {
  const qs = query ? (query.startsWith("?") ? query : `?${query}`) : "";
  const res = await fetch(`http://127.0.0.1:${port}/mcp${qs}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  let body = null;
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (dataLine) {
    body = JSON.parse(dataLine.slice("data:".length).trim());
  } else if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function toolNames(listBody) {
  return (listBody.result.tools || []).map((t) => t.name).sort();
}

describe("planboard MCP tools (issue #849)", () => {
  let tmp;
  let repo;
  let gitlab;
  let callsPath;
  let prevGh;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orch-planboard-"));
    repo = makeRepo(tmp, "gh-repo", "https://github.com/acme/demo.git");
    gitlab = makeRepo(tmp, "gl-repo", "https://gitlab.com/acme/demo.git");
    callsPath = path.join(tmp, "gh-calls.json");
    prevGh = process.env.CODER_GH_BIN;
    writeFakeGh(
      tmp,
      callsPath,
      `
if (args[1] === "create") {
  process.stdout.write("https://github.com/acme/demo/issues/77\\n");
  process.exit(0);
}
if (args[1] === "list") {
  process.stdout.write(JSON.stringify([{
    number: 77,
    title: "chip",
    url: "https://github.com/acme/demo/issues/77",
    state: "OPEN",
    labels: [{ name: "plan:doing" }],
  }]));
  process.exit(0);
}
if (args[1] === "view") {
  process.stdout.write(JSON.stringify({
    state: "OPEN",
    labels: [{ name: "plan:doing" }],
  }));
  process.exit(0);
}
process.exit(0);
`,
    );
  });

  afterEach(() => {
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function githubDeps() {
    return makeDeps(
      makeStore(
        {
          p1: { id: "p1", name: "Alpha", path: repo },
          p2: { id: "p2", name: "Beta", path: gitlab },
        },
        [
          { id: "t1", title: "First", projectId: "p1", status: "idle" },
          { id: "t3", title: "Other", projectId: "p2", status: "idle" },
        ],
      ),
    );
  }

  it("instructions and the Planboard note name the host-side tools, not gh", () => {
    assert.match(INSTRUCTIONS, /issue_create/);
    assert.match(INSTRUCTIONS, /issue_list/);
    assert.match(INSTRUCTIONS, /issue_set_plan/);
    assert.match(INSTRUCTIONS, /issue_complete/);
    assert.match(PLANBOARD_NOTE, /issue_create/);
    assert.match(PLANBOARD_NOTE, /issue_list/);
    assert.match(PLANBOARD_NOTE, /issue_set_plan/);
    assert.match(PLANBOARD_NOTE, /issue_complete/);
    assert.match(PLANBOARD_NOTE, /plan:todo, plan:doing, plan:done/);
    assert.doesNotMatch(PLANBOARD_NOTE, /using `gh`/);
  });

  it("creates, labels, lists, and closes against fake gh on the thread origin", async () => {
    const h = createToolHandlers(githubDeps());
    const created = await h.issue_create({
      threadId: "t1",
      projectId: "p1",
      title: "chip",
      body: "do the thing",
    });
    assert.deepEqual(created, {
      ok: true,
      number: 77,
      url: "https://github.com/acme/demo/issues/77",
    });

    const labeled = await h.issue_set_plan({
      threadId: "t1",
      projectId: "p1",
      number: 77,
      status: "doing",
    });
    assert.deepEqual(labeled, { ok: true });

    const listed = await h.issue_list({ threadId: "t1", projectId: "p1" });
    assert.equal(listed.ok, true);
    assert.equal(listed.issues[0].number, 77);

    const closed = await h.issue_complete({
      threadId: "t1",
      projectId: "p1",
      number: 77,
      comment: "landed",
    });
    assert.deepEqual(closed, { ok: true });

    const seen = calls(callsPath);
    assert.equal(fs.realpathSync(seen[0].cwd), fs.realpathSync(repo));
    assert.deepEqual(seen[0].args, [
      "issue",
      "create",
      "--title",
      "chip",
      "--body",
      "do the thing",
    ]);
    assert.equal(seen.some((c) => c.args.includes("-R")), false);
    const origin = fs.realpathSync(repo);
    assert.ok(
      seen.some(
        (c) =>
          c.args[1] === "edit" &&
          c.args.includes("plan:doing") &&
          fs.realpathSync(c.cwd) === origin,
      ),
    );
    assert.ok(
      seen.some(
        (c) =>
          c.args[1] === "close" &&
          c.args.includes("77") &&
          c.args.includes("landed") &&
          fs.realpathSync(c.cwd) === origin,
      ),
    );
  });

  it("rejects a thread in another project and never spawns gh", async () => {
    const h = createToolHandlers(githubDeps());
    await assert.rejects(
      () =>
        h.issue_create({
          threadId: "t3",
          projectId: "p1",
          title: "nope",
        }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.deepEqual(calls(callsPath), []);
  });

  it("returns not a GitHub repo without spawning gh", async () => {
    const h = createToolHandlers(githubDeps());
    assert.deepEqual(
      await h.issue_create({
        threadId: "t3",
        projectId: "p2",
        title: "chip",
      }),
      { ok: false, reason: "not a GitHub repo" },
    );
    assert.deepEqual(calls(callsPath), []);
  });
});

describe("planboard MCP tools/list gate (issue #849)", () => {
  let tmpDir;
  /** @type {Array<ReturnType<typeof createOrchServer>>} */
  let servers;
  let prevEnv;
  /** @type {string[]} */
  let logs;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orch-planboard-http-"));
    servers = [];
    logs = [];
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_GROK_CONFIG_PATH: process.env.CODER_GROK_CONFIG_PATH,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    process.env.CODER_KIMI_BIN = path.join(tmpDir, "no-kimi");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = path.join(tmpDir, "no-grok-not-a-real-binary");
    process.env.CODER_GROK_CONFIG_PATH = path.join(tmpDir, "grok-config.toml");
    resetMemorySupForTests();
  });

  afterEach(() => {
    for (const s of servers) {
      try {
        s.stop();
      } catch {
        // ignore
      }
    }
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startOrch(store) {
    const orch = createOrchServer({
      store,
      runner: { startRun: async () => ({}) },
      userDataPath: tmpDir,
      appPath: APP_PATH,
      log: (m) => {
        logs.push(String(m));
      },
      forkThread: () => ({ id: "fork-1" }),
      getProvider: () => null,
    });
    servers.push(orch);
    await orch.start();
    const st = orch.getStatus();
    if (!st.running) {
      throw new Error("orch did not start: " + logs.join(" | "));
    }
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
    );
    return { orch, token: cfg.token, port: st.port };
  }

  async function listTools(port, token, query) {
    const list = await mcpPost(
      port,
      token,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      query ? { query } : {},
    );
    assert.equal(list.status, 200);
    return toolNames(list.body);
  }

  it("omits issue_* tools when the bound project origin is not GitHub", async () => {
    const gitlab = makeRepo(
      tmpDir,
      "gl",
      "https://gitlab.com/acme/demo.git",
    );
    const { port, token } = await startOrch(
      makeStore(
        { p1: { id: "p1", name: "Alpha", path: gitlab } },
        [{ id: "t1", title: "First", projectId: "p1", status: "idle" }],
      ),
    );
    const names = await listTools(port, token, "projectId=p1");
    assert.ok(names.includes("threads_list"), "server must still list other tools");
    for (const t of PLANBOARD_TOOLS) {
      assert.equal(names.includes(t), false, `${t} should be omitted`);
    }
  });

  it("exposes issue_* tools when the bound project origin is GitHub", async () => {
    const gh = makeRepo(
      tmpDir,
      "gh",
      "https://github.com/acme/demo.git",
    );
    const { port, token } = await startOrch(
      makeStore(
        { p1: { id: "p1", name: "Alpha", path: gh } },
        [{ id: "t1", title: "First", projectId: "p1", status: "idle" }],
      ),
    );
    const names = await listTools(port, token, "projectId=p1");
    for (const t of PLANBOARD_TOOLS) {
      assert.equal(names.includes(t), true, `${t} should be listed`);
    }
  });
});
