/**
 * Thread details "Open in ‹editor›" (#1411): allowlisted ids only, detection
 * per platform, and the exact command each id runs.
 * Run: node --test electron/test/open-in.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { listEditors, openIn } = require("../openIn.js");

describe("openIn (#1411)", () => {
  it("lists macOS editors by app bundle, file manager always last", () => {
    const rows = listEditors({
      platform: "darwin",
      home: "/Users/me",
      exists: (p) => p === "/Applications/Cursor.app" || p === "/Users/me/Applications/Zed.app",
      onPath: () => false,
    });
    assert.deepEqual(rows.map((r) => r.id), ["cursor", "zed", "finder"]);
    assert.equal(rows.at(-1).name, "Finder");
  });

  it("lists Linux/Windows editors by CLI on PATH", () => {
    const rows = listEditors({
      platform: "linux",
      home: "/home/me",
      exists: () => false,
      onPath: (bin) => bin === "code",
    });
    assert.deepEqual(rows.map((r) => r.id), ["vscode", "finder"]);
    assert.equal(rows.at(-1).name, "File manager");
  });

  it("opens with `open -a` on macOS and the CLI elsewhere", async () => {
    const runs = [];
    const run = async (cmd, args) => {
      runs.push([cmd, ...args]);
    };
    await openIn("/wt", "vscode", {
      platform: "darwin",
      exists: () => false,
      openPath: async () => "",
      run,
    });
    await openIn("/wt", "zed", { platform: "linux", openPath: async () => "", run });
    assert.deepEqual(runs, [
      ["open", "-a", "Visual Studio Code", "/wt"],
      ["zed", "/wt"],
    ]);
  });

  it("detects JetBrains IDEs by any bundle name or CLI launcher (#1506)", () => {
    const mac = listEditors({
      platform: "darwin",
      home: "/Users/me",
      exists: (p) =>
        p === "/Applications/IntelliJ IDEA CE.app" ||
        p === "/Users/me/Applications/RustRover.app",
      onPath: () => false,
    });
    assert.deepEqual(mac.map((r) => r.id), ["idea", "rustrover", "finder"]);
    const linux = listEditors({
      platform: "linux",
      home: "/home/me",
      exists: () => false,
      onPath: (bin) => bin === "webstorm" || bin === "fleet",
    });
    assert.deepEqual(linux.map((r) => r.id), ["webstorm", "fleet", "finder"]);
  });

  it("jumps to path:line:col with each editor's own syntax (#1506)", async () => {
    const runs = [];
    const run = async (cmd, args) => {
      runs.push([cmd, ...args]);
    };
    const base = { openPath: async () => "", run };
    await openIn("/wt/a.ts", "vscode", { ...base, platform: "linux", line: 12, col: 3 });
    await openIn("/wt/a.ts", "cursor", { ...base, platform: "linux", line: 12 });
    await openIn("/wt/a.ts", "zed", { ...base, platform: "linux", line: 12, col: 3 });
    await openIn("/wt/a.ts", "goland", { ...base, platform: "linux", line: 12, col: 3 });
    await openIn("/wt/a.ts", "fleet", { ...base, platform: "linux", line: 12 });
    // Junk from IPC never reaches argv.
    await openIn("/wt/a.ts", "vscode", {
      ...base,
      platform: "linux",
      line: "12; rm -rf /",
      col: 3,
    });
    assert.deepEqual(runs, [
      ["code", "--goto", "/wt/a.ts:12:3"],
      ["cursor", "--goto", "/wt/a.ts:12"],
      ["zed", "/wt/a.ts:12:3"],
      ["goland", "--line", "12", "--column", "3", "/wt/a.ts"],
      ["fleet", "/wt/a.ts"],
      ["code", "/wt/a.ts"],
    ]);
  });

  it("uses the bundle CLI for a line on macOS, `open -a` otherwise (#1506)", async () => {
    const runs = [];
    const run = async (cmd, args) => {
      runs.push([cmd, ...args]);
    };
    const installed = new Set([
      "/Applications/PyCharm CE.app",
      "/Applications/PyCharm CE.app/Contents/MacOS/pycharm",
      "/Applications/Zed.app",
    ]);
    const base = {
      platform: "darwin",
      home: "/Users/me",
      exists: (p) => installed.has(p),
      openPath: async () => "",
      run,
    };
    await openIn("/wt/a.py", "pycharm", { ...base, line: 4, col: 2 });
    await openIn("/wt/a.py", "pycharm", base);
    // Zed without its bundled cli falls back to opening the file.
    await openIn("/wt/a.py", "zed", { ...base, line: 4 });
    assert.deepEqual(runs, [
      ["/Applications/PyCharm CE.app/Contents/MacOS/pycharm", "--line", "4", "--column", "2", "/wt/a.py"],
      ["open", "-a", "PyCharm CE", "/wt/a.py"],
      ["open", "-a", "Zed", "/wt/a.py"],
    ]);
  });

  it("routes the file manager through openPath and rejects unknown ids", async () => {
    const opened = [];
    await openIn("/wt", "finder", {
      platform: "darwin",
      openPath: async (p) => {
        opened.push(p);
        return "";
      },
      run: async () => assert.fail("no command for the file manager"),
    });
    assert.deepEqual(opened, ["/wt"]);
    await assert.rejects(
      openIn("/wt", "rm -rf /", { platform: "darwin", openPath: async () => "" }),
      /Unknown editor/,
    );
    await assert.rejects(
      openIn("/wt", "terminal", { platform: "linux", openPath: async () => "", run: async () => {} }),
      /only available on macOS/,
    );
  });
});
