/**
 * lazyNamed (#1475 finding 7): a lazy view mounted before its chunk loads keeps
 * its state once loaded, and a view whose chunk is loaded never suspends.
 *
 * Run: node --import=./test/support/render.mjs --test test/lazyNamed.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Suspense, useState } from "react";
import { inAct, mount } from "./support/dom.ts";
import { lazyNamed } from "../src/lazyNamed";

function Counter({ label }: { label: string }) {
  const [n, setN] = useState(0);
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      {label}:{n}
    </button>
  );
}

describe("lazyNamed", () => {
  it("keeps the first instance's state after the chunk resolves", async () => {
    let resolve!: (c: typeof Counter) => void;
    let View: ReturnType<typeof lazyNamed<{ label: string }>> | null = null;
    let bump!: () => void;
    function Parent() {
      const [tick, setTick] = useState(0);
      bump = () => setTick((t) => t + 1);
      if (!View) return null;
      return (
        <Suspense fallback={<i>loading</i>}>
          <View label={`t${tick}`} />
        </Suspense>
      );
    }
    const m = await mount(<Parent />);
    // Registered after mount() preloaded, so this one really suspends.
    View = lazyNamed(() => new Promise<typeof Counter>((r) => (resolve = r)));
    await inAct(() => bump());
    try {
      assert.equal(m.text(), "loading");
      await inAct(async () => resolve(Counter));
      await m.flush();
      assert.equal(m.text(), "t1:0");
      await inAct(() => (m.query("button") as HTMLElement).click());
      await inAct(() => bump());
      assert.equal(m.text(), "t2:1", "parent re-render must not remount it");
    } finally {
      m.unmount();
    }
  });

  it("renders a loaded chunk without suspending", async () => {
    const View = lazyNamed(async () => Counter);
    // mount() preloads every registered lazyNamed chunk first.
    let fallbacks = 0;
    function Fallback() {
      fallbacks += 1;
      return null;
    }
    const m = await mount(
      <Suspense fallback={<Fallback />}>
        <View label="ready" />
      </Suspense>,
    );
    try {
      assert.equal(m.text(), "ready:0");
      assert.equal(fallbacks, 0);
    } finally {
      m.unmount();
    }
  });
});
