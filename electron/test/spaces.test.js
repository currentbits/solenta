"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");

describe("spaces retired (#568)", () => {
  let tmpDir;
  let storePath;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-spaces-"));
    storePath = path.join(tmpDir, "store.json");
    store = new Store(storePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("list is always empty; add and update throw", () => {
    assert.deepEqual(services.listSpaces(store), []);
    assert.throws(
      () => services.addSpace(store, { name: "Client work" }),
      /spaces have been removed/i,
    );
    assert.throws(
      () => services.updateSpace(store, { id: "s1", name: "New" }),
      /spaces have been removed/i,
    );
    assert.deepEqual(services.listSpaces(store), []);
  });

  it("remove is a no-op", () => {
    services.removeSpace(store, { id: "missing" });
    assert.deepEqual(services.listSpaces(store), []);
  });

  it("projects:update ignores spaceId instead of assigning it", async () => {
    const project = await services.addProject(store, "", {
      remoteHost: "dev@box",
      remotePath: "/srv/app",
    });
    const patched = services.updateProject(store, project.id, {
      spaceId: "s-legacy",
    });
    assert.equal(Object.hasOwn(patched, "spaceId"), false);
    assert.equal(Object.hasOwn(store.getProjects()[0], "spaceId"), false);
  });

  it("load drops persisted spaces and project spaceIds, then saves the wipe", () => {
    const raw = {
      spaces: [
        { id: "s1", name: "One" },
        { id: "s2", name: "Two" },
      ],
      projects: [
        {
          id: "p-ok",
          slug: "ok",
          name: "ok",
          path: "/tmp/ok",
          spaceId: "s1",
        },
        {
          id: "p-junk",
          slug: "app",
          name: "app",
          path: "/tmp/app",
          spaceId: "",
        },
      ],
      threads: [],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(storePath, JSON.stringify(raw), "utf8");
    const loaded = new Store(storePath);
    assert.deepEqual(loaded.getSpaces(), []);
    for (const p of loaded.getProjects()) {
      assert.equal(Object.hasOwn(p, "spaceId"), false, p.id);
    }
    loaded.saveNow();
    const persisted = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.deepEqual(persisted.spaces, []);
    for (const p of persisted.projects) {
      assert.equal(Object.hasOwn(p, "spaceId"), false, p.id);
    }
  });

  it("legacy store with no spaces key still loads", () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        projects: [
          { id: "p1", slug: "app", name: "app", path: "/tmp/app" },
        ],
        threads: [],
      }),
      "utf8",
    );
    const loaded = new Store(storePath);
    assert.deepEqual(loaded.getSpaces(), []);
    assert.equal(loaded.getProjects()[0].id, "p1");
  });
});
