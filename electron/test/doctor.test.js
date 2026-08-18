const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const doctor = require("../doctor.js");
const ssh = require("../ssh.js");

const WIN = "win32";
const WIN_REPO = { path: "C:\\Users\\me\\repo" };
const WSL_REPO = { path: "\\\\wsl$\\Ubuntu\\home\\me\\repo" };
const MNT_REPO = { path: "\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\repo" };
const REMOTE = {
  remoteHost: "dev@box",
  remotePath: "/srv/app",
  path: "C:\\unused",
};

/** @param {(bin: string, args: string[]) => string} handler */
function fakeExec(handler) {
  ssh.setExecFile((bin, args, _opts, cb) => {
    try {
      cb(null, handler(bin, args));
    } catch (err) {
      cb(err);
    }
  });
}

afterEach(() => {
  ssh.setExecFile(null);
  ssh.setExecFileSync(null);
  doctor.setPlatform(null);
});

describe("runWindowsDoctor", () => {
  it("is a no-op off win32 and never probes", async () => {
    let calls = 0;
    ssh.setExecFile(() => {
      calls += 1;
      throw new Error("should not spawn");
    });
    assert.equal(await doctor.runWindowsDoctor(WIN_REPO, "darwin"), null);
    assert.equal(await doctor.runWindowsDoctor(WIN_REPO, "linux"), null);
    assert.equal(await doctor.runWindowsDoctor(WIN_REPO), null);
    assert.equal(calls, 0);
  });

  it("reports all four checks green on a healthy Windows drive repo", async () => {
    const calls = [];
    fakeExec((bin, args) => {
      calls.push({ bin, args });
      if (bin === "git" && args[0] === "config") return "true\n";
      if (bin === "bash") return "ok\n";
      if (bin === "node") return "v22.14.0\n";
      throw new Error(`unexpected ${bin}`);
    });
    const report = await doctor.runWindowsDoctor(WIN_REPO, WIN);
    assert.ok(report);
    assert.deepEqual(
      report.checks.map((c) => [c.id, c.ok]),
      [
        ["longpaths", true],
        ["gitBash", true],
        ["node22", true],
        ["wslBoundary", true],
      ],
    );
    assert.ok(calls.some((c) => c.bin === "git" && c.args.includes("core.longpaths")));
    assert.ok(calls.some((c) => c.bin === "bash"));
    assert.ok(calls.some((c) => c.bin === "node" && c.args[0] === "-v"));
  });

  it("reports every probe red without throwing", async () => {
    fakeExec((bin) => {
      if (bin === "node") return "v18.20.8\n";
      throw new Error(`${bin} missing`);
    });
    const report = await doctor.runWindowsDoctor(WIN_REPO, WIN);
    assert.ok(report);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.longpaths.ok, false);
    assert.match(byId.longpaths.fix, /core\.longpaths true/);
    assert.equal(byId.gitBash.ok, false);
    assert.match(byId.gitBash.fix, /Git for Windows/);
    assert.equal(byId.node22.ok, false);
    assert.match(byId.node22.message, /too old/);
    assert.equal(byId.wslBoundary.ok, true);
  });

  it("treats a missing node as a failed node22 check", async () => {
    fakeExec((bin) => {
      if (bin === "git") return "true\n";
      if (bin === "bash") return "ok\n";
      throw new Error("node: not found");
    });
    const report = await doctor.runWindowsDoctor(WIN_REPO, WIN);
    const node = report.checks.find((c) => c.id === "node22");
    assert.equal(node.ok, false);
    assert.match(node.message, /not on PATH/);
  });

  it("skips the longpaths probe on a WSL-side repo and flags /mnt/<drive>", async () => {
    const calls = [];
    fakeExec((bin, args) => {
      calls.push({ bin, args });
      if (bin === "bash") return "ok\n";
      if (bin === "node") return "v22.1.0\n";
      throw new Error(`unexpected ${bin} ${args.join(" ")}`);
    });
    const inside = await doctor.runWindowsDoctor(WSL_REPO, WIN);
    assert.equal(inside.checks.find((c) => c.id === "longpaths").ok, true);
    assert.match(
      inside.checks.find((c) => c.id === "wslBoundary").message,
      /inside WSL \(Ubuntu\)/,
    );
    assert.ok(
      !calls.some((c) => c.bin === "git"),
      "Linux git has no MAX_PATH — do not probe core.longpaths in the distro",
    );

    const mounted = await doctor.runWindowsDoctor(MNT_REPO, WIN);
    const boundary = mounted.checks.find((c) => c.id === "wslBoundary");
    assert.equal(boundary.ok, false);
    assert.match(boundary.message, /\/mnt\/<drive>/);
    assert.match(boundary.fix, /Move the repo into the distro/);
  });

  it("probes an ssh remote through the wrap seam", async () => {
    const calls = [];
    ssh.setExecFile((bin, args, _opts, cb) => {
      calls.push({ bin, args });
      const remoteCmd = String(args[args.length - 1] || "");
      if (remoteCmd.includes("'bash'")) return cb(null, "ok\n");
      if (remoteCmd.includes("'node'")) return cb(null, "v22.4.0\n");
      cb(null, "");
    });
    const report = await doctor.runWindowsDoctor(REMOTE, WIN);
    assert.ok(calls.length > 0);
    assert.ok(
      calls.every((c) => c.bin === "ssh"),
      "remote probes must go through wrapCommand, not a local spawn",
    );
    assert.ok(calls.some((c) => /'node' '-v'/.test(c.args[c.args.length - 1])));
    assert.equal(report.checks.find((c) => c.id === "longpaths").ok, true);
    assert.equal(report.checks.find((c) => c.id === "node22").ok, true);
    assert.match(
      report.checks.find((c) => c.id === "wslBoundary").message,
      /SSH remote/,
    );
  });

  it("honours setPlatform so addProject can flip win32 on macOS tests", async () => {
    doctor.setPlatform(WIN);
    fakeExec((bin) => {
      if (bin === "git") return "true\n";
      if (bin === "bash") return "ok\n";
      if (bin === "node") return "v23.0.0\n";
      throw new Error(bin);
    });
    const report = await doctor.runWindowsDoctor(WIN_REPO);
    assert.ok(report);
    assert.equal(report.checks.find((c) => c.id === "node22").ok, true);
    doctor.setPlatform(null);
    assert.equal(await doctor.runWindowsDoctor(WIN_REPO), null);
  });
});
