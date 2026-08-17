/**
 * pairsForThread: which forecast pairs mention a given thread.
 * Run: node --experimental-strip-types --test test/conflictForecast.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pairsForThread } from "../src/conflictForecast.ts";
import type { ConflictForecast, ConflictPairInfo } from "../src/shared/ipc.ts";

function pair(
  over: Partial<ConflictPairInfo> &
    Pick<ConflictPairInfo, "threadA" | "threadB">,
): ConflictPairInfo {
  return {
    overlap: over.overlap ?? ["src/a.ts"],
    conflicts: over.conflicts ?? [],
    ...over,
  };
}

function forecast(pairs: ConflictPairInfo[]): ConflictForecast {
  return { pairs, computedAt: 1 };
}

describe("pairsForThread", () => {
  it("returns [] when the forecast is missing or empty", () => {
    assert.deepEqual(pairsForThread(undefined, "t1"), []);
    assert.deepEqual(pairsForThread(null, "t1"), []);
    assert.deepEqual(pairsForThread(forecast([]), "t1"), []);
  });

  it("keeps pairs where the thread is either side", () => {
    const a = pair({ threadA: "t1", threadB: "t2" });
    const b = pair({ threadA: "t3", threadB: "t1" });
    const other = pair({ threadA: "t2", threadB: "t3" });
    assert.deepEqual(pairsForThread(forecast([a, b, other]), "t1"), [a, b]);
  });

  it("returns [] when the thread is in no pair", () => {
    const only = pair({ threadA: "t2", threadB: "t3" });
    assert.deepEqual(pairsForThread(forecast([only]), "t1"), []);
  });
});
