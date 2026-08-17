const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");

describe("services.updateProject", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-proj-upd-"));
    store = new Store(path.join(tmpDir, "store.json"));
    // Remote form needs no local checkout on disk.
    project = await services.addProject(store, "", {
      remoteHost: "dev@box",
      remotePath: "/srv/app",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renames a project and keeps the remote fields", () => {
    const updated = services.updateProject(store, project.id, {
      name: "box app",
    });
    assert.equal(updated.name, "box app");
    assert.equal(updated.remoteHost, "dev@box");
    assert.equal(updated.remotePath, "/srv/app");
    assert.equal(store.getProjects()[0].name, "box app");
  });

  it("rejects a remote host without a remote path", () => {
    assert.throws(
      () => services.updateProject(store, project.id, { remoteHost: "a@b" }),
      /remote path is required/i,
    );
  });

  it("rejects a non-absolute remote path", () => {
    assert.throws(
      () =>
        services.updateProject(store, project.id, {
          remoteHost: "a@b",
          remotePath: "srv/app",
        }),
      /absolute path/i,
    );
  });

  it("sets remote fields on a project and clears them again", () => {
    const cleared = services.updateProject(store, project.id, {
      remoteHost: "",
      remotePath: "",
    });
    assert.equal(cleared.remoteHost, undefined);
    assert.equal(cleared.remotePath, undefined);
    const persisted = store.getProjects()[0];
    assert.equal("remoteHost" in persisted, false);
    assert.equal("remotePath" in persisted, false);

    const remote = services.updateProject(store, project.id, {
      remoteHost: "ops@other",
      remotePath: "/var/www",
    });
    assert.equal(remote.remoteHost, "ops@other");
    assert.equal(remote.remotePath, "/var/www");
  });

  it("rejects an unknown project id", () => {
    assert.throws(
      () => services.updateProject(store, "nope", { name: "x" }),
      /unknown project/i,
    );
  });

  it("rejects an empty name", () => {
    assert.throws(
      () => services.updateProject(store, project.id, { name: "   " }),
      /name cannot be empty/i,
    );
  });

  it("persists autoDispatch when set true", () => {
    const updated = services.updateProject(store, project.id, {
      autoDispatch: true,
    });
    assert.equal(updated.autoDispatch, true);
    assert.equal(store.getProjects()[0].autoDispatch, true);
  });

  it("removes the autoDispatch key when set false", () => {
    services.updateProject(store, project.id, { autoDispatch: true });
    const cleared = services.updateProject(store, project.id, {
      autoDispatch: false,
    });
    assert.equal(cleared.autoDispatch, undefined);
    assert.equal("autoDispatch" in store.getProjects()[0], false);
  });

  it("leaves an existing autoDispatch flag alone on a name-only patch", () => {
    services.updateProject(store, project.id, { autoDispatch: true });
    const updated = services.updateProject(store, project.id, {
      name: "box app",
    });
    assert.equal(updated.name, "box app");
    assert.equal(updated.autoDispatch, true);
    assert.equal(store.getProjects()[0].autoDispatch, true);
  });
});
