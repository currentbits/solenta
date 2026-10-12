import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectPrStacks, stackContaining } from "../src/prStack.ts";

describe("detectPrStacks", () => {
  it("walks a three-PR chain bottom-up", () => {
    const stacks = detectPrStacks([
      { number: 3, headRefName: "feat/top", baseRefName: "feat/mid", title: "top" },
      { number: 1, headRefName: "feat/bot", baseRefName: "main", title: "bot" },
      { number: 2, headRefName: "feat/mid", baseRefName: "feat/bot", title: "mid" },
      { number: 9, headRefName: "solo", baseRefName: "main", title: "alone" },
    ]);
    assert.equal(stacks.length, 1);
    assert.deepEqual(
      stacks[0]!.map((p) => p.number),
      [1, 2, 3],
    );
    assert.deepEqual(
      stackContaining(stacks, 2)?.map((p) => p.number),
      [1, 2, 3],
    );
  });

  it("ignores a cycle instead of looping", () => {
    const stacks = detectPrStacks([
      { number: 1, headRefName: "a", baseRefName: "b" },
      { number: 2, headRefName: "b", baseRefName: "a" },
    ]);
    assert.ok(stacks.length <= 1);
    if (stacks[0]) assert.ok(stacks[0].length >= 2);
  });
});
