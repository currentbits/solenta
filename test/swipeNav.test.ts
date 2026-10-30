/**
 * Pure gesture math for trackpad swipe back/forward (#1752); see
 * threadHistory.test.tsx for the App-level wiring (⌘[/⌘], side buttons).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import {
  accumulateSwipe,
  hasHorizontalScrollAncestor,
  SWIPE_RESET_MS,
  SWIPE_THRESHOLD,
  type SwipeState,
} from "../src/swipeNav";

describe("accumulateSwipe", () => {
  const horiz = (deltaX: number) => ({ deltaX, deltaY: 0, ctrlKey: false });

  it("ignores vertical-dominant and ctrl (pinch-zoom) wheel events", () => {
    const r1 = accumulateSwipe(null, { deltaX: 200, deltaY: 300, ctrlKey: false }, 0);
    assert.equal(r1.commit, null);
    assert.equal(r1.state, null);
    const r2 = accumulateSwipe(null, { deltaX: -200, deltaY: 0, ctrlKey: true }, 0);
    assert.equal(r2.commit, null);
    assert.equal(r2.state, null);
  });

  it("accumulates across a gesture and commits back once past the threshold", () => {
    let state: SwipeState | null = null;
    let now = 0;
    const step = (dx: number) => {
      const r = accumulateSwipe(state, horiz(dx), now);
      state = r.state;
      now += 10;
      return r.commit;
    };
    assert.equal(step(-40), null);
    assert.equal(step(-40), null);
    assert.equal(step(-45), -1, "crossed -120 going negative: back");
    // Further events in the same gesture do not re-commit.
    assert.equal(step(-50), null);
  });

  it("commits forward on a positive run and resets after a quiet gap", () => {
    let state: SwipeState | null = null;
    let now = 0;
    const r1 = accumulateSwipe(state, horiz(SWIPE_THRESHOLD + 1), now);
    assert.equal(r1.commit, 1);
    state = r1.state;
    now += SWIPE_RESET_MS + 1;
    // New gesture after the gap: a small move alone should not re-commit.
    const r2 = accumulateSwipe(state, horiz(10), now);
    assert.equal(r2.commit, null);
    assert.equal(r2.state?.committed, false);
  });
});

describe("hasHorizontalScrollAncestor", () => {
  function install() {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.getComputedStyle = dom.window.getComputedStyle;
    return dom;
  }

  it("is false with no scrollable ancestor", () => {
    install();
    const div = document.createElement("div");
    document.body.appendChild(div);
    assert.equal(hasHorizontalScrollAncestor(div), false);
  });

  it("is true when an ancestor overflows and is set to scroll horizontally", () => {
    install();
    const outer = document.createElement("div");
    const inner = document.createElement("span");
    outer.appendChild(inner);
    document.body.appendChild(outer);
    outer.style.overflowX = "auto";
    Object.defineProperty(outer, "scrollWidth", { value: 800, configurable: true });
    Object.defineProperty(outer, "clientWidth", { value: 400, configurable: true });
    assert.equal(hasHorizontalScrollAncestor(inner), true);
  });

  it("ignores an overflowing ancestor whose overflow-x is not auto/scroll", () => {
    install();
    const outer = document.createElement("div");
    const inner = document.createElement("span");
    outer.appendChild(inner);
    document.body.appendChild(outer);
    Object.defineProperty(outer, "scrollWidth", { value: 800, configurable: true });
    Object.defineProperty(outer, "clientWidth", { value: 400, configurable: true });
    assert.equal(hasHorizontalScrollAncestor(inner), false);
  });
});
