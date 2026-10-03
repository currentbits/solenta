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
    await openIn("/wt", "vscode", { platform: "darwin", openPath: async () => "", run });
    await openIn("/wt", "zed", { platform: "linux", openPath: async () => "", run });
    assert.deepEqual(runs, [
      ["open", "-a", "Visual Studio Code", "/wt"],
      ["zed", "/wt"],
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
