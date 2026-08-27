/**
 * Agent profiles (issue #190): normalize + setSettings validation.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store");
const services = require("../services");

function validProfile(over = {}) {
  return {
    id: "scout",
    name: "Cheap scout",
    provider: "claude",
    model: "haiku",
    reasoningEffort: "low",
    permissionMode: "plan",
    ...over,
  };
}

describe("normalizeSettings agentProfiles", () => {
  it("absent / junk / non-array → []", () => {
    assert.deepEqual(normalizeSettings({}).agentProfiles, []);
    assert.deepEqual(normalizeSettings(null).agentProfiles, []);
    assert.deepEqual(normalizeSettings({ agentProfiles: null }).agentProfiles, []);
    assert.deepEqual(normalizeSettings({ agentProfiles: "nope" }).agentProfiles, []);
    assert.deepEqual(normalizeSettings({ agentProfiles: {} }).agentProfiles, []);
  });

  it("drops invalid entries and keeps valid ones", () => {
    const n = normalizeSettings({
      agentProfiles: [
        validProfile(),
        "garbage",
        null,
        [],
        { name: "no-id", provider: "claude", model: null, reasoningEffort: null, permissionMode: "default" },
        { id: "", name: "empty-id", provider: "claude", model: null, reasoningEffort: null, permissionMode: "default" },
        { id: "no-name", name: "", provider: "claude", model: null, reasoningEffort: null, permissionMode: "default" },
        { id: "no-provider", name: "x", provider: "", model: null, reasoningEffort: null, permissionMode: "default" },
        { id: "bad-model", name: "x", provider: "claude", model: 1, reasoningEffort: null, permissionMode: "default" },
        { id: "bad-effort", name: "x", provider: "claude", model: null, reasoningEffort: "ultra", permissionMode: "default" },
        { id: "bad-mode", name: "x", provider: "claude", model: null, reasoningEffort: null, permissionMode: "yolo" },
        { id: "long", name: "x".repeat(41), provider: "claude", model: null, reasoningEffort: null, permissionMode: "default" },
        validProfile({ id: "scout" }),
        validProfile({
          id: "worker",
          name: "  Deep worker  ",
          model: null,
          reasoningEffort: null,
          permissionMode: "acceptEdits",
        }),
      ],
    });
    assert.deepEqual(n.agentProfiles, [
      validProfile(),
      validProfile({
        id: "worker",
        name: "Deep worker",
        model: null,
        reasoningEffort: null,
        permissionMode: "acceptEdits",
      }),
    ]);
  });
});

describe("setSettings agentProfiles validation", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-profiles-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("round-trips a valid list across save + reload", () => {
    const store = new Store(filePath);
    const list = [
      validProfile(),
      validProfile({
        id: "worker",
        name: "Deep worker",
        model: null,
        reasoningEffort: "max",
        permissionMode: "acceptEdits",
      }),
    ];
    const next = services.setSettings(store, { agentProfiles: list });
    assert.deepEqual(next.agentProfiles, list);
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.deepEqual(reloaded.getSettings().agentProfiles, list);
  });

  it("trims name on write", () => {
    const store = new Store(filePath);
    const next = services.setSettings(store, {
      agentProfiles: [validProfile({ name: "  Scout  " })],
    });
    assert.equal(next.agentProfiles[0].name, "Scout");
  });

  it("old store file without the key heals to [] on load", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        projects: [],
        threads: [],
        settings: { dailyBudgetUsd: null },
      }),
    );
    const store = new Store(filePath);
    assert.deepEqual(store.getSettings().agentProfiles, []);
  });

  it("junk entries on disk are dropped, not thrown", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        projects: [],
        threads: [],
        settings: {
          agentProfiles: [
            validProfile(),
            { id: "bad" },
            "nope",
          ],
        },
      }),
    );
    const store = new Store(filePath);
    assert.deepEqual(store.getSettings().agentProfiles, [validProfile()]);
  });

  it("rejects each invalid patch and leaves saved profiles untouched", () => {
    const store = new Store(filePath);
    services.setSettings(store, { agentProfiles: [validProfile()] });

    const reject = (patch, re) => {
      assert.throws(() => services.setSettings(store, { agentProfiles: patch }), re);
      assert.deepEqual(store.getSettings().agentProfiles, [validProfile()]);
    };

    reject("nope", /agentProfiles must be an array/);
    reject([validProfile(), validProfile()], /Duplicate agentProfiles id/);
    reject(["x"], /plain object/);
    reject([[]], /plain object/);
    reject([validProfile({ id: "" })], /id must be a non-empty string/);
    reject([validProfile({ id: 1 })], /id must be a non-empty string/);
    reject([validProfile({ name: "" })], /name must be a non-empty string/);
    reject([validProfile({ name: 1 })], /name must be a non-empty string/);
    reject([validProfile({ name: "x".repeat(41) })], /at most 40 characters/);
    reject([validProfile({ provider: "" })], /provider must be a non-empty string/);
    reject([validProfile({ provider: 1 })], /provider must be a non-empty string/);
    reject([validProfile({ model: 1 })], /model must be a string or null/);
    reject([validProfile({ model: undefined })], /model must be a string or null/);
    reject([validProfile({ reasoningEffort: "ultra" })], /reasoningEffort/);
    reject([validProfile({ reasoningEffort: "LOW" })], /reasoningEffort/);
    reject([validProfile({ permissionMode: "yolo" })], /permissionMode/);
    reject([validProfile({ permissionMode: null })], /permissionMode/);
  });

  it("a patch that omits agentProfiles leaves saved profiles untouched", () => {
    const store = new Store(filePath);
    services.setSettings(store, { agentProfiles: [validProfile()] });
    const next = services.setSettings(store, { notifications: false });
    assert.equal(next.notifications, false);
    assert.deepEqual(next.agentProfiles, [validProfile()]);
    store.saveNow();
    assert.deepEqual(new Store(filePath).getSettings().agentProfiles, [
      validProfile(),
    ]);
  });
});

describe("defaultOrchestratorProfileId (#725)", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orch-default-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("absent / junk / unknown id → null; matching id kept", () => {
    assert.equal(normalizeSettings({}).defaultOrchestratorProfileId, null);
    assert.equal(
      normalizeSettings({ defaultOrchestratorProfileId: "scout" })
        .defaultOrchestratorProfileId,
      null,
    );
    assert.equal(
      normalizeSettings({
        agentProfiles: [validProfile()],
        defaultOrchestratorProfileId: "nope",
      }).defaultOrchestratorProfileId,
      null,
    );
    assert.equal(
      normalizeSettings({
        agentProfiles: [validProfile()],
        defaultOrchestratorProfileId: "  scout  ",
      }).defaultOrchestratorProfileId,
      "scout",
    );
    assert.equal(
      normalizeSettings({
        agentProfiles: [validProfile()],
        defaultOrchestratorProfileId: 1,
      }).defaultOrchestratorProfileId,
      null,
    );
  });

  it("round-trips a matching id and rejects an unknown one", () => {
    const store = new Store(filePath);
    services.setSettings(store, { agentProfiles: [validProfile()] });
    assert.equal(store.getSettings().defaultOrchestratorProfileId, null);
    assert.equal(
      services.setSettings(store, { defaultOrchestratorProfileId: "scout" })
        .defaultOrchestratorProfileId,
      "scout",
    );
    assert.throws(
      () =>
        services.setSettings(store, { defaultOrchestratorProfileId: "nope" }),
      /must match an agent profile or be null/,
    );
    assert.throws(
      () => services.setSettings(store, { defaultOrchestratorProfileId: 1 }),
      /must be a string or null/,
    );
    store.saveNow();
    assert.equal(
      new Store(filePath).getSettings().defaultOrchestratorProfileId,
      "scout",
    );
  });

  it("deleting the default profile clears the id", () => {
    const store = new Store(filePath);
    services.setSettings(store, {
      agentProfiles: [validProfile(), validProfile({ id: "worker", name: "Deep" })],
      defaultOrchestratorProfileId: "scout",
    });
    const next = services.setSettings(store, {
      agentProfiles: [validProfile({ id: "worker", name: "Deep" })],
    });
    assert.equal(next.defaultOrchestratorProfileId, null);
  });

  it("null clears a saved default", () => {
    const store = new Store(filePath);
    services.setSettings(store, {
      agentProfiles: [validProfile()],
      defaultOrchestratorProfileId: "scout",
    });
    assert.equal(
      services.setSettings(store, { defaultOrchestratorProfileId: null })
        .defaultOrchestratorProfileId,
      null,
    );
  });
});
