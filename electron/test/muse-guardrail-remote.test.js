"use strict";

/**
 * #873: Muse XDG overlay on ssh/WSL.
 *
 * Task 6 throws on crossesBoundary. Deploy via remote-overlay.js the way
 * kimi does, pass XDG_CONFIG_HOME / XDG_DATA_HOME through wrapCommand.
 * A deploy miss must not run far-side muse against unsandboxed settings.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const remoteOverlay = require("../remote-overlay.js");
const ssh = require("../ssh.js");
const { resolveSpawn } = require("../runner.js");
const { wrapCommand } = require("../ssh.js");
const { deployMuseGuardrailOverlay, museRemoteChildEnv } = require("../muse.js");
const { spawnPhaseAgent } = require("../workflow.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");

const ECHO_HELLO = path.join(__dirname, "fixtures", "muse", "echo-hello.jsonl");

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

describe("resolveSpawn muse XDG overlay across a boundary", () => {
  it("prefixes env XDG_CONFIG_HOME and XDG_DATA_HOME onto the ssh wrap", () => {
    const out = resolveSpawn(
      { remoteHost: "dev@box", remotePath: "/srv/app", path: "/unused" },
      "/usr/local/bin/muse",
      ["exec", "--json", "hello"],
      "/unused",
      {
        XDG_CONFIG_HOME: "/home/u/.solenta/muse-homes/tid/config",
        XDG_DATA_HOME: "/home/u/.solenta/muse-homes/tid/share",
      },
    );
    assert.equal(out.binary, "ssh");
    const remote = out.args[out.args.length - 1];
    assert.match(
      remote,
      /cd '\/srv\/app' && 'env' 'XDG_CONFIG_HOME=\/home\/u\/\.solenta\/muse-homes\/tid\/config' 'XDG_DATA_HOME=\/home\/u\/\.solenta\/muse-homes\/tid\/share' 'muse' 'exec' '--json' 'hello'/,
    );
  });

  it("leaves a local muse spawn unchanged (overlay is process env, not argv)", () => {
    const out = resolveSpawn(
      { path: "/local/repo" },
      "/usr/local/bin/muse",
      ["exec", "--json", "hello"],
      "/local/repo",
      {
        XDG_CONFIG_HOME: "/tmp/overlay/config",
        XDG_DATA_HOME: "/tmp/overlay/share",
      },
    );
    assert.deepEqual(out, {
      binary: "/usr/local/bin/muse",
      args: ["exec", "--json", "hello"],
      cwd: "/local/repo",
    });
  });

  it("prefixes env XDG_CONFIG_HOME and XDG_DATA_HOME onto the WSL wrap", () => {
    const out = wrapCommand(
      { path: "\\\\wsl$\\Ubuntu\\home\\me\\repo" },
      "/usr/bin/muse",
      ["exec", "--json", "hi"],
      "win32",
      {
        XDG_CONFIG_HOME: "/home/me/.solenta/muse-homes/t/config",
        XDG_DATA_HOME: "/home/me/.solenta/muse-homes/t/share",
      },
    );
    assert.equal(out.bin, "wsl.exe");
    assert.deepEqual(out.args, [
      "-d",
      "Ubuntu",
      "--cd",
      "/home/me/repo",
      "--",
      "env",
      "XDG_CONFIG_HOME=/home/me/.solenta/muse-homes/t/config",
      "XDG_DATA_HOME=/home/me/.solenta/muse-homes/t/share",
      "muse",
      "exec",
      "--json",
      "hi",
    ]);
  });
});

describe("muse remote child env POSIX XDG", () => {
  it("uses forward-slash XDG paths that start with dest (would fail on win32 path.join)", () => {
    const dest = "/home/u/.solenta/muse-homes/tid";
    const env = museRemoteChildEnv(dest, path.win32);
    assert.equal(env.XDG_CONFIG_HOME, dest + "/config");
    assert.equal(env.XDG_DATA_HOME, dest + "/share");
    assert.ok(env.XDG_CONFIG_HOME.startsWith(dest));
    assert.ok(env.XDG_DATA_HOME.startsWith(dest));
    assert.equal(env.XDG_CONFIG_HOME.includes("\\"), false);
    assert.equal(env.XDG_DATA_HOME.includes("\\"), false);
    assert.notEqual(env.XDG_CONFIG_HOME, path.win32.join(dest, "config"));
    assert.notEqual(env.XDG_DATA_HOME, path.win32.join(dest, "share"));
  });
});

describe("deployMuseGuardrailOverlay", () => {
  const project = {
    remoteHost: "dev@box",
    remotePath: "/srv/app",
    path: "/unused",
  };
  let origProbe;
  let origWrite;
  /** @type {{ project: object, dest: string, files: Record<string, string>, extraCmds: string[] } | null} */
  let lastWrite;

  beforeEach(() => {
    lastWrite = null;
    origProbe = remoteOverlay.probeRemoteHome;
    origWrite = remoteOverlay.writeRemoteOverlay;
    remoteOverlay.probeRemoteHome = () => "/home/u";
    remoteOverlay.writeRemoteOverlay = (proj, dest, files, extraCmds) => {
      lastWrite = { project: proj, dest, files, extraCmds };
    };
  });

  afterEach(() => {
    remoteOverlay.probeRemoteHome = origProbe;
    remoteOverlay.writeRemoteOverlay = origWrite;
  });

  it("writeRemoteOverlay is called with solenta-hooks.json, hook js, guardrails, and schema_version 1 settings", () => {
    const dest = deployMuseGuardrailOverlay({ project, threadId: "tid" });
    assert.equal(dest, "/home/u/.solenta/muse-homes/tid");
    assert.ok(lastWrite, "writeRemoteOverlay must be called");
    assert.equal(lastWrite.dest, dest);
    assert.equal(lastWrite.project, project);
    const files = lastWrite.files;
    assert.ok("solenta-hooks.json" in files, "solenta-hooks.json");
    assert.ok("muse-guardrail-hook.js" in files, "muse-guardrail-hook.js");
    assert.ok("guardrails.js" in files, "guardrails.js");
    assert.ok("guardrail-hook-core.js" in files, "guardrail-hook-core.js");
    assert.ok(
      "config/muse/settings.json" in files,
      "config/muse/settings.json",
    );
    const settings = JSON.parse(files["config/muse/settings.json"]);
    assert.equal(settings.schema_version, 1);
  });

  it("post-write shell symlinks auth.json and sessions from XDG muse dirs", () => {
    deployMuseGuardrailOverlay({ project, threadId: "tid" });
    assert.ok(lastWrite, "writeRemoteOverlay must be called");
    const extra = (lastWrite.extraCmds || []).join("\n");
    assert.match(extra, /ln -s/);
    assert.match(extra, /auth\.json/);
    assert.match(extra, /sessions/);
    assert.match(extra, /\$XDG_CONFIG_HOME/);
    assert.match(extra, /\$XDG_DATA_HOME/);
    assert.match(extra, /\$HOME\/\.config\/muse/);
    assert.match(extra, /\$HOME\/\.local\/share\/muse/);
  });

  it("throws when dest is unusable", () => {
    remoteOverlay.probeRemoteHome = () => "";
    assert.throws(
      () => deployMuseGuardrailOverlay({ project, threadId: "tid" }),
      /unusable/,
    );
    assert.equal(lastWrite, null, "must not write when dest is unusable");
  });
});

