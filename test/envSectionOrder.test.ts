/**
 * Environment section order: merge, move, persistence.
 *
 * Run: node --experimental-strip-types --test test/envSectionOrder.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ENV_ORDER_KEY,
  ENV_SECTION_IDS,
  getEnvSectionOrder,
  isDefaultEnvSectionOrder,
  mergeEnvSectionOrder,
  moveEnvSection,
  moveEnvSectionAmong,
  reloadEnvSectionOrder,
  resetEnvSectionOrder,
  setEnvSectionOrder,
} from "../src/envSectionOrder.ts";

const CANON = ["a", "b", "c", "d"] as const;

afterEach(() => {
  resetEnvSectionOrder();
  try {
    globalThis.window?.localStorage?.removeItem(ENV_ORDER_KEY);
  } catch {
    // node without jsdom, or storage disabled
  }
  reloadEnvSectionOrder();
});

describe("mergeEnvSectionOrder", () => {
  it("returns the canonical list when saved is missing or empty", () => {
    assert.deepEqual(mergeEnvSectionOrder(null, CANON), ["a", "b", "c", "d"]);
    assert.deepEqual(mergeEnvSectionOrder(undefined, CANON), [
      "a",
      "b",
      "c",
      "d",
    ]);
    assert.deepEqual(mergeEnvSectionOrder([], CANON), ["a", "b", "c", "d"]);
  });

  it("drops unknown and duplicate ids, keeps a valid permutation", () => {
    assert.deepEqual(
      mergeEnvSectionOrder(["c", "nope", "a", "c", 1, "b"], CANON),
      ["c", "a", "b", "d"],
    );
  });

  it("appends newly introduced canonical ids after the saved prefix", () => {
    assert.deepEqual(mergeEnvSectionOrder(["b", "a"], CANON), [
      "b",
      "a",
      "c",
      "d",
    ]);
  });

  it("retains ids that are only temporarily hidden from the UI", () => {
    assert.deepEqual(mergeEnvSectionOrder(["d", "a", "b", "c"], CANON), [
      "d",
      "a",
      "b",
      "c",
    ]);
  });

  it("treats a non-array payload as empty", () => {
    assert.deepEqual(mergeEnvSectionOrder({ order: ["b"] }, CANON), [
      "a",
      "b",
      "c",
      "d",
    ]);
    assert.deepEqual(mergeEnvSectionOrder("b,a", CANON), ["a", "b", "c", "d"]);
  });
});

describe("moveEnvSection", () => {
  it("inserts before or after a target and leaves hidden ids in place", () => {
    const order = ["hidden", "a", "b", "c"];
    assert.deepEqual(moveEnvSection(order, "c", "a", "before"), [
      "hidden",
      "c",
      "a",
      "b",
    ]);
    assert.deepEqual(moveEnvSection(order, "a", "c", "after"), [
      "hidden",
      "b",
      "c",
      "a",
    ]);
  });

  it("is a no-op when the ids are missing or the same", () => {
    const order = ["a", "b", "c"];
    assert.deepEqual(moveEnvSection(order, "a", "a", "before"), [
      "a",
      "b",
      "c",
    ]);
    assert.deepEqual(moveEnvSection(order, "z", "a", "before"), [
      "a",
      "b",
      "c",
    ]);
  });
});

describe("moveEnvSectionAmong", () => {
  it("moves within the visible list without promoting hidden neighbors", () => {
    const order = ["scm", "display", "hidden", "changes", "pull"];
    const visible = ["display", "changes", "pull"];
    assert.deepEqual(moveEnvSectionAmong(order, visible, "display", 1), [
      "scm",
      "hidden",
      "changes",
      "display",
      "pull",
    ]);
    assert.deepEqual(moveEnvSectionAmong(order, visible, "pull", -1), [
      "scm",
      "display",
      "hidden",
      "pull",
      "changes",
    ]);
    assert.equal(moveEnvSectionAmong(order, visible, "display", -1), null);
    assert.equal(moveEnvSectionAmong(order, visible, "pull", 1), null);
  });
});

describe("reset", () => {
  it("restore the canonical order after a partial permutation", () => {
    setEnvSectionOrder(["editor", "changes"]);
    assert.equal(isDefaultEnvSectionOrder(getEnvSectionOrder()), false);
    resetEnvSectionOrder();
    assert.ok(isDefaultEnvSectionOrder(getEnvSectionOrder()));
  });
});
