const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Store } = require("../store.js");
const services = require("../services.js");
const { diff, setExecFile } = require("../worktrees.js");
const { createRunner, resolveSpawn } = require("../runner.js");
const ssh = require("../ssh.js");
const { writeFakeBin } = require("./support/fakeBin.js");

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

describe("worktrees.diff remoteHost", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-ssh-diff-"));
    store = new Store(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    setExecFile(null);
    ssh.setExecFileSync(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefixes git with ssh when the project has remoteHost", async () => {
    const calls = [];
    setExecFile((bin, args, _opts, cb) => {
      calls.push({ bin, args: args.slice() });
      const remote = String(args[args.length - 1] || "");
      let out = "";
      if (remote.includes("status")) out = " M src/a.ts\n";
      else if (remote.includes("numstat")) out = "1\t2\tsrc/a.ts\n";
      else if (remote.includes("diff")) out = "diff --git a/src/a.ts b/src/a.ts\n";
      cb(null, out, "");
    });

    const project = await services.addProject(store, "", {
      remoteHost: "dev@box",
      remotePath: "/srv/app",
    });
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Remote changes",
    });

    const result = await diff({ store, threadId: thread.id });
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((c) => c.bin === "ssh"));
    assert.ok(calls[0].args.includes("dev@box"));
    assert.ok(calls[0].args.includes("BatchMode=yes"));
    assert.ok(
      calls.some((c) =>
        /cd '\/srv\/app' && 'git' 'status'/.test(c.args[c.args.length - 1]),
      ),
    );
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, "src/a.ts");
    assert.equal(result.files[0].additions, 1);
    assert.equal(result.files[0].deletions, 2);
    assert.ok(result.patch.includes("diff --git"));
  });
});

describe("runner.resolveSpawn remoteHost", () => {
  it("is a no-op for local projects", () => {
    const out = resolveSpawn({ path: "/local/repo" }, "claude", ["-p", "hi"], "/local/repo");
    assert.deepEqual(out, {
      binary: "claude",
      args: ["-p", "hi"],
      cwd: "/local/repo",
    });
  });

  it("rewrites the spawn to ssh when remoteHost is set", () => {
    const out = resolveSpawn(
      { remoteHost: "dev@box", remotePath: "/srv/app", path: "/unused" },
      "claude",
      ["-p", "hello world"],
      "/unused",
    );
    assert.equal(out.binary, "ssh");
    assert.ok(out.args.includes("dev@box"));
    assert.ok(out.args.includes("BatchMode=yes"));
    assert.ok(out.args.includes("ConnectTimeout=10"));
    assert.equal(
      out.args[out.args.length - 1],
      "cd '/srv/app' && 'claude' '-p' 'hello world'",
    );
    assert.equal(out.cwd, process.cwd());
  });
});

describe("runner startRun remoteHost fake spawn", () => {
  let tmpDir;
  let store;
  let runner;
  let prevSimulate;
  let prevAgentCmd;
  let prevPath;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevPath = process.env.PATH;
    delete process.env.CODER_SIMULATE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-ssh-run-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
    });

    const project = await services.addProject(store, "", {
      remoteHost: "dev@box",
      remotePath: "/srv/app",
    });
    services.createThread(store, {
      projectId: project.id,
      title: "Remote run",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  });

  it("spawns ssh instead of the local CLI", async () => {
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir);
    const logFile = path.join(tmpDir, "ssh-argv.json");
    writeFakeBin(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write("Hello_from_remote");
process.exit(0);
`,
    );

    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ""}`;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e process.stdout.write('should-not-run')`;

    const thread = store.getThreads()[0];
    await runner.startRun({
      threadId: thread.id,
      prompt: "do remote work",
    });
    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && (t.status === "done" || t.status === "failed");
    });

    assert.equal(store.getThread(thread.id).status, "done");
    assert.ok(fs.existsSync(logFile), "fake ssh must have been spawned");
    const argv = JSON.parse(fs.readFileSync(logFile, "utf8"));
    assert.ok(argv.includes("dev@box"));
    assert.ok(argv.includes("BatchMode=yes"));
    assert.ok(argv.includes("ConnectTimeout=10"));
    const remote = argv[argv.length - 1];
    assert.match(remote, /cd '\/srv\/app' && /);
    const msgs = store.getMessages(thread.id);
    assert.ok(
      msgs.some((m) => m.role === "assistant" && /Hello_from_remote/.test(m.text)),
      "stdout from ssh must pass through as the assistant message",
    );
  });
});
