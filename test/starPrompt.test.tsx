import assert from "node:assert/strict";
import { it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import { StarPromptToast } from "../src/components/StarPromptToast";

it("delays the star request until 20 minutes of foreground use and asks only once", async () => {
  let calls = 0;
  const claim = async () => { calls++; return true; };
  const m = await mount(<div />);
  let tick = () => {};
  let now = 0;
  let focused = true;
  const savedInterval = window.setInterval;
  const savedClear = window.clearInterval;
  const savedNow = performance.now;
  const savedFocus = document.hasFocus;
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  window.setInterval = ((fn: () => void) => { tick = fn; return 42; }) as typeof window.setInterval;
  window.clearInterval = () => {};
  performance.now = () => now;
  document.hasFocus = () => focused;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const advance = async (count: number) => {
    for (let i = 0; i < count; i++) await inAct(() => { now += 5000; tick(); });
  };
  try {
    await m.rerender(<StarPromptToast enabled blocked={false} claim={claim} />);
    assert.equal(calls, 0);
    focused = false;
    await advance(241);
    assert.equal(calls, 0, "background time does not qualify");
    focused = true;
    await advance(240);
    assert.equal(calls, 0, "still short of 20 minutes in foreground");
    await m.rerender(<StarPromptToast enabled blocked claim={claim} />);
    await advance(2);
    assert.equal(calls, 0, "active modal/toast blocks the prompt");
    await m.rerender(<StarPromptToast enabled blocked={false} claim={claim} />);
    await advance(1);
    assert.equal(calls, 1);
    assert.match(m.text(), /Enjoying Solenta/);
    await m.click(m.query('[aria-label="Dismiss star request"]'));
    assert.equal(m.query('[role="status"]'), null);
    await m.rerender(<StarPromptToast enabled={false} blocked={false} claim={claim} />);
    await m.rerender(<StarPromptToast enabled blocked={false} claim={claim} />);
    assert.equal(calls, 1);
  } finally {
    m.unmount();
    window.setInterval = savedInterval;
    window.clearInterval = savedClear;
    performance.now = savedNow;
    document.hasFocus = savedFocus;
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else delete (document as unknown as Record<string, unknown>).visibilityState;
  }
});
