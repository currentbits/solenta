"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  killTree,
  awaitKillTree,
  awaitPendingKills,
  agentSpawnOptions,
  signalGroup,
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
});

function forceKill(child) {
  if (!child || !child.pid) return;
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

function spawnDetached(script) {
  return spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
}

/** READY handshake so the SIGTERM handler is installed before we signal. */
async function spawnStubborn() {
  const ready = path.join(
    os.tmpdir(),
    `coder-stubborn-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const child = spawnDetached(
    `process.on("SIGTERM",()=>{});require("fs").writeFileSync(${JSON.stringify(ready)},"READY");setInterval(()=>{},50);`,
  );
  await waitFor(() => fs.existsSync(ready), { timeoutMs: 3000 });
  try {
    fs.unlinkSync(ready);
  } catch {
    // ignore
  }
  return child;
}

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

  it("returns without waiting for a SIGTERM-ignoring child", async () => {
    const child = await spawnStubborn();
    try {
      const t0 = Date.now();
      killTree(child, 2000);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 200, `killTree held for ${elapsed}ms`);
      assert.ok(alive(child.pid), "in-app Stop must not wait for SIGKILL");
    } finally {
      forceKill(child);
      await waitFor(() => !alive(child.pid), { timeoutMs: 2000 }).catch(() => {});
    }
  });
});

describe("awaitKillTree", { skip: !posix }, () => {
  it("SIGKILLs a SIGTERM-ignoring child instead of waiting past the grace", async () => {
    const child = await spawnStubborn();
    try {
      const t0 = Date.now();
      await awaitKillTree(child, 200);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 100, `escalated too fast (${elapsed}ms)`);
      assert.ok(elapsed < 1500, `hung quit (${elapsed}ms)`);
      assert.equal(alive(child.pid), false);
    } finally {
      forceKill(child);
    }
  });

  it("lets a cooperative child exit without waiting the full grace", async () => {
    const child = spawnDetached("setInterval(()=>{},200);");
    try {
      await waitFor(() => alive(child.pid), { timeoutMs: 2000 });
      const t0 = Date.now();
      await awaitKillTree(child, 3000);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 1000, `waited the full grace (${elapsed}ms)`);
      assert.equal(alive(child.pid), false);
    } finally {
      forceKill(child);
    }
  });

  it("resolves immediately when the child is already dead", async () => {
    const child = spawnDetached("setInterval(()=>{},200);");
    forceKill(child);
    await waitFor(() => !alive(child.pid), { timeoutMs: 2000 });
    const t0 = Date.now();
    await awaitKillTree(child, 3000);
    assert.ok(Date.now() - t0 < 200);
  });

  it("joins an in-flight killTree instead of stacking a second grace", async () => {
    const child = await spawnStubborn();
    try {
      killTree(child, 200);
      const t0 = Date.now();
      await awaitKillTree(child, 5000);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 1500, `second grace stacked (${elapsed}ms)`);
      assert.equal(alive(child.pid), false);
    } finally {
      forceKill(child);
    }
  });
});

describe("awaitPendingKills", { skip: !posix }, () => {
  it("resolves immediately when nothing is in flight", async () => {
    const t0 = Date.now();
    await awaitPendingKills();
    assert.ok(Date.now() - t0 < 100);
  });

  it("still reaps after a caller throws", async () => {
    const child = await spawnStubborn();
    try {
      killTree(child, 200);
      await assert.rejects(async () => {
        try {
          throw new Error("boom");
        } finally {
          await awaitPendingKills();
        }
      }, /boom/);
      assert.equal(alive(child.pid), false);
    } finally {
      forceKill(child);
    }
  });
});
