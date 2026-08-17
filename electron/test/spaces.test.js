"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");

describe("spaces", () => {
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

  it("add → list round-trips and persists across a store reload", () => {
    const created = services.addSpace(store, { name: "  Client work  " });
    assert.equal(created.name, "Client work");
    assert.ok(created.id);
    assert.deepEqual(services.listSpaces(store), [
      { id: created.id, name: "Client work" },
    ]);

    const again = services.addSpace(store, { name: "Experiments" });
    assert.deepEqual(
      services.listSpaces(store).map((s) => s.name),
      ["Client work", "Experiments"],
    );

    store.saveNow();
    const reloaded = new Store(storePath);
    assert.deepEqual(services.listSpaces(reloaded), [
      { id: created.id, name: "Client work" },
      { id: again.id, name: "Experiments" },
    ]);
  });

  it("add rejects an empty or whitespace name", () => {
    assert.throws(
      () => services.addSpace(store, { name: "" }),
      /name cannot be empty/i,
    );
    assert.throws(
      () => services.addSpace(store, { name: "   " }),
      /name cannot be empty/i,
    );
    assert.throws(
      () => services.addSpace(store, {}),
      /name cannot be empty/i,
    );
    assert.deepEqual(services.listSpaces(store), []);
  });

  it("update renames; update on an unknown id throws", () => {
    const created = services.addSpace(store, { name: "Old" });
    const updated = services.updateSpace(store, {
      id: created.id,
      name: "  New  ",
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "New");
    assert.equal(services.listSpaces(store)[0].name, "New");

    assert.throws(
      () => services.updateSpace(store, { id: "nope", name: "x" }),
      /unknown space: nope/i,
    );
    assert.throws(
      () => services.updateSpace(store, { id: created.id, name: "   " }),
      /name cannot be empty/i,
    );
  });

  it("remove drops the space and unassigns only its projects", async () => {
    const keep = services.addSpace(store, { name: "Keep" });
    const drop = services.addSpace(store, { name: "Drop" });
    const assigned = await services.addProject(store, "", {
      remoteHost: "dev@box",
      remotePath: "/srv/assigned",
    });
    const otherAssigned = await services.addProject(store, "", {
      remoteHost: "dev@box",
      remotePath: "/srv/other",
    });
    const untouched = await services.addProject(store, "", {
      remoteHost: "dev@box",
      remotePath: "/srv/untouched",
    });

    services.updateProject(store, assigned.id, { spaceId: drop.id });
    services.updateProject(store, otherAssigned.id, { spaceId: keep.id });

    services.removeSpace(store, { id: drop.id });

    assert.deepEqual(
      services.listSpaces(store).map((s) => s.id),
      [keep.id],
    );
    const projects = store.getProjects();
    const a = projects.find((p) => p.id === assigned.id);
    const b = projects.find((p) => p.id === otherAssigned.id);
    const c = projects.find((p) => p.id === untouched.id);
    assert.equal(Object.hasOwn(a, "spaceId"), false);
    assert.equal(b.spaceId, keep.id);
    assert.equal(Object.hasOwn(c, "spaceId"), false);

    assert.throws(
      () => services.removeSpace(store, { id: drop.id }),
      /unknown space/i,
    );
  });

  it("projects:update assigns spaceId and clears it back to an absent key", async () => {
    const space = services.addSpace(store, { name: "Clients" });
    const project = await services.addProject(store, "", {
      remoteHost: "dev@box",
      remotePath: "/srv/app",
    });
    assert.equal(Object.hasOwn(project, "spaceId"), false);

    const assigned = services.updateProject(store, project.id, {
      spaceId: space.id,
    });
    assert.equal(assigned.spaceId, space.id);
    assert.equal(store.getProjects()[0].spaceId, space.id);

    assert.throws(
      () => services.updateProject(store, project.id, { spaceId: "missing" }),
      /unknown space: missing/i,
    );

    const cleared = services.updateProject(store, project.id, { spaceId: "" });
    assert.equal(Object.hasOwn(cleared, "spaceId"), false);
    const persisted = store.getProjects()[0];
    assert.equal(Object.hasOwn(persisted, "spaceId"), false);
    assert.equal("spaceId" in persisted, false);
  });

  it("legacy store with no spaces key loads as [] and drops junk spaceId", () => {
    const legacy = {
      projects: [
        {
          id: "p-junk",
          slug: "app",
          name: "app",
          path: "/tmp/app",
          spaceId: "",
        },
        {
          id: "p-ws",
          slug: "ws",
          name: "ws",
          path: "/tmp/ws",
          spaceId: "   ",
        },
        {
          id: "p-ok",
          slug: "ok",
          name: "ok",
          path: "/tmp/ok",
          spaceId: "space-1",
        },
      ],
      threads: [],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(storePath, JSON.stringify(legacy), "utf8");
    const loaded = new Store(storePath);
    assert.deepEqual(loaded.getSpaces(), []);
    const junk = loaded.getProjects().find((p) => p.id === "p-junk");
    const ws = loaded.getProjects().find((p) => p.id === "p-ws");
    const ok = loaded.getProjects().find((p) => p.id === "p-ok");
    assert.equal(Object.hasOwn(junk, "spaceId"), false);
    assert.equal(Object.hasOwn(ws, "spaceId"), false);
    assert.equal(ok.spaceId, "space-1");
  });

  it("load drops junk space rows and keeps valid ones in order", () => {
    const raw = {
      spaces: [
        { id: "s1", name: "One" },
        { id: "", name: "empty id" },
        { name: "no id" },
        null,
        "nope",
        { id: "s2", name: 12 },
        { id: "  s3  ", name: "Three" },
      ],
      projects: [],
      threads: [],
    };
    fs.writeFileSync(storePath, JSON.stringify(raw), "utf8");
    const loaded = new Store(storePath);
    assert.deepEqual(loaded.getSpaces(), [
      { id: "s1", name: "One" },
      { id: "s3", name: "Three" },
    ]);
  });
});
