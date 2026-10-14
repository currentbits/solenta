"use strict";

/**
 * Multi-repo tasks (#263): createThread({ taskGroupFrom }) groups threads
 * across projects; the prompt note and PR footer name the siblings.
 * Run: node --test electron/test/task-groups.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const { withTaskGroupFooter, taskGroupNoteFor } = require("../taskGroups.js");
const { rmTree } = require("./support/rmTree.js");

describe("multi-repo task groups (#263)", () => {
  let dir;
  let store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-groups-"));
    store = new Store(path.join(dir, "store.json"));
    store.setProjects([
      { id: "api", name: "api", slug: "acme/api", path: path.join(dir, "api") },
      { id: "web", name: "web", slug: "acme/web", path: path.join(dir, "web") },
      { id: "infra", name: "infra", slug: "acme/infra", path: path.join(dir, "infra") },
      { id: "scratch", name: "Scratch", slug: "scratch", path: dir, scratch: true },
    ]);
  });
  afterEach(() => rmTree(dir));

  it("groups a sibling with its source and stamps the source on first use", () => {
    const api = services.createThread(store, { projectId: "api", title: "Dark mode" });
    assert.equal(api.taskGroupId, undefined);
    const web = services.createThread(store, {
      projectId: "web",
      title: "Dark mode",
      taskGroupFrom: api.id,
    });
    assert.equal(web.taskGroupId, api.id);
    assert.equal(store.getThread(api.id).taskGroupId, api.id);
    // Extending from a member reuses the existing group id.
    const infra = services.createThread(store, {
      projectId: "infra",
      title: "Dark mode",
      taskGroupFrom: web.id,
    });
    assert.equal(infra.taskGroupId, api.id);
  });

  it("rejects an unknown source thread and the scratch workspace", () => {
    const api = services.createThread(store, { projectId: "api", title: "t" });
    assert.throws(
      () => services.createThread(store, { projectId: "web", taskGroupFrom: "nope" }),
      /Unknown thread/,
    );
    assert.throws(
      () => services.createThread(store, { projectId: "scratch", taskGroupFrom: api.id }),
      /Scratch/,
    );
    assert.equal(store.getThread(api.id).taskGroupId, undefined);
  });

  it("the prompt note lists siblings and their PRs, never their paths", () => {
    const api = services.createThread(store, { projectId: "api", title: "Dark mode" });
    const web = services.createThread(store, {
      projectId: "web",
      title: "Dark mode web",
      taskGroupFrom: api.id,
    });
    store.updateThread(web.id, {
      prNumber: 12,
      prUrl: "https://github.com/acme/web/pull/12",
      prState: "OPEN",
    });
    assert.equal(taskGroupNoteFor(store, services.createThread(store, { projectId: "infra" })), "");
    const note = taskGroupNoteFor(store, store.getThread(api.id));
    assert.match(note, /\[Multi-repo task\]/);
    assert.match(note, /web \(acme\/web\): "Dark mode web" — idle, PR https:\/\/github\.com\/acme\/web\/pull\/12/);
    assert.match(note, /Change only this repo/);
    assert.ok(!note.includes(path.join(dir, "web")), "sibling path leaked");
    // Trashed siblings drop out.
    store.updateThread(web.id, { trashedAt: Date.now() });
    assert.equal(taskGroupNoteFor(store, store.getThread(api.id)), "");
  });

  it("the PR footer names sibling PRs once and flags unopened ones", () => {
    const api = services.createThread(store, { projectId: "api", title: "x" });
    const web = services.createThread(store, { projectId: "web", taskGroupFrom: api.id });
    services.createThread(store, { projectId: "infra", taskGroupFrom: api.id });
    const url = "https://github.com/acme/web/pull/12";
    store.updateThread(web.id, { prNumber: 12, prUrl: url, prState: "OPEN" });
    const self = store.getThread(api.id);
    const body = withTaskGroupFooter(store, self, "Adds dark mode.");
    assert.equal(
      body,
      `Adds dark mode.\n\n---\nPart of a multi-repo change:\n- web (acme/web): ${url}\n- infra (acme/infra): PR not opened yet`,
    );
    // A ref the author already wrote is not repeated.
    assert.ok(!withTaskGroupFooter(store, self, `See ${url}`).includes(`- web (acme/web): ${url}`));
    // No group → untouched.
    const solo = services.createThread(store, { projectId: "api" });
    assert.equal(withTaskGroupFooter(store, solo, "b"), "b");
    assert.equal(withTaskGroupFooter(store, solo, null), "");
  });
});
