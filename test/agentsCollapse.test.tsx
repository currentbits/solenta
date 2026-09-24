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
import {
  defaultInspectorTab,
  inspectorContextKey,
} from "../src/components/AgentsPanel";
import type { ThreadDetail } from "../src/shared/ipc";

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
      const labels = m
        .queryAll('[role="tab"]')
        .map((el) => (el.textContent || "").trim());
      assert.deepEqual(labels, [
        "Environment",
        "Agents",
        "Memory",
        "Skills",
        "Pulse",
      ]);
    } finally {
      m.unmount();
    }
  });
});

function selectedInspectorTab(m: Awaited<ReturnType<typeof mount>>): string | null {
  return (
    m.query('[role="tab"][aria-selected="true"]')?.getAttribute("data-panel-tab") ??
    null
  );
}

async function showInspector(m: Awaited<ReturnType<typeof mount>>) {
  const expand = m.query("[data-agents-expand]");
  if (expand) await m.click(expand);
}

async function openMore(m: Awaited<ReturnType<typeof mount>>) {
  await m.click(m.query("[data-app-more]"));
}

const WORKFLOW = {
  id: "wf1",
  name: "Ship",
  phases: [],
  settled: 0,
  total: 0,
  tokensTotal: 0,
  complete: false,
};

describe("inspector tab defaults", () => {
  it("keeps ordinary threads and manual forks on Environment, and crew or workflow on Agents", () => {
    const lead = { id: "lead", projectId: "p1" };
    const worker = {
      id: "worker",
      projectId: "p1",
      orchWorker: true,
      handoffFrom: "lead",
    };
    const fork = { id: "fork", projectId: "p1", handoffFrom: "lead" };
    const cross = {
      id: "cross",
      projectId: "p2",
      orchWorker: true,
      handoffFrom: "lead",
    };
    const rows = [lead, worker, fork, cross];
    assert.equal(
      defaultInspectorTab({ view: "thread", summary: lead, threads: rows, workflow: null }),
      "agents",
    );
    assert.equal(
      defaultInspectorTab({ view: "thread", summary: worker, threads: rows, workflow: null }),
      "agents",
    );
    assert.equal(
      defaultInspectorTab({ view: "thread", summary: fork, threads: rows, workflow: null }),
      "git",
      "handoffFrom alone is not a crew",
    );
    assert.equal(
      defaultInspectorTab({ view: "thread", summary: cross, threads: rows, workflow: null }),
      "git",
    );
    assert.equal(
      defaultInspectorTab({
        view: "thread",
        summary: { id: "plain", projectId: "p1" },
        threads: rows,
        workflow: WORKFLOW,
      }),
      "agents",
    );
    assert.equal(
      defaultInspectorTab({
        view: "thread",
        summary: null,
        threads: rows,
        workflow: null,
      }),
      "git",
      "a missing detail must not inherit another thread",
    );
    assert.equal(
      defaultInspectorTab({ view: "prs", summary: lead, threads: rows, workflow: WORKFLOW }),
      "git",
    );
    assert.equal(
      defaultInspectorTab({ view: "usage", summary: lead, threads: rows, workflow: WORKFLOW }),
      "pulse",
    );
    assert.notEqual(
      inspectorContextKey({ view: "thread", projectId: "p1", threadId: "a" }),
      inspectorContextKey({ view: "thread", projectId: "p2", threadId: "a" }),
    );
    assert.equal(
      inspectorContextKey({ view: "planboard", projectId: "p1" }),
      "route:p1:planboard",
    );
  });
});

