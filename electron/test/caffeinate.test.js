/**
 * Stay-awake power blocker (issue #364, item 5): three modes, battery
 * cutoff, agent mode follows the working state.
 * Run: npm run test:electron -- --test-name-pattern caffeinate
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createStayAwake, normalizeStayAwakeMode } = require("../caffeinate");

/** Fake electron.powerSaveBlocker. */
function fakeBlocker() {
  let nextId = 1;
  const started = new Set();
  return {
    started,
    start(type) {
      assert.equal(type, "prevent-app-suspension");
      const id = nextId++;
      started.add(id);
      return id;
    },
    stop(id) {
      started.delete(id);
    },
    isStarted(id) {
      return started.has(id);
    },
    count() {
      return started.size;
    },
  };
}

/** Fake electron.powerMonitor with an event bus. */
function fakePowerMonitor({ onBattery = false } = {}) {
  const listeners = new Map();
  return {
    battery: onBattery,
    isOnBatteryPower() {
      return this.battery;
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    removeListener(event, cb) {
      const list = listeners.get(event) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    emit(event) {
      for (const cb of listeners.get(event) || []) cb();
    },
    listenerCount() {
      let n = 0;
      for (const list of listeners.values()) n += list.length;
      return n;
    },
  };
}

function setup({ mode = "agent", working = false, onBattery = false } = {}) {
  const blocker = fakeBlocker();
  const monitor = fakePowerMonitor({ onBattery });
  const changes = [];
  const ctx = { mode, working };
  const stayAwake = createStayAwake({
    powerSaveBlocker: blocker,
    powerMonitor: monitor,
    getMode: () => ctx.mode,
    isAnyWorking: () => ctx.working,
    onChange: (s) => changes.push(s),
  });
  return { blocker, monitor, changes, ctx, stayAwake };
}

describe("normalizeStayAwakeMode", () => {
  it("keeps the three modes, heals junk to agent", () => {
    assert.equal(normalizeStayAwakeMode("agent"), "agent");
    assert.equal(normalizeStayAwakeMode("on"), "on");
    assert.equal(normalizeStayAwakeMode("off"), "off");
    assert.equal(normalizeStayAwakeMode("always"), "agent");
    assert.equal(normalizeStayAwakeMode(undefined), "agent");
    assert.equal(normalizeStayAwakeMode(null), "agent");
    assert.equal(normalizeStayAwakeMode(1), "agent");
  });
});

describe("createStayAwake (#364)", () => {
  it('mode "on" holds the blocker immediately', () => {
    const { blocker, stayAwake } = setup({ mode: "on" });
    assert.equal(blocker.count(), 1);
    assert.equal(stayAwake.getState().blocking, true);
    stayAwake.dispose();
  });

  it('mode "off" never blocks, even while working', () => {
    const { blocker, ctx, stayAwake } = setup({ mode: "off", working: true });
    assert.equal(blocker.count(), 0);
    ctx.working = true;
    stayAwake.evaluate();
    assert.equal(blocker.count(), 0);
    stayAwake.dispose();
  });

  it('mode "agent" follows the working state', () => {
    const { blocker, ctx, stayAwake } = setup({ mode: "agent" });
    assert.equal(blocker.count(), 0);
    ctx.working = true;
    stayAwake.evaluate();
    assert.equal(blocker.count(), 1);
    ctx.working = false;
    stayAwake.evaluate();
    assert.equal(blocker.count(), 0);
    stayAwake.dispose();
  });

  it("mode transitions re-evaluate", () => {
    const { blocker, ctx, stayAwake } = setup({ mode: "agent" });
    assert.equal(blocker.count(), 0);
    ctx.mode = "on";
    stayAwake.evaluate();
    assert.equal(blocker.count(), 1);
    ctx.mode = "off";
    stayAwake.evaluate();
    assert.equal(blocker.count(), 0);
    ctx.mode = "agent";
    stayAwake.evaluate();
    assert.equal(blocker.count(), 0);
    stayAwake.dispose();
  });

  it("battery cutoff suspends the blocker; AC resumes it", () => {
    const { blocker, monitor, stayAwake } = setup({ mode: "on" });
    assert.equal(blocker.count(), 1);
    monitor.battery = true;
    monitor.emit("on-battery");
    assert.equal(blocker.count(), 0);
    const s = stayAwake.getState();
    assert.equal(s.blocking, false);
    assert.equal(s.onBattery, true);
    monitor.battery = false;
    monitor.emit("on-ac");
    assert.equal(blocker.count(), 1);
    assert.equal(stayAwake.getState().blocking, true);
    stayAwake.dispose();
  });

  it("battery cutoff also applies in agent mode mid-run", () => {
    const { blocker, monitor, stayAwake } = setup({
      mode: "agent",
      working: true,
    });
    assert.equal(blocker.count(), 1);
    monitor.battery = true;
    monitor.emit("on-battery");
    assert.equal(blocker.count(), 0);
    monitor.battery = false;
    monitor.emit("on-ac");
    assert.equal(blocker.count(), 1);
    stayAwake.dispose();
  });

  it("starting on battery blocks nothing until AC", () => {
    const { blocker, monitor, stayAwake } = setup({
      mode: "on",
      onBattery: true,
    });
    assert.equal(blocker.count(), 0);
    monitor.battery = false;
    monitor.emit("on-ac");
    assert.equal(blocker.count(), 1);
    stayAwake.dispose();
  });

  it("onChange fires only on derived-state transitions", () => {
    const { changes, ctx, stayAwake } = setup({ mode: "agent" });
    // Initial evaluate inside createStayAwake reports the first state.
    assert.equal(changes.length, 1);
    stayAwake.evaluate(); // nothing moved: no echo
    assert.equal(changes.length, 1);
    ctx.working = true;
    stayAwake.evaluate();
    assert.equal(changes.length, 2);
    assert.equal(changes[1].blocking, true);
    assert.equal(changes[1].anyWorking, true);
    ctx.working = false;
    stayAwake.evaluate();
    assert.equal(changes.length, 3);
    assert.equal(changes[2].blocking, false);
    stayAwake.dispose();
  });

  it("junk mode from the store behaves as agent", () => {
    const { blocker, ctx, stayAwake } = setup({ mode: "junk" });
    assert.equal(blocker.count(), 0);
    assert.equal(stayAwake.getState().mode, "agent");
    ctx.working = true;
    stayAwake.evaluate();
    assert.equal(blocker.count(), 1);
    stayAwake.dispose();
  });

  it("dispose releases the blocker and unlistens", () => {
    const { blocker, monitor, stayAwake } = setup({ mode: "on" });
    assert.equal(blocker.count(), 1);
    stayAwake.dispose();
    assert.equal(blocker.count(), 0);
    assert.equal(monitor.listenerCount(), 0);
    // A power event after dispose must not resurrect the blocker.
    monitor.emit("on-ac");
    assert.equal(blocker.count(), 0);
  });
});
