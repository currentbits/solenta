/**
 * Issue #188: per-project env map — persisted on the project, layered into
 * agent runs (local + across ssh), verify / quick actions, and terminals.
 * Dev servers are covered in devserver-isolation-ipc.test.js.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner, resolveSpawn } = require("../runner.js");
const { withProjectEnv } = require("../worktreeEnv.js");
const { runVerifyCommand } = require("../verify.js");
const { rmTree } = require("./support/rmTree.js");

async function loadCore() {
  const url = pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href;
  return import(url);
}

function waitFor(predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("withProjectEnv", () => {
  it("layers project env under the spawn overlay", () => {
    assert.deepEqual(
      withProjectEnv(
        { env: { AWS_PROFILE: "bedrock", CODEX_HOME: "/mine", PATH: "/x" } },
        { CODEX_HOME: "/overlay" },
      ),
      { AWS_PROFILE: "bedrock", CODEX_HOME: "/overlay" },
    );
  });

  it("returns the overlay untouched when the project sets nothing", () => {
    assert.equal(withProjectEnv({}, undefined), undefined);
    const env = { A: "1" };
    assert.equal(withProjectEnv(null, env), env);
  });

  it("forwards project env across ssh, quoted", () => {
    const out = resolveSpawn(
      {
        remoteHost: "dev@box",
        remotePath: "/srv/app",
        env: { AWS_PROFILE: "bedrock prod" },
      },
      "/usr/local/bin/claude",
      ["-p"],
      "/unused",
      { GROK_HOME: "/g" },
    );
    assert.match(
      out.args[out.args.length - 1],
      /'env' 'AWS_PROFILE=bedrock prod' 'GROK_HOME=\/g' .*'claude' '-p'/,
    );
  });
});

describe("project env persistence (#188)", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-project-env-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    project = await services.addProject(store, repo);
  });

  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("persists, survives reload, and clears", () => {
    const set = services.updateProject(store, project.id, {
      env: { AWS_PROFILE: "bedrock", "bad key": "x", PATH: "/nope" },
    });
    assert.deepEqual(set.env, { AWS_PROFILE: "bedrock" });
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.deepEqual(reloaded.getProject(project.id).env, {
      AWS_PROFILE: "bedrock",
    });

    services.updateProject(store, project.id, { name: "renamed" });
    assert.deepEqual(store.getProject(project.id).env, { AWS_PROFILE: "bedrock" });

    services.updateProject(store, project.id, { env: null });
    assert.equal("env" in store.getProject(project.id), false);
  });

  it("injects project env into a generic agent run", async () => {
    const prevSimulate = process.env.CODER_SIMULATE;
    const prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e process.exit(0)`;
    let runner;
    try {
      services.updateProject(store, project.id, { env: { PORT: "3001" } });
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "env",
      });
      let seenEnv;
      runner = createRunner({
        store,
        core: await loadCore(),
        pushFn: () => {},
        tickMs: 15,
        runAgentFn: ({ env, onDone }) => {
          seenEnv = env;
          setImmediate(() => onDone(0, "ok", ""));
          return { kill() {} };
        },
      });
      await runner.startRun({ threadId: thread.id, prompt: "hi" });
      await waitFor(() => seenEnv !== undefined);
      assert.deepEqual(seenEnv, { PORT: "3001" });
    } finally {
      if (runner) runner.stopAll();
      if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
      else process.env.CODER_SIMULATE = prevSimulate;
      if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
      else process.env.CODER_AGENT_CMD = prevAgentCmd;
    }
  });
});

describe("verify / quick actions get project env", () => {
  it("passes project env to the shell", async () => {
    let seen;
    const spawn = (_bin, _args, opts) => {
      seen = opts.env;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 0;
      child.kill = () => {};
      setImmediate(() => child.emit("close", 0));
      return child;
    };
    await runVerifyCommand({
      command: "true",
      cwd: os.tmpdir(),
      project: { path: os.tmpdir(), env: { AWS_PROFILE: "bedrock" } },
      env: { BASE: "1" },
      spawn,
      platform: "darwin",
    });
    assert.equal(seen.AWS_PROFILE, "bedrock");
    assert.equal(seen.BASE, "1");
  });
});