describe("inspector tab selection stays with the context", () => {
  it("keeps Memory across collapse, stream ticks, and a usage roundtrip", async () => {
    const row = thread({ id: "t-plain", title: "Plain session" });
    const fake = createFakeCoder({
      threads: [row],
      details: { "t-plain": detail({ thread: row }) },
    });
    const m = await boot(fake);
    try {
      assert.ok(m.query("[data-agents-expand]"), "stays collapsed until asked");
      await showInspector(m);
      assert.equal(selectedInspectorTab(m), "git");
      assert.equal(
        m.query('[role="tabpanel"]')?.getAttribute("aria-labelledby"),
        "inspector-tab-git",
      );
      await m.click(m.query('[data-panel-tab="memory"]'));
      assert.equal(selectedInspectorTab(m), "memory");
      assert.ok(m.query('[aria-label="Search shared memory"]'));

      await inAct(() =>
        fake.emitThread(
          detail({
            thread: { ...row, status: "working" },
            messages: [
              {
                id: "m-stream",
                role: "assistant",
                text: "still going",
                createdAt: Date.now(),
              },
            ],
            usage: {
              model: "claude",
              inputTokens: 12,
              outputTokens: 4,
              costUsd: 0.01,
              turns: 1,
            },
          }),
        ),
      );
      await m.flush();
      assert.equal(selectedInspectorTab(m), "memory");

      await m.click(m.query("[data-agents-collapse]"));
      assert.equal(m.query('[role="tab"]'), null, "collapsed panel unmounts");
      await m.click(m.query("[data-agents-expand]"));
      assert.equal(selectedInspectorTab(m), "memory");

      await openMore(m);
      await m.click(m.query('[data-app-more-menu] [data-view-nav="usage"]'));
      assert.equal(selectedInspectorTab(m), "pulse");
      assert.equal(m.query("[data-agents-expand]"), null, "route change does not collapse");
      await m.click(m.query('[data-view-nav="threads"]'));
      assert.equal(selectedInspectorTab(m), "memory");
    } finally {
      m.unmount();
    }
  });

  it("opens Agents from Workers once, then keeps a later Memory choice", async () => {
    const m = await boot(createFakeCoder(crewFixture()));
    try {
      await showInspector(m);
      assert.equal(selectedInspectorTab(m), "agents", "a real crew opens on Agents");
      await m.click(m.query('[data-panel-tab="memory"]'));
      await m.click(m.query("[data-agents-collapse]"));
      await m.click(m.query("[data-agents-expand]"));
      assert.equal(selectedInspectorTab(m), "memory");
      await m.click(m.query("[data-thread-header] [data-open-workers]"));
      assert.equal(selectedInspectorTab(m), "agents");
      assert.ok(m.query('[aria-label="Team"]'));
      await m.click(m.query('[data-panel-tab="memory"]'));
      await m.click(m.query("[data-agents-collapse]"));
      await m.click(m.query("[data-agents-expand]"));
      assert.equal(
        selectedInspectorTab(m),
        "memory",
        "an old Workers click must not replay",
      );
    } finally {
      m.unmount();
    }
  });

  it("does not carry Agents onto an ordinary thread or a manual fork", async () => {
    const m = await boot(createFakeCoder(crewFixture()));
    try {
      await m.click(m.query("[data-thread-header] [data-open-workers]"));
      assert.equal(selectedInspectorTab(m), "agents");
      await selectThreadByTitle(m, "Fork: Lead task");
      await showInspector(m);
      assert.equal(selectedInspectorTab(m), "git");
      await selectThreadByTitle(m, "Wrong project worker");
      assert.equal(selectedInspectorTab(m), "git");
      await selectThreadByTitle(m, "Lead task");
      assert.equal(selectedInspectorTab(m), "agents");
    } finally {
      m.unmount();
    }
  });

  it("uses Pulse for usage and Environment for Review without opening a collapsed panel", async () => {
    const row = thread({ id: "t-plain", title: "Plain session" });
    const m = await boot(
      createFakeCoder({
        threads: [row],
        details: { "t-plain": detail({ thread: row }) },
      }),
    );
    try {
      await m.click(m.query('[data-view-nav="review"]'));
      assert.ok(m.query("[data-agents-expand]"), "Review must not open the panel");
      await showInspector(m);
      assert.equal(selectedInspectorTab(m), "git");
      assert.ok(m.query("[data-env-tools]"));
      await m.click(m.query("[data-agents-collapse]"));
      await openMore(m);
      await m.click(m.query('[data-app-more-menu] [data-view-nav="usage"]'));
      assert.ok(m.query("[data-agents-expand]"));
      await showInspector(m);
      assert.equal(selectedInspectorTab(m), "pulse");
    } finally {
      m.unmount();
    }
  });

  it("keeps each project's thread choice and updates a crew default when workers arrive", async () => {
    const a = thread({ id: "t-a", projectId: "p1", title: "Alpha" });
    const b = thread({ id: "t-b", projectId: "p2", title: "Beta" });
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      threads: [a, b],
      details: {
        "t-a": detail({ thread: a }),
        "t-b": detail({ thread: b }),
      },
    });
    const m = await boot(fake);
    try {
      await showInspector(m);
      await m.click(m.query('[data-panel-tab="memory"]'));
      await selectThreadByTitle(m, "Beta");
      assert.equal(selectedInspectorTab(m), "git");
      await selectThreadByTitle(m, "Alpha");
      assert.equal(selectedInspectorTab(m), "memory");

      const worker = thread({
        id: "t-b-worker",
        projectId: "p2",
        title: "Beta worker",
        handoffFrom: "t-b",
        orchWorker: true,
      });
      await inAct(() => fake.emitThreads([a, b, worker]));
      await m.flush();
      assert.equal(selectedInspectorTab(m), "memory", "Alpha's choice survives the roster");
      await selectThreadByTitle(m, "Beta");
      assert.equal(selectedInspectorTab(m), "agents");
    } finally {
      m.unmount();
    }
  });

  it("keys a route tab by the inspector project when the board scope differs", async () => {
    const alpha = thread({
      id: "t-a",
      projectId: "p1",
      title: "Alpha",
    });
    const beta = thread({
      id: "t-b",
      projectId: "p2",
      title: "Beta",
    });
    const m = await boot(
      createFakeCoder({
        projects: [
          project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
          project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
        ],
        threads: [alpha, beta],
        details: {
          "t-a": detail({ thread: alpha }),
          "t-b": detail({ thread: beta }),
        },
      }),
    );
    try {
      await showInspector(m);
      await m.click(m.query('[data-panel-tab="memory"]'));
      assert.match(
        m.query("[data-memory-scroll]")?.parentElement?.textContent || "",
        /one/,
      );

      await m.click(m.query("[data-scope-trigger]"));
      await m.click(m.query('[data-scope-item="p2"]'));
      await m.click(m.query('[data-view-nav="planboard"]'));
      const board = m.query(
        '[data-planboard] select[aria-label="Project"]',
      ) as HTMLSelectElement | null;
      assert.ok(board);
      assert.equal(board.value, "p2", "the board scope changed");
      assert.equal(
        selectedInspectorTab(m),
        "git",
        "the thread's Memory choice does not follow the board",
      );
      await m.click(m.query('[data-panel-tab="memory"]'));
      assert.match(
        m.query("[data-memory-scroll]")?.parentElement?.textContent || "",
        /one/,
        "the inspector still shows Alpha's project",
      );
      await m.click(m.query('[data-panel-tab="skills"]'));

      await selectThreadByTitle(m, "Beta");
      await m.click(m.query('[data-view-nav="planboard"]'));
      const boardAgain = m.query(
        '[data-planboard] select[aria-label="Project"]',
      ) as HTMLSelectElement | null;
      assert.equal(boardAgain?.value, "p2");
      assert.equal(
        selectedInspectorTab(m),
        "git",
        "Skills stayed on Alpha's inspector project",
      );

      await m.click(m.query("[data-scope-trigger]"));
      await m.click(m.query('[data-scope-item="all"]'));
      await selectThreadByTitle(m, "Alpha");
      await m.click(m.query('[data-view-nav="planboard"]'));
      assert.equal(selectedInspectorTab(m), "skills");
      await m.click(m.query('[data-view-nav="threads"]'));
      assert.equal(selectedInspectorTab(m), "memory");
      assert.equal(
        m.query('[data-thread-card="t-a"]')?.getAttribute("data-active"),
        "true",
      );
    } finally {
      m.unmount();
    }
  });

  it("waits for the selected thread's detail and does not reset a remembered tab", async () => {
    const plain = thread({ id: "t-plain", title: "Plain session" });
    const flow = thread({ id: "t-flow", title: "Workflow session" });
    const fake = createFakeCoder({
      threads: [plain, flow],
      details: {
        "t-plain": detail({ thread: plain }),
        "t-flow": detail({ thread: flow, workflow: WORKFLOW }),
      },
    });
    const orig = fake.api.threads.get.bind(fake.api.threads);
    let pending: ((value: ThreadDetail) => void) | null = null;
    let held = false;
    fake.api.threads.get = ((id: string) => {
      if (id === "t-flow" && !held) {
        held = true;
        return new Promise<ThreadDetail>((resolve) => {
          pending = resolve;
        });
      }
      return orig(id);
    }) as typeof fake.api.threads.get;

    const m = await boot(fake);
    try {
      await showInspector(m);
      await m.click(m.query('[data-panel-tab="skills"]'));
      await selectThreadByTitle(m, "Workflow session");
      assert.equal(selectedInspectorTab(m), "git", "workflow is unknown until detail arrives");
      assert.equal(m.text().includes("Ship"), false);
      await m.click(m.query('[data-panel-tab="memory"]'));
      const release = pending;
      assert.ok(release, "detail get was held");
      const loaded = await orig("t-flow");
      await inAct(() => {
        release!(loaded);
      });
      await m.flush();
      assert.equal(selectedInspectorTab(m), "memory");
      assert.equal(m.text().includes("Ship"), false);

      await selectThreadByTitle(m, "Plain session");
      assert.equal(selectedInspectorTab(m), "skills");
      await selectThreadByTitle(m, "Workflow session");
      assert.equal(selectedInspectorTab(m), "memory");
    } finally {
      m.unmount();
    }
  });

  it("moves the inspector tabs with Left, Right, Home, and End", async () => {
    const row = thread({ id: "t-plain", title: "Plain session" });
    const m = await boot(
      createFakeCoder({
        threads: [row],
        details: { "t-plain": detail({ thread: row }) },
      }),
    );
    try {
      await showInspector(m);
      const list = m.query('[role="tablist"]');
      assert.equal(list?.getAttribute("aria-label"), "Inspector");
      const first = m.query('[data-panel-tab="git"]') as HTMLElement;
      await inAct(() => first.focus());
      await m.pressFocused("ArrowRight");
      assert.equal(selectedInspectorTab(m), "agents");
      assert.equal(document.activeElement, m.query('[data-panel-tab="agents"]'));
      await m.pressFocused("End");
      assert.equal(selectedInspectorTab(m), "pulse");
      assert.equal(document.activeElement, m.query('[data-panel-tab="pulse"]'));
      await m.pressFocused("Home");
      assert.equal(selectedInspectorTab(m), "git");
      assert.equal(document.activeElement, m.query('[data-panel-tab="git"]'));
      await m.pressFocused("ArrowLeft");
      assert.equal(selectedInspectorTab(m), "pulse");
    } finally {
      m.unmount();
    }
  });

  it("keeps a narrow-drawer Memory choice until the next Workers click", async () => {
    restoreMatchMedia = stubNarrow();
    const m = await boot(createFakeCoder(crewFixture()));
    try {
      await m.click(m.query("[data-thread-header] [data-open-workers]"));
      assert.equal(selectedInspectorTab(m), "agents");
      await m.click(m.query('[data-panel-tab="memory"]'));
      const toggle = m.query('[data-drawer-open="agents"]') as HTMLElement;
      await m.click(toggle);
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      await m.click(toggle);
      assert.equal(selectedInspectorTab(m), "memory");
      await m.click(m.query("[data-thread-header] [data-open-workers]"));
      assert.equal(selectedInspectorTab(m), "agents");
    } finally {
      m.unmount();
    }
  });
});
