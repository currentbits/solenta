"use strict";

// createIOSSimulatorService seam: device input over the helper — tap, swipe,
// text, hardware buttons, raw input events, the accessibility tree and
// scrollTo (#1447 pass V2, seam 7). Convention: see the header of
// electron/runner-watchdogs.js; plan:
// docs/superpowers/specs/2026-10-05-ios-simulator-split.md.

const { iosError } = require("./ios-simulator-parse.js");

const TAP_HOLD_MS = 50;
const SWIPE_MIN_DURATION_MS = 50;
const SWIPE_MAX_DURATION_MS = 2000;
const SWIPE_MAX_MOVES = 16;
const TYPE_TEXT_MAX_BYTES = 4096;
const COORD_ABS_MAX = 1e6;
const HARDWARE_BUTTONS = new Set([
  "home",
  "lock",
  "volumeUp",
  "volumeDown",
  "action",
  "shake",
]);
const SIMULATOR_KEY_USAGE = Object.freeze({
  enter: 0x28,
  escape: 0x29,
  backspace: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  delete: 0x4c,
  pageUp: 0x4b,
  pageDown: 0x4e,
  home: 0x4a,
  end: 0x4d,
  arrowRight: 0x4f,
  arrowLeft: 0x50,
  arrowDown: 0x51,
  arrowUp: 0x52,
});

function requireCoord(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw iosError("unexpected", `Simulator ${label} is invalid`);
  }
  if (Math.abs(value) > COORD_ABS_MAX) {
    throw iosError("unexpected", `Simulator ${label} is invalid`);
  }
  return value;
}

/**
 * @param {object} ctx - createIOSSimulatorService context
 */
