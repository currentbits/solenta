/**
 * Sidebar: T3 flat list (no project groups), two shelves, scope filter.
 *
 * Contract: .solenta/specs/t3-flat-sidebar.md
 * Pinned block → active cards → Snoozed shelf → Settled shelf (settled then
 * archived). Every card carries data-card-slug. Create + scope live in the
 * header. Runtime green waits on the UI branch; tsc must pass.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { dismissContextMenu } from "../src/contextMenuFallback";
import * as React from "react";
import { inAct, mount } from "./support/dom";
import App from "../src/App";
import { Sidebar, SettledRow, ThreadCard } from "../src/components/Sidebar";
import {
  createFakeCoder,
  installFakeCoder,
} from "./support/fakeCoder";
import {
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
} from "../src/threadSettle";
import type {
  ProjectInfo,
  ProviderInfo,
  ThreadInfo,
  UpdateStatus,
} from "../src/shared/ipc";

const p1: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};
const p2: ProjectInfo = {
  id: "p2",
  slug: "acme/billing",
  name: "billing",
  path: "/tmp/billing",
};

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

const FRESH = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  dismissContextMenu();
  try {
    const ls = globalThis.window?.localStorage;
    if (!ls) return;
    for (const k of [
      "sidebar:projectScope",
      "sidebar:snoozedOpen",
      "sidebar:settledOpen",
      "sidebar:statusFilter",
      "sidebar:providerFilter",
      "sidebar:tagFilter",
      "sidebar:groupBy",
      "coder.sidebar.collapsedGroups",
      "coder.sidebar.settledCollapsed",
    ]) {
      ls.removeItem(k);
    }
  } catch {
    // jsdom not installed yet
  }
});

function thread(over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">): ThreadInfo {
  const createdAt = over.createdAt ?? FRESH;
  const updatedAt = over.updatedAt ?? createdAt;
  return {
    projectId: "p1",
    title: over.id,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt,
    updatedAt,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    tags: [],
    lastVisitedAt:
      over.lastVisitedAt !== undefined ? over.lastVisitedAt : updatedAt,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

function sidebar(
  threads: ThreadInfo[],
  over: {
    projects?: ProjectInfo[];
    activeThreadId?: string | null;
    onSetSettled?: (id: string, o: "settled" | "active") => void;
    onSetArchived?: (id: string, archived: boolean) => void;
    onSelectThread?: (id: string) => void;
    onRemoveProject?: (projectId: string) => void;
    onEditProject?: (projectId: string) => void;
    onAddProject?: () => void;
    onCreateThread?: (
      projectId?: string,
      opts?: {
        worktree?: boolean;
        orchestrate?: boolean;
        teach?: boolean;
        ask?: boolean;
        issueNumber?: number | null;
      },
    ) => void;
    onCreateThreadFromIssue?: (input: {
      projectId: string;
      projectPath: string;
      ref: string;
    }) => Promise<{ ok: boolean; reason?: string }>;
    onSetPinned?: (threadId: string, pinned: boolean) => void;
    onSetSnoozed?: (threadId: string, until: number | null) => void;
    onSetTags?: (threadId: string, tags: string[]) => void;
    projectError?: string | null;
    providers?: ProviderInfo[];
    onSetMuted?: (threadId: string, muted: boolean) => void;
    onRenameThread?: (threadId: string, title: string) => void;
    onFork?: (threadId: string, opts?: { provider?: string }) => void;
    onOpenPlanboard?: (scopedProjectId?: string | null) => void;
    onOpenKanban?: (scopedProjectId?: string | null) => void;
    onOpenActivity?: (scopedProjectId?: string | null) => void;
    revealThreadId?: string | null;
    onRevealHandled?: () => void;
    updateState?: UpdateStatus["state"] | null;
    onDownloadUpdate?: () => void | Promise<void>;
    onApplyUpdate?: () => void | Promise<void>;
    onOpenSettings?: () => void;
    appVersion?: string | null;
    channel?: "prod" | "nightly" | null;
    searchThreads?: (input: { query: string }) => Promise<ThreadInfo[]>;
  } = {},
) {
  const projects = over.projects ?? [p1];
  return (
    <Sidebar
      appName="Solenta"
      appVersion={over.appVersion}
      channel={over.channel}
      searchPlaceholder="Search threads..."
      projectsHeader="All projects"
      projects={projects}
      threads={threads}
      providers={over.providers ?? providers}
      activeThreadId={over.activeThreadId ?? null}
      onSelectThread={over.onSelectThread ?? (() => {})}
      onCreateThread={over.onCreateThread ?? (() => {})}
      onAddProject={over.onAddProject ?? (() => {})}
      onRemoveProject={over.onRemoveProject}
      onEditProject={over.onEditProject}
      projectError={over.projectError ?? null}
      onSetSettled={over.onSetSettled}
      onSetArchived={over.onSetArchived}
      onSetPinned={over.onSetPinned}
      onSetSnoozed={over.onSetSnoozed}
      onSetTags={over.onSetTags}
      onSetMuted={over.onSetMuted}
      onRenameThread={over.onRenameThread}
      onFork={over.onFork}
      onOpenPlanboard={over.onOpenPlanboard}
      onOpenKanban={over.onOpenKanban}
      onOpenActivity={over.onOpenActivity}
      onCreateThreadFromIssue={over.onCreateThreadFromIssue}
      revealThreadId={over.revealThreadId ?? null}
      onRevealHandled={over.onRevealHandled}
      updateState={over.updateState}
      onDownloadUpdate={over.onDownloadUpdate}
      onApplyUpdate={over.onApplyUpdate}
      onOpenSettings={over.onOpenSettings}
      searchThreads={
        over.searchThreads ??
        (async ({ query }) =>
          threads.filter((t) => t.title.includes(query)))
      }
    />
  );
}

/** Two projects; settled cases not all in one; selected not index 0. */
const THREADS = [
  thread({
    id: "busy",
    title: "busy work",
    status: "working",
    runStartedAt: FRESH,
    createdAt: FRESH + 50,
    updatedAt: FRESH + 50,
    projectId: "p1",
  }),
  thread({
    id: "finished",
    title: "finished work",
    status: "done",
    createdAt: FRESH + 40,
    updatedAt: FRESH + 40,
    projectId: "p1",
  }),
  thread({
    id: "merged-p1",
    title: "merged ledger",
    status: "done",
    prState: "MERGED",
    settledAt: FRESH + 30,
    createdAt: FRESH + 30,
    updatedAt: FRESH + 30,
    projectId: "p1",
  }),
  thread({
    id: "broken",
    title: "broken work",
    status: "failed",
    createdAt: FRESH + 20,
    updatedAt: FRESH + 20,
    projectId: "p1",
  }),
  thread({
    id: "merged-p2",
    title: "merged billing",
    status: "done",
    prState: "MERGED",
    settledAt: FRESH + 35,
    createdAt: FRESH + 35,
    updatedAt: FRESH + 35,
    projectId: "p2",
  }),
  thread({
    id: "billing-idle",
    title: "billing idle",
    status: "idle",
    createdAt: FRESH + 10,
    updatedAt: FRESH + 10,
    projectId: "p2",
  }),
];

function cardTitles(m: Awaited<ReturnType<typeof mount>>): string[] {
  return m
    .queryAll("[data-thread-card]")
    .map((el) => el.getAttribute("data-thread-card") || "");
}

