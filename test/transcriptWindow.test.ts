/**
 * Pure tail-window math for #564.
 * Run: node --experimental-strip-types --test test/transcriptWindow.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TRANSCRIPT_CHAR_BUDGET,
  TRANSCRIPT_WINDOW,
  clampWindowStart,
  ensureVisibleStart,
  extendWindowStart,
  initialWindowStart,
  tailWindowStart,
} from "../src/transcriptWindow.ts";
import type { TimelineEntry } from "../src/timeline.ts";

const entries = (sizes: number[]): TimelineEntry[] =>
  sizes.map((n, i) => ({
    kind: "message",
    timestamp: i,
    message: { id: `m${i}`, role: "assistant", text: "x".repeat(n), createdAt: i },
  }));

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

  it("tail window stops at the character budget (#1475)", () => {
    // Six 45 KB streamed answers: a 120-entry window would mount all six.
    const big = entries([...Array(200).fill(10), ...Array(6).fill(45_000)]);
    const start = tailWindowStart(big);
    assert.equal(big.length - start, Math.floor(TRANSCRIPT_CHAR_BUDGET / 45_000));
  });

  it("tail window keeps the count cap for small entries and always the last entry", () => {
    assert.equal(tailWindowStart(entries(Array(500).fill(10))), 500 - TRANSCRIPT_WINDOW);
    assert.equal(tailWindowStart(entries(Array(40).fill(10))), 0);
    const huge = entries([10, 10, TRANSCRIPT_CHAR_BUDGET * 3]);
    assert.equal(tailWindowStart(huge), 2);
  });
});
