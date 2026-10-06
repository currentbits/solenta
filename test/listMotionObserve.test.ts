/**
 * auto-animate re-observes rows from a timer that can fire after the row was
 * removed; a document-rooted observer on a detached row leaks it (#1475).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { skipDetachedObserve } from "../src/components/sidebar/motion";

describe("skipDetachedObserve", () => {
  it("drops observe() on a detached target and keeps connected ones", () => {
    const observed: unknown[] = [];
    class FakeIO {
      observe(target: unknown) {
        observed.push(target);
      }
    }
    const IO = FakeIO as unknown as { prototype: IntersectionObserver };
    skipDetachedObserve(IO);
    skipDetachedObserve(IO); // idempotent: no double wrap
    const io = new FakeIO() as unknown as IntersectionObserver;
    const detached = { isConnected: false } as Element;
    const connected = { isConnected: true } as Element;
    io.observe(detached);
    io.observe(connected);
    assert.deepEqual(observed, [connected]);
  });

  it("is a no-op without IntersectionObserver", () => {
    assert.doesNotThrow(() => skipDetachedObserve(undefined));
  });
});
