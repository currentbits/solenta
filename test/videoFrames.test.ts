/**
 * Screen-recording frames (#266): which clips sample, when, and how the
 * frames are labelled. Decoding needs a real <video> (jsdom never loads one).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAt, frameTimes, isVideoName } from "../src/coder/videoFrames";

describe("video frames", () => {
  it("recognises recording containers only", () => {
    assert.ok(isVideoName("Screen Recording 2026-10-13.MOV"));
    assert.ok(isVideoName("demo.webm"));
    assert.equal(isVideoName("notes.txt"), false);
    assert.equal(isVideoName("mov"), false);
  });

  it("samples about once a second, capped at 8, centred in each slice", () => {
    assert.deepEqual(frameTimes(3), [0.5, 1.5, 2.5]);
    const long = frameTimes(80);
    assert.equal(long.length, 8);
    assert.equal(long[0], 5);
    assert.equal(long[7], 75);
    assert.deepEqual(frameTimes(Infinity), [0]);
    assert.deepEqual(frameTimes(Number.NaN), [0]);
  });

  it("formats timestamps as m:ss", () => {
    assert.equal(formatAt(3.7), "0:03");
    assert.equal(formatAt(75), "1:15");
  });
});
