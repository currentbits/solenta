"use strict";

/**
 * Reclaim remote $HOME/.solenta/{codex-homes,opencode-guardrails,
 * cursor-guardrails,kimi-homes,muse-homes}/<threadId> overlays (#838 / #873).
 *
 * #835 / #837 write those dirs via writeRemoteOverlay and never delete
 * them. After archive or run-end they must go, without touching the
 * user's real ~/.codex or ~/.opencode (overlays may symlink into those).
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const ssh = require("../ssh.js");
const { wrapCommand } = require("../ssh.js");
const { scheduleRetention } = require("../worktrees.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");

const OVERLAY_KINDS = [
  "codex-homes",
  "opencode-guardrails",
  "cursor-guardrails",
  "kimi-homes",
  "muse-homes",
];

const AUTH_BODY = "do-not-delete-codex-auth\n";
const OPENCODE_BODY = '{"do":"not-delete"}\n';
const SESSION = '{"id":"live-session"}\n';

const SSH_PROJECT = {
  id: "ssh-proj",
  path: "/unused",
  remoteHost: "dev@box",
  remotePath: "/srv/app",
};

const LOCAL_PROJECT = {
  id: "local-proj",
  path: "/local/repo",
};

const WSL_PROJECT = {
  id: "wsl-proj",
  path: "\\\\wsl$\\Ubuntu\\home\\me\\repo",
};

function makeStore(threads, projects) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const projById = new Map(projects.map((p) => [p.id, p]));
  return {
    getProjects: () => projects,
    getProject: (id) => projById.get(id) || null,
    getThreads: () => threads,
    getThread: (id) => byId.get(id) || null,
    getSettings: () => ({}),
  };
}

function remoteScripts(calls) {
  return calls
    .filter((c) => c.bin === "ssh" || c.bin === "wsl.exe")
    .map((c) => {
      if (c.bin === "wsl.exe") return c.args.join(" ");
      return String(c.args[c.args.length - 1] || "");
    });
}

/** Undo ssh.js posixQuote on the `'sh' '-c' '…'` tail of a wrapCommand payload. */
function extractShC(wrapped) {
  const marker = "'sh' '-c' ";
  const i = String(wrapped || "").indexOf(marker);
  if (i < 0) return "";
  const quoted = String(wrapped).slice(i + marker.length);
  if (!quoted.startsWith("'")) return "";
  return quoted.slice(1, -1).replace(/'\\''/g, "'");
}

function overlayDest(remoteHome, kind, threadId) {
  return path.join(remoteHome, ".solenta", kind, threadId);
}

function plantRemoteOverlays(remoteHome, threadId) {
  const realCodex = path.join(remoteHome, ".codex");
  const realOpencode = path.join(remoteHome, ".opencode");
  fs.mkdirSync(path.join(realCodex, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(realCodex, "auth.json"), AUTH_BODY);
  fs.writeFileSync(path.join(realCodex, "sessions", "keep-me.json"), SESSION);
  fs.mkdirSync(realOpencode, { recursive: true });
  fs.writeFileSync(path.join(realOpencode, "opencode.json"), OPENCODE_BODY);

  for (const kind of OVERLAY_KINDS) {
    const dest = overlayDest(remoteHome, kind, threadId);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "hooks.json"), "{}\n");
    if (kind === "codex-homes") {
      fs.symlinkSync(path.join(realCodex, "auth.json"), path.join(dest, "auth.json"));
      fs.symlinkSync(path.join(realCodex, "sessions"), path.join(dest, "sessions"));
    }
    if (kind === "opencode-guardrails") {
      fs.symlinkSync(
        path.join(realOpencode, "opencode.json"),
        path.join(dest, "opencode.json"),
      );
    }
  }
  return { realCodex, realOpencode };
}

function assertOverlaysGone(remoteHome, threadId) {
  for (const kind of OVERLAY_KINDS) {
    assert.equal(
      fs.existsSync(overlayDest(remoteHome, kind, threadId)),
      false,
      `archived crossesBoundary thread must not keep ~/.solenta/${kind}/${threadId}`,
    );
  }
}

