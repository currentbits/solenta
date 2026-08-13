const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildSshCommand, posixQuote, wrapCommand } = require("../ssh.js");

describe("posixQuote", () => {
  it("wraps a plain token in single quotes", () => {
    assert.equal(posixQuote("git"), "'git'");
  });

  it("preserves spaces inside the quotes", () => {
    assert.equal(posixQuote("hello world"), "'hello world'");
  });

  it("escapes an embedded single quote as '\\''", () => {
    assert.equal(posixQuote("it's"), `'it'\\''s'`);
  });
});

describe("buildSshCommand", () => {
  it("returns ssh with BatchMode, ConnectTimeout, host, and cd && argv", () => {
    const cmd = buildSshCommand("dev@box", "/srv/app", ["git", "status"]);
    assert.equal(cmd.bin, "ssh");
    assert.deepEqual(cmd.args, [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "dev@box",
      "cd '/srv/app' && 'git' 'status'",
    ]);
  });

  it("quotes remote paths that contain spaces", () => {
    const cmd = buildSshCommand("user@host", "/home/me/my app", [
      "ls",
      "-la",
    ]);
    assert.equal(cmd.args[cmd.args.length - 1], "cd '/home/me/my app' && 'ls' '-la'");
  });

  it("quotes argv tokens that contain spaces", () => {
    const cmd = buildSshCommand("user@host", "/repo", [
      "echo",
      "hello world",
    ]);
    assert.equal(
      cmd.args[cmd.args.length - 1],
      "cd '/repo' && 'echo' 'hello world'",
    );
  });

  it("quotes both a spaced path and spaced args together", () => {
    const cmd = buildSshCommand("user@host", "/opt/my project", [
      "git",
      "commit",
      "-m",
      "fix the bug",
    ]);
    assert.equal(
      cmd.args[cmd.args.length - 1],
      "cd '/opt/my project' && 'git' 'commit' '-m' 'fix the bug'",
    );
  });

  it("escapes single quotes inside path and args", () => {
    const cmd = buildSshCommand("user@host", "/tmp/it's here", [
      "bash",
      "-c",
      "echo it's",
    ]);
    assert.equal(
      cmd.args[cmd.args.length - 1],
      `cd '/tmp/it'\\''s here' && 'bash' '-c' 'echo it'\\''s'`,
    );
  });
});

describe("wrapCommand", () => {
  it("is a no-op when remoteHost is absent", () => {
    assert.deepEqual(wrapCommand({ path: "/local/repo" }, "git", ["status"]), {
      bin: "git",
      args: ["status"],
    });
    assert.deepEqual(wrapCommand(null, "claude", ["-p"]), {
      bin: "claude",
      args: ["-p"],
    });
  });

  it("wraps through buildSshCommand when remoteHost is set", () => {
    const cmd = wrapCommand(
      { remoteHost: "dev@box", remotePath: "/srv/app", path: "/unused" },
      "git",
      ["diff", "HEAD"],
    );
    assert.equal(cmd.bin, "ssh");
    assert.ok(cmd.args.includes("dev@box"));
    assert.ok(cmd.args.includes("BatchMode=yes"));
    assert.equal(cmd.args[cmd.args.length - 1], "cd '/srv/app' && 'git' 'diff' 'HEAD'");
  });

  it("uses basename of an absolute local binary on the remote", () => {
    const cmd = wrapCommand(
      { remoteHost: "dev@box", remotePath: "/srv/app" },
      "/usr/local/bin/claude",
      ["-p", "hi"],
    );
    assert.ok(
      cmd.args[cmd.args.length - 1].includes("'claude'"),
      "remote must see the CLI name, not the local path",
    );
    assert.ok(!cmd.args[cmd.args.length - 1].includes("/usr/local/bin"));
  });
});
