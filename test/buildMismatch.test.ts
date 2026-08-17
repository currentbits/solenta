/**
 * Build-sha mismatch after an in-place update (#313).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBuildMismatch } from "../src/buildMismatch.ts";

describe("isBuildMismatch", () => {
  it("true only when both sides are set and differ", () => {
    assert.equal(isBuildMismatch("aaa", "bbb"), true);
  });

  it("false when both sides match", () => {
    assert.equal(isBuildMismatch("aaa", "aaa"), false);
    assert.equal(isBuildMismatch("deadbee+dirty", "deadbee+dirty"), false);
  });

  it("false when either side is missing (dev tree, test fake)", () => {
    assert.equal(isBuildMismatch(null, "aaa"), false);
    assert.equal(isBuildMismatch("aaa", null), false);
    assert.equal(isBuildMismatch(undefined, "aaa"), false);
    assert.equal(isBuildMismatch("aaa", undefined), false);
    assert.equal(isBuildMismatch("", "aaa"), false);
    assert.equal(isBuildMismatch("aaa", ""), false);
    assert.equal(isBuildMismatch(null, null), false);
    assert.equal(isBuildMismatch(undefined, undefined), false);
  });
});
