const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveSandbox } = require("../sandbox.js");

// Suite runs on macOS/Linux, so every win32 case passes the platform in.
const WIN = "win32";
const local = { path: "/Users/me/repo" };
const wsl = { path: "\\\\wsl$\\Ubuntu\\home\\me\\repo" };
const remote = { remoteHost: "dev@box", remotePath: "/srv/app", path: "/unused" };

function reason(over, platform) {
  return resolveSandbox(over, platform).reason;
}

describe("resolveSandbox location", () => {
  it("calls a local project local, even on win32", () => {
    assert.match(
      reason({ provider: "claude", project: { path: "C:\\repo" } }, WIN),
      /runs locally as your user$/,
    );
  });

  it("names the WSL distro only on win32", () => {
    assert.match(
      reason({ provider: "claude", project: wsl }, WIN),
      /runs inside WSL Ubuntu$/,
    );
    // Off win32 a \\\\wsl$ path is just another local path.
    assert.match(
      reason({ provider: "claude", project: wsl }, "darwin"),
      /runs locally as your user$/,
    );
  });

  it("calls an ssh remote out, even when the path looks like WSL", () => {
    assert.match(
      reason(
        {
          provider: "claude",
          project: {
            remoteHost: "dev@box",
            path: "\\\\wsl$\\Ubuntu\\home\\me\\repo",
          },
        },
        WIN,
      ),
      /runs on ssh remote$/,
    );
  });
});

describe("resolveSandbox per provider (local)", () => {
  it("claude: permission-mode is a gate, not an OS sandbox", () => {
    const def = resolveSandbox({
      provider: "claude",
      permissionMode: "default",
      project: local,
    });
    assert.equal(def.sandboxed, false);
    assert.match(def.reason, /Claude --permission-mode default; no OS sandbox/);

    const bypass = resolveSandbox({
      provider: "claude",
      permissionMode: "bypassPermissions",
      project: local,
    });
    assert.equal(bypass.sandboxed, false);
    assert.match(bypass.reason, /bypassPermissions \(not gated\)/);
  });

  it("codex: --sandbox follows permissionMode", () => {
    const plan = resolveSandbox({
      provider: "codex",
      permissionMode: "plan",
      project: local,
    });
    assert.equal(plan.sandboxed, true);
    assert.match(plan.reason, /Codex --sandbox read-only/);

    const def = resolveSandbox({
      provider: "codex",
      permissionMode: "default",
      project: local,
    });
    assert.equal(def.sandboxed, true);
    assert.match(def.reason, /Codex --sandbox workspace-write/);

    const accept = resolveSandbox({
      provider: "codex",
      permissionMode: "acceptEdits",
      project: local,
    });
    assert.equal(accept.sandboxed, true);
    assert.match(accept.reason, /Codex --sandbox workspace-write/);

    const bypass = resolveSandbox({
      provider: "codex",
      permissionMode: "bypassPermissions",
      project: local,
    });
    assert.equal(bypass.sandboxed, false);
    assert.match(bypass.reason, /Codex --sandbox danger-full-access/);
  });

  it("grok: asking modes become bypassPermissions; never passes --sandbox", () => {
    const asking = resolveSandbox({
      provider: "grok",
      permissionMode: "default",
      project: local,
    });
    assert.equal(asking.sandboxed, false);
    assert.match(
      asking.reason,
      /--always-approve|--permission-mode bypassPermissions/,
    );

    const accept = resolveSandbox({
      provider: "grok",
      permissionMode: "acceptEdits",
      project: local,
    });
    assert.equal(accept.sandboxed, false);
    assert.match(
      accept.reason,
      /--always-approve|--permission-mode bypassPermissions/,
    );

    const plan = resolveSandbox({
      provider: "grok",
      permissionMode: "plan",
      project: local,
    });
    assert.equal(plan.sandboxed, false);
    assert.match(plan.reason, /--permission-mode plan; no --sandbox/);

    const bypass = resolveSandbox({
      provider: "grok",
      permissionMode: "bypassPermissions",
      project: local,
    });
    assert.equal(bypass.sandboxed, false);
    assert.match(bypass.reason, /bypassPermissions \(not gated\)/);
  });

  it("kimi: permission mode is ignored", () => {
    const out = resolveSandbox({
      provider: "kimi",
      permissionMode: "bypassPermissions",
      project: local,
    });
    assert.equal(out.sandboxed, false);
    assert.match(out.reason, /Kimi -p ignores permission mode/);
  });

  it("opencode and simulate have no OS sandbox", () => {
    assert.equal(
      resolveSandbox({ provider: "opencode", project: local }).sandboxed,
      false,
    );
    assert.match(
      reason({ provider: "opencode", project: local }),
      /OpenCode run without --auto/,
    );
    assert.match(
      reason({
        provider: "opencode",
        permissionMode: "bypassPermissions",
        project: local,
      }),
      /OpenCode --auto/,
    );
    assert.equal(
      resolveSandbox({ provider: "simulate", project: local }).sandboxed,
      false,
    );
    assert.match(reason({ provider: "simulate", project: local }), /Simulate/);
  });

  it("cursor: plan drops --force; other modes are --force", () => {
    const plan = resolveSandbox({
      provider: "cursor",
      permissionMode: "plan",
      project: local,
    });
    assert.equal(plan.sandboxed, false);
    assert.match(plan.reason, /--mode plan/);
    const bypass = resolveSandbox({
      provider: "cursor",
      permissionMode: "bypassPermissions",
      project: local,
    });
    assert.equal(bypass.sandboxed, false);
    assert.match(bypass.reason, /--force/);
  });

  it("unknown / generic is an honest no", () => {
    const out = resolveSandbox({ provider: "generic", project: local });
    assert.equal(out.sandboxed, false);
    assert.match(out.reason, /generic has no sandbox flags/);
  });

  it("missing provider is treated as claude", () => {
    const out = resolveSandbox({ project: local });
    assert.equal(out.sandboxed, false);
    assert.match(out.reason, /Claude --permission-mode default/);
  });
});

describe("resolveSandbox agent x location", () => {
  it("keeps Codex sandboxed inside WSL and on ssh", () => {
    const inside = resolveSandbox(
      { provider: "codex", project: wsl },
      WIN,
    );
    assert.equal(inside.sandboxed, true);
    assert.match(inside.reason, /inside WSL Ubuntu/);

    const ssh = resolveSandbox({ provider: "codex", project: remote });
    assert.equal(ssh.sandboxed, true);
    assert.match(ssh.reason, /ssh remote/);
  });

  it("does not pretend WSL or ssh is a repo sandbox for claude", () => {
    const inside = resolveSandbox(
      { provider: "claude", permissionMode: "default", project: wsl },
      WIN,
    );
    assert.equal(inside.sandboxed, false);
    assert.match(inside.reason, /no OS sandbox; runs inside WSL Ubuntu/);
  });
});
