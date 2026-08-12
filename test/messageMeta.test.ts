import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatClock,
  messageMetaLine,
  stripDurationPrefix,
} from "../src/messageMeta.ts";

// Local 9:15 PM on a fixed date; formatClock renders local time, so build the
// timestamp from local components instead of hardcoding an epoch.
const AT_9_15_PM = new Date(2026, 7, 12, 21, 15).getTime();

describe("formatClock", () => {
  it("renders 12-hour time with AM/PM", () => {
    assert.equal(formatClock(AT_9_15_PM), "9:15 PM");
    assert.equal(formatClock(new Date(2026, 7, 12, 0, 5).getTime()), "12:05 AM");
    assert.equal(formatClock(new Date(2026, 7, 12, 12, 0).getTime()), "12:00 PM");
  });
});

describe("stripDurationPrefix", () => {
  it("strips the WorkLog label prefix", () => {
    assert.equal(stripDurationPrefix("Worked for 1m 45s"), "1m 45s");
    assert.equal(stripDurationPrefix("Worked for 45s"), "45s");
  });

  it("passes through labels without the prefix", () => {
    assert.equal(stripDurationPrefix("11.6s"), "11.6s");
  });

  it("returns null for null, empty, and prefix-only input", () => {
    assert.equal(stripDurationPrefix(null), null);
    assert.equal(stripDurationPrefix(undefined), null);
    assert.equal(stripDurationPrefix(""), null);
    assert.equal(stripDurationPrefix("Worked for "), null);
  });
});

describe("messageMetaLine", () => {
  it("joins all segments with a middle dot", () => {
    assert.equal(
      messageMetaLine({
        createdAt: AT_9_15_PM,
        model: "Opus 5",
        effort: "high",
        duration: "Worked for 1m 45s",
      }),
      "Opus 5 · high · 1m 45s · 9:15 PM",
    );
  });

  it("always shows the time, even when nothing else is known", () => {
    assert.equal(messageMetaLine({ createdAt: AT_9_15_PM }), "9:15 PM");
  });

  it("omits null and empty segments", () => {
    assert.equal(
      messageMetaLine({
        createdAt: AT_9_15_PM,
        model: null,
        effort: "high",
        duration: null,
      }),
      "high · 9:15 PM",
    );
    assert.equal(
      messageMetaLine({ createdAt: AT_9_15_PM, model: "", effort: "" }),
      "9:15 PM",
    );
  });
});
