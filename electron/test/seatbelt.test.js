/**
 * #803: matrix → SBPL compile, the wrap predicate, the badge, and (macOS
 * only) the kernel actually enforcing a compiled profile.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  SANDBOX_EXEC,
  seatbeltApplies,
  compileSeatbelt,
  globToSbRegex,
  wrapSpawn,
} = require("../seatbelt.js");
const { resolveSandbox } = require("../sandbox.js");

const local = { path: "/Users/me/repo" };
const writeRule = { rules: [{ kind: "write", match: "src/*", action: "deny" }] };
const netRule = { rules: [{ kind: "network", match: "evil.test", action: "deny" }] };

describe("seatbeltApplies", () => {
  it("wraps only macOS local threads with write or network rules", () => {
    assert.equal(seatbeltApplies(writeRule, local, "darwin"), true);
    assert.equal(seatbeltApplies(netRule, local, "darwin"), true);
    assert.equal(seatbeltApplies(writeRule, local, "linux"), false);
    assert.equal(
      seatbeltApplies(writeRule, { remoteHost: "dev@box", path: "/x" }, "darwin"),
      false,
    );
    assert.equal(
      seatbeltApplies({ rules: [{ kind: "bash", match: "x", action: "deny" }] }, local, "darwin"),
      false,
    );
    assert.equal(seatbeltApplies(null, local, "darwin"), false);
  });

  it("CODER_SEATBELT=off disables it", () => {
    const prev = process.env.CODER_SEATBELT;
    process.env.CODER_SEATBELT = "off";
    try {
      assert.equal(seatbeltApplies(writeRule, local, "darwin"), false);
    } finally {
      if (prev === undefined) delete process.env.CODER_SEATBELT;
      else process.env.CODER_SEATBELT = prev;
    }
  });
});

describe("resolveSandbox stays honest about Seatbelt", () => {
  it("reports the wrap only when the runner would wrap", () => {
    const on = resolveSandbox(
      { provider: "kimi", project: local, policy: { rules: [...writeRule.rules, ...netRule.rules] } },
      "darwin",
    );
    assert.equal(on.sandboxed, true);
    assert.match(on.reason, /^Seatbelt: writes confined to the worktree and 1 write rule, egress via Solenta's proxy \(1 network rule\); Kimi/);
    const claude = resolveSandbox({ provider: "claude", project: local, policy: writeRule }, "darwin");
    assert.doesNotMatch(claude.reason, /no OS sandbox/);
    const linux = resolveSandbox({ provider: "kimi", project: local, policy: writeRule }, "linux");
    assert.equal(linux.sandboxed, false);
    const none = resolveSandbox({ provider: "kimi", project: local, policy: null }, "darwin");
    assert.equal(none.sandboxed, false);
  });
});

describe("compileSeatbelt", () => {
  let dir;
  let wt;
  before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sb-compile-")));
    wt = path.join(dir, "wt");
    fs.mkdirSync(wt);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const compile = (rules, extra = {}) =>
    compileSeatbelt({
      threadId: "T1",
      policy: { rules },
      worktree: wt,
      home: dir,
      tmpdir: dir,
      commonDir: null,
      ...extra,
    });

  it("confines writes, tags every deny, and adds no network rules without network rules", () => {
    const { profile, network } = compile([{ kind: "write", match: "src/*", action: "deny" }]);
    assert.equal(network, false);
    assert.match(profile, /^\(version 1\)\n\(allow default\)\n/);
    assert.ok(profile.includes(`(subpath "${wt}")`));
    assert.ok(profile.includes(`(subpath "${dir}/.claude")`));
    assert.match(profile, /\(deny file-write\* \(require-not \(require-any .*\(with message "solenta:T1"\)\)/);
    assert.match(profile, /\(deny file-write\* \(require-any \(regex #"\^.*\/\[sS\]\[rR\]\[cC\]\/\.\*\$"\)\) \(with message "solenta:T1"\)\)/);
    assert.doesNotMatch(profile, /network-outbound/);
  });

  it("network rules deny outbound IP except loopback and unix sockets", () => {
    const { profile, network } = compile([{ kind: "network", match: "evil.test", action: "deny" }]);
    assert.equal(network, true);
    assert.ok(profile.includes('(deny network-outbound (with message "solenta:T1"))'));
    assert.ok(profile.includes('(allow network-outbound (remote ip "localhost:*"))'));
    assert.ok(profile.includes("(allow network-outbound (remote unix-socket))"));
  });

  it("allow/ask write rules widen the writable set; env homes are writable", () => {
    const { profile } = compile(
      [{ kind: "write", match: `${dir}/out/*`, action: "allow" }],
      { env: { GROK_HOME: path.join(dir, "grok-home"), NOT_A_PATH: "x" } },
    );
    assert.ok(profile.includes(`(subpath "${dir}/grok-home")`));
    const allowLine = profile.split("\n")[2];
    assert.match(allowLine, /\/\[oO\]\[uU\]\[tT\]\/\.\*\$"\)/);
  });

  it("canonicalizes an absolute glob's directory prefix", () => {
    fs.symlinkSync(wt, path.join(dir, "alias"));
    const re = globToSbRegex(`${dir}/alias/*.env`, wt);
    assert.ok(re.includes("/[wW][tT]/"), re);
  });

  it("denies the shared git hooks dir", () => {
    const { profile } = compile([{ kind: "write", match: "x", action: "deny" }], {
      commonDir: path.join(dir, "main.git"),
    });
    assert.ok(profile.includes(`(subpath "${dir}/main.git/hooks")`));
  });

  it("fails closed on what it cannot express or canonicalize", () => {
    assert.throws(() => compile([{ kind: "write", match: 'a"b', action: "deny" }]), /Seatbelt/);
    const loop = path.join(dir, "loop");
    fs.symlinkSync(loop, loop);
    assert.throws(() => compile([{ kind: "write", match: `${loop}/x/*`, action: "deny" }]));
    assert.throws(() => compile([], { worktree: `${loop}/wt` }));
  });

  it("wrapSpawn puts the proxy env and the thread identity inside the sandbox", () => {
    const w = wrapSpawn(
      { binary: "/bin/cli", args: ["-p"], cwd: wt },
      "(version 1)",
      { port: 4242, threadId: "T 1" },
    );
    assert.equal(w.binary, SANDBOX_EXEC);
    assert.deepEqual(w.args.slice(0, 3), ["-p", "(version 1)", "/usr/bin/env"]);
    assert.ok(w.args.includes("HTTPS_PROXY=http://T%201:x@127.0.0.1:4242"));
    assert.deepEqual(w.args.slice(-2), ["/bin/cli", "-p"]);
    assert.deepEqual(wrapSpawn({ binary: "/bin/cli", args: [], cwd: wt }, "p", null).args, ["-p", "p", "/bin/cli"]);
  });
});

describe("sandbox-exec enforces the compiled profile", { skip: process.platform !== "darwin" || !fs.existsSync(SANDBOX_EXEC) }, () => {
  let dir;
  let wt;
  before(() => {
    // Outside tmp: tmp is writable by design, so the "outside" target must not be.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".sb-enforce-")));
    wt = path.join(dir, "wt");
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function sh(cmd) {
    const { profile } = compileSeatbelt({
      threadId: "E1",
      policy: { rules: [{ kind: "write", match: "src/*", action: "deny" }] },
      worktree: wt,
      commonDir: null,
    });
    const w = wrapSpawn({ binary: "/bin/sh", args: ["-c", cmd], cwd: wt }, profile, null);
    try {
      execFileSync(w.binary, w.args, { cwd: wt, stdio: "ignore" });
      return "ok";
    } catch {
      return "denied";
    }
  }

  it("worktree writable, deny rule carved out, outside denied", () => {
    assert.equal(sh("echo x > ok.txt"), "ok");
    assert.equal(sh("echo x > src/no.txt"), "denied");
    assert.equal(sh(`echo x > ${dir}/outside.txt`), "denied");
    assert.equal(fs.existsSync(path.join(dir, "outside.txt")), false);
  });
});