function assertRealHomesIntact(realCodex, realOpencode) {
  assert.equal(
    fs.readFileSync(path.join(realCodex, "auth.json"), "utf8"),
    AUTH_BODY,
    "user ~/.codex/auth.json must not be deleted",
  );
  assert.equal(
    fs.readFileSync(path.join(realCodex, "sessions", "keep-me.json"), "utf8"),
    SESSION,
    "user ~/.codex/sessions must not be followed",
  );
  assert.equal(
    fs.readFileSync(path.join(realOpencode, "opencode.json"), "utf8"),
    OPENCODE_BODY,
    "user ~/.opencode must not be deleted",
  );
}

function runWrappedReclaim(calls, remoteHome) {
  const wrapped = remoteScripts(calls).find(
    (s) =>
      s.includes(".solenta/") &&
      OVERLAY_KINDS.some((k) => s.includes(k)),
  );
  assert.ok(wrapped, "reclaim must go through wrapCommand (ssh/WSL sh -c)");
  assert.equal(wrapped.includes("rm -rf"), false, "rm -rf would follow overlay symlinks");
  const script = extractShC(wrapped) || wrapped;
  execFileSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: remoteHome },
  });
  return wrapped;
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

describe("remote overlay reclaim (#838)", () => {
  /** @type {Array<{ bin: string, args: string[], opts: object }>} */
  let calls;
  let tmpDir;
  let remoteHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-overlay-reclaim-"));
    remoteHome = path.join(tmpDir, "remote-home");
    fs.mkdirSync(remoteHome);
    calls = [];
    ssh.setExecFileSync((bin, args, opts) => {
      calls.push({ bin, args, opts: opts || {} });
      return "";
    });
  });

  afterEach(() => {
    ssh.setExecFileSync(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scheduleRetention deletes remote overlay dirs for an archived crossesBoundary thread", async () => {
    const staleId = "stale-overlay-thread";
    const { realCodex, realOpencode } = plantRemoteOverlays(remoteHome, staleId);

    await scheduleRetention({
      store: makeStore(
        [
          {
            id: staleId,
            projectId: SSH_PROJECT.id,
            provider: "codex",
            status: "idle",
            archived: true,
          },
        ],
        [SSH_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    const wrapped = runWrappedReclaim(calls, remoteHome);
    assert.match(wrapped, /cd '\/srv\/app' && 'sh' '-c'/);
    assertOverlaysGone(remoteHome, staleId);
    assertRealHomesIntact(realCodex, realOpencode);
  });

  it("scheduleRetention deletes remote overlay dirs for a settled crossesBoundary thread", async () => {
    const settledId = "settled-overlay-thread";
    plantRemoteOverlays(remoteHome, settledId);

    await scheduleRetention({
      store: makeStore(
        [
          {
            id: settledId,
            projectId: SSH_PROJECT.id,
            provider: "kimi",
            status: "done",
            settledOverride: "settled",
          },
        ],
        [SSH_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    runWrappedReclaim(calls, remoteHome);
    assertOverlaysGone(remoteHome, settledId);
  });

  it("skips working and quota-wait threads", async () => {
    plantRemoteOverlays(remoteHome, "working-overlay");
    plantRemoteOverlays(remoteHome, "quota-overlay");

    await scheduleRetention({
      store: makeStore(
        [
          {
            id: "working-overlay",
            projectId: SSH_PROJECT.id,
            provider: "codex",
            status: "working",
            archived: true,
          },
          {
            id: "quota-overlay",
            projectId: SSH_PROJECT.id,
            provider: "opencode",
            status: "quota-wait",
            settledOverride: "settled",
          },
        ],
        [SSH_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    const blob = remoteScripts(calls).join("\n");
    assert.equal(blob.includes("working-overlay"), false, "working overlay must survive");
    assert.equal(blob.includes("quota-overlay"), false, "quota-wait overlay must survive");
    assert.equal(
      fs.existsSync(overlayDest(remoteHome, "codex-homes", "working-overlay")),
      true,
    );
  });

  it("skips idle (not archived/settled) threads and local projects", async () => {
    plantRemoteOverlays(remoteHome, "idle-overlay");
    plantRemoteOverlays(remoteHome, "local-archived");

    await scheduleRetention({
      store: makeStore(
        [
          {
            id: "idle-overlay",
            projectId: SSH_PROJECT.id,
            provider: "cursor",
            status: "idle",
          },
          {
            id: "local-archived",
            projectId: LOCAL_PROJECT.id,
            provider: "codex",
            status: "idle",
            archived: true,
          },
        ],
        [SSH_PROJECT, LOCAL_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    const blob = remoteScripts(calls).join("\n");
    assert.equal(blob.includes("idle-overlay"), false);
    assert.equal(blob.includes("local-archived"), false);
    assert.equal(
      fs.existsSync(overlayDest(remoteHome, "codex-homes", "idle-overlay")),
      true,
      "idle unarchived overlay stays until run-end",
    );
  });

  it("wrapCommand puts the reclaim sh -c on the WSL side", () => {
    const { remoteOverlayReclaimScript } = require("../remote-overlay.js");
    const script = remoteOverlayReclaimScript(["wsl-overlay-thread"]);
    assert.ok(script, "reclaim script must exist");
    const cmd = wrapCommand(WSL_PROJECT, "sh", ["-c", script], "win32");
    assert.equal(cmd.bin, "wsl.exe");
    assert.ok(cmd.args.includes("Ubuntu"));
    assert.ok(cmd.args.includes("sh"));
    assert.ok(
      cmd.args.some((a) => String(a).includes(".solenta/")),
      "WSL wrap must carry the overlay reclaim script",
    );
    assert.equal(cmd.args.join(" ").includes("rm -rf"), false);
  });

  it("a remote exec failure does not block local overlay reclaim", async () => {
    const localStale = "local-kimi-stale";
    const sourceHome = path.join(tmpDir, "real-kimi-code");
    fs.mkdirSync(sourceHome);
    fs.writeFileSync(path.join(sourceHome, "credentials"), "keep\n");
    fs.writeFileSync(path.join(sourceHome, "config.toml"), "default_model = \"kimi\"\n");
    fs.mkdirSync(path.join(sourceHome, "sessions"));
    const { materializeKimiHome } = require("../kimi.js");
    const localDest = path.join(tmpDir, "kimi-homes", localStale);
    materializeKimiHome({
      dest: localDest,
      sourceHome,
      cwd: "/tmp/stale-proj",
      mcpServers: {},
    });

    ssh.setExecFileSync((bin, args) => {
      calls.push({ bin, args, opts: {} });
      if (String(args[args.length - 1] || "").includes(".solenta/")) {
        throw new Error("ssh: connection refused");
      }
      return "";
    });

    await scheduleRetention({
      store: makeStore(
        [
          {
            id: localStale,
            projectId: LOCAL_PROJECT.id,
            provider: "kimi",
            status: "idle",
          },
          {
            id: "remote-stale",
            projectId: SSH_PROJECT.id,
            provider: "codex",
            status: "idle",
            archived: true,
          },
        ],
        [SSH_PROJECT, LOCAL_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    assert.equal(
      fs.existsSync(localDest),
      false,
      "local kimi-home reclaim must still run when the remote host is dead",
    );
  });
});

describe("remote overlay reclaim on run end (#838)", () => {
  let tmpDir;
  let store;
  let runner;
  let remoteHome;
  /** @type {Array<{ bin: string, args: string[] }>} */
  let calls;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e process.exit(0)`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-overlay-runend-"));
    remoteHome = path.join(tmpDir, "remote-home");
    fs.mkdirSync(remoteHome);
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    const project = await services.addProject(store, "", {
      remoteHost: "dev@box",
      remotePath: "/srv/app",
    });
    services.createThread(store, {
      projectId: project.id,
      title: "Remote overlay run",
      provider: "codex",
    });
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      runAgentFn: ({ onDone }) => {
        setImmediate(() => onDone(0, "done", ""));
        return { kill() {} };
      },
    });
    calls = [];
    ssh.setExecFileSync((bin, args) => {
      calls.push({ bin, args });
      return "";
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    ssh.setExecFileSync(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("run end deletes remote overlay dirs for a crossesBoundary thread", async () => {
    const thread = store.getThreads()[0];
    const { realCodex, realOpencode } = plantRemoteOverlays(remoteHome, thread.id);

    await runner.startRun({
      threadId: thread.id,
      prompt: "one turn",
    });
    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && (t.status === "done" || t.status === "failed" || t.status === "idle");
    });

    const wrapped = runWrappedReclaim(calls, remoteHome);
    assert.match(wrapped, /cd '\/srv\/app' && 'sh' '-c'/);
    assertOverlaysGone(remoteHome, thread.id);
    assertRealHomesIntact(realCodex, realOpencode);
  });
});
