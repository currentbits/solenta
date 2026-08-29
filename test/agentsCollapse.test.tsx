/**
 * Wide-window Agents panel collapse (issue #645), launch default (issue #767),
 * and optional remember-last (issue #769).
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

const LAST_KEY = "coder.agents.collapsed";

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
    window.localStorage?.removeItem(LAST_KEY);
  } catch {
    // jsdom not installed yet
  }
});

describe("wide agents panel collapse (#645)", () => {
  it("starts collapsed and restores from the rail", async () => {
    const m = await boot(createFakeCoder());
    try {
      assert.equal(
        m.query('[data-layout="app"]')?.getAttribute("data-agents-collapsed"),
        "true",
        "product default is a closed agents panel",
      );
      const expand = m.query("[data-agents-expand]");
      assert.ok(expand, "collapsed rail must offer Show agents");
      assert.equal(expand.tagName, "BUTTON");
      assert.equal(expand.getAttribute("aria-expanded"), "false");
      assert.ok(
        !m.query('[data-panel-tab="pulse"]'),
        "Agents tabs stay hidden while collapsed",
      );

      await m.click(expand);
      const collapse = m.query("[data-agents-collapse]");
      assert.ok(collapse, "wide layout must offer a Hide agents control");
      assert.equal(collapse.getAttribute("aria-expanded"), "true");
      assert.ok(
        m.query('[data-panel-tab="pulse"]'),
        "expand must bring the Agents tabs back",
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
      assert.ok(m.query("[data-agents-expand]"));
    } finally {
      m.unmount();
    }
  });

  it("settings default open remounts open", async () => {
    const fake = createFakeCoder({
      settings: { agentsPanelDefault: "open" },
    });
    const first = await boot(fake);
    try {
      assert.ok(
        first.query("[data-agents-collapse]"),
        "open default must show Hide agents",
      );
      assert.ok(first.query('[data-panel-tab="pulse"]'));
    } finally {
      first.unmount();
    }

    const second = await boot(fake);
    try {
      assert.ok(
        second.query("[data-agents-collapse]"),
        "a later mount must honor settings.agentsPanelDefault=open",
      );
      assert.ok(second.query('[data-panel-tab="pulse"]'));
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
      assert.ok(
        m.query('[data-panel-tab="pulse"]'),
        "⌘. must expand the closed default even from the composer",
      );
      await inAct(() => dispatchModPeriod());
      await m.flush();
      assert.equal(
        m.query('[data-layout="app"]')?.getAttribute("data-agents-collapsed"),
        "true",
        "second ⌘. must collapse again",
      );
    } finally {
      m.unmount();
    }
  });

  it("Settings → Agents panel Open applies immediately", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    try {
      assert.ok(m.query("[data-agents-expand]"), "starts closed");
      const settingsBtn = m.byText("Settings");
      assert.ok(settingsBtn, "sidebar must offer Settings");
      await m.click(settingsBtn);
      await m.flush();
      const select = m.query("[data-agents-panel-default]") as HTMLSelectElement;
      assert.ok(select, "General pane must offer the agents-panel default");
      await m.change(select, "open");
      await m.flush();
      assert.ok(
        m.query("[data-agents-collapse]"),
        "saving Open must expand the panel now",
      );
      assert.ok(m.query('[data-panel-tab="pulse"]'));
      assert.equal(
        fake.api.settings && (await fake.api.settings.get()).agentsPanelDefault,
        "open",
      );
    } finally {
      m.unmount();
    }
  });

  it("⌘. does not survive remount when remember-last is off", async () => {
    const fake = createFakeCoder();
    const first = await boot(fake);
    try {
      await inAct(() => dispatchModPeriod());
      await first.flush();
      assert.ok(
        first.query("[data-agents-collapse]"),
        "session toggle still opens the panel",
      );
    } finally {
      first.unmount();
    }

    const second = await boot(fake);
    try {
      assert.ok(
        second.query("[data-agents-expand]"),
        "next launch must use Closed default, not the session toggle",
      );
    } finally {
      second.unmount();
    }
  });

  it("remember-last with no stored state uses the Closed/Open default", async () => {
    const fake = createFakeCoder({
      settings: {
        agentsPanelDefault: "open",
        agentsPanelRememberLast: true,
      },
    });
    const m = await boot(fake);
    try {
      assert.ok(
        m.query("[data-agents-collapse]"),
        "no last state → Open default",
      );
      assert.ok(m.query('[data-panel-tab="pulse"]'));
    } finally {
      m.unmount();
    }
  });

  it("remember-last persists the ⌘. toggle across remount", async () => {
    const fake = createFakeCoder({
      settings: {
        agentsPanelDefault: "closed",
        agentsPanelRememberLast: true,
      },
    });
    const first = await boot(fake);
    try {
      assert.ok(first.query("[data-agents-expand]"), "starts from Closed");
      await inAct(() => dispatchModPeriod());
      await first.flush();
      assert.ok(first.query("[data-agents-collapse]"), "⌘. opens it");
    } finally {
      first.unmount();
    }

    const second = await boot(fake);
    try {
      assert.ok(
        second.query("[data-agents-collapse]"),
        "remember-last must restore the open toggle on the next launch",
      );
      assert.ok(second.query('[data-panel-tab="pulse"]'));
    } finally {
      second.unmount();
    }
  });

  it("remember-last ignores a leftover last state when the option is off", async () => {
    window.localStorage.setItem(LAST_KEY, "0");
    const fake = createFakeCoder({
      settings: {
        agentsPanelDefault: "closed",
        agentsPanelRememberLast: false,
      },
    });
    const m = await boot(fake);
    try {
      assert.ok(
        m.query("[data-agents-expand]"),
        "off + leftover open key must still launch closed",
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
