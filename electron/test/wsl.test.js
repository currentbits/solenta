const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { pathSide, isWindowsMount, wslTarget, buildWslCommand } = require("../wsl.js");
const { wrapCommand } = require("../ssh.js");

// The suite runs on macOS/Linux, so every win32 case passes the platform in.
const WIN = "win32";

describe("pathSide", () => {
  it("calls every path unix off win32", () => {
    assert.deepEqual(pathSide("\\\\wsl$\\Ubuntu\\home\\me\\repo", "darwin"), {
      side: "unix",
      distro: null,
      linuxPath: null,
    });
    assert.equal(pathSide("/Users/me/repo", "linux").side, "unix");
  });

  it("reads distro and linux path out of a \\\\wsl$ UNC", () => {
    assert.deepEqual(pathSide("\\\\wsl$\\Ubuntu\\home\\me\\repo", WIN), {
      side: "wsl",
      distro: "Ubuntu",
      linuxPath: "/home/me/repo",
    });
  });

  it("accepts the newer \\\\wsl.localhost form and hyphenated distros", () => {
    assert.deepEqual(pathSide("\\\\wsl.localhost\\Ubuntu-22.04\\srv\\app", WIN), {
      side: "wsl",
      distro: "Ubuntu-22.04",
      linuxPath: "/srv/app",
    });
  });

  it("calls a drive path windows-side", () => {
    assert.deepEqual(pathSide("C:\\Users\\me\\repo", WIN), {
      side: "windows",
      distro: null,
      linuxPath: null,
    });
  });

  it("survives a distro root with no trailing path", () => {
    assert.equal(pathSide("\\\\wsl$\\Ubuntu", WIN).linuxPath, "/");
    assert.equal(pathSide("\\\\wsl$\\Ubuntu\\", WIN).linuxPath, "/");
  });
});

describe("isWindowsMount", () => {
  it("flags /mnt/<drive> paths — the boundary crossed the other way", () => {
    assert.equal(isWindowsMount("/mnt/c/Users/me/repo"), true);
    assert.equal(isWindowsMount("/mnt/d"), true);
  });

  it("leaves real ext4 paths alone", () => {
    assert.equal(isWindowsMount("/home/me/repo"), false);
    assert.equal(isWindowsMount("/mnt/data/repo"), false);
    assert.equal(isWindowsMount(null), false);
  });
});

describe("wslTarget", () => {
  it("is null for an ssh remote — remoteHost wins", () => {
    const project = { remoteHost: "dev@box", path: "\\\\wsl$\\Ubuntu\\home\\me\\repo" };
    assert.equal(wslTarget(project, WIN), null);
  });

  it("is null for a windows-side project", () => {
    assert.equal(wslTarget({ path: "C:\\repo" }, WIN), null);
  });

  it("returns distro and linux path for a wsl-side project", () => {
    assert.deepEqual(wslTarget({ path: "\\\\wsl$\\Ubuntu\\home\\me\\repo" }, WIN), {
      distro: "Ubuntu",
      linuxPath: "/home/me/repo",
    });
  });
});

describe("buildWslCommand", () => {
  it("passes argv after -- with no shell and no quoting", () => {
    const cmd = buildWslCommand("Ubuntu", "/home/me/my repo", ["git", "log", "--format=%s"]);
    assert.equal(cmd.bin, "wsl.exe");
    assert.deepEqual(cmd.args, [
      "-d",
      "Ubuntu",
      "--cd",
      "/home/me/my repo",
      "--",
      "git",
      "log",
      "--format=%s",
    ]);
  });
});

describe("wrapCommand on this platform", () => {
  it("leaves local projects byte-for-byte unchanged", () => {
    const out = wrapCommand({ path: "/Users/me/repo" }, "git", ["status"]);
    assert.deepEqual(out, { bin: "git", args: ["status"] });
  });

  it("still wraps ssh remotes", () => {
    const out = wrapCommand({ remoteHost: "dev@box", remotePath: "/srv/app" }, "/usr/bin/git", [
      "status",
    ]);
    assert.equal(out.bin, "ssh");
    assert.equal(out.args[out.args.length - 1], "cd '/srv/app' && 'git' 'status'");
  });

  it("wraps a WSL-side project when platform is injected", () => {
    const out = wrapCommand(
      { path: "\\\\wsl$\\Ubuntu\\home\\me\\repo" },
      "bash",
      ["-c", "npm test"],
      WIN,
    );
    assert.equal(out.bin, "wsl.exe");
    assert.deepEqual(out.args, [
      "-d",
      "Ubuntu",
      "--cd",
      "/home/me/repo",
      "--",
      "bash",
      "-c",
      "npm test",
    ]);
  });
});
