"use strict";

/**
 * coder-threads `automation_create` (#1589): any provider can author a
 * scheduled or GitHub-triggered automation via services.addAutomation.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../store.js");
const services = require("../services.js");
const {
  createToolHandlers,
  INSTRUCTIONS,
} = require("../orchServer.js");

describe("automation_create MCP tool (#1589)", () => {
  let tmpDir;
  let store;
  let thread;
  let handlers;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orch-auto-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([
      { id: "p1", slug: "acme/app", name: "app", path: tmpDir },
      { id: "p2", slug: "acme/other", name: "other", path: tmpDir },
    ]);
    thread = services.createThread(store, {
      projectId: "p1",
      title: "Chat",
      provider: "claude",
    });
    const other = services.createThread(store, {
      projectId: "p2",
      title: "Other",
      provider: "claude",
    });
    store.saveNow();
    handlers = createToolHandlers({
      store,
      runner: { isRunning: () => false },
      forkThread: services.forkThread,
      getProvider: () => ({ id: "claude" }),
    });
    handlers._otherId = other.id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a daily automation on the calling thread's project", async () => {
    const created = await handlers.automation_create({
      threadId: thread.id,
      projectId: "p1",
      name: "Nightly review",
      prompt: "review the repo",
      provider: "claude",
      preset: "daily",
      hour: 9,
    });
    assert.equal(created.name, "Nightly review");
    assert.equal(created.projectId, "p1");
    assert.equal(created.prompt, "review the repo");
    assert.equal(created.provider, "claude");
    assert.equal(created.preset, "daily");
    assert.equal(created.hour, 9);
    assert.equal(created.trigger, null);
    assert.equal(created.enabled, true);
    assert.ok(created.id);
    assert.equal(services.listAutomations(store).length, 1);
    assert.equal(services.listAutomations(store)[0].id, created.id);
  });

  it("creates a GitHub CI trigger without a dummy schedule from the agent", async () => {
    const created = await handlers.automation_create({
      threadId: thread.id,
      projectId: "p1",
      name: "Triage CI",
      prompt: "triage the failed run",
      provider: "claude",
      trigger: {
        event: "ci_completed",
        branch: "main",
        conclusion: "failure",
      },
    });
    assert.equal(created.name, "Triage CI");
    assert.equal(created.trigger.event, "ci_completed");
    assert.equal(created.trigger.branch, "main");
    assert.equal(created.trigger.conclusion, "failure");
    assert.equal(created.preset, "hourly");
    assert.equal(created.hour, null);
  });

  it("rejects a missing schedule-or-trigger, a bad event, and another project", async () => {
    await assert.rejects(
      () =>
        handlers.automation_create({
          threadId: thread.id,
          projectId: "p1",
          name: "No when",
          prompt: "go",
          provider: "claude",
        }),
      /schedule or GitHub trigger/i,
    );
    await assert.rejects(
      () =>
        handlers.automation_create({
          threadId: thread.id,
          projectId: "p1",
          name: "Bad event",
          prompt: "go",
          provider: "claude",
          trigger: { event: "issue_opened" },
        }),
      /Unknown trigger event/,
    );
    await assert.rejects(
      () =>
        handlers.automation_create({
          threadId: handlers._otherId,
          projectId: "p1",
          name: "Cross",
          prompt: "go",
          provider: "claude",
          preset: "hourly",
        }),
      /own project/,
    );
    assert.equal(services.listAutomations(store).length, 0);
  });

  it("instructions tell every CLI to author via automation_create", () => {
    assert.match(INSTRUCTIONS, /automation_create/);
    assert.match(INSTRUCTIONS, /schedule or a GitHub/);
  });
});
