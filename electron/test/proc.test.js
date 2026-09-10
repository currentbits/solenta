"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const {
  killTree,
  reapTree,
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

function spawnDetached(src) {
  return spawn(process.execPath, ["-e", src], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function waitReady(child) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no READY")), 5000);
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function reapOrKill(child) {
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

describe("reapTree", { skip: !posix }, () => {
  it("SIGKILLs a SIGTERM-ignoring child instead of returning at TERM", async () => {
    const child = spawnDetached(`
      process.on("SIGTERM", () => {});
      process.stdout.write("READY\\n");
      setInterval(() => {}, 50);
    `);
    try {
      await waitReady(child);
      assert.ok(alive(child.pid));
      const started = Date.now();
      await reapTree(child, 200);
      assert.equal(alive(child.pid), false, "owned child must be dead after reap");
      assert.ok(Date.now() - started >= 150, "must wait the grace period before KILL");
    } finally {
      await reapOrKill(child);
    }
  });

  it("returns as soon as a cooperative child exits, without the full grace", async () => {
    const child = spawnDetached(`
      process.stdout.write("READY\\n");
      setInterval(() => {}, 50);
    `);
    try {
      await waitReady(child);
      const started = Date.now();
      await reapTree(child, 2000);
      assert.equal(alive(child.pid), false);
      assert.ok(
        Date.now() - started < 1000,
        "cooperative exit must not wait the full grace",
      );
    } finally {
      await reapOrKill(child);
    }
  });

  it("resolves immediately when the child has already exited", async () => {
    const child = spawnDetached(`process.stdout.write("READY\\n"); process.exit(0);`);
    await waitReady(child);
    await new Promise((resolve) => child.once("exit", resolve));
    const started = Date.now();
    await reapTree(child, 2000);
    assert.ok(Date.now() - started < 200);
  });

  it("reaping the same child twice shares one teardown", async () => {
    const child = spawnDetached(`
      process.on("SIGTERM", () => {});
      process.stdout.write("READY\\n");
      setInterval(() => {}, 50);
    `);
    try {
      await waitReady(child);
      const a = reapTree(child, 200);
      const b = reapTree(child, 200);
      assert.equal(a, b);
      await a;
      assert.equal(alive(child.pid), false);
    } finally {
      await reapOrKill(child);
    }
  });

  it("does not SIGKILL a decoy that reused the owned child's pid number", async () => {
    const decoy = spawnDetached(`
      process.on("SIGTERM", () => {});
      process.stdout.write("READY\\n");
      setInterval(() => {}, 50);
    `);
    try {
      await waitReady(decoy);
      const fake = new EventEmitter();
      fake.pid = decoy.pid;
      fake.kill = () => {
        throw new Error("fake.kill must not run after the owned child exited");
      };
      fake.exitCode = 0;
      fake.signalCode = null;
      const started = Date.now();
      await reapTree(fake, 200);
      assert.ok(Date.now() - started < 100);
      assert.ok(alive(decoy.pid), "unrelated process must not be signalled");
    } finally {
      await reapOrKill(decoy);
    }
  });

  it("settles even if the child never emits exit after KILL", async () => {
    const fake = new EventEmitter();
    fake.pid = 2147483646;
    fake.kill = () => {};
    const started = Date.now();
    await Promise.race([
      reapTree(fake, 50),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("reapTree hung")), 1000),
      ),
    ]);
    assert.ok(Date.now() - started < 500);
    await awaitPendingKills();
  });
});

describe("killTree still fire-and-forgets for ordinary Stop", { skip: !posix }, () => {
  it("returns a timer and does not wait for the child to die", async () => {
    const child = spawnDetached(`
      process.on("SIGTERM", () => {});
      process.stdout.write("READY\\n");
      setInterval(() => {}, 50);
    `);
    try {
      await waitReady(child);
      const started = Date.now();
      const timer = killTree(child, 2000);
      assert.ok(timer);
      assert.ok(typeof timer.unref === "function");
      assert.ok(Date.now() - started < 200, "killTree must return immediately");
      assert.ok(alive(child.pid), "SIGTERM-ignoring child still runs after killTree");
      clearTimeout(timer);
    } finally {
      await reapOrKill(child);
    }
  });
});
