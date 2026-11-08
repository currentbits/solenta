"use strict";

/**
 * Readiness is allowed before background execution. A normal server update
 * keeps its marker until the new process has proved identity and build; an
 * explicit maintenance trial never activates. Poll only while waiting, with
 * no watcher left behind once the marker is released.
 */
function createActivationGate({ blocked = () => false, maintenance = false, intervalMs = 100, schedule = setTimeout, unschedule = clearTimeout, onError = () => {} } = {}) {
  let state = "pending";
  let started = false;
  let timer = null;
  let draining = null;
  const tasks = [];
  const controller = new AbortController();
  const context = { signal: controller.signal, isActive: () => state === "active" };

  function drain() {
    if (draining || state !== "active") return;
    draining = (async () => {
      while (state === "active" && tasks.length) {
        const { name, run } = tasks.shift();
        try { await run(context); } catch (error) { onError(name, error); }
      }
    })().finally(() => {
      draining = null;
      if (state === "active" && tasks.length) drain();
    });
  }
  function check() {
    timer = null;
    if (!started || state === "cancelled" || maintenance) return;
    let waiting;
    try { waiting = blocked(); }
    catch (error) { waiting = true; onError("activation marker", error); }
    if (!waiting) { state = "active"; drain(); return; }
    state = "waiting";
    timer = schedule(check, intervalMs);
    timer?.unref?.();
  }
  return {
    defer(name, run) {
      if (state === "cancelled") return;
      tasks.push({ name, run });
      drain();
    },
    start() {
      if (started || state === "cancelled") return;
      started = true;
      check();
    },
    cancel() {
      if (state === "cancelled") return;
      state = "cancelled";
      tasks.length = 0;
      if (timer !== null) unschedule(timer);
      timer = null;
      controller.abort();
    },
    state: () => state,
    whenIdle: () => draining || Promise.resolve(),
  };
}
module.exports = { createActivationGate };
