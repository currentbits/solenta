/**
 * Narrow-window drawer a11y (issue #219): real buttons, aria-expanded,
 * inert panes, Escape to close. The old checkbox/label hack is gone.
 *
 * Run: node --import=./test/support/render.mjs --test test/drawerA11y.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  restoreMatchMedia = stubNarrow();
  shell.unmount();
  return mount(<App />);
}

function stubNarrow(): () => void {
  const prev = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 900px"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;
  return () => {
    if (typeof prev === "function") window.matchMedia = prev;
    else delete (window as { matchMedia?: unknown }).matchMedia;
  };
}

let restoreMatchMedia: (() => void) | null = null;

afterEach(() => {
  restoreMatchMedia?.();
  restoreMatchMedia = null;
});

describe("narrow drawer a11y", () => {
  it("opens from a button, inerts the thread pane, and closes on Escape", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);

    const threads = m.query('[data-drawer-open="sidebar"]');
    assert.ok(threads, "Threads trigger missing");
    assert.equal(threads.tagName, "BUTTON");
    assert.equal(threads.getAttribute("aria-expanded"), "false");

    const sidebar = m.query('[data-pane="sidebar"]');
    const thread = m.query('[data-pane="thread"]');
    assert.ok(sidebar && thread, "panes missing");
    assert.ok(sidebar.hasAttribute("inert"), "closed sidebar must be inert");
    assert.ok(!thread.hasAttribute("inert"), "thread stays reachable when closed");

    await m.click(threads);
    assert.equal(threads.getAttribute("aria-expanded"), "true");
    assert.ok(!sidebar.hasAttribute("inert"), "open sidebar must lose inert");
    assert.ok(thread.hasAttribute("inert"), "thread must be inert while sidebar is open");

    await inAct(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    assert.equal(threads.getAttribute("aria-expanded"), "false");
    assert.ok(sidebar.hasAttribute("inert"), "Escape must close and re-inert sidebar");
    assert.ok(!thread.hasAttribute("inert"), "thread must be reachable after Escape");

    m.unmount();
  });
});
