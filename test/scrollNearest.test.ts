/**
 * Scroll a child inside its overflow box only.
 * Run: node --experimental-strip-types --test test/scrollNearest.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nearestScrollTop } from "../src/scrollNearest";

describe("nearestScrollTop", () => {
  it("leaves scrollTop when the child is already fully visible", () => {
    assert.equal(
      nearestScrollTop(
        { scrollTop: 80, clientHeight: 240 },
        { offsetTop: 100, offsetHeight: 40 },
      ),
      80,
    );
  });

  it("scrolls up when the child sits above the viewport", () => {
    assert.equal(
      nearestScrollTop(
        { scrollTop: 120, clientHeight: 240 },
        { offsetTop: 40, offsetHeight: 40 },
      ),
      40,
    );
  });

  it("scrolls down when the child sits below the viewport", () => {
    assert.equal(
      nearestScrollTop(
        { scrollTop: 0, clientHeight: 240 },
        { offsetTop: 280, offsetHeight: 40 },
      ),
      80,
    );
  });
});