function writeFakeMuse(dir) {
  return writeFakeBin(
    path.join(dir, "muse"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_MUSE_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_MUSE_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
  fs.writeFileSync(
    process.env.CODER_FAKE_MUSE_ARGV_FILE + ".env.json",
    JSON.stringify({
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || "",
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || "",
      HOME: process.env.HOME || "",
      SOLENTA_WORKTREE: process.env.SOLENTA_WORKTREE || "",
    }),
    "utf8",
  );
}
const fixture = process.env.CODER_FAKE_MUSE_FIXTURE || "";
const text = fs.readFileSync(fixture, "utf8");
for (const line of text.split("\\n")) {
  if (!line.trim()) continue;
  process.stdout.write(line + "\\n");
}
process.exit(0);
`,
  );
}

function writeFakeSsh(dir) {
  return writeFakeBin(
    path.join(dir, "ssh"),
    `#!/usr/bin/env node
"use strict";
const { execSync } = require("child_process");
const remote = process.argv[process.argv.length - 1] || "";
const env = { ...process.env };
if (process.env.CODER_FAKE_REMOTE_HOME) env.HOME = process.env.CODER_FAKE_REMOTE_HOME;
if (process.env.CODER_FAKE_REMOTE_PATH) {
  env.PATH = process.env.CODER_FAKE_REMOTE_PATH + (env.PATH ? ":" + env.PATH : "");
}
try {
  execSync(remote, { env, stdio: "inherit", shell: "/bin/sh" });
} catch (err) {
  process.exit(err.status || 1);
}
`,
  );
}

describe("muse runner: overlay on a crossesBoundary turn", () => {
  it("deploys XDG overlay over ssh and prefixes child env", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-muse-ssh-gr-"));
    const remoteHome = path.join(tmpDir, "remote-home");
    fs.mkdirSync(path.join(remoteHome, ".config", "muse"), { recursive: true });
    fs.mkdirSync(path.join(remoteHome, ".local", "share", "muse", "sessions"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(remoteHome, ".config", "muse", "auth.json"),
      '{"token":"keep"}\n',
    );
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir);
    const fakeMuse = writeFakeMuse(binDir);
    writeFakeSsh(binDir);
    const argvFile = path.join(tmpDir, "argv.json");

    const prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_MUSE_BIN: process.env.CODER_MUSE_BIN,
      CODER_FAKE_MUSE_ARGV_FILE: process.env.CODER_FAKE_MUSE_ARGV_FILE,
      CODER_FAKE_MUSE_FIXTURE: process.env.CODER_FAKE_MUSE_FIXTURE,
      CODER_FAKE_REMOTE_HOME: process.env.CODER_FAKE_REMOTE_HOME,
      CODER_FAKE_REMOTE_PATH: process.env.CODER_FAKE_REMOTE_PATH,
      CODER_GUARDRAILS: process.env.CODER_GUARDRAILS,
      PATH: process.env.PATH,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_GUARDRAILS;
    process.env.CODER_MUSE_BIN = fakeMuse;
    process.env.CODER_FAKE_MUSE_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_MUSE_FIXTURE = ECHO_HELLO;
    process.env.CODER_FAKE_REMOTE_HOME = remoteHome;
    process.env.CODER_FAKE_REMOTE_PATH = binDir;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ""}`;

    let runner;
    try {
      const projectDir = path.join(tmpDir, "proj");
      fs.mkdirSync(projectDir);
      git(projectDir, ["init"]);
      git(projectDir, ["config", "user.email", "t@t.com"]);
      git(projectDir, ["config", "user.name", "t"]);
      fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
      git(projectDir, ["add", "."]);
      git(projectDir, ["commit", "-m", "init"]);

      const store = new Store(path.join(tmpDir, "store.json"));
      const core = await loadCore();
      runner = createRunner({
        store,
        core,
        pushFn() {},
        tickMs: 15,
        userDataPath: tmpDir,
      });
      const project = await services.addProject(store, projectDir, {
        remoteHost: "dev@box",
        remotePath: projectDir,
      });
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Muse SSH Overlay",
      });
      services.setProvider(store, { threadId: thread.id, provider: "muse" });

      const dest = path.join(remoteHome, ".solenta", "muse-homes", thread.id);
      const settingsPath = path.join(dest, "config", "muse", "settings.json");
      await runner.startRun({ threadId: thread.id, prompt: "hello" });
      // Snapshot before run-end reclaim deletes muse-homes (#838 / #873).
      await waitFor(() => fs.existsSync(settingsPath));
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.equal(settings.schema_version, 1);
      assert.ok(
        fs.lstatSync(path.join(dest, "config", "muse", "auth.json")).isSymbolicLink(),
      );
      assert.ok(
        fs.lstatSync(path.join(dest, "share", "muse", "sessions")).isSymbolicLink(),
      );
      await waitFor(() => store.getThread(thread.id).status === "done");

      const env = JSON.parse(fs.readFileSync(argvFile + ".env.json", "utf8"));
      assert.equal(env.XDG_CONFIG_HOME, dest + "/config");
      assert.equal(env.XDG_DATA_HOME, dest + "/share");
      assert.ok(env.XDG_CONFIG_HOME.startsWith(dest));
      assert.equal(env.XDG_CONFIG_HOME.includes("\\"), false);
    } finally {
      if (runner) runner.stopAll();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("fails the run when remote dest is unusable", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-muse-ssh-miss-"));
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir);
    const fakeMuse = writeFakeMuse(binDir);
    const argvFile = path.join(tmpDir, "argv.json");

    const prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_MUSE_BIN: process.env.CODER_MUSE_BIN,
      CODER_FAKE_MUSE_ARGV_FILE: process.env.CODER_FAKE_MUSE_ARGV_FILE,
      CODER_FAKE_MUSE_FIXTURE: process.env.CODER_FAKE_MUSE_FIXTURE,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_MUSE_BIN = fakeMuse;
    process.env.CODER_FAKE_MUSE_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_MUSE_FIXTURE = ECHO_HELLO;

    ssh.setExecFileSync(() => "");

    let runner;
    try {
      const projectDir = path.join(tmpDir, "proj");
      fs.mkdirSync(projectDir);
      git(projectDir, ["init"]);
      git(projectDir, ["config", "user.email", "t@t.com"]);
      git(projectDir, ["config", "user.name", "t"]);
      fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
      git(projectDir, ["add", "."]);
      git(projectDir, ["commit", "-m", "init"]);

      const store = new Store(path.join(tmpDir, "store.json"));
      const core = await loadCore();
      runner = createRunner({
        store,
        core,
        pushFn() {},
        tickMs: 15,
        userDataPath: tmpDir,
      });
      const project = await services.addProject(store, projectDir, {
        remoteHost: "dev@box",
        remotePath: projectDir,
      });
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Muse SSH miss",
      });
      services.setProvider(store, { threadId: thread.id, provider: "muse" });

      try {
        await runner.startRun({ threadId: thread.id, prompt: "hello" });
      } catch {
        // overlay fail-closed may throw after markRunFailed
      }
      await waitFor(() => store.getThread(thread.id).status === "failed");
      assert.ok(
        store.getMessages(thread.id).some(
          (m) => m.role === "event" && /overlay/i.test(m.text),
        ),
        "unusable dest must fail the run, not spawn unsandboxed muse",
      );
      assert.equal(fs.existsSync(argvFile), false, "must not spawn muse");
    } finally {
      if (runner) runner.stopAll();
      ssh.setExecFileSync(null);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("workflow muse remote overlay", () => {
  it("deploys overlay on ssh instead of hard-failing the phase", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-muse-ssh-"));
    const remoteHome = path.join(tmpDir, "remote-home");
    fs.mkdirSync(remoteHome);
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir);
    const fakeMuse = writeFakeMuse(binDir);
    writeFakeSsh(binDir);
    const argvFile = path.join(tmpDir, "argv.json");
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);

    const prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_MUSE_BIN: process.env.CODER_MUSE_BIN,
      CODER_FAKE_MUSE_ARGV_FILE: process.env.CODER_FAKE_MUSE_ARGV_FILE,
      CODER_FAKE_MUSE_FIXTURE: process.env.CODER_FAKE_MUSE_FIXTURE,
      CODER_FAKE_REMOTE_HOME: process.env.CODER_FAKE_REMOTE_HOME,
      CODER_FAKE_REMOTE_PATH: process.env.CODER_FAKE_REMOTE_PATH,
      PATH: process.env.PATH,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_MUSE_BIN = fakeMuse;
    process.env.CODER_FAKE_MUSE_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_MUSE_FIXTURE = ECHO_HELLO;
    process.env.CODER_FAKE_REMOTE_HOME = remoteHome;
    process.env.CODER_FAKE_REMOTE_PATH = binDir;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ""}`;

    try {
      const { done } = spawnPhaseAgent({
        providerId: "muse",
        prompt: "hello",
        cwd: projectDir,
        userDataPath: tmpDir,
        threadId: "tid-muse",
        overlayKey: "phase-a",
        project: { remoteHost: "dev@box", remotePath: projectDir },
      });
      const result = await done;
      assert.equal(result.ok, true, result.stderr);
      assert.ok(
        fs.existsSync(argvFile),
        "must spawn muse after remote overlay deploy",
      );
      const env = JSON.parse(fs.readFileSync(argvFile + ".env.json", "utf8"));
      assert.match(
        env.XDG_CONFIG_HOME,
        /\.solenta\/muse-homes\/tid-muse\/config$/,
        `remote XDG_CONFIG_HOME missing: ${env.XDG_CONFIG_HOME}`,
      );
      assert.match(
        env.XDG_DATA_HOME,
        /\.solenta\/muse-homes\/tid-muse\/share$/,
        `remote XDG_DATA_HOME missing: ${env.XDG_DATA_HOME}`,
      );
      assert.equal(env.XDG_CONFIG_HOME.includes("\\"), false);
      assert.equal(env.XDG_DATA_HOME.includes("\\"), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
