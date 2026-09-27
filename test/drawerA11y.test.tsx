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

  it("closes the sidebar drawer after a destination, and Escape closes More first", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    const threads = m.query('[data-drawer-open="sidebar"]') as HTMLElement;
    const sidebar = m.query('[data-pane="sidebar"]');
    assert.ok(threads && sidebar);

    await m.click(threads);
    await m.click(m.query('[data-view-nav="planboard"]') as HTMLElement);
    assert.equal(threads.getAttribute("aria-expanded"), "false");
    assert.ok(sidebar.hasAttribute("inert"), "Planboard closes the drawer");
    assert.ok(m.query("[data-planboard]"));

    await m.click(threads);
    await m.click(m.query("[data-app-more]") as HTMLElement);
    assert.ok(m.query("[data-app-more-menu]"));
    const focused = m.container.ownerDocument.activeElement as HTMLElement;
    await m.press(focused, "Escape");
    assert.equal(m.query("[data-app-more-menu]"), null, "Escape closes More");
    assert.equal(
      threads.getAttribute("aria-expanded"),
      "true",
      "the drawer stays open until a second Escape",
    );
    await m.press(m.query("[data-app-more]") as HTMLElement, "Escape");
    assert.equal(threads.getAttribute("aria-expanded"), "false");

    await m.click(threads);
    await m.click(m.query("[data-app-more]") as HTMLElement);
    await m.click(
      m.query('[data-app-more-menu] [data-view-nav="usage"]') as HTMLElement,
    );
    assert.equal(threads.getAttribute("aria-expanded"), "false");
    assert.ok(sidebar.hasAttribute("inert"));
    assert.ok(m.query("[data-usage]"));

    m.unmount();
  });

  it("closes More when keyboard focus leaves, then Escape closes the drawer second", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    const drawerBtn = m.query('[data-drawer-open="sidebar"]') as HTMLElement;
    assert.ok(drawerBtn);

    await m.click(drawerBtn);
    await m.click(m.query("[data-app-more]") as HTMLElement);
    assert.ok(m.query("[data-app-more-menu]"));

    const outside = m.query('[data-view-nav="review"]') as HTMLElement;
    assert.ok(outside);
    await inAct(() => {
      outside.focus();
    });
    assert.equal(
      m.query("[data-app-more-menu]"),
      null,
      "moving focus out of More closes it",
    );
    assert.equal(drawerBtn.getAttribute("aria-expanded"), "true");
    assert.equal(
      m.container.ownerDocument.activeElement,
      outside,
      "keyboard exit leaves focus on the target",
    );

    await m.click(m.query("[data-app-more]") as HTMLElement);
    assert.ok(m.query("[data-app-more-menu]"), "More reopens");
    const focused = m.container.ownerDocument.activeElement as HTMLElement;
    await m.press(focused, "Escape");
    assert.equal(m.query("[data-app-more-menu]"), null);
    assert.equal(
      drawerBtn.getAttribute("aria-expanded"),
      "true",
      "Escape closes More before the drawer",
    );
    await m.press(m.query("[data-app-more]") as HTMLElement, "Escape");
    assert.equal(drawerBtn.getAttribute("aria-expanded"), "false");

    m.unmount();
  });
});
