"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { killTree, agentSpawnOptions, signalGroup } = require("../proc.js");

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
});

describe("killTree", { skip: !posix }, () => {
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
      if (gpid && alive(gpid)) {
        try {
          process.kill(-gpid, "SIGKILL");
        } catch {
          try {
            process.kill(gpid, "SIGKILL");
          } catch {
            // ignore
          }
        }
      }
      if (child.pid && alive(child.pid)) {
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
  });
});
