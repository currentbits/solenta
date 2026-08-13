const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");

describe("services.createProject", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-proj-new-"));
    store = new Store(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a folder, git-inits it, and adds it as a project", () => {
    const project = services.createProject(store, {
      name: "fresh-app",
      parentDir: tmpDir,
    });
    const target = path.join(tmpDir, "fresh-app");
    assert.equal(project.name, "fresh-app");
    assert.equal(project.slug, "fresh-app");
    assert.equal(project.path, target);
    assert.ok(fs.statSync(target).isDirectory(), "folder must exist");
    const inside = String(
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: target,
        encoding: "utf8",
      }),
    ).trim();
    assert.equal(inside, "true", "target must be a git work tree");
    assert.equal(store.getProjects()[0].id, project.id);
  });

  it("rejects an empty name", () => {
    assert.throws(
      () => services.createProject(store, { name: "   ", parentDir: tmpDir }),
      /name is required/i,
    );
  });

  it("rejects names with path separators or dot segments", () => {
    for (const name of ["a/b", "a\\b", ".", ".."]) {
      assert.throws(
        () => services.createProject(store, { name, parentDir: tmpDir }),
        /plain folder name/i,
        `name ${JSON.stringify(name)} must be rejected`,
      );
    }
  });

  it("rejects a missing parent directory", () => {
    assert.throws(
      () =>
        services.createProject(store, {
          name: "fresh-app",
          parentDir: path.join(tmpDir, "nope"),
        }),
      /path does not exist/i,
    );
  });

  it("rejects when the target already exists", () => {
    fs.mkdirSync(path.join(tmpDir, "fresh-app"));
    assert.throws(
      () => services.createProject(store, { name: "fresh-app", parentDir: tmpDir }),
      /already exists/i,
    );
  });

  it("rejects a parentDir that is a file", () => {
    const file = path.join(tmpDir, "file.txt");
    fs.writeFileSync(file, "x");
    assert.throws(
      () => services.createProject(store, { name: "fresh-app", parentDir: file }),
      /not a directory/i,
    );
  });
});
