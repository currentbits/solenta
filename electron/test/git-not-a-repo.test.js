const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");

// Only a genuine "not a git repository" may read as isRepo:false; other git
// failures must surface instead of hiding behind it (or triggering git init).
describe("git failures are not 'not a repo'", { skip: process.platform === "win32" }, () => {
  let tmpDir;
  let oldPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-notrepo-"));
    oldPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Put a git on PATH that logs its argv and fails with dubious ownership. */
  function dubiousGit() {
    const bin = path.join(tmpDir, "bin");
    fs.mkdirSync(bin);
    const log = path.join(tmpDir, "git.log");
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\necho "$@" >> '${log}'\necho "fatal: detected dubious ownership in repository at '$PWD'" >&2\nexit 128\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    return log;
  }

  it("gitStatus is isRepo:false for a plain directory", async () => {
    const dir = path.join(tmpDir, "plain");
    fs.mkdirSync(dir);
    assert.deepEqual(await services.gitStatus(dir), {
      isRepo: false,
      branch: "",
      dirty: false,
    });
  });

  it("gitStatus surfaces dubious ownership instead of isRepo:false", async () => {
    dubiousGit();
    await assert.rejects(services.gitStatus(tmpDir), /dubious ownership/);
  });

  it("addProject reports dubious ownership and never runs git init", async () => {
    const log = dubiousGit();
    const dir = path.join(tmpDir, "repo");
    fs.mkdirSync(dir);
    const store = new Store(path.join(tmpDir, "store.json"));
    await assert.rejects(services.addProject(store, dir), /dubious ownership/);
    assert.doesNotMatch(fs.readFileSync(log, "utf8"), /^init/m);
  });
});
