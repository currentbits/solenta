/**
 * settings.stayAwake normalize + setSettings (issue #364, item 5).
 * Run: npm run test:electron -- --test-name-pattern stay-awake
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store");
const services = require("../services");

describe("settings.stayAwake (#364)", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-stayawake-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('absent/junk → "agent" (safe default: awake during runs only)', () => {
    assert.equal(normalizeSettings({}).stayAwake, "agent");
    assert.equal(normalizeSettings(null).stayAwake, "agent");
    assert.equal(normalizeSettings({ stayAwake: "always" }).stayAwake, "agent");
    assert.equal(normalizeSettings({ stayAwake: 1 }).stayAwake, "agent");
    assert.equal(normalizeSettings({ stayAwake: null }).stayAwake, "agent");
  });

  it("keeps agent, on, and off", () => {
    assert.equal(normalizeSettings({ stayAwake: "agent" }).stayAwake, "agent");
    assert.equal(normalizeSettings({ stayAwake: "on" }).stayAwake, "on");
    assert.equal(normalizeSettings({ stayAwake: "off" }).stayAwake, "off");
  });

  it("setSettings validates, persists, and round-trips", () => {
    const store = new Store(filePath);
    assert.equal(store.getSettings().stayAwake, "agent");
    assert.equal(
      services.setSettings(store, { stayAwake: "on" }).stayAwake,
      "on",
    );
    assert.equal(store.getSettings().stayAwake, "on");
    assert.throws(
      () => services.setSettings(store, { stayAwake: "always" }),
      /stayAwake must be "agent", "on", or "off"/,
    );
    assert.throws(
      () => services.setSettings(store, { stayAwake: null }),
      /stayAwake must be "agent", "on", or "off"/,
    );
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().stayAwake, "on");
    assert.equal(
      services.setSettings(reloaded, { stayAwake: "off" }).stayAwake,
      "off",
    );
  });

  it("ipc stayAwake:status falls back to the configured mode without power APIs", async () => {
    const store = new Store(filePath);
    services.setSettings(store, { stayAwake: "off" });
    const { IPC_HANDLERS, makeCtx } = require("../ipc");
    const ctx = makeCtx({ store });
    const state = await IPC_HANDLERS["stayAwake:status"](ctx);
    assert.deepEqual(state, {
      mode: "off",
      blocking: false,
      onBattery: false,
      anyWorking: false,
    });
  });

  it("ipc stayAwake:status reports the live state when wired", async () => {
    const store = new Store(filePath);
    const live = { mode: "on", blocking: true, onBattery: false, anyWorking: true };
    const { IPC_HANDLERS, makeCtx } = require("../ipc");
    const ctx = makeCtx({
      store,
      stayAwake: { getState: () => live, evaluate: () => live },
    });
    assert.deepEqual(await IPC_HANDLERS["stayAwake:status"](ctx), live);
  });

  it("settings:set re-evaluates the stay-awake blocker", async () => {
    const store = new Store(filePath);
    let evaluations = 0;
    const { IPC_HANDLERS, makeCtx } = require("../ipc");
    const ctx = makeCtx({
      store,
      stayAwake: {
        evaluate: () => {
          evaluations += 1;
        },
        getState: () => ({
          mode: "on",
          blocking: true,
          onBattery: false,
          anyWorking: false,
        }),
      },
    });
    await IPC_HANDLERS["settings:set"](ctx, { stayAwake: "on" });
    assert.equal(evaluations, 1);
    assert.equal(store.getSettings().stayAwake, "on");
  });
});
