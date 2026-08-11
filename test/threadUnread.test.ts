/**
 * Pure unread predicate (round 43).
 * Run: node --experimental-strip-types --test test/threadUnread.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countUnread, isUnread } from "../src/threadUnread.ts";

describe("isUnread", () => {
  it("table: unread when updatedAt > lastVisitedAt", () => {
    assert.equal(
      isUnread({ updatedAt: 100, lastVisitedAt: 50 }),
      true,
      "activity after visit → unread",
    );
  });

  it("table: visited when lastVisitedAt >= updatedAt", () => {
    assert.equal(
      isUnread({ updatedAt: 100, lastVisitedAt: 100 }),
      false,
      "exact equality is visited (boundary)",
    );
    assert.equal(
      isUnread({ updatedAt: 100, lastVisitedAt: 150 }),
      false,
      "visited after last activity",
    );
  });

  it("table: legacy null is NOT unread", () => {
    assert.equal(
      isUnread({ updatedAt: 999, lastVisitedAt: null }),
      false,
      "contract: null lastVisitedAt = legacy = not unread",
    );
  });
});

describe("countUnread", () => {
  it("counts only true isUnread rows", () => {
    assert.equal(
      countUnread([
        { updatedAt: 10, lastVisitedAt: 1 },
        { updatedAt: 10, lastVisitedAt: 10 },
        { updatedAt: 10, lastVisitedAt: null },
        { updatedAt: 20, lastVisitedAt: 5 },
      ]),
      2,
    );
  });
});
