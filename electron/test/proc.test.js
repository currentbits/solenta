"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const {
  killTree,
  agentSpawnOptions,
  signalGroup,
  signalPid,
  beginShutdown,
  resetShutdownForTests,
  WINDOWS_TREE_KILL_TIMEOUT_MS,
} = require("../proc.js");

const posix = process.platform !== "win32";

function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
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

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // kill(pid, 0) is true for zombies. systemd/launchd reap them quickly;
  // a container without an init (and some Linux boxes between waitpid)
  // leaves the slot, and the test would fail closed after a successful
  // group kill. /proc is Linux-only; macOS never hits this path.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).charAt(0);
    if (state === "Z") return false;
  } catch {
    // no /proc, or the pid vanished between kill(0) and the read
  }
  return true;
}

describe("agentSpawnOptions", () => {
  it("keeps the child attached on win32 so .cmd stdout stays on the parent pipes (#480)", () => {
    const opts = agentSpawnOptions({
      cwd: ".",
      stdio: ["pipe", "pipe", "pipe"],
      platform: "win32",
    });
    assert.equal(opts.detached, false);
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.shell, false);
    assert.deepEqual(opts.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(opts.cwd, ".");
    assert.equal("env" in opts, false);
  });

  it("detaches on posix so killTree can signal the process group", () => {
    const opts = agentSpawnOptions({
      cwd: "/tmp",
      stdio: ["ignore", "pipe", "pipe"],
      platform: "darwin",
    });
    assert.equal(opts.detached, true);
    assert.equal(opts.windowsHide, false);
    assert.equal(opts.shell, false);
  });

  it("passes env through only when provided", () => {
    const env = { FOO: "1" };
    const withEnv = agentSpawnOptions({
      cwd: ".",
      stdio: "pipe",
      env,
      platform: "linux",
    });
    assert.equal(withEnv.env, env);
  });
});

describe("signalGroup", () => {
  it("is exported for simulator recording finalization", () => {
    assert.equal(typeof signalGroup, "function");
  });

  it("on win32 taskkill is /T /F with a bounded timeout, and failure leaves the parent", () => {
    /** @type {{ cmd: string, args: string[], timeout: number | undefined }[]} */
    const calls = [];
    const killed = [];
    const child = {
      pid: 4242,
      kill(sig) {
        killed.push(sig);
      },
    };
    const spawn = (cmd, args, opts) => {
      calls.push({
        cmd,
        args: args.slice(),
        timeout: opts && opts.timeout,
      });
      return { status: calls.length === 1 ? 1 : 0 };
    };
    const win = { platform: "win32", spawn };
    const termOk = signalGroup(child, "SIGTERM", win);
    const killOk = signalPid(99, "SIGKILL", win);
    assert.equal(termOk, false);
    assert.equal(killOk, true);
    assert.deepEqual(calls, [
      {
        cmd: "taskkill",
        args: ["/PID", "4242", "/T", "/F"],
        timeout: WINDOWS_TREE_KILL_TIMEOUT_MS,
      },
      {
        cmd: "taskkill",
        args: ["/PID", "99", "/T", "/F"],
        timeout: WINDOWS_TREE_KILL_TIMEOUT_MS,
      },
    ]);
    assert.deepEqual(
      killed,
      [],
      "a failed tree kill must not signal cmd.exe alone",
    );
  });

  it("on win32 a thrown taskkill does not kill the parent", () => {
    const killed = [];
    const child = {
      pid: 7,
      kill(sig) {
        killed.push(sig);
      },
    };
    const ok = signalGroup(child, "SIGTERM", {
      platform: "win32",
      spawn() {
        throw new Error("ETIMEDOUT");
      },
    });
    assert.equal(ok, false);
    assert.deepEqual(killed, []);
  });
});

function reapPid(pid, child) {
  if (pid && alive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  if (child && child.pid && alive(child.pid)) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}

async function spawnIgnorer() {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('READY');setInterval(()=>{},200)",
    ],
    agentSpawnOptions({ stdio: ["ignore", "pipe", "pipe"] }),
  );
  child.stdout.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no READY")), 3000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
  return child;
}

describe("killTree", { skip: !posix }, () => {
  afterEach(() => {
    resetShutdownForTests();
  });

  it("kills a backgrounded grandchild via the process group", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 60 & echo $!; wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");

    let buf = "";
    let gpid;
    try {
      gpid = await new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error("no grandchild pid")),
          3000,
        );
        child.stdout.on("data", (chunk) => {
          buf += chunk;
          const n = Number(String(buf).trim());
          if (Number.isFinite(n) && n > 0) {
            clearTimeout(t);
            resolve(n);
          }
        });
        child.on("error", (err) => {
          clearTimeout(t);
          reject(err);
        });
      });

      assert.ok(alive(gpid), "grandchild must be alive before kill");
      const timer = killTree(child, 200);
      try {
        await waitFor(() => !alive(gpid), { timeoutMs: 2000 });
      } finally {
        clearTimeout(timer);
      }
      assert.equal(alive(gpid), false, "grandchild must die with the group");
    } finally {
      reapPid(gpid, child);
    }
  });

  it("SIGKILL immediately on shutdown so a SIGTERM-ignorer cannot outlive quit", async () => {
    const child = await spawnIgnorer();
    try {
      assert.ok(alive(child.pid), "ignorer must be alive before kill");
      beginShutdown();
      const timer = killTree(child, 3000);
      assert.equal(timer, null, "quit path must not arm an unref'd SIGKILL timer");
      await waitFor(() => !alive(child.pid), { timeoutMs: 2000 });
      assert.equal(alive(child.pid), false);
    } finally {
      reapPid(child.pid, child);
    }
  });

  it("does not hold in-app Stop: a SIGTERM-ignorer stays up until the fallback", async () => {
    const child = await spawnIgnorer();
    let timer;
    try {
      timer = killTree(child, 400);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(
        alive(child.pid),
        true,
        "in-app Stop must not SIGKILL immediately",
      );
      await waitFor(() => !alive(child.pid), { timeoutMs: 2000 });
    } finally {
      if (timer) clearTimeout(timer);
      reapPid(child.pid, child);
    }
  });
});