function createInput(ctx) {
  const {
    mutate,
    withHelper,
    assertHelperSession,
    touchLeaseActivityBestEffort,
    delay,
    helperRpcWithSession,
  } = ctx;

  async function tap(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const x = requireCoord(input && input.x, "x");
    const y = requireCoord(input && input.y, "y");
    return mutate(async () => {
      await withHelper(threadId, generation, async (session) => {
        await helperRpcWithSession(session, "touch", {
          phase: "down",
          x,
          y,
          pointerId: 1,
        });
        await delay(TAP_HOLD_MS);
        assertHelperSession(threadId, generation, session);
        await helperRpcWithSession(session, "touch", {
          phase: "up",
          x,
          y,
          pointerId: 1,
        });
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ ok: true });
    });
  }

  async function swipe(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const x1 = requireCoord(input && input.x1, "x1");
    const y1 = requireCoord(input && input.y1, "y1");
    const x2 = requireCoord(input && input.x2, "x2");
    const y2 = requireCoord(input && input.y2, "y2");
    let durationMs = input && input.durationMs;
    if (durationMs == null) durationMs = 200;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
      throw iosError("unexpected", "Simulator swipe duration is invalid");
    }
    durationMs = Math.min(
      SWIPE_MAX_DURATION_MS,
      Math.max(SWIPE_MIN_DURATION_MS, durationMs),
    );
    const moves = Math.min(
      SWIPE_MAX_MOVES,
      Math.max(1, Math.round(durationMs / 40)),
    );
    return mutate(async () => {
      await withHelper(threadId, generation, async (session) => {
        await helperRpcWithSession(session, "touch", {
          phase: "down",
          x: x1,
          y: y1,
          pointerId: 1,
        });
        for (let i = 1; i <= moves; i += 1) {
          const t = i / (moves + 1);
          assertHelperSession(threadId, generation, session);
          await helperRpcWithSession(session, "touch", {
            phase: "move",
            x: x1 + (x2 - x1) * t,
            y: y1 + (y2 - y1) * t,
            pointerId: 1,
          });
        }
        assertHelperSession(threadId, generation, session);
        await helperRpcWithSession(session, "touch", {
          phase: "up",
          x: x2,
          y: y2,
          pointerId: 1,
        });
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ ok: true });
    });
  }

  async function typeText(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const text = input && input.text;
    if (typeof text !== "string") {
      throw iosError("unexpected", "Simulator text is invalid");
    }
    if (Buffer.byteLength(text, "utf8") > TYPE_TEXT_MAX_BYTES) {
      throw iosError("unexpected", "Simulator text is too long");
    }
    return mutate(async () => {
      await withHelper(threadId, generation, async (session) => {
        await helperRpcWithSession(session, "text", { text });
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ ok: true });
    });
  }

  async function pressButton(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const button = input && input.button;
    if (!HARDWARE_BUTTONS.has(button)) {
      throw iosError("unexpected", "Simulator hardware button is invalid");
    }
    return mutate(async () => {
      await withHelper(threadId, generation, async (session) => {
        await helperRpcWithSession(session, "pressButton", { button });
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ ok: true });
    });
  }

  async function sendInput(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const event = input && input.input;
    if (!event || typeof event !== "object") {
      throw iosError("unexpected", "Simulator input is invalid");
    }
    if (event.kind === "touch") {
      const x = requireCoord(event.x, "x");
      const y = requireCoord(event.y, "y");
      if (event.phase !== "down" && event.phase !== "move" && event.phase !== "up") {
        throw iosError("unexpected", "Simulator input is invalid");
      }
      if (typeof event.pointerId !== "number" || !Number.isFinite(event.pointerId)) {
        throw iosError("unexpected", "Simulator input is invalid");
      }
      return mutate(async () => {
        await withHelper(threadId, generation, async (session) => {
          await helperRpcWithSession(session, "touch", {
            phase: event.phase,
            x,
            y,
            pointerId: event.pointerId,
          });
        });
        await touchLeaseActivityBestEffort();
        return Object.freeze({ ok: true });
      });
    }
    if (event.kind === "text") {
      return typeText({ threadId, generation, text: event.text });
    }
    if (event.kind === "key") {
      const usage = SIMULATOR_KEY_USAGE[event.key];
      if (usage == null) {
        throw iosError("unexpected", "Simulator key is invalid");
      }
      if (event.phase !== "down" && event.phase !== "up") {
        throw iosError("unexpected", "Simulator input is invalid");
      }
      return mutate(async () => {
        await withHelper(threadId, generation, async (session) => {
          await helperRpcWithSession(session, "key", {
            usage,
            down: event.phase === "down",
            modifiers: 0,
          });
        });
        await touchLeaseActivityBestEffort();
        return Object.freeze({ ok: true });
      });
    }
    if (event.kind === "button") {
      return pressButton({ threadId, generation, button: event.button });
    }
    throw iosError("unexpected", "Simulator input is invalid");
  }

  async function accessibility(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const maxDepth = input && input.maxDepth;
    return mutate(async () => {
      const result = await withHelper(threadId, generation, async (session) => {
        return helperRpcWithSession(session, "accessibility", {
          maxDepth: maxDepth == null ? 8 : maxDepth,
        });
      });
      await touchLeaseActivityBestEffort();
      return result;
    });
  }

  async function scrollTo(input) {
    const threadId = input && input.threadId;
    const generation = input && input.generation;
    const x = requireCoord(input && input.x, "x");
    const y = requireCoord(input && input.y, "y");
    const dx = input && input.dx != null ? requireCoord(input.dx, "dx") : 0;
    const dy = input && input.dy != null ? requireCoord(input.dy, "dy") : 0;
    return mutate(async () => {
      await withHelper(threadId, generation, async (session) => {
        await helperRpcWithSession(session, "scrollTo", { x, y, dx, dy });
      });
      await touchLeaseActivityBestEffort();
      return Object.freeze({ ok: true });
    });
  }

  return {
    tap,
    swipe,
    typeText,
    pressButton,
    sendInput,
    accessibility,
    scrollTo,
  };
}

module.exports = { createInput };