function searchInput(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLInputElement {
  const el = m.query(
    'input[placeholder="Search threads..."]',
  ) as HTMLInputElement | null;
  assert.ok(el, "search input must render");
  return el;
}

function scopeTrigger(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLButtonElement {
  const el = m.query("[data-scope-trigger]") as HTMLButtonElement | null;
  assert.ok(el, "scope trigger must render");
  return el;
}

function snoozedToggle(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLButtonElement {
  const el = m.query(
    "[data-snoozed-shelf-toggle]",
  ) as HTMLButtonElement | null;
  assert.ok(el, "snoozed shelf toggle must render");
  return el;
}

function settledToggle(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLButtonElement {
  const el = m.query(
    "[data-settled-shelf-toggle]",
  ) as HTMLButtonElement | null;
  assert.ok(el, "settled shelf toggle must render");
  return el;
}

async function openSettledShelf(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  const btn = settledToggle(m);
  if (btn.getAttribute("aria-expanded") !== "true") {
    await m.click(btn);
    await m.flush();
  }
}

async function openSnoozedShelf(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  const btn = snoozedToggle(m);
  if (btn.getAttribute("aria-expanded") !== "true") {
    await m.click(btn);
    await m.flush();
  }
}

async function openScopeMenu(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  if (!m.query("[data-scope-menu]")) {
    await m.click(scopeTrigger(m));
    await m.flush();
  }
}

async function openCreateMenu(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  if (!m.query("[data-new-thread-menu]")) {
    const caret = m.query("[data-new-thread-caret]");
    assert.ok(caret, "create caret must render");
    await m.click(caret);
    await m.flush();
  }
}

/** Install jsdom via a throwaway mount, then clear localStorage for a clean slate. */
async function clearSidebarStorage(): Promise<void> {
  const shell = await mount(<div />);
  window.localStorage.clear();
  shell.unmount();
}

describe("t3 paging constants are fixed facts", () => {
  it("INITIAL is 10 and PAGE is 25", () => {
    assert.equal(SETTLED_TAIL_INITIAL_COUNT, 10, "t3 SETTLED_TAIL_INITIAL_COUNT");
    assert.equal(SETTLED_TAIL_PAGE_COUNT, 25, "t3 SETTLED_TAIL_PAGE_COUNT");
  });
});

describe("Sidebar is a flat list (no project groups)", () => {
  it("retires group chrome and paints a slug on every card", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.equal(m.query("[data-projects-section]"), null);
    assert.equal(m.query("[data-group-chevron]"), null);
    assert.equal(m.query("[data-later-shelf]"), null);
    assert.equal(m.query("[data-pin-btn]"), null);
    assert.equal(m.query("[data-project-edit]"), null);
    assert.ok(
      !m.text().includes("Later ·"),
      "Later · header copy is gone",
    );

    const ids = cardTitles(m);
    assert.ok(ids.includes("busy"), "working stays in the active list");
    assert.ok(ids.includes("finished"), "fresh done stays visible (not settled)");
    assert.ok(ids.includes("broken"), "failed stays visible");
    assert.ok(ids.includes("billing-idle"), "other project's attention shows");
    // Shelves default collapsed — MERGED is not a card in the active list.
    assert.ok(!ids.includes("merged-p1"), "MERGED is not an active card");
    assert.ok(!ids.includes("merged-p2"));

    for (const id of ["busy", "finished", "broken", "billing-idle"]) {
      const slug = m.query(`[data-thread-card="${id}"] [data-card-slug]`);
      assert.ok(slug, `${id} must carry data-card-slug (replaces group headers)`);
    }
    assert.equal(
      (m.query('[data-thread-card="busy"] [data-card-slug]')!.textContent || "").trim(),
      "acme/ledger",
    );
    assert.equal(
      (
        m.query('[data-thread-card="billing-idle"] [data-card-slug]')!
          .textContent || ""
      ).trim(),
      "acme/billing",
    );
    m.unmount();
  });

  it("archived wins over settled: MERGED+archived is a slim archived row", async () => {
    await clearSidebarStorage();
    const archiveCalls: Array<[string, boolean]> = [];
    const m = await mount(
      sidebar(
        [
          thread({
            id: "kept",
            title: "kept",
            status: "working",
            runStartedAt: FRESH,
          }),
          thread({
            id: "gone",
            title: "gone",
            status: "done",
            prState: "MERGED",
            archived: true,
          }),
        ],
        {
          projects: [p1],
          onSetArchived: (id, a) => archiveCalls.push([id, a]),
        },
      ),
    );
    assert.ok(
      !m.text().includes("1 archived"),
      "per-group archived toggle is gone",
    );
    const header = settledToggle(m);
    assert.match(
      header.textContent || "",
      /Settled \(1\)/,
      "archived counts into Settled (N) while collapsed",
    );
    assert.equal(header.getAttribute("aria-expanded"), "false");

    await openSettledShelf(m);
    assert.match(settledToggle(m).textContent || "", /^Settled$/);
    const row = m.query('[data-thread-card="gone"]');
    assert.ok(row, "archived thread renders on the settled shelf");
    assert.equal(row!.getAttribute("data-archived"), "true");
    assert.equal(
      row!.getAttribute("data-slim-row"),
      "gone",
      "archived rows are slim",
    );
    assert.equal(
      row!.getAttribute("data-settled"),
      null,
      "archived MERGED must not present as a settled row",
    );
    const unarchive = m.query(
      '[data-unarchive-btn="gone"]',
    ) as HTMLButtonElement | null;
    assert.ok(unarchive, "archived row offers an unarchive hover button");
    await m.click(unarchive!);
    assert.deepEqual(archiveCalls, [["gone", false]]);
    m.unmount();
  });

  it("a project whose threads are all settled has no empty-group copy", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(
        [
          thread({
            id: "only-merged",
            title: "only merged",
            status: "done",
            prState: "MERGED",
            projectId: "p1",
          }),
          thread({
            id: "p2-work",
            title: "billing busy",
            status: "working",
            runStartedAt: FRESH,
            projectId: "p2",
          }),
        ],
        { projects: [p1, p2] },
      ),
    );
    assert.ok(!m.text().includes("Nothing active"));
    assert.ok(!m.text().includes("No threads yet"));
    assert.ok(cardTitles(m).includes("p2-work"));
    assert.ok(!cardTitles(m).includes("only-merged"));
    m.unmount();
  });
});

describe("Sidebar snoozed + settled shelves", () => {
  it("settled shelf defaults collapsed, counts every project, opens to newest-first", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const header = settledToggle(m);
    assert.match(
      header.textContent || "",
      /Settled \(2\)/,
      "collapsed header counts settled from every project",
    );
    assert.equal(
      header.getAttribute("aria-expanded"),
      "false",
      "shelves default collapsed",
    );
    assert.ok(!cardTitles(m).includes("merged-p1"));

    await openSettledShelf(m);
    assert.equal(settledToggle(m).getAttribute("aria-expanded"), "true");
    assert.match(settledToggle(m).textContent || "", /^Settled$/);
    const ids = cardTitles(m);
    assert.ok(ids.includes("merged-p1"));
    assert.ok(ids.includes("merged-p2"));
    const i2 = ids.indexOf("merged-p2");
    const i1 = ids.indexOf("merged-p1");
    assert.ok(i2 >= 0 && i1 >= 0 && i2 < i1, "newest-settled first across projects");
    m.unmount();
  });

  it("expanding the settled shelf persists across remounts", async () => {
    await clearSidebarStorage();
    const m1 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await openSettledShelf(m1);
    assert.equal(settledToggle(m1).getAttribute("aria-expanded"), "true");
    m1.unmount();

    const m2 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.equal(
      settledToggle(m2).getAttribute("aria-expanded"),
      "true",
      "stored expand survives a remount via sidebar:settledOpen",
    );
    assert.ok(cardTitles(m2).includes("merged-p1"));
    m2.unmount();
  });

  it("collapsing hides rows again", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await openSettledShelf(m);
    await m.click(settledToggle(m));
    assert.equal(settledToggle(m).getAttribute("aria-expanded"), "false");
    assert.ok(
      !cardTitles(m).includes("merged-p1"),
      "collapsing the shelf hides its rows",
    );
    m.unmount();
  });

  it("pages the settled shelf: 40 → 10 visible, Show more → 35, header counts 40", async () => {
    await clearSidebarStorage();
    const TOTAL = 40;
    const many = Array.from({ length: TOTAL }, (_, i) =>
      thread({
        id: `s${i}`,
        title: `settled ${i}`,
        status: "done",
        prState: "MERGED",
        settledAt: FRESH + 1000 - i,
        updatedAt: FRESH + 1000 - i,
        projectId: i % 2 === 0 ? "p1" : "p2",
      }),
    );
    many.push(
      thread({
        id: "attn",
        title: "still working",
        status: "working",
        runStartedAt: FRESH,
        createdAt: FRESH + 2000,
        updatedAt: FRESH + 2000,
        projectId: "p1",
      }),
    );
    const m = await mount(sidebar(many, { projects: [p1, p2] }));
    assert.match(settledToggle(m).textContent || "", /Settled \(40\)/);
    await openSettledShelf(m);
    const shown = cardTitles(m).filter((id) => id.startsWith("s"));
    assert.equal(shown.length, 10, "initial expand shows exactly 10");
    const more = m.query("[data-settled-more]");
    assert.ok(more, "data-settled-more appears when more than 10 remain");
    assert.match(more!.textContent || "", /more/i);
    await m.click(more!);
    const after = cardTitles(m).filter((id) => id.startsWith("s"));
    assert.equal(after.length, 35, "one page adds 25 → 10+25=35");
    m.unmount();
  });

  it("exactly 10 settled shows no Show more once opened", async () => {
    await clearSidebarStorage();
    const many = Array.from({ length: 10 }, (_, i) =>
      thread({
        id: `exact${i}`,
        title: `exact settled ${i}`,
        status: "done",
        prState: "MERGED",
        settledAt: FRESH + 500 - i,
        updatedAt: FRESH + 500 - i,
        projectId: i % 2 === 0 ? "p1" : "p2",
      }),
    );
    many.push(
      thread({
        id: "noise-work",
        title: "noise work",
        status: "working",
        runStartedAt: FRESH,
        projectId: "p1",
      }),
    );
    const m = await mount(sidebar(many, { projects: [p1, p2] }));
    assert.match(settledToggle(m).textContent || "", /Settled \(10\)/);
    await openSettledShelf(m);
    assert.equal(
      cardTitles(m).filter((id) => id.startsWith("exact")).length,
      10,
    );
    assert.equal(
      m.query("[data-settled-more]") != null,
      false,
      "data-settled-more must not appear at exactly INITIAL",
    );
    m.unmount();
  });

  it("SettledRow age text uses settledAt when it diverges from updatedAt", async () => {
    const wrapUp = FRESH - 5 * DAY_MS;
    const recentTouch = FRESH;
    const t = thread({
      id: "divergent-age",
      title: "divergent wrap up",
      status: "done",
      prState: "MERGED",
      settledAt: wrapUp,
      updatedAt: recentTouch,
      projectId: "p1",
    });
    const m = await mount(
      <SettledRow
        thread={t}
        slug="acme/ledger"
        active={false}
        now={FRESH}
        onSelect={() => {}}
      />,
    );
    const row =
      m.query('[data-slim-row="divergent-age"]') ||
      m.query('[data-thread-card="divergent-age"]');
    assert.ok(row, "slim settled row must render");
    assert.match(
      row!.textContent || "",
      /5d(?!\w)/,
      "age label must come from settledAt (5d), not updatedAt (now)",
    );
    assert.doesNotMatch(row!.textContent || "", /\bnow\b/);
    m.unmount();
  });

  it("carve-out: selected settled thread stays visible while the shelf is collapsed", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        activeThreadId: "merged-p2",
      }),
    );
    assert.equal(settledToggle(m).getAttribute("aria-expanded"), "false");
    assert.ok(
      cardTitles(m).includes("merged-p2"),
      "open settled thread must never vanish behind the collapsed shelf",
    );
    assert.ok(
      !cardTitles(m).includes("merged-p1"),
      "other settled rows stay hidden while collapsed",
    );
    m.unmount();
  });

  it("opening a settled thread selects it and does not call setSettled", async () => {
    await clearSidebarStorage();
    const settleCalls: Array<{ id: string; o: string }> = [];
    const selects: string[] = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onSetSettled: (id, o) => {
          settleCalls.push({ id, o });
        },
        onSelectThread: (id) => {
          selects.push(id);
        },
      }),
    );
    await openSettledShelf(m);
    const select = m.query(
      'button[aria-label="Select thread: merged billing"]',
    );
    assert.ok(select, "settled row is selectable");
    await m.click(select!);
    assert.deepEqual(selects, ["merged-p2"], "click navigates only");
    assert.equal(settleCalls.length, 0);
    m.unmount();
  });

  it("Keep thread active on a settled row calls setSettled active", async () => {
    await clearSidebarStorage();
    const settleCalls: Array<{ id: string; o: string }> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onSetSettled: (id, o) => {
          settleCalls.push({ id, o });
        },
      }),
    );
    await openSettledShelf(m);
    const keep =
      (m.query("[data-unsettle-btn]") as HTMLButtonElement | null) ||
      (m
        .queryAll("button")
        .find((b) => b.getAttribute("aria-label") === "Keep thread active") as
        | HTMLButtonElement
        | undefined);
    assert.ok(keep, "settled rows keep the un-settle hover affordance");
    await m.click(keep!);
    assert.equal(settleCalls.length, 1);
    assert.equal(settleCalls[0]!.o, "active");
    m.unmount();
  });

  it("snoozed shelf is its own toggle; snooze beats pin", async () => {
    await clearSidebarStorage();
    const soon = thread({
      id: "snooze-soon",
      title: "snooze soon",
      projectId: "p2",
      snoozedUntil: FRESH + 10_000,
      snoozedAt: FRESH,
      createdAt: FRESH - 100,
      updatedAt: FRESH - 100,
    });
    const latePinned = thread({
      id: "snooze-late",
      title: "snooze late",
      projectId: "p1",
      snoozedUntil: FRESH + 90_000,
      snoozedAt: FRESH,
      pinnedAt: FRESH - 1000,
      createdAt: FRESH - 50,
      updatedAt: FRESH - 50,
    });
    const m = await mount(
      sidebar([THREADS[0]!, soon, latePinned], { projects: [p1, p2] }),
    );
    assert.match(snoozedToggle(m).textContent || "", /Snoozed \(2\)/);
    assert.equal(snoozedToggle(m).getAttribute("aria-expanded"), "false");
    assert.ok(!cardTitles(m).includes("snooze-soon"));

    await openSnoozedShelf(m);
    assert.match(snoozedToggle(m).textContent || "", /^Snoozed$/);
    const rows = m
      .queryAll("[data-snoozed='true']")
      .map((el) => el.getAttribute("data-thread-card"));
    assert.deepEqual(rows, ["snooze-soon", "snooze-late"]);
    assert.equal(
      m.queryAll('[data-thread-card="snooze-late"]').length,
      1,
      "snoozed+pinned renders once, on the snoozed shelf",
    );
    m.unmount();
  });
});

