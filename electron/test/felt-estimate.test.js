/**
 * Issue #401: threads:setFeltEstimate - one-tap felt estimate, persisted
 * without bumping updatedAt; decline and junk handling.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");

describe("setFeltEstimate", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-felt-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Worker",
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createThread starts with no estimate", () => {
    assert.equal(store.getThread(threadId).feltEstimate, null);
  });

  it("records a saved estimate", () => {
    const updated = services.setFeltEstimate(store, {
      threadId,
      savedMs: 3_600_000,
    });
    assert.equal(updated.feltEstimate.kind, "saved");
    assert.equal(updated.feltEstimate.savedMs, 3_600_000);
    assert.equal(typeof updated.feltEstimate.at, "number");
    assert.equal(store.getThread(threadId).feltEstimate.savedMs, 3_600_000);
  });

  it("clamps an absurd estimate to the cap", () => {
    const updated = services.setFeltEstimate(store, {
      threadId,
      savedMs: 365 * 24 * 3_600_000,
    });
    assert.equal(updated.feltEstimate.savedMs, 7 * 24 * 3_600_000);
  });

  it("null records a decline so the card never asks again", () => {
    const updated = services.setFeltEstimate(store, {
      threadId,
      savedMs: null,
    });
    assert.equal(updated.feltEstimate.kind, "declined");
    assert.equal(store.getThread(threadId).feltEstimate.kind, "declined");
  });

  it("rejects negative and non-numeric estimates", () => {
    assert.throws(
      () => services.setFeltEstimate(store, { threadId, savedMs: -1 }),
      /Invalid felt estimate/,
    );
    assert.throws(
      () => services.setFeltEstimate(store, { threadId, savedMs: "2h" }),
      /Invalid felt estimate/,
    );
    assert.throws(
      () => services.setFeltEstimate(store, { threadId, savedMs: NaN }),
      /Invalid felt estimate/,
    );
  });

  it("never bumps updatedAt", () => {
    const before = store.getThread(threadId).updatedAt;
    services.setFeltEstimate(store, { threadId, savedMs: 60_000 });
    assert.equal(store.getThread(threadId).updatedAt, before);
  });

  it("throws on an unknown thread", () => {
    assert.throws(
      () => services.setFeltEstimate(store, { threadId: "nope", savedMs: 1 }),
      /Unknown thread/,
    );
  });

  it("the prompt is opt-in: off by default, only an explicit true asks", () => {
    assert.equal(store.getSettings().feltEstimatePrompt, false);
    assert.equal(
      store.setSettings({ feltEstimatePrompt: true }).feltEstimatePrompt,
      true,
    );
    assert.throws(
      () => store.setSettings({ feltEstimatePrompt: "yes" }),
      /must be a boolean/,
    );
    store.data.settings.feltEstimatePrompt = "yes";
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getSettings().feltEstimatePrompt, false);
  });

  it("migration heals a junk estimate to null and keeps a good one", () => {
    services.setFeltEstimate(store, { threadId, savedMs: 60_000 });
    store.data.threads = store.data.threads.map((t) =>
      t.id === threadId ? { ...t, feltEstimate: { kind: "maybe" } } : t,
    );
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getThread(threadId).feltEstimate, null);
  });
});
