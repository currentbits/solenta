/**
 * fs:browse / browseFilesystem (#609): directory listing for the in-app
 * add-project path, including ~ expansion, missing dirs, frecency, and SSH.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const ssh = require("../ssh.js");
const {
  browseFilesystem,
  expandUserPath,
  resolveBrowseTarget,
} = require("../fsBrowse.js");

describe("fsBrowse", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-fs-browse-"));
    store = new Store(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    ssh.setExecFile(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("expands ~ against the given home", () => {
    assert.equal(expandUserPath("~", "/Users/demo"), "/Users/demo");
    assert.equal(
      expandUserPath("~/code", "/Users/demo"),
      path.join("/Users/demo", "code"),
    );
    assert.equal(expandUserPath("/abs", "/Users/demo"), "/abs");
  });

  it("rejects windows paths off win32", () => {
    assert.throws(
      () =>
        resolveBrowseTarget("C:\\repo", { platform: "darwin", home: tmpDir }),
      /Windows-style paths/,
    );
  });

  it("rejects relative paths without a cwd", () => {
    assert.throws(
      () => resolveBrowseTarget("./docs", { platform: "darwin" }),
      /active project/i,
    );
    const resolved = resolveBrowseTarget("./docs", {
      cwd: "/work/app",
      platform: "darwin",
    });
    assert.equal(resolved, path.resolve("/work/app", "docs"));
  });

  it("lists directories including hidden; files are omitted", async () => {
    fs.mkdirSync(path.join(tmpDir, "Code"));
    fs.mkdirSync(path.join(tmpDir, "Projects"));
    fs.mkdirSync(path.join(tmpDir, ".config"));
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "x");

    const listed = await browseFilesystem({
      store,
      path: tmpDir + "/",
      home: tmpDir,
    });
    const names = listed.entries.map((e) => e.name);
    assert.ok(names.includes("Code"));
    assert.ok(names.includes("Projects"));
    // Hidden dirs are listed; the client filter hides them until the
    // typed leaf starts with `.` (T3: filterFilesystemBrowseEntries).
    assert.ok(names.includes(".config"));
    assert.ok(!names.includes("readme.txt"));
    assert.equal(listed.existed, true);
    assert.equal(listed.parentPath, path.resolve(tmpDir));

    const hidden = await browseFilesystem({
      store,
      path: path.join(tmpDir, ".c"),
      home: tmpDir,
    });
    assert.ok(hidden.entries.some((e) => e.name === ".config"));
    assert.equal(
      hidden.entries.some((e) => e.name === "Code"),
      false,
      "prefix .c must not include Code",
    );
  });

  it("follows a symlink to a directory", async () => {
    const real = path.join(tmpDir, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tmpDir, "link"));
    const listed = await browseFilesystem({
      store,
      path: tmpDir + "/",
    });
    assert.ok(listed.entries.some((e) => e.name === "link"));
  });

  it("returns empty entries when the directory does not exist", async () => {
    const listed = await browseFilesystem({
      store,
      path: path.join(tmpDir, "nope") + "/",
    });
    assert.equal(listed.existed, false);
    assert.deepEqual(listed.entries, []);
  });

  it("prepends a bounded frecency list of existing projects on ~/", async () => {
    const home = path.join(tmpDir, "home");
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(home, "Downloads"));
    store.setProjects([
      { id: "1", slug: "alpha", name: "alpha", path: path.join(tmpDir, "alpha") },
      { id: "2", slug: "beta", name: "beta", path: path.join(tmpDir, "beta") },
    ]);
    store.save();
    const listed = await browseFilesystem({
      store,
      path: "~/",
      home,
    });
    const recent = listed.entries.filter((e) => e.recent);
    assert.equal(recent[0].name, "beta");
    assert.equal(recent[1].name, "alpha");
    assert.ok(listed.entries.some((e) => e.name === "Downloads"));
  });

  it("lists remote directories over SSH when environment is set", async () => {
    const calls = [];
    ssh.setExecFile((bin, args, _opts, cb) => {
      calls.push({ bin, args: args.slice() });
      const remote = String(args[args.length - 1] || "");
      if (remote.includes("printenv")) return cb(null, "/home/dev\n");
      if (remote.includes("ls")) return cb(null, "Code/\nProjects/\nreadme.txt\n");
      cb(null, "");
    });
    const listed = await browseFilesystem({
      store,
      path: "~/",
      environment: "dev@box",
    });
    assert.ok(calls.some((c) => c.bin === "ssh"));
    assert.ok(listed.entries.some((e) => e.name === "Code"));
    assert.ok(listed.entries.some((e) => e.name === "Projects"));
    assert.ok(!listed.entries.some((e) => e.name === "readme.txt"));
  });
});
