"use strict";

/**
 * coder-threads automation_create (#1589): wrap addAutomation so any
 * provider can author a scheduled or GitHub-triggered automation from chat.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../store.js");
const {
  createToolHandlers,
  INSTRUCTIONS,
} = require("../orchServer.js");
const services = require("../services.js");
const {
  registerMcpServer,
  unregisterMcpServer,
} = require("../memory-sup.js");

function makeDeps(store) {
  return {
    store,
    runner: { startRun: async () => ({}) },
    forkThread: () => ({ id: "fork-1" }),
    getProvider: () => null,
  };
}

describe("automation_create MCP tool", () => {
  let tmpDir;
  /** @type {Store} */
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-create-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([
      { id: "p1", slug: "acme/app", name: "Alpha", path: tmpDir },
      { id: "p2", slug: "acme/other", name: "Beta", path: tmpDir },
    ]);
    store.setThreads([
      {
        id: "t1",
        projectId: "p1",
        title: "First",
        status: "idle",
        provider: "claude",
      },
      {
        id: "t3",
        projectId: "p2",
        title: "Other",
        status: "idle",
        provider: "codex",
      },
    ]);
    store.saveNow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a scheduled automation on the thread's project", async () => {
    const h = createToolHandlers(makeDeps(store));
    const out = await h.automation_create({
      threadId: "t1",
      projectId: "p1",
      name: "Nightly review",
      prompt: "review the repo",
      preset: "daily",
      hour: 9,
    });
    assert.equal(out.ok, true);
    assert.equal(out.name, "Nightly review");
    assert.equal(out.projectId, "p1");
    assert.equal(out.provider, "claude");
    assert.equal(out.preset, "daily");
    assert.equal(out.hour, 9);
    assert.equal(out.trigger, null);
    assert.ok(out.id);
    assert.equal(out.enabled, true);
    assert.equal(store.getAutomations().length, 1);
    assert.equal(store.getAutomation(out.id).prompt, "review the repo");
    assert.equal(store.getAutomation(out.id).enabled, true);
  });

  it("creates a GitHub trigger automation and defaults preset to hourly", async () => {
    const h = createToolHandlers(makeDeps(store));
    const out = await h.automation_create({
      threadId: "t1",
      projectId: "p1",
      name: "Triage CI",
      prompt: "when CI fails on main, triage it",
      trigger: {
        event: "ci_completed",
        branch: "main",
        conclusion: "failure",
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.preset, "hourly");
    assert.deepEqual(out.trigger, {
      type: "github",
      event: "ci_completed",
      branch: "main",
      label: null,
      conclusion: "failure",
      team: null,
      status: null,
      org: null,
      project: null,
      environment: null,
    });
    assert.equal(store.getAutomation(out.id).trigger.event, "ci_completed");
  });

  it("honours an explicit provider", async () => {
    const h = createToolHandlers(makeDeps(store));
    const out = await h.automation_create({
      threadId: "t1",
      projectId: "p1",
      name: "Hourly",
      prompt: "go",
      provider: "codex",
      preset: "hourly",
    });
    assert.equal(out.provider, "codex");
  });

  it("rejects a cross-project threadId", async () => {
    const h = createToolHandlers(makeDeps(store));
    await assert.rejects(
      () =>
        h.automation_create({
          threadId: "t3",
          projectId: "p1",
          name: "Nope",
          prompt: "go",
          preset: "hourly",
        }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.equal(store.getAutomations().length, 0);
  });

  it("rejects neither schedule nor trigger", async () => {
    const h = createToolHandlers(makeDeps(store));
    await assert.rejects(
      () =>
        h.automation_create({
          threadId: "t1",
          projectId: "p1",
          name: "Nope",
          prompt: "go",
        }),
      /schedule|trigger/i,
    );
    assert.equal(store.getAutomations().length, 0);
  });

  it("rejects an unknown trigger event via addAutomation validation", async () => {
    const h = createToolHandlers(makeDeps(store));
    await assert.rejects(
      () =>
        h.automation_create({
          threadId: "t1",
          projectId: "p1",
          name: "Nope",
          prompt: "go",
          trigger: { event: "slack_message" },
        }),
      /Unknown trigger event/,
    );
    assert.equal(store.getAutomations().length, 0);
  });
});

describe("automation authoring note + instructions", () => {
  afterEach(() => {
    unregisterMcpServer("coder-threads");
  });

  it("INSTRUCTIONS name the tool", () => {
    assert.match(INSTRUCTIONS, /automation_create/);
  });

  it("returns empty unless coder-threads is registered", () => {
    assert.equal(services.automationNoteFor(), "");
    assert.equal(
      registerMcpServer({
        name: "coder-threads",
        port: 1234,
        token: "tok",
        userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), "auto-note-")),
      }),
      true,
    );
    const note = services.automationNoteFor();
    assert.match(note, /automation_create/);
    assert.match(note, /Open in Automations/);
    unregisterMcpServer("coder-threads");
    assert.equal(services.automationNoteFor(), "");
  });
});
