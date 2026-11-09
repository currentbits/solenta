"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const { createActivationGate } = require("../server/activationGate.js");
function fixture(options = {}) {
  const timers = new Map(); let id = 0;
  const gate = createActivationGate({
    schedule: (fn) => { const timer = { id: ++id, unref() {} }; timers.set(timer, fn); return timer; },
    unschedule: (timer) => timers.delete(timer), ...options,
  });
  return { gate, timers, tick() { const pending = [...timers]; timers.clear(); for (const [, fn] of pending) fn(); } };
}
it("keeps readiness independent from marked startup, then activates every task once", async () => {
  let marker = true; const order = [];
  const f = fixture({ blocked: () => marker });
  f.gate.defer("cleanup", () => order.push("cleanup"));
  f.gate.defer("scheduler", () => order.push("scheduler"));
  f.gate.start();
  assert.equal(f.gate.state(), "waiting"); assert.deepEqual(order, []); assert.equal(f.timers.size, 1);
  f.tick(); assert.deepEqual(order, []); assert.equal(f.timers.size, 1);
  marker = false; f.tick(); await f.gate.whenIdle();
  assert.deepEqual(order, ["cleanup", "scheduler"]); assert.equal(f.timers.size, 0);
  f.gate.start(); f.tick(); await f.gate.whenIdle();
  assert.deepEqual(order, ["cleanup", "scheduler"]);
});
it("unmarked startup activates without leaving a watcher", async () => {
  const f = fixture(); let started = 0;
  f.gate.defer("memory", () => started++); f.gate.start(); await f.gate.whenIdle();
  assert.equal(started, 1); assert.equal(f.timers.size, 0); assert.equal(f.gate.state(), "active");
});
it("an explicit maintenance trial never activates even after its marker disappears", async () => {
  let marker = true; const f = fixture({ maintenance: true, blocked: () => marker });
  f.gate.defer("work", () => assert.fail("a trial cannot activate")); f.gate.start();
  marker = false; f.tick(); await f.gate.whenIdle();
  assert.notEqual(f.gate.state(), "active"); assert.equal(f.timers.size, 0);
});
it("shutdown cancels a pending gate and removes its only timer", async () => {
  const f = fixture({ blocked: () => true });
  f.gate.defer("work", () => assert.fail("cancelled startup cannot activate")); f.gate.start();
  const staleTick = [...f.timers.values()][0];
  f.gate.cancel(); assert.equal(f.timers.size, 0);
  staleTick(); f.gate.start(); await f.gate.whenIdle();
  assert.equal(f.gate.state(), "cancelled"); assert.equal(f.timers.size, 0);
});
it("cancellation fences async activation continuations and later callbacks", async () => {
  const f = fixture(); let release; let context; const order = [];
  f.gate.defer("path", async (ctx) => { context = ctx; await new Promise((r) => { release = r; }); if (ctx.isActive()) order.push("provider setup"); });
  f.gate.defer("scheduler", () => order.push("scheduler"));
  f.gate.start(); f.gate.cancel(); release(); await f.gate.whenIdle();
  assert.deepEqual(order, []); assert.equal(context.signal.aborted, true);
});
it("one failed background service does not suppress the remaining activation callbacks", async () => {
  const errors = []; const f = fixture({ onError: (name, error) => errors.push([name, error.message]) });
  const order = [];
  f.gate.defer("bad", () => { throw new Error("unavailable"); }); f.gate.defer("good", () => order.push("good"));
  f.gate.start(); await f.gate.whenIdle();
  assert.deepEqual(errors, [["bad", "unavailable"]]); assert.deepEqual(order, ["good"]);
});
it("an unreadable activation marker fails closed and can recover on a later poll", async () => {
  let readable = false; const f = fixture({ blocked: () => { if (!readable) throw new Error("permission denied"); return false; } });
  let started = false; f.gate.defer("work", () => { started = true; }); f.gate.start();
  assert.equal(started, false); readable = true; f.tick(); await f.gate.whenIdle();
  assert.equal(started, true); assert.equal(f.timers.size, 0);
});
