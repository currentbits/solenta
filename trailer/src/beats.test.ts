import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BEATS, TOTAL_FRAMES } from "./beats.ts";

describe("beats", () => {
  it("sums to 960 frames", () => {
    const sum = Object.values(BEATS).reduce((n, b) => n + b.durationInFrames, 0);
    assert.equal(sum, 960);
    assert.equal(TOTAL_FRAMES, 960);
  });

  it("starts each beat where the previous ends", () => {
    let cursor = 0;
    for (const beat of Object.values(BEATS)) {
      assert.equal(beat.from, cursor);
      cursor += beat.durationInFrames;
    }
    assert.equal(cursor, 960);
  });
});