describe("Sidebar project scope", () => {
  it("filters the flat list to the scoped project and persists", async () => {
    await clearSidebarStorage();
    const m1 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.ok(cardTitles(m1).includes("busy"));
    assert.ok(cardTitles(m1).includes("billing-idle"));
    assert.match(scopeTrigger(m1).textContent || "", /All projects/);

    await openScopeMenu(m1);
    assert.ok(m1.query('[data-scope-item="all"]'));
    const p2Item = m1.query('[data-scope-item="p2"]');
    assert.ok(p2Item, "every project is a scope item");
    assert.match(p2Item!.textContent || "", /acme\/billing/);
    await m1.click(p2Item!);
    await m1.flush();

    const after = cardTitles(m1);
    assert.ok(after.includes("billing-idle"));
    assert.ok(!after.includes("busy"), "p1 attention is filtered out");
    assert.match(scopeTrigger(m1).textContent || "", /acme\/billing/);
    m1.unmount();


    const m2 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.match(
      scopeTrigger(m2).textContent || "",
      /acme\/billing/,
      "scope persists via sidebar:projectScope",
    );
    assert.ok(!cardTitles(m2).includes("busy"));
    m2.unmount();
  });

  it("search ANDs with project scope (#553)", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();
    assert.ok(!cardTitles(m).includes("merged-p1"));

    await m.type(searchInput(m), "merged ledger");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.deepEqual(
      cardTitles(m),
      [],
      "a p1 hit is dropped while scoped to p2",
    );
    m.unmount();
  });

  it("search still surfaces settled hits in the scoped project while the shelf is collapsed", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();

    await m.type(searchInput(m), "merged billing");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.deepEqual(
      cardTitles(m),
      ["merged-p2"],
      "search bypasses the collapsed settled shelf inside the scoped project",
    );
    const hit = m.query('[data-thread-card="merged-p2"]');
    assert.ok(hit);
    assert.ok(
      hit!.querySelector("[data-card-slug]"),
      "search hits still carry the project slug",
    );
    m.unmount();
  });

  it("All projects restores the unfiltered list", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="all"]')!);
    await m.flush();
    assert.ok(cardTitles(m).includes("busy"));
    assert.ok(cardTitles(m).includes("billing-idle"));
    assert.match(scopeTrigger(m).textContent || "", /All projects/);
    m.unmount();
  });

  it("view nav stays three icon buttons", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.ok(m.query('[data-view-nav="activity"]'));
    assert.ok(m.query('[data-view-nav="kanban"]'));
    assert.ok(m.query('[data-view-nav="planboard"]'));
    m.unmount();
  });

  it("planboard nav passes the scoped project id (#597)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenPlanboard: (pid) => {
          opened.push(pid);
        },
      }),
    );
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();
    const btn = m.query('[data-view-nav="planboard"]') as HTMLButtonElement | null;
    assert.ok(btn, "planboard nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, ["p2"]);
    m.unmount();
  });

  it("planboard nav passes null when unscoped (#597)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenPlanboard: (pid) => {
          opened.push(pid);
        },
      }),
    );
    const btn = m.query('[data-view-nav="planboard"]') as HTMLButtonElement | null;
    assert.ok(btn, "planboard nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, [null]);
    m.unmount();
  });

  it("kanban nav passes the scoped project id (#598)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenKanban: (pid) => {
          opened.push(pid);
        },
      }),
    );
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();
    const btn = m.query('[data-view-nav="kanban"]') as HTMLButtonElement | null;
    assert.ok(btn, "kanban nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, ["p2"]);
    m.unmount();
  });

  it("kanban nav passes null when unscoped (#598)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenKanban: (pid) => {
          opened.push(pid);
        },
      }),
    );
    const btn = m.query('[data-view-nav="kanban"]') as HTMLButtonElement | null;
    assert.ok(btn, "kanban nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, [null]);
    m.unmount();
  });

  it("activity nav passes the scoped project id (#598)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenActivity: (pid) => {
          opened.push(pid);
        },
      }),
    );
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();
    const btn = m.query('[data-view-nav="activity"]') as HTMLButtonElement | null;
    assert.ok(btn, "activity nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, ["p2"]);
    m.unmount();
  });

  it("activity nav passes null when unscoped (#598)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenActivity: (pid) => {
          opened.push(pid);
        },
      }),
    );
    const btn = m.query('[data-view-nav="activity"]') as HTMLButtonElement | null;
    assert.ok(btn, "activity nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, [null]);
    m.unmount();
  });

  it("shows a project icon on the scope item and thread card (#610)", async () => {
    await clearSidebarStorage();
    const iconUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const m = await mount(
      sidebar(THREADS, {
        projects: [
          { ...p1, iconUrl },
          p2,
        ],
      }),
    );
    await openScopeMenu(m);
    const item = m.query('[data-scope-item="p1"]');
    assert.ok(item?.querySelector("[data-project-icon]"), "scope row glyph");
    const card = m.query('[data-thread-card="busy"]');
    assert.ok(card?.querySelector("[data-project-icon]"), "thread card glyph");
    assert.ok(
      !m.query('[data-scope-item="p2"]')?.querySelector("[data-project-icon]"),
      "a project without iconUrl stays text-only",
    );
    m.unmount();
  });

  it("keeps text-only scope rows and cards when no icon is resolved", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await openScopeMenu(m);
    assert.equal(m.queryAll("[data-project-icon]").length, 0);
    m.unmount();
  });
});

