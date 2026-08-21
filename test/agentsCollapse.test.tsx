/**
 * Wide-window Agents panel collapse (issue #645).
 *
 * Run: node --import=./test/support/render.mjs --test test/agentsCollapse.test.tsx
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

const COLLAPSED_KEY = "coder.agents.collapsed";

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
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

function dispatchModPeriod() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: ".",
      bubbles: true,
      cancelable: true,
      metaKey: true,
    }),
  );
}

let restoreMatchMedia: (() => void) | null = null;

afterEach(() => {
  restoreMatchMedia?.();
  restoreMatchMedia = null;
  try {
    window.localStorage?.removeItem(COLLAPSED_KEY);
  } catch {
    // jsdom not installed yet
  }
});

describe("wide agents panel collapse (#645)", () => {
  it("hides the panel on click and restores it from the rail", async () => {
    const m = await boot(createFakeCoder());
    try {
      const collapse = m.query("[data-agents-collapse]");
      assert.ok(collapse, "wide layout must offer a Hide agents control");
      assert.equal(collapse.tagName, "BUTTON");
      assert.equal(collapse.getAttribute("aria-expanded"), "true");
      assert.ok(
        m.query('[data-panel-tab="pulse"]'),
        "Agents tabs must be visible while expanded",
      );

      await m.click(collapse);

      assert.ok(
        !m.query('[data-panel-tab="pulse"]'),
        "collapsing must hide the Agents tabs",
      );
      assert.equal(
        m.query('[data-layout="app"]')?.getAttribute("data-agents-collapsed"),
        "true",
        "app root records the collapsed rail",
      );
      const expand = m.query("[data-agents-expand]");
      assert.ok(expand, "collapsed rail must offer Show agents");
      assert.equal(expand.tagName, "BUTTON");
      assert.equal(expand.getAttribute("aria-expanded"), "false");

      await m.click(expand);
      assert.ok(
        m.query('[data-panel-tab="pulse"]'),
        "expand must bring the Agents tabs back",
      );
      assert.ok(
        !m.query("[data-agents-expand]"),
        "expand control leaves once the panel is open",
      );
    } finally {
      m.unmount();
    }
  });

  it("persists collapsed across remount", async () => {
    const fake = createFakeCoder();
    const first = await boot(fake);
    try {
      const collapse = first.query("[data-agents-collapse]");
      assert.ok(collapse);
      await first.click(collapse);
      assert.equal(window.localStorage.getItem(COLLAPSED_KEY), "1");
    } finally {
      first.unmount();
    }

    const second = await boot(fake);
    try {
      assert.equal(
        second
          .query('[data-layout="app"]')
          ?.getAttribute("data-agents-collapsed"),
        "true",
        "a later mount must restore the stored collapse",
      );
      assert.ok(
        !second.query('[data-panel-tab="pulse"]'),
        "restored collapse must not show Agents tabs",
      );
      assert.ok(second.query("[data-agents-expand]"));
    } finally {
      second.unmount();
    }
  });

  it("⌘. toggles even while the composer is focused", async () => {
    const m = await boot(createFakeCoder());
    try {
      const composer = m.query("textarea");
      assert.ok(composer, "composer must exist so we can prove the chord wins");
      await inAct(() => {
        (composer as HTMLTextAreaElement).focus();
      });
      await inAct(() => dispatchModPeriod());
      await m.flush();
      assert.equal(
        m.query('[data-layout="app"]')?.getAttribute("data-agents-collapsed"),
        "true",
        "⌘. must collapse even from the composer",
      );
      await inAct(() => dispatchModPeriod());
      await m.flush();
      assert.ok(
        m.query('[data-panel-tab="pulse"]'),
        "second ⌘. must expand again",
      );
    } finally {
      m.unmount();
    }
  });

  it("keyboard sheet lists the agents-panel chord", async () => {
    const m = await boot(createFakeCoder());
    try {
      await inAct(() => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "?",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await m.flush();
      const sheet = m.query("[data-keyboard-sheet]");
      assert.ok(sheet, "? opens the keyboard sheet");
      const text = sheet!.textContent || "";
      assert.match(text, /⌘ \+ \./);
      assert.match(text, /agents panel/i);
    } finally {
      m.unmount();
    }
  });
});

describe("narrow agents drawer is unchanged (#645)", () => {
  it("does not show a collapse control; ⌘. opens the agents drawer", async () => {
    restoreMatchMedia = stubNarrow();
    const m = await boot(createFakeCoder());
    try {
      assert.ok(
        !m.query("[data-agents-collapse]"),
        "narrow already uses the Agents drawer — no second collapse button",
      );
      const agentsOpen = m.query('[data-drawer-open="agents"]');
      assert.ok(agentsOpen);
      assert.equal(agentsOpen.getAttribute("aria-expanded"), "false");

      await inAct(() => dispatchModPeriod());
      await m.flush();
      assert.equal(
        agentsOpen.getAttribute("aria-expanded"),
        "true",
        "⌘. on a narrow window must open the Agents drawer",
      );
      assert.ok(
        m.query('[data-panel-tab="pulse"]'),
        "open drawer still shows Agents tabs",
      );
    } finally {
      m.unmount();
    }
  });
});
