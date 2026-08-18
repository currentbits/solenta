/**
 * Renderer quota-wait labels (#462).
 * Run: node --experimental-strip-types --test test/quotaWait.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatQuotaWaitLabel,
  isQuotaWaitStatus,
} from "../src/quotaWait.ts";

const NOW = new Date(2026, 7, 18, 10, 0, 0, 0).getTime();

describe("formatQuotaWaitLabel", () => {
  it("labels same-day, tomorrow, and weekday wakes", () => {
    assert.equal(
      formatQuotaWaitLabel(new Date(2026, 7, 18, 15, 0, 0, 0).getTime(), NOW),
      "3pm",
    );
    assert.equal(
      formatQuotaWaitLabel(new Date(2026, 7, 19, 9, 0, 0, 0).getTime(), NOW),
      "tomorrow 9am",
    );
    assert.match(
      formatQuotaWaitLabel(new Date(2026, 7, 20, 9, 30, 0, 0).getTime(), NOW),
      /9:30am/,
    );
  });
});

describe("isQuotaWaitStatus", () => {
  it("is only true for the explicit parked state", () => {
    assert.equal(isQuotaWaitStatus("quota-wait"), true);
    assert.equal(isQuotaWaitStatus("failed"), false);
    assert.equal(isQuotaWaitStatus("working"), false);
    assert.equal(isQuotaWaitStatus(null), false);
  });
});