describe("Sidebar filter columns (#746)", () => {
  function cssBlock(className: string): string {
    const css = fs
      .readFileSync("src/components/Sidebar.module.css", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    return css.match(new RegExp(`\\.${className}(?![\\w-])\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  }

  it("lays Status / Provider / Group and the view-nav icons on matching 3-col tracks", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const filters = m.query("[data-filter-row]");
    const nav = filters?.parentElement?.querySelector("nav[aria-label='Views']");
    assert.ok(filters, "filter row");
    assert.ok(nav, "view nav sits with the filter row");
    assert.equal(filters!.children.length, 3, "three filter columns");
    assert.equal(nav!.querySelectorAll("[data-view-nav]").length, 3, "three view-nav icons");
    m.unmount();

    const threeCol = /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/;
    assert.match(cssBlock("filterRow"), threeCol, "filter labels share three equal tracks");
    assert.match(cssBlock("viewNav"), threeCol, "view-nav icons share the same three tracks");
    assert.match(
      cssBlock("filterTrigger"),
      /justify-content:\s*center/,
      "label+chevron sit on the column centerline above the icon",
    );
    assert.doesNotMatch(
      cssBlock("filterTriggerLabel"),
      /flex:\s*1/,
      "growing the label shoved the chevron to the far edge and un-centered the column",
    );
    assert.match(cssBlock("viewNavBtn"), /place-items:\s*center/);
  });
});

describe("Sidebar header create + issue form", () => {
  it("New thread targets the scoped project, else the open thread, else the first", async () => {
    await clearSidebarStorage();
    const calls: Array<string | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        activeThreadId: "billing-idle",
        onCreateThread: (pid) => {
          calls.push(pid);
        },
      }),
    );
    const btn = m.query("[data-new-thread]");
    assert.ok(btn, "data-new-thread lives in the search row");
    await m.click(btn!);
    assert.deepEqual(calls, ["p2"], "open thread's project when unscoped");

    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p1"]')!);
    await m.flush();
    await m.click(m.query("[data-new-thread]")!);
    assert.deepEqual(calls, ["p2", "p1"], "scope wins over the open thread");
    m.unmount();
  });

  it("caret opens the existing create-type items plus from-issue", async () => {
    await clearSidebarStorage();
    const calls: Array<[string | undefined, unknown]> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onCreateThread: (pid, opts) => calls.push([pid, opts]),
        onCreateThreadFromIssue: async () => ({ ok: true }),
      }),
    );
    await openCreateMenu(m);
    assert.ok(m.query("[data-new-thread-menu]"));
    for (const attr of [
      "data-create-worktree-thread",
      "data-create-orchestrator-thread",
      "data-create-plain-thread",
      "data-create-teach-thread",
      "data-create-ask-thread",
      "data-create-from-issue",
    ]) {
      assert.ok(m.query(`[${attr}]`), `menu is missing ${attr}`);
    }
    await m.click(m.query("[data-create-orchestrator-thread]")!);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]![1], { orchestrate: true });
    assert.equal(
      m.query("[data-new-thread-menu]"),
      null,
      "menu closes after selection",
    );
    m.unmount();
  });

  it("from-issue opens the existing form under the header", async () => {
    await clearSidebarStorage();
    const calls: Array<{ projectId: string; ref: string }> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1],
        onCreateThreadFromIssue: async (input) => {
          calls.push({ projectId: input.projectId, ref: input.ref });
          return { ok: false, reason: "issue not found" };
        },
      }),
    );
    await openCreateMenu(m);
    await m.click(m.query("[data-create-from-issue]")!);
    const form = m.query("[data-issue-form]");
    assert.ok(form, "issue form renders under the header");
    const input = m.query("[data-issue-input]") as HTMLInputElement | null;
    assert.ok(input);
    await m.type(input!, "https://github.com/acme/ledger/issues/99");
    await m.click(m.query("[data-issue-create]")!);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.ref, "https://github.com/acme/ledger/issues/99");
    assert.equal(m.query("[data-issue-error]")?.textContent, "issue not found");
    await m.click(m.query("[data-issue-cancel]")!);
    assert.equal(m.query("[data-issue-form]"), null);
    m.unmount();
  });

  it("omits from-issue when the optional handler is missing", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1] }));
    await openCreateMenu(m);
    assert.equal(m.query("[data-create-from-issue]"), null);
    m.unmount();
  });
});

describe("Sidebar remove + edit project (scope menu)", () => {
  const removeThreads = [
    thread({ id: "t-p1-a", title: "ledger a", projectId: "p1" }),
    thread({ id: "t-p2-a", title: "billing a", projectId: "p2" }),
    thread({ id: "t-p2-b", title: "billing b", projectId: "p2", archived: true }),
    thread({
      id: "t-p2-c",
      title: "billing c",
      projectId: "p2",
      status: "done",
      prState: "MERGED",
    }),
  ];

  it("exposes edit + remove per project inside the scope menu, plus New project", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(removeThreads, {
        projects: [p1, p2],
        onRemoveProject: () => {},
        onEditProject: () => {},
        onAddProject: () => {},
      }),
    );
    assert.ok(m.query("[data-new-project]"), "New project sits outside the menu");
    await openScopeMenu(m);
    assert.ok(m.query('[data-scope-edit="p1"]'));
    assert.ok(m.query('[data-scope-edit="p2"]'));
    assert.ok(m.query('[data-project-remove="p1"]'));
    const removeP2 = m.query('[data-project-remove="p2"]');
    assert.ok(removeP2);
    assert.equal(
      removeP2!.getAttribute("aria-label"),
      "Remove project acme/billing",
    );
    m.unmount();
  });

  it("badges a jj project in the scope menu (#521)", async () => {
    await clearSidebarStorage();
    const jjProject: ProjectInfo = {
      ...p1,
      scm: {
        kind: "jj",
        colocated: true,
        support: "unsupported",
        detail: "Jujutsu colocated repo.",
      },
    };
    const m = await mount(
      sidebar(removeThreads, {
        projects: [jjProject, p2],
        onEditProject: () => {},
      }),
    );
    await openScopeMenu(m);
    const item = m.query('[data-scope-item="p1"]');
    assert.ok(item, "jj project row");
    const badge = item!.querySelector("[data-scm-badge]");
    assert.ok(badge, "jj chip");
    assert.equal(badge!.getAttribute("data-scm-badge"), "unsupported");
    assert.equal((badge!.textContent || "").trim(), "jj");
    assert.equal(m.query('[data-scope-item="p2"]')?.querySelector("[data-scm-badge]"), null);
    m.unmount();
  });

  it("confirm shows REAL thread count, path, and both t3 sentences", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(removeThreads, {
        projects: [p1, p2],
        onRemoveProject: () => {},
      }),
    );
    await openScopeMenu(m);
    await m.click(m.query('[data-project-remove="p2"]')!);
    const dialog = m.query('[data-remove-confirm="p2"]');
    assert.ok(dialog, "destructive confirm dialog must open");
    const text = dialog!.textContent || "";
    assert.ok(
      text.includes("Remove project acme/billing and delete its 3 threads?"),
    );
    assert.ok(text.includes("/tmp/billing"));
    assert.ok(
      text.includes(
        "This permanently clears conversation history for those threads.",
      ),
    );
    assert.ok(text.includes("This removes only this project entry."));
    m.unmount();
  });

  it("Cancel records nothing; Confirm records the project id", async () => {
    await clearSidebarStorage();
    const removed: string[] = [];
    const m = await mount(
      sidebar(removeThreads, {
        projects: [p1, p2],
        onRemoveProject: (id) => {
          removed.push(id);
        },
      }),
    );
    await openScopeMenu(m);
    await m.click(m.query('[data-project-remove="p2"]')!);
    await m.click(m.byText("Cancel"));
    assert.deepEqual(removed, []);
    assert.equal(m.query('[data-remove-confirm="p2"]'), null);

    await openScopeMenu(m);
    await m.click(m.query('[data-project-remove="p2"]')!);
    await m.click(m.query('[data-remove-confirm-submit="p2"]')!);
    await m.flush();
    assert.deepEqual(removed, ["p2"]);
    m.unmount();
  });

  it("singular thread count wording", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([thread({ id: "only", title: "only", projectId: "p2" })], {
        projects: [p1, p2],
        onRemoveProject: () => {},
      }),
    );
    await openScopeMenu(m);
    await m.click(m.query('[data-project-remove="p2"]')!);
    const text = m.query('[data-remove-confirm="p2"]')?.textContent || "";
    assert.ok(
      text.includes("Remove project acme/billing and delete its 1 thread?"),
    );
    m.unmount();
  });

  it("confirm submit disables while remove is in flight; second click records nothing", async () => {
    await clearSidebarStorage();
    let resolveRemove!: () => void;
    const held = new Promise<void>((resolve) => {
      resolveRemove = resolve;
    });
    const calls: string[] = [];
    const m = await mount(
      sidebar(removeThreads, {
        projects: [p1, p2],
        onRemoveProject: (id) => {
          calls.push(id);
          return held;
        },
      }),
    );
    await openScopeMenu(m);
    await m.click(m.query('[data-project-remove="p2"]')!);
    const submit = m.query(
      '[data-remove-confirm-submit="p2"]',
    ) as HTMLButtonElement | null;
    assert.ok(submit);
    assert.equal(submit!.disabled, false);

    await m.click(submit!);
    await m.flush();
    assert.deepEqual(calls, ["p2"]);

    const inflight = m.query(
      '[data-remove-confirm-submit="p2"]',
    ) as HTMLButtonElement | null;
    assert.ok(inflight);
    assert.equal(inflight!.disabled, true);
    assert.equal(inflight!.getAttribute("aria-busy"), "true");
    await m.click(inflight!);
    await m.flush();
    assert.deepEqual(calls, ["p2"]);

    await inAct(async () => {
      resolveRemove();
      await Promise.resolve();
    });
    await m.flush();
    assert.equal(m.query('[data-remove-confirm="p2"]'), null);
    m.unmount();
  });
});

describe("Sidebar unread indicators", () => {
  const baseVisited = FRESH;
  const UNREAD_THREADS = [
    thread({
      id: "visited-first",
      title: "visited first",
      status: "idle",
      createdAt: baseVisited,
      updatedAt: baseVisited,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    }),
    thread({
      id: "sel",
      title: "selected open",
      status: "idle",
      createdAt: baseVisited + 200,
      updatedAt: baseVisited + 200,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    }),
    thread({
      id: "u-mid",
      title: "unread mid",
      status: "done",
      createdAt: baseVisited + 300,
      updatedAt: baseVisited + 300,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    }),
    thread({
      id: "legacy-null",
      title: "legacy null",
      status: "idle",
      createdAt: baseVisited + 400,
      updatedAt: baseVisited + 400,
      lastVisitedAt: null,
      projectId: "p1",
    }),
    thread({
      id: "settled-unread",
      title: "settled unread",
      status: "done",
      prState: "MERGED",
      settledAt: baseVisited + 50,
      createdAt: baseVisited + 50,
      updatedAt: baseVisited + 350,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    }),
  ];

  it("marks a non-selected unread attention card (data-unread + sr-only)", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(UNREAD_THREADS, { projects: [p1], activeThreadId: "sel" }),
    );
    const card = m.query('[data-thread-card="u-mid"]');
    assert.equal(card?.getAttribute("data-unread"), "true");
    assert.ok(
      Array.from(card!.querySelectorAll("span")).some(
        (el) => (el.textContent || "").trim() === "unread",
      ),
      "card must carry an sr-only unread span",
    );
    const select = m.query(
      'button[aria-label^="Select thread: unread mid, unread"]',
    );
    assert.ok(select, "select aria-label must suffix , unread");
    const done = m.query('[data-thread-card="u-mid"] [data-status-label]');
    assert.ok(done, "unread done paints a status label");
    assert.match(done!.textContent || "", /^Done$/);
    m.unmount();
  });

  it("suppresses unread on the selected thread even when technically unread", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(UNREAD_THREADS, { projects: [p1], activeThreadId: "sel" }),
    );
    assert.equal(
      m.query('[data-thread-card="sel"]')?.getAttribute("data-unread"),
      null,
    );
    m.unmount();
  });

  it("does not paint unread for legacy null lastVisitedAt", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(UNREAD_THREADS, { projects: [p1], activeThreadId: "sel" }),
    );
    assert.equal(
      m.query('[data-thread-card="legacy-null"]')?.getAttribute("data-unread"),
      null,
    );
    m.unmount();
  });

  it("shows unread on a settled row when the shelf is open; omits unread in the header", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(UNREAD_THREADS, { projects: [p1], activeThreadId: "sel" }),
    );
    await openSettledShelf(m);
    const row = m.query('[data-thread-card="settled-unread"]');
    assert.ok(row);
    assert.equal(row!.getAttribute("data-unread"), "true");
    assert.ok(
      !(settledToggle(m).textContent || "").includes("unread"),
      "Settled (N) does not carry an unread fragment",
    );
    m.unmount();
  });

  it("selected settled unread paints no unread hook", async () => {
    await clearSidebarStorage();
    const settledVisited = thread({
      id: "settled-read",
      title: "settled and read",
      status: "done",
      prState: "MERGED",
      settledAt: baseVisited + 10,
      updatedAt: baseVisited + 10,
      lastVisitedAt: baseVisited + 10,
      projectId: "p1",
    });
    const settledSelectedUnread = thread({
      id: "settled-sel-unread",
      title: "settled selected unread",
      status: "done",
      prState: "MERGED",
      settledAt: baseVisited + 20,
      updatedAt: baseVisited + 400,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    });
    const attention = thread({
      id: "att-noise",
      title: "attention noise",
      status: "idle",
      updatedAt: baseVisited,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    });
    const m = await mount(
      sidebar([attention, settledVisited, settledSelectedUnread], {
        projects: [p1],
        activeThreadId: "settled-sel-unread",
      }),
    );
    assert.ok(m.query('[data-thread-card="settled-sel-unread"]'));
    assert.equal(
      m
        .query('[data-thread-card="settled-sel-unread"]')
        ?.getAttribute("data-unread") ?? null,
      null,
    );
    m.unmount();
  });
});

describe("Sidebar new-thread reveal", () => {
  it("flashes the new card and clears the request", async () => {
    await clearSidebarStorage();
    let handledCalls = 0;
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        revealThreadId: "busy",
        onRevealHandled: () => {
          handledCalls += 1;
        },
      }),
    );
    assert.equal(handledCalls, 1, "onRevealHandled fires exactly once");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    await m.flush();
    const card = m.query('[data-thread-card="busy"]');
    assert.ok(card, "new thread card renders");
    assert.ok(
      (card!.getAttribute("class") || "").includes("reveal"),
      "highlight flash class applied to the new card",
    );
    m.unmount();
  });

  it("unknown reveal id just clears the request", async () => {
    await clearSidebarStorage();
    let handledCalls = 0;
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        revealThreadId: "does-not-exist",
        onRevealHandled: () => {
          handledCalls += 1;
        },
      }),
    );
    assert.equal(handledCalls, 1);
    m.unmount();
  });

  it("revealing a settled thread carves it out of the collapsed shelf", async () => {
    await clearSidebarStorage();
    let handledCalls = 0;
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        revealThreadId: "merged-p2",
        onRevealHandled: () => {
          handledCalls += 1;
        },
      }),
    );
    assert.equal(handledCalls, 1);
    assert.ok(
      cardTitles(m).includes("merged-p2"),
      "revealed settled thread must be visible even while the shelf is collapsed",
    );
    m.unmount();
  });
});

describe("Sidebar status label + wait row", () => {
  const ORCH = thread({
    id: "orch",
    title: "orchestrate the fix",
    status: "done",
    updatedAt: FRESH,
  });
  const worker = (over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">) =>
    thread({
      handoffFrom: "orch",
      status: "working",
      runStartedAt: FRESH - 3 * 60 * 1000,
      updatedAt: FRESH,
      ...over,
    });

  it("status is a text label; live threads also get a title pulse", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const working = m.query('[data-thread-card="busy"] [data-status-label]');
    assert.ok(working);
    assert.match(working!.textContent || "", /^Working\b/);
    const pulse = m.query('[data-thread-card="busy"] [data-status-dot]');
    assert.ok(pulse, "working card keeps a title-adjacent pulse");
    assert.equal(pulse!.getAttribute("data-status-dot"), "working");
    const failed = m.query('[data-thread-card="broken"] [data-status-label]');
    assert.ok(failed);
    assert.match(failed!.textContent || "", /^Failed$/);
    assert.equal(
      m.query('[data-thread-card="broken"] [data-status-dot]'),
      null,
      "failed stays text-only",
    );
    m.unmount();
  });

  it("an orchestrator with live workers keeps the wait row and tooltip", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1" }), worker({ id: "w2" })]),
    );
    const row = m.query('[data-wait-row="orch"]');
    assert.ok(row, "visible wait line renders while delegation is live");
    assert.match(row!.textContent || "", /Waiting on 2 workers/);
    const label = m.query('[data-thread-card="orch"] [data-status-label]');
    assert.ok(label, "delegating parent still has a status label");
    assert.equal(
      label!.textContent,
      "Delegating",
      "a parent waiting on workers reads Delegating, not Working",
    );
    assert.match(label!.getAttribute("title") || "", /Waiting on 2 workers/);
    assert.match(label!.getAttribute("title") || "", /w1/);
    m.unmount();
  });

  it("a worker blocked on a prompt turns the wait row into attention", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1", awaitingInput: true })]),
    );
    const row = m.query('[data-wait-row="orch"]');
    assert.ok(row);
    assert.equal(row!.getAttribute("data-attention"), "true");
    const label = m.query('[data-thread-card="orch"] [data-status-label]');
    assert.ok(label);
    assert.match(label!.getAttribute("title") || "", /blocked on you/);
    m.unmount();
  });

  it("no wait row once the fan-out lands", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1", status: "done", runStartedAt: null })]),
    );
    assert.equal(m.query('[data-wait-row="orch"]'), null);
    m.unmount();
  });

  it("an idle thread with a queued follow-up says so", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([
        thread({
          id: "q",
          status: "idle",
          updatedAt: FRESH,
          queued: { prompt: "then update the changelog" },
        }),
      ]),
    );
    const label = m.query('[data-thread-card="q"] [data-status-label]');
    assert.ok(label, "a queued follow-up must still show in the sidebar");
    assert.equal(label!.textContent, "Queued");
    assert.match(label!.getAttribute("title") || "", /then update the changelog/);
    m.unmount();
  });

  it("in-agent subagents count too, without a false elapsed", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([
        thread({
          id: "solo",
          status: "working",
          runStartedAt: FRESH,
          subagents: [
            {
              id: "toolu_1",
              description: "Background research",
              agentType: "general-purpose",
              status: "running",
            },
          ],
        }),
      ]),
    );
    const label = m.query('[data-thread-card="solo"] [data-status-label]');
    assert.ok(label);
    const title = label!.getAttribute("title") || "";
    assert.match(title, /Waiting on 1 subagent:/);
    assert.match(title, /Background research/);
    assert.ok(!/Waiting on 1 subagent · \d/.test(title));
    m.unmount();
  });
});

describe("Sidebar subagent rows (#542)", () => {
  const withSubagents = (subagents: ThreadInfo["subagents"]) =>
    thread({ id: "solo", status: "working", runStartedAt: FRESH, subagents });

  it("names each running subagent under the wait row", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([
        withSubagents([
          {
            id: "toolu_1",
            description: "Background research",
            agentType: "general-purpose",
            status: "running",
          },
        ]),
      ]),
    );
    const rows = m.queryAll('[data-thread-card="solo"] [data-subagent-row]');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.textContent, "Background research");
    // The count noun distinguishes it from a forked worker thread.
    const wait = m.query('[data-wait-row="solo"]');
    assert.match(wait!.textContent || "", /Waiting on 1 subagent/);
    m.unmount();
  });

  it("a finished subagent renders no row", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([
        withSubagents([
          {
            id: "toolu_1",
            description: "Background research",
            agentType: "general-purpose",
            status: "done",
          },
        ]),
      ]),
    );
    assert.ok(!m.query('[data-thread-card="solo"] [data-subagent-row]'));
    assert.ok(!m.query('[data-wait-row="solo"]'));
    m.unmount();
  });

  it("rows are not interactive: a click reaches the card select", async () => {
    await clearSidebarStorage();
    const picked: string[] = [];
    const m = await mount(
      sidebar(
        [
          withSubagents([
            {
              id: "toolu_1",
              description: "Background research",
              agentType: "general-purpose",
              status: "running",
            },
          ]),
        ],
        { onSelectThread: (id: string) => picked.push(id) },
      ),
    );
    const row = m.query('[data-thread-card="solo"] [data-subagent-row]');
    assert.ok(row);
    assert.ok(
      !row!.querySelector("button, a, input"),
      "no interactive child inside the card's stretch-select area",
    );
    // The row itself is inert (pointer-events:none in CSS, which jsdom does
    // not model) — selection comes from the card's own stretch button.
    const select = m.query('button[aria-label^="Select thread: solo"]');
    assert.ok(select);
    await m.click(select!);
    assert.deepEqual(picked, ["solo"]);
    m.unmount();
  });

  it("caps at three named rows plus a +N more tail", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([
        withSubagents(
          ["one", "two", "three", "four", "five"].map((d, i) => ({
            id: `toolu_${i}`,
            description: d,
            agentType: null,
            status: "running" as const,
          })),
        ),
      ]),
    );
    const rows = m.queryAll('[data-thread-card="solo"] [data-subagent-row]');
    assert.deepEqual(
      rows.map((r) => r.textContent),
      ["one", "two", "three", "+2 more"],
    );
    m.unmount();
  });
});

describe("Sidebar card anatomy + hover actions", () => {
  it("three lines: slug, title, branch/PR/provider; pin lives in the overflow", async () => {
    await clearSidebarStorage();
    const pinCalls: Array<[string, boolean]> = [];
    const t = thread({
      id: "meta",
      title: "with meta",
      branch: "coder/foo-bar",
      prNumber: 12,
      prUrl: "https://github.com/acme/ledger/pull/12",
      provider: "claude",
      createdAt: FRESH + 10,
      updatedAt: FRESH + 10,
    });
    const m = await mount(
      sidebar([t], {
        projects: [p1],
        onSetPinned: (id, pinned) => pinCalls.push([id, pinned]),
        onSetSettled: () => {},
        onSetSnoozed: () => {},
      }),
    );
    const card = m.query('[data-thread-card="meta"]');
    assert.ok(card);
    assert.equal(
      (card!.querySelector("[data-card-slug]")?.textContent || "").trim(),
      "acme/ledger",
    );
    assert.match(
      card!.querySelector("[data-card-branch]")?.textContent || "",
      /coder\/foo-bar/,
    );
    const pr = card!.querySelector("[data-pr-badge]");
    assert.ok(pr);
    assert.equal(pr!.tagName, "A");
    assert.match(pr!.textContent || "", /#12/);
    assert.match(
      (card!.querySelector("[data-card-provider]")?.textContent || "").trim(),
      /claude/i,
    );
    assert.equal(card!.querySelector("[data-pin-btn]"), null);
    assert.ok(m.query('[data-snooze-btn="meta"]'));
    const settle = m.query(
      '[data-settle-btn="meta"]',
    ) as HTMLButtonElement | null;
    assert.ok(settle);
    assert.equal(settle!.disabled, false);
    await m.click(m.query('[data-more-btn="meta"]')!);
    // #592: the actions menu portals onto document.body.
    const pinItem = document.querySelector('[data-pin-item="meta"]');
    assert.ok(pinItem, "pin/unpin moved into the overflow menu");
    await m.click(pinItem as HTMLElement);
    await m.flush();
    assert.deepEqual(pinCalls, [["meta", true]]);
    m.unmount();
  });

  it("pinned block sits above the inbox with a divider; pin-flag stays on the card", async () => {
    await clearSidebarStorage();
    const older = thread({
      id: "pin-old",
      title: "old pin",
      pinnedAt: FRESH - 5000,
      createdAt: FRESH + 1,
      updatedAt: FRESH + 1,
    });
    const newer = thread({
      id: "pin-new",
      title: "new pin",
      pinnedAt: FRESH - 1000,
      createdAt: FRESH + 2,
      updatedAt: FRESH + 2,
    });
    const active = thread({
      id: "active-card",
      title: "active",
      createdAt: FRESH + 100,
      updatedAt: FRESH + 100,
    });
    const m = await mount(
      sidebar([active, newer, older], { projects: [p1] }),
    );
    const order = cardTitles(m);
    assert.deepEqual(
      order.slice(0, 3),
      ["pin-old", "pin-new", "active-card"],
      "pinned block is oldest-pin-first, then active createdAt-desc",
    );
    assert.ok(m.query("[data-pinned-divider]"));
    assert.ok(
      m.query('[data-thread-card="pin-old"] [data-pin-flag]'),
      "pin glyph stays on the card",
    );
    assert.ok(
      m
        .query('[data-thread-card="pin-old"] button[aria-label]')
        ?.getAttribute("aria-label")
        ?.includes(", pinned"),
    );
    m.unmount();
  });

  it("attention card menu settle sends override settled; settle-btn disabled while working", async () => {
    await clearSidebarStorage();
    const settleCalls: Array<{ id: string; o: string }> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onSetSettled: (id, o) => {
          settleCalls.push({ id, o });
        },
      }),
    );
    const workingSettle = m.query(
      '[data-settle-btn="busy"]',
    ) as HTMLButtonElement | null;
    assert.ok(workingSettle, "working cards still expose the settle check");
    assert.equal(workingSettle!.disabled, true);

    await m.click(m.query('[data-more-btn="finished"]')!);
    const item = document.querySelector(
      '[data-settle-item="finished"]',
    ) as HTMLButtonElement | null;
    assert.ok(item, "actions menu offers Settle thread");
    assert.equal(item!.disabled, false);
    assert.equal((item!.textContent || "").trim(), "Settle thread");
    await m.click(item!);
    await m.flush();
    assert.deepEqual(settleCalls, [{ id: "finished", o: "settled" }]);

    await m.click(m.query('[data-more-btn="busy"]')!);
    const busyItem = document.querySelector(
      '[data-settle-item="busy"]',
    ) as HTMLButtonElement | null;
    assert.ok(busyItem);
    assert.equal(busyItem!.disabled, true);
    m.unmount();
  });

  it("all active cards render — no per-group Show more cap", async () => {
    await clearSidebarStorage();
    const many = Array.from({ length: 12 }, (_, i) =>
      thread({
        id: `p1-t${i}`,
        title: `p1 thread ${i}`,
        createdAt: FRESH + 1000 - i,
        updatedAt: FRESH + 1000 - i,
        projectId: "p1",
      }),
    );
    const m = await mount(sidebar(many));
    const shown = cardTitles(m).filter((id) => id.startsWith("p1-t"));
    assert.equal(shown.length, 12, "flat list has no GROUP_ATTENTION_CAP");
    assert.ok(!m.byText("Show 4 more"));
    assert.ok(!m.byText("Show fewer"));
    m.unmount();
  });

  it("orphan cards still carry a slug", async () => {
    await clearSidebarStorage();
    const orphan = thread({
      id: "orphan-1",
      title: "orphan work",
      projectId: "p-gone",
      createdAt: FRESH + 2000,
      updatedAt: FRESH + 2000,
    });
    const m = await mount(
      sidebar([thread({ id: "home", title: "home work" }), orphan], {
        projects: [p1],
      }),
    );
    assert.ok(
      (m.query('[data-thread-card="home"] [data-card-slug]')?.textContent || "")
        .includes("acme/ledger"),
    );
    assert.ok(
      (m.query('[data-thread-card="orphan-1"] [data-card-slug]')?.textContent || "")
        .includes("unknown"),
    );
    m.unmount();
  });
});

function settingsButton(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLButtonElement {
  const el = m
    .queryAll("button")
    .find((b) => (b.textContent || "").includes("Settings"));
  assert.ok(el, "Settings footer button must render");
  return el as HTMLButtonElement;
}

describe("Sidebar update indicator (issue #138 / #673)", () => {
  it("shows an update button when one is waiting, not otherwise", async () => {
    const available = await mount(
      sidebar(THREADS, { updateState: "available" }),
    );
    const btn = available.query("[data-settings-update]") as HTMLButtonElement;
    assert.equal(btn?.textContent, "Update");
    assert.equal(btn.tagName, "BUTTON", "the label must be clickable");
    assert.equal(
      settingsButton(available).querySelector("[data-settings-update]"),
      null,
      "nested buttons are invalid; it sits beside Settings",
    );
    available.unmount();

    const staged = await mount(sidebar(THREADS, { updateState: "staged" }));
    assert.equal(
      staged.query("[data-settings-update]")?.textContent,
      "Restart",
      "Restart label present when updateState=staged",
    );
    staged.unmount();

    const none = await mount(sidebar(THREADS, { updateState: "none" }));
    assert.equal(
      none.query("[data-settings-update]"),
      null,
      "button absent when updateState=none",
    );
    none.unmount();

    const unset = await mount(sidebar(THREADS));
    assert.equal(
      unset.query("[data-settings-update]"),
      null,
      "button absent when updateState is unset",
    );
    unset.unmount();
  });

  it("Update installs, Restart relaunches, Settings stays untouched", async () => {
    let release = (): void => {};
    const downloads: number[] = [];
    const m = await mount(
      sidebar(THREADS, {
        updateState: "available",
        onDownloadUpdate: () => {
          downloads.push(1);
          return new Promise<void>((r) => {
            release = r;
          });
        },
        onOpenSettings: () => assert.fail("Update must not open Settings"),
      }),
    );
    await m.click(m.query("[data-settings-update]"));
    assert.equal(downloads.length, 1, "click downloads the update");
    const busy = m.query("[data-settings-update]") as HTMLButtonElement;
    assert.equal(busy.textContent, "Updating…");
    assert.ok(busy.disabled, "no double install while downloading");
    await inAct(async () => {
      release();
    });
    m.unmount();

    let applied = 0;
    const restart = await mount(
      sidebar(THREADS, {
        updateState: "staged",
        onApplyUpdate: () => {
          applied += 1;
        },
      }),
    );
    await restart.click(restart.query("[data-settings-update]"));
    assert.equal(applied, 1, "Restart relaunches into the staged bundle");
    restart.unmount();
  });

  it("sits next to Settings, not a far-right dot", () => {
    const css = fs.readFileSync("src/components/Sidebar.module.css", "utf8");
    assert.match(css, /\.settingsUpdate\s*\{/, "Update label has a class");
    assert.doesNotMatch(
      css,
      /\.settingsDot\s*\{/,
      "the #138 far-right 6px dot must not come back",
    );
    const body = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .match(/\.settingsUpdate(?![\w-])\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.doesNotMatch(
      body,
      /margin-left:\s*auto/,
      "margin-left:auto parked the old dot at the far end of a flex:1 button",
    );
  });
});

describe("Sidebar wordmark version (issue #673)", () => {
  it("renders the running version next to the app name", async () => {
    const m = await mount(sidebar(THREADS, { appVersion: "0.10.0" }));
    assert.equal(m.query("[data-app-version]")?.textContent, "0.10.0");
    assert.ok(
      m.text().includes("Solenta"),
      "wordmark still shows the app name",
    );
    m.unmount();
  });

  it("omits the version node when unset, and keeps the nightly pill", async () => {
    const unset = await mount(sidebar(THREADS));
    assert.equal(unset.query("[data-app-version]"), null);
    assert.equal(unset.query(".brandChannel"), null);
    unset.unmount();

    const nightly = await mount(
      sidebar(THREADS, { appVersion: "0.10.0", channel: "nightly" }),
    );
    assert.equal(nightly.query("[data-app-version]")?.textContent, "0.10.0");
    assert.equal(nightly.query(".brandChannel")?.textContent, "nightly");
    nightly.unmount();
  });
});

function portalMenu(): HTMLElement | null {
  return document.querySelector("[data-context-menu]");
}

describe("Sidebar thread-actions menu chrome (#582)", () => {
  const MENU_THREAD = [
    thread({
      id: "menu-src",
      title: "menu source",
      status: "idle",
      updatedAt: FRESH + 80,
      projectId: "p1",
    }),
    thread({
      id: "menu-noise",
      title: "other project decoy",
      status: "idle",
      updatedAt: FRESH + 10,
      projectId: "p2",
    }),
  ];

  async function openMenu() {
    const m = await mount(
      sidebar(MENU_THREAD, {
        projects: [p1, p2],
        onSetSnoozed: () => {},
        onSetPinned: () => {},
        onSetMuted: () => {},
        onRenameThread: () => {},
        onSetSettled: () => {},
        onFork: () => {},
      }),
    );
    await m.click(m.query('[data-more-btn="menu-src"]'));
    const menu = portalMenu();
    assert.ok(menu, "… menu must open");
    return { m, menu };
  }

  it("portals the menu onto document.body so sticky headers cannot paint through it", async () => {
    const { m, menu } = await openMenu();
    assert.equal(menu.parentElement, document.body);
    assert.equal(menu.style.position, "fixed");
    const list = m.query("[data-sidebar-list]");
    assert.ok(list, "sidebar list");
    assert.ok(
      !list.contains(menu),
      "a menu inside the scroll container is what sticky group headers painted through",
    );
    m.unmount();
  });

  it("snooze rows use the preset label, not a wrapping Snooze · prefix", async () => {
    const { m, menu } = await openMenu();
    const trigger = menu.querySelector("[data-snooze-item]") as HTMLElement | null;
    assert.ok(trigger, "Snooze is one first-level item");
    await m.click(trigger);
    const hour = document.querySelector('[data-snooze-preset="hour"]') as HTMLElement | null;
    assert.ok(hour, "hour preset is listed after opening Snooze");
    const text = (hour!.textContent || "").replace(/\s+/g, " ").trim();
    assert.match(text, /In 1 hour/, "preset label stays");
    assert.equal(text.includes("Snooze ·"), false);
    m.unmount();
  });

  it("mousedown outside the menu closes it", async () => {
    const { m } = await openMenu();
    const search = m.query("input") as HTMLElement | null;
    assert.ok(search, "search field is outside the menu");
    await inAct(() => {
      search.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await m.flush();
    assert.ok(!portalMenu(), "outside pointerdown dismisses the portal");
    m.unmount();
  });
});

const extraProviders: ProviderInfo[] = [
  ...providers,
  {
    id: "grok",
    name: "Grok",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

describe("Sidebar snooze nested submenu (#583)", () => {
  const MENU_THREAD = [
    thread({
      id: "menu-src",
      title: "menu source",
      status: "idle",
      updatedAt: FRESH + 80,
      projectId: "p1",
    }),
    thread({
      id: "menu-noise",
      title: "other project decoy",
      status: "idle",
      updatedAt: FRESH + 10,
      projectId: "p2",
    }),
  ];

  async function openMenu() {
    const m = await mount(
      sidebar(MENU_THREAD, {
        projects: [p1, p2],
        providers: extraProviders,
        onSetSnoozed: () => {},
        onSetPinned: () => {},
        onSetMuted: () => {},
        onRenameThread: () => {},
        onSetSettled: () => {},
        onFork: () => {},
      }),
    );
    await m.click(m.query('[data-more-btn="menu-src"]'));
    const menu = portalMenu();
    assert.ok(menu, "… menu must open");
    return { m, menu };
  }

  it("first-level menu has one Snooze item; presets stay nested", async () => {
    const { m, menu } = await openMenu();
    const snooze = menu.querySelector("[data-snooze-item]") as HTMLElement | null;
    assert.ok(snooze, "single Snooze item on the first level");
    assert.ok(!menu.querySelector("[data-snooze-preset]"), "presets are children");
    assert.ok(menu.querySelector("[data-fork-btn]"), "Fork stays first-level");
    await m.click(snooze);
    const sub = document.querySelector("[data-context-submenu]");
    assert.ok(sub, "Snooze opens a flyout submenu (T3 children), not a drill-in");
    assert.ok(portalMenu(), "parent menu stays mounted");
    assert.ok(sub!.querySelector('[data-snooze-preset="hour"]'));
    m.unmount();
  });

  it("already-snoozed card offers Wake instead of a Snooze submenu", async () => {
    const frozen = FRESH;
    const m = await mount(
      <ThreadCard
        thread={thread({
          id: "t-snoozed",
          title: "already snoozed",
          snoozedUntil: frozen + 60 * 60 * 1000,
          snoozedAt: frozen,
        })}
        slug="acme/ledger"
        providers={providers}
        active={false}
        now={frozen}
        onSelect={() => {}}
        onSetSnoozed={() => {}}
      />,
    );
    await m.click(m.query('[data-more-btn="t-snoozed"]'));
    const menu = portalMenu();
    assert.ok(menu);
    assert.ok(!menu.querySelector("[data-snooze-item]"), "no Snooze parent");
    assert.ok(menu.querySelector("[data-snooze-clear]"), "Wake / clear hook");
    m.unmount();
  });

  it("keeps the menu on document.body while the snooze submenu is open", async () => {
    const { m, menu } = await openMenu();
    await m.click(menu.querySelector("[data-snooze-item]"));
    assert.ok(document.querySelector("[data-context-submenu]"));
    assert.equal(portalMenu()?.parentElement, document.body);
    m.unmount();
  });

  it("ArrowRight on Snooze drills into the submenu and keeps focus inside", async () => {
    const { m, menu } = await openMenu();
    const snooze = menu.querySelector("[data-snooze-item]") as HTMLElement;
    snooze.focus();
    // Portal lives on document.body, outside the mount container, so
    // pressFocused would reject. press() still hits the focused item.
    await m.press(snooze, "ArrowRight");
    const sub = document.querySelector("[data-context-submenu]");
    assert.ok(sub, "ArrowRight opens the submenu");
    assert.ok(menu.contains(document.activeElement) || sub!.contains(document.activeElement));
    m.unmount();
  });

  it("ArrowDown from Snooze moves to the next item without opening the submenu", async () => {
    const { m, menu } = await openMenu();
    const snooze = menu.querySelector("[data-snooze-item]") as HTMLElement;
    snooze.focus();
    await m.press(snooze, "ArrowDown");
    // Pin sits between Snooze and Fork in the flat-sidebar menu.
    assert.equal(
      (document.activeElement as HTMLElement | null)?.getAttribute("data-pin-item"),
      "menu-src",
    );
    assert.ok(!document.querySelector("[data-context-submenu]"));
    m.unmount();
  });

  it("Escape closes the whole menu", async () => {
    const { m, menu } = await openMenu();
    const snooze = menu.querySelector("[data-snooze-item]") as HTMLElement;
    await m.click(snooze);
    const focused = document.activeElement as HTMLElement;
    await m.press(focused, "Escape");
    assert.ok(!portalMenu());
    m.unmount();
  });

  it("clicking Fork still works without keyboard", async () => {
    let forked: string | null = null;
    const m = await mount(
      sidebar(MENU_THREAD, {
        projects: [p1, p2],
        providers: extraProviders,
        onSetSnoozed: () => {},
        onSetPinned: () => {},
        onFork: (id) => {
          forked = id;
        },
      }),
    );
    await m.click(m.query('[data-more-btn="menu-src"]'));
    const fork = portalMenu()?.querySelector("[data-fork-btn]") as HTMLElement | null;
    assert.ok(fork);
    await m.click(fork);
    assert.equal(forked, "menu-src");
    assert.ok(!portalMenu());
    m.unmount();
  });

  it("right-click on the card opens the same portal menu", async () => {
    const m = await mount(
      sidebar(MENU_THREAD, {
        projects: [p1, p2],
        onSetSnoozed: () => {},
        onFork: () => {},
      }),
    );
    const card = m.query('[data-thread-card="menu-src"]') as HTMLElement;
    await inAct(() => {
      card.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    await m.flush();
    assert.ok(portalMenu(), "contextmenu on the row is how T3 opens this menu");
    m.unmount();
  });

  it("hover slot still has a snooze clock and a settle check", async () => {
    const m = await mount(
      sidebar(MENU_THREAD, {
        projects: [p1, p2],
        onSetSnoozed: () => {},
        onSetSettled: () => {},
      }),
    );
    assert.ok(m.query('[data-snooze-btn="menu-src"]'), "T3 hover snooze");
    assert.ok(m.query('[data-settle-btn="menu-src"]'), "T3 hover settle");
    m.unmount();
  });
});

/**
 * React.memo(ThreadCard) stores the inner function on `.type`. Wrap it so a
 * no-op threads:changed can assert cards did not re-render (issue #617).
 */
function countThreadCardRenders(): { count: () => number; restore: () => void } {
  const memo = ThreadCard as unknown as { type: (props: unknown) => unknown };
  const inner = memo.type;
  let n = 0;
  memo.type = ((props: unknown) => {
    n += 1;
    return inner(props);
  }) as typeof inner;
  return {
    count: () => n,
    restore: () => {
      memo.type = inner;
    },
  };
}

describe("threads:changed does not rebuild unchanged cards (#617)", () => {
  it("a clone of the current list does not re-render ThreadCard", async () => {
    const probe = countThreadCardRenders();
    try {
      const rows = [
        thread({ id: "keep-a", title: "keep a", projectId: "p1" }),
        thread({ id: "keep-b", title: "keep b", projectId: "p1" }),
      ];
      const fake = createFakeCoder({
        projects: [p1],
        threads: rows,
      });
      const shell = await mount(<div />);
      installFakeCoder(fake);
      shell.unmount();
      const m = await mount(<App />);
      // threads.get stamps lastVisitedAt on the selected row; clone THAT
      // list, not the fixtures, or the selected card would correctly re-render.
      const live = await fake.api.threads.list();
      await m.flush();
      const before = probe.count();
      assert.ok(before > 0, "cards must have rendered on boot");

      await inAct(() =>
        fake.emitThreads(JSON.parse(JSON.stringify(live)) as ThreadInfo[]),
      );
      await m.flush();

      assert.equal(
        probe.count(),
        before,
        "no-op threads:changed must not re-render memo'd cards",
      );
      m.unmount();
    } finally {
      probe.restore();
    }
  });
});

describe("Sidebar filters (#553)", () => {
  const moreProviders: ProviderInfo[] = [
    ...providers,
    {
      id: "codex",
      name: "Codex",
      available: true,
      supportsResume: true,
      models: [],
      modelInfo: [],
      efforts: [],
    },
  ];

  const filterThreadsList: ThreadInfo[] = [
    ...THREADS,
    thread({
      id: "waiting-you",
      title: "needs input",
      status: "working",
      awaitingInput: true,
      runStartedAt: FRESH,
      createdAt: FRESH + 60,
      updatedAt: FRESH + 60,
      projectId: "p1",
    }),
    thread({
      id: "codex-idle",
      title: "codex idle",
      status: "idle",
      provider: "codex",
      createdAt: FRESH + 5,
      updatedAt: FRESH + 5,
      projectId: "p1",
    }),
    thread({
      id: "archived-old",
      title: "archived old",
      status: "idle",
      archived: true,
      createdAt: FRESH - DAY_MS,
      updatedAt: FRESH - DAY_MS,
      projectId: "p1",
    }),
  ];

  async function openStatusMenu(
    m: Awaited<ReturnType<typeof mount>>,
  ): Promise<void> {
    if (!m.query("[data-status-filter-menu]")) {
      const btn = m.query("[data-status-filter-trigger]");
      assert.ok(btn, "status filter trigger");
      await m.click(btn);
      await m.flush();
    }
  }

  async function openProviderMenu(
    m: Awaited<ReturnType<typeof mount>>,
  ): Promise<void> {
    if (!m.query("[data-provider-filter-menu]")) {
      const btn = m.query("[data-provider-filter-trigger]");
      assert.ok(btn, "provider filter trigger");
      await m.click(btn);
      await m.flush();
    }
  }

  async function openGroupMenu(
    m: Awaited<ReturnType<typeof mount>>,
  ): Promise<void> {
    if (!m.query("[data-group-by-menu]")) {
      const btn = m.query("[data-group-by-trigger]");
      assert.ok(btn, "group-by trigger");
      await m.click(btn);
      await m.flush();
    }
  }

  it("filters to waiting-on-you and keeps the open thread visible", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(filterThreadsList, {
        projects: [p1, p2],
        activeThreadId: "billing-idle",
      }),
    );
    await openStatusMenu(m);
    await m.click(m.query('[data-status-filter="waiting"]')!);
    await m.flush();
    const ids = cardTitles(m);
    assert.ok(ids.includes("waiting-you"));
    assert.ok(ids.includes("billing-idle"), "#70 carve-out keeps the open thread");
    assert.ok(!ids.includes("busy"));
    assert.ok(!ids.includes("broken"));
    m.unmount();
  });

  it("filters to failed and persists the status", async () => {
    await clearSidebarStorage();
    const m1 = await mount(
      sidebar(filterThreadsList, { projects: [p1, p2] }),
    );
    await openStatusMenu(m1);
    await m1.click(m1.query('[data-status-filter="failed"]')!);
    await m1.flush();
    assert.deepEqual(cardTitles(m1), ["broken"]);
    m1.unmount();

    const m2 = await mount(
      sidebar(filterThreadsList, { projects: [p1, p2] }),
    );
    assert.match(
      m2.query("[data-status-filter-trigger]")!.textContent || "",
      /Failed/,
    );
    assert.deepEqual(cardTitles(m2), ["broken"]);
    m2.unmount();
  });

  it("provider chips are multi-select and AND with status", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(filterThreadsList, {
        projects: [p1, p2],
        providers: moreProviders,
      }),
    );
    await openProviderMenu(m);
    assert.ok(m.query('[data-provider-filter="claude"]'));
    await m.click(m.query('[data-provider-filter="codex"]')!);
    await m.flush();
    const afterProvider = cardTitles(m);
    assert.ok(afterProvider.includes("codex-idle"));
    assert.ok(!afterProvider.includes("busy"));
    await openStatusMenu(m);
    await m.click(m.query('[data-status-filter="idle"]')!);
    await m.flush();
    assert.ok(cardTitles(m).includes("codex-idle"));
    assert.ok(!cardTitles(m).includes("busy"));
    m.unmount();
  });

  it("archived status expands the settled shelf", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(filterThreadsList, { projects: [p1, p2] }),
    );
    assert.equal(m.query('[data-thread-card="archived-old"]'), null);
    await openStatusMenu(m);
    await m.click(m.query('[data-status-filter="archived"]')!);
    await m.flush();
    assert.ok(m.query('[data-thread-card="archived-old"]'));
    assert.equal(
      settledToggle(m).getAttribute("aria-expanded"),
      "true",
    );
    m.unmount();
  });

  it("group by project restores per-project headers", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.equal(m.query("[data-filter-group]"), null);
    await openGroupMenu(m);
    await m.click(m.query('[data-group-by="project"]')!);
    await m.flush();
    assert.ok(m.query('[data-filter-group="p1"]'));
    assert.ok(m.query('[data-filter-group="p2"]'));
    assert.equal(m.query("[data-group-chevron]"), null, "retired selector stays gone");
    assert.equal(m.query("[data-pinned-divider]"), null);
    m.unmount();
  });

  it("group by status sections the active list", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(filterThreadsList, { projects: [p1, p2] }),
    );
    await openGroupMenu(m);
    await m.click(m.query('[data-group-by="status"]')!);
    await m.flush();
    assert.ok(m.query('[data-filter-group="running"]'));
    assert.ok(m.query('[data-filter-group="waiting"]'));
    assert.ok(m.query('[data-filter-group="failed"]'));
    assert.ok(m.query('[data-filter-group="idle"]'));
    m.unmount();
  });

  it("search ANDs with status without a second message scan", async () => {
    await clearSidebarStorage();
    let calls = 0;
    const m = await mount(
      sidebar(filterThreadsList, {
        projects: [p1, p2],
        searchThreads: async ({ query }) => {
          calls += 1;
          return filterThreadsList.filter((t) => t.title.includes(query));
        },
      }),
    );
    await m.type(searchInput(m), "work");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    const afterSearch = calls;
    assert.ok(afterSearch >= 1, "search ran");
    assert.ok(cardTitles(m).includes("busy"));
    assert.ok(cardTitles(m).includes("broken"));
    await openStatusMenu(m);
    await m.click(m.query('[data-status-filter="failed"]')!);
    await m.flush();
    assert.equal(calls, afterSearch, "status filter does not re-scan messages");
    assert.deepEqual(cardTitles(m), ["broken"]);
    m.unmount();
  });
});

describe("Sidebar thread tags (#789)", () => {
  const TAGGED = [
    thread({
      id: "tagged-work",
      title: "tagged work",
      status: "idle",
      updatedAt: FRESH + 50,
      projectId: "p1",
      tags: ["work"],
    }),
    thread({
      id: "tagged-both",
      title: "tagged both",
      status: "idle",
      updatedAt: FRESH + 40,
      projectId: "p1",
      tags: ["work", "bug"],
    }),
    thread({
      id: "plain",
      title: "plain",
      status: "idle",
      updatedAt: FRESH + 30,
      projectId: "p1",
    }),
  ];

  it("renders tag chips on tagged cards only", async () => {
    const m = await mount(sidebar(TAGGED, { projects: [p1] }));
    assert.ok(m.query('[data-tag-row="tagged-work"]'));
    assert.ok(m.query('[data-tag-chip="work"]'));
    assert.ok(m.query('[data-tag-chip="bug"]'));
    assert.equal(m.query('[data-tag-row="plain"]'), null);
    m.unmount();
  });

  it("menu 'Edit tags' opens the chip editor; Enter adds, × removes", async () => {
    const calls: { threadId: string; tags: string[] }[] = [];
    const m = await mount(
      sidebar(TAGGED, {
        projects: [p1],
        onSetTags: (threadId, tags) => {
          calls.push({ threadId, tags });
        },
      }),
    );
    await m.click(m.query('[data-more-btn="tagged-both"]'));
    const menu = portalMenu();
    assert.ok(menu, "… menu must open");
    const editItem = menu.querySelector("[data-edit-tags]");
    assert.ok(editItem, "Edit tags item");
    await m.click(editItem as HTMLElement);
    await m.flush();
    const input = m.query('[data-tag-input="tagged-both"]');
    assert.ok(input, "tag editor opens");
    await m.type(input, "urgent");
    await inAct(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await m.flush();
    assert.deepEqual(calls.at(-1), {
      threadId: "tagged-both",
      tags: ["work", "bug", "urgent"],
    });
    await m.click(m.query('[data-tag-remove="work"]')!);
    await m.flush();
    assert.deepEqual(calls.at(-1), { threadId: "tagged-both", tags: ["bug"] });
    m.unmount();
  });

  it("group by tag sections the active list, multi-tag threads appear twice", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(TAGGED, { projects: [p1] }));
    await m.click(m.query("[data-group-by-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-group-by="tag"]')!);
    await m.flush();
    assert.ok(m.query('[data-filter-group="bug"]'));
    assert.ok(m.query('[data-filter-group="work"]'));
    assert.ok(m.query('[data-filter-group="untagged"]'));
    m.unmount();
  });

  it("tag trigger hides until a tag exists; filter narrows the list", async () => {
    await clearSidebarStorage();
    const untagged = await mount(sidebar(THREADS, { projects: [p1] }));
    assert.equal(
      untagged.query("[data-tag-filter-trigger]"),
      null,
      "no tags anywhere → no tag filter trigger",
    );
    untagged.unmount();

    const m = await mount(sidebar(TAGGED, { projects: [p1] }));
    await m.click(m.query("[data-tag-filter-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-tag-filter="work"]')!);
    await m.flush();
    const ids = cardTitles(m);
    assert.ok(ids.includes("tagged-work"));
    assert.ok(ids.includes("tagged-both"));
    assert.ok(!ids.includes("plain"));
    m.unmount();
  });
});
