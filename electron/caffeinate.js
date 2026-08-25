"use strict";

/**
 * Stay-awake control (issue #364, item 5): hold a
 * powerSaveBlocker('prevent-app-suspension') while the mode calls for it,
 * never on battery power.
 *
 * Three modes (settings.stayAwake):
 *   "on"    — block always (except on battery).
 *   "agent" — block only while at least one thread is working (default).
 *   "off"   — never block.
 *
 * Deps are injected so the module is unit-testable without Electron:
 * powerSaveBlocker / powerMonitor come from the electron import in main.js,
 * getMode / isAnyWorking read the store. Re-evaluate on every relevant
 * event: mode change (ipc settings:set), thread status change (runner
 * push), power source change (powerMonitor events, wired here).
 */

/** @typedef {"agent" | "on" | "off"} StayAwakeMode */

/**
 * @typedef {object} StayAwakeState
 * @property {StayAwakeMode} mode
 * @property {boolean} blocking  blocker currently held
 * @property {boolean} onBattery machine on battery power right now
 * @property {boolean} anyWorking at least one thread status is "working"
 */

/**
 * Junk mode heals to "agent" (the default) rather than "off": a corrupt
 * setting must not silently let the machine sleep mid-run.
 * @param {unknown} raw
 * @returns {StayAwakeMode}
 */
function normalizeStayAwakeMode(raw) {
  return raw === "on" || raw === "off" || raw === "agent" ? raw : "agent";
}

/**
 * @param {object} deps
 * @param {{ start: (type: string) => number, stop: (id: number) => void, isStarted: (id: number) => boolean }} deps.powerSaveBlocker
 * @param {{ isOnBatteryPower: () => boolean, on: (event: string, cb: () => void) => void, removeListener: (event: string, cb: () => void) => void }} deps.powerMonitor
 * @param {() => unknown} deps.getMode raw mode source (store settings)
 * @param {() => boolean} deps.isAnyWorking true while any thread is working
 * @param {(state: StayAwakeState) => void} [deps.onChange] fired when the
 *   derived state flips (mode, blocking, onBattery, or anyWorking)
 */
function createStayAwake(deps) {
  const { powerSaveBlocker, powerMonitor, getMode, isAnyWorking } = deps;
  const onChange = typeof deps.onChange === "function" ? deps.onChange : null;

  /** @type {number | null} */
  let blockerId = null;
  /** @type {StayAwakeState | null} */
  let last = null;

  /** @returns {StayAwakeState} */
  function getState() {
    const mode = normalizeStayAwakeMode(getMode());
    const onBattery = powerMonitor.isOnBatteryPower() === true;
    const anyWorking = isAnyWorking() === true;
    const blocking =
      blockerId != null && powerSaveBlocker.isStarted(blockerId);
    return { mode, blocking, onBattery, anyWorking };
  }

  /**
   * Recompute and start/stop the blocker. Idempotent; safe to call on every
   * status tick. Fires onChange only when the derived state actually moved.
   * @returns {StayAwakeState}
   */
  function evaluate() {
    const mode = normalizeStayAwakeMode(getMode());
    const onBattery = powerMonitor.isOnBatteryPower() === true;
    const anyWorking = isAnyWorking() === true;
    const want =
      mode !== "off" && !onBattery && (mode === "on" || anyWorking);
    if (want && blockerId == null) {
      blockerId = powerSaveBlocker.start("prevent-app-suspension");
    } else if (!want && blockerId != null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
    const state = getState();
    if (
      onChange &&
      (!last ||
        last.mode !== state.mode ||
        last.blocking !== state.blocking ||
        last.onBattery !== state.onBattery ||
        last.anyWorking !== state.anyWorking)
    ) {
      onChange(state);
    }
    last = state;
    return state;
  }

  const onPowerChange = () => evaluate();
  powerMonitor.on("on-battery", onPowerChange);
  powerMonitor.on("on-ac", onPowerChange);

  function dispose() {
    powerMonitor.removeListener("on-battery", onPowerChange);
    powerMonitor.removeListener("on-ac", onPowerChange);
    if (blockerId != null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
  }

  evaluate();
  return { evaluate, getState, dispose };
}

module.exports = { createStayAwake, normalizeStayAwakeMode };
