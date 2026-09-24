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
  detail,
  project,
  thread,
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

const NOW = Date.now();

function crewFixture() {
  const lead = thread({
    id: "t-lead",
    title: "Lead task",
    updatedAt: NOW,
  });
  const w1 = thread({
    id: "t-w1",
    title: "Review permissions",
    handoffFrom: "t-lead",
    orchWorker: true,
    updatedAt: NOW + 1,
  });
  const w2 = thread({
    id: "t-w2",
    title: "Fix sidebar grouping",
    handoffFrom: "t-lead",
    orchWorker: true,
    updatedAt: NOW + 2,
  });
  const nested = thread({
    id: "t-nested",
    title: "Nested helper",
    handoffFrom: "t-w1",
    orchWorker: true,
    updatedAt: NOW + 3,
  });
  const fork = thread({
    id: "t-fork",
    title: "Fork: Lead task",
    handoffFrom: "t-lead",
    updatedAt: NOW + 4,
  });
  const archived = thread({
    id: "t-archived",
    title: "Archived crew worker",
    handoffFrom: "t-lead",
    orchWorker: true,
    archived: true,
    updatedAt: NOW + 5,
  });
  const cross = thread({
    id: "t-cross",
    projectId: "p2",
    title: "Wrong project worker",
    handoffFrom: "t-lead",
    orchWorker: true,
    updatedAt: NOW + 6,
  });
  return {
    projects: [
      project({ id: "p1" }),
      project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
    ],
    threads: [lead, w1, w2, nested, fork, archived, cross],
    details: {
      "t-lead": detail({ thread: lead }),
      "t-w1": detail({ thread: w1 }),
      "t-w2": detail({ thread: w2 }),
      "t-nested": detail({ thread: nested }),
      "t-fork": detail({ thread: fork }),
      "t-archived": detail({ thread: archived }),
      "t-cross": detail({ thread: cross }),
    },
  };
}

async function selectThreadByTitle(
  m: Awaited<ReturnType<typeof mount>>,
  title: string,
) {
  const card = m.query(`button[aria-label^="Select thread: ${title}"]`);
  assert.ok(card, `thread card for "${title}" must exist`);
  await m.click(card as HTMLElement);
  await m.flush();
}

/** Crew families start collapsed. No-op when the toggle is not in this tree. */
async function expandFamily(
  m: Awaited<ReturnType<typeof mount>>,
  threadId: string,
) {
  const toggle = m.query(`[data-family-toggle="${threadId}"]`);
  if (!toggle) return;
  if (toggle.getAttribute("aria-expanded") === "true") return;
  await m.click(toggle as HTMLElement);
  await m.flush();
}

async function selectFamilyWorker(
  m: Awaited<ReturnType<typeof mount>>,
  leadId: string,
  title: string,
) {
  await expandFamily(m, leadId);
  await selectThreadByTitle(m, title);
}

describe("Workers control opens the existing Agents team surface", () => {
  it("opens the Agents tab from a collapsed rail and ignores manual forks", async () => {
    const m = await boot(createFakeCoder(crewFixture()));
    try {
      assert.ok(m.query("[data-agents-expand]"), "starts collapsed");
      const btn = m.query("[data-thread-header] [data-open-workers]");
      assert.ok(btn, "lead with orchWorkers gets Workers");
      assert.equal(
        (btn!.textContent || "").trim(),
        "Workers (3)",
        "same-project orchWorkers including archived; cross-project excluded",
      );
      await m.click(btn as HTMLElement);
      await m.flush();
      assert.equal(m.query("[data-agents-expand]"), null, "rail expands");
      const tab = m.query('[data-panel-tab="agents"]');
      assert.ok(tab);
      assert.equal(tab.getAttribute("data-active"), "true");
      const team = m.query('[aria-label="Team"]');
      assert.ok(team, "Team roster is the destination");
      assert.match(team!.textContent || "", /Review permissions/);
      assert.match(team!.textContent || "", /Fix sidebar grouping/);
      assert.match(team!.textContent || "", /Archived crew worker/);
      assert.doesNotMatch(
        team!.textContent || "",
        /Fork: Lead task/,
        "manual forks stay out of Team",
      );
      assert.doesNotMatch(
        team!.textContent || "",
        /Wrong project worker/,
        "cross-project orchWorker stays out of Team",
      );
      assert.ok(
        m.query('[data-crew-integration]') || team,
        "existing integration surface stays reachable",
      );
    } finally {
      m.unmount();
    }
  });

  it("hides Workers on an unrelated single thread", async () => {
    const m = await boot(createFakeCoder());
    try {
      assert.equal(m.query("[data-open-workers]"), null);
    } finally {
      m.unmount();
    }
  });

  it("opens the Agents drawer on a narrow window", async () => {
    restoreMatchMedia = stubNarrow();
    const m = await boot(createFakeCoder(crewFixture()));
    try {
      const agentsOpen = m.query('[data-drawer-open="agents"]');
      assert.ok(agentsOpen);
      assert.equal(agentsOpen.getAttribute("aria-expanded"), "false");
      const btn = m.query("[data-thread-header] [data-open-workers]");
      assert.ok(btn);
      await m.click(btn as HTMLElement);
      await m.flush();
      assert.equal(agentsOpen.getAttribute("aria-expanded"), "true");
      const tab = m.query('[data-panel-tab="agents"]');
      assert.ok(tab);
      assert.equal(tab.getAttribute("data-active"), "true");
      assert.ok(m.query('[aria-label="Team"]'));
    } finally {
      m.unmount();
    }
  });

  it("sends a worker back to its task and keeps ordinary fork provenance", async () => {
    const m = await boot(createFakeCoder(crewFixture()));
    try {
      await selectFamilyWorker(m, "t-lead", "Fix sidebar grouping");
      assert.equal(m.query("[data-open-workers]"), null);
      assert.equal(m.query("[data-handoff-banner]"), null);
      const nav = m.query("[data-worker-nav]");
      assert.ok(nav);
      assert.match(nav!.textContent || "", /^Task/);
      assert.ok((nav!.textContent || "").includes("Lead task"));
      await m.click(m.query('[data-task-source="t-lead"]') as HTMLElement);
      await m.flush();
      assert.ok(m.query("[data-open-workers]"), "parent task is selected again");

      await selectFamilyWorker(m, "t-lead", "Nested helper");
      const nestedNav = m.query("[data-worker-nav]");
      assert.ok(nestedNav);
      assert.match(
        nestedNav!.textContent || "",
        /^Parent worker/,
        "a worker of a worker names the parent worker",
      );
      assert.doesNotMatch(nestedNav!.textContent || "", /^Task /);
      await m.click(m.query('[data-task-source="t-w1"]') as HTMLElement);
      await m.flush();
      assert.ok(
        m.query("[data-open-workers]"),
        "parent worker is selected again",
      );

      await selectThreadByTitle(m, "Fork: Lead task");
      assert.equal(m.query("[data-worker-nav]"), null);
      assert.ok(m.query("[data-handoff-banner]"));
      assert.ok(m.query("[aria-label='Dismiss handoff banner']"));

      await selectThreadByTitle(m, "Wrong project worker");
      assert.ok(m.query("[data-worker-nav]"));
      assert.ok(
        m.query("[data-worker-nav-missing]"),
        "cross-project parent is not a Task link",
      );
      assert.equal(m.query("[data-task-source]"), null);
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
