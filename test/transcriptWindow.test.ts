/**
 * Pure tail-window math for #564.
 * Run: node --experimental-strip-types --test test/transcriptWindow.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TRANSCRIPT_WINDOW,
  clampWindowStart,
  ensureVisibleStart,
  extendWindowStart,
  initialWindowStart,
} from "../src/transcriptWindow.ts";

describe("transcriptWindow", () => {
  it("starts at 0 when the timeline fits in one window", () => {
    assert.equal(initialWindowStart(0), 0);
    assert.equal(initialWindowStart(TRANSCRIPT_WINDOW), 0);
    assert.equal(initialWindowStart(TRANSCRIPT_WINDOW - 1), 0);
  });

  it("pins a long timeline to the last N entries", () => {
    assert.equal(initialWindowStart(500), 500 - TRANSCRIPT_WINDOW);
  });

  it("extends upward by one chunk without passing 0", () => {
    assert.equal(extendWindowStart(380), 260);
    assert.equal(extendWindowStart(80), 0);
    assert.equal(extendWindowStart(0), 0);
  });

  it("ensureVisible raises the window to include an earlier index", () => {
    assert.equal(ensureVisibleStart(380, 10), 10);
    assert.equal(ensureVisibleStart(380, 400), 380);
    assert.equal(ensureVisibleStart(380, -1), 380);
  });

  it("clamp resets a start that now sits past the timeline", () => {
    assert.equal(clampWindowStart(380, 500), 380);
    assert.equal(clampWindowStart(380, 10), 0);
    assert.equal(clampWindowStart(380, 0), 0);
  });
});
