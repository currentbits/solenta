"use strict";

/**
 * Jujutsu detection (#521). The probe is filesystem-only — no jj binary.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  detectScm,
  attachScm,
  JJ_COLOCATED_DETAIL,
  JJ_NON_COLOCATED_DETAIL,
  JJ_NON_COLOCATED_ADD_ERROR,
} = require("../scm.js");
const { presentProject } = require("../projectIcon.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("detectScm", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-scm-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns git for a plain git checkout", () => {
    const repo = path.join(tmpDir, "git");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    assert.deepEqual(detectScm(repo), { kind: "git", support: "supported" });
  });

  it("returns jj colocated when .jj and .git both exist", () => {
    const repo = path.join(tmpDir, "colo");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, ".jj"));
    assert.deepEqual(detectScm(repo), {
      kind: "jj",
      colocated: true,
      support: "unsupported",
      detail: JJ_COLOCATED_DETAIL,
    });
  });

  it("returns jj non-colocated when only .jj exists", () => {
    const repo = path.join(tmpDir, "noco");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(repo, ".jj"));
    assert.deepEqual(detectScm(repo), {
      kind: "jj",
      colocated: false,
      support: "unsupported",
      detail: JJ_NON_COLOCATED_DETAIL,
    });
  });

  it("treats a .jj symlink as a jj repo", () => {
    const repo = path.join(tmpDir, "link");
    const real = path.join(tmpDir, "real-jj");
    fs.mkdirSync(repo);
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(repo, ".jj"));
    const scm = detectScm(repo);
    assert.equal(scm && scm.kind, "jj");
    assert.equal(scm && scm.colocated, false);
  });

  it("returns null for an empty directory", () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir);
    assert.equal(detectScm(dir), null);
  });

  it("returns null for a missing path", () => {
    assert.equal(detectScm(path.join(tmpDir, "nope")), null);
    assert.equal(detectScm(""), null);
    assert.equal(detectScm(null), null);
  });
});

describe("attachScm / presentProject", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-scm-pres-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("copies jj onto the presented project and leaves git quiet", () => {
    const colo = path.join(tmpDir, "colo");
    fs.mkdirSync(colo);
    fs.mkdirSync(path.join(colo, ".git"));
    fs.mkdirSync(path.join(colo, ".jj"));
    const presented = attachScm({ id: "p", path: colo, slug: "colo", name: "colo" });
    assert.equal(presented.scm.kind, "jj");
    assert.equal(presented.scm.support, "unsupported");

    const gitRepo = path.join(tmpDir, "git");
    fs.mkdirSync(gitRepo);
    fs.mkdirSync(path.join(gitRepo, ".git"));
    const gitPresented = attachScm({
      id: "g",
      path: gitRepo,
      slug: "git",
      name: "git",
    });
    assert.equal("scm" in gitPresented, false);
  });

  it("does not probe remotes", () => {
    const presented = attachScm({
      id: "r",
      path: "/tmp/whatever",
      slug: "r",
      name: "r",
      remoteHost: "dev@box",
      scm: { kind: "jj", support: "unsupported" },
    });
    assert.equal("scm" in presented, false);
  });

  it("presentProject attaches scm without persisting it", async () => {
    const repo = path.join(tmpDir, "colo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    fs.mkdirSync(path.join(repo, ".jj"));
    const store = new Store(path.join(tmpDir, "store.json"));
    const project = await services.addProject(store, repo);
    assert.equal(project.scm && project.scm.kind, "jj");
    assert.equal(project.scm.colocated, true);
    assert.equal("scm" in store.getProjects()[0], false);
    const listed = services.listProjects(store);
    assert.equal(listed[0].scm && listed[0].scm.kind, "jj");
    assert.equal("scm" in store.getProjects()[0], false);
    const presented = presentProject(store.getProjects()[0]);
    assert.equal(presented.scm && presented.scm.kind, "jj");
  });

  it("drops a persisted scm field on load", () => {
    const file = path.join(tmpDir, "store.json");
    const store = new Store(file);
    store.setProjects([
      {
        id: "p1",
        slug: "x",
        name: "x",
        path: "/tmp/x",
        scm: { kind: "jj", support: "unsupported" },
      },
    ]);
    store.saveNow();
    const reloaded = new Store(file);
    assert.equal("scm" in reloaded.getProjects()[0], false);
  });
});

describe("addProject refuses non-colocated jj", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-scm-add-"));
    store = new Store(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not git-init next to .jj", async () => {
    const repo = path.join(tmpDir, "noco");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(repo, ".jj"));
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    await assert.rejects(
      () => services.addProject(store, repo),
      (err) => {
        assert.equal(err.message, JJ_NON_COLOCATED_ADD_ERROR);
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(repo, ".git")), false);
    assert.equal(store.getProjects().length, 0);
  });
});
