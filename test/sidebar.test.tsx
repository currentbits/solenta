/**
 * Sidebar: project collapse + global Later shelf (#567), jsdom.
 *
 * #567: two zones — Active project groups (pinned rows first) and ONE global
 * "Later · N" shelf at the bottom holding snoozed + settled + archived rows.
 * Fresh done stays in project groups; MERGED goes to the shelf.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { inAct, mount } from "./support/dom";
import { Sidebar, SettledRow } from "../src/components/Sidebar";
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
    projectError?: string | null;
    revealThreadId?: string | null;
    onRevealHandled?: () => void;
    updateState?: UpdateStatus["state"] | null;
  } = {},
) {
  const projects = over.projects ?? [p1];
  return (
    <Sidebar
      appName="Solenta"
      searchPlaceholder="Search threads..."
      projectsHeader="All projects"
      projects={projects}
      threads={threads}
      providers={providers}
      activeThreadId={over.activeThreadId ?? null}
      onSelectThread={over.onSelectThread ?? (() => {})}
      onCreateThread={() => {}}
      onAddProject={() => {}}
      onRemoveProject={over.onRemoveProject}
      projectError={over.projectError ?? null}
      onSetSettled={over.onSetSettled}
      onSetArchived={over.onSetArchived}
      revealThreadId={over.revealThreadId ?? null}
      onRevealHandled={over.onRevealHandled}
      updateState={over.updateState}
      searchThreads={async ({ query }) =>
        threads.filter((t) => t.title.includes(query))
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
    updatedAt: FRESH + 50,
    projectId: "p1",
  }),
  thread({
    id: "finished",
    title: "finished work",
    status: "done",
    updatedAt: FRESH + 40,
    projectId: "p1",
  }),
  thread({
    id: "merged-p1",
    title: "merged ledger",
    status: "done",
    prState: "MERGED",
    settledAt: FRESH + 30,
    updatedAt: FRESH + 30,
    projectId: "p1",
  }),
  thread({
    id: "broken",
    title: "broken work",
    status: "failed",
    updatedAt: FRESH + 20,
    projectId: "p1",
  }),
  thread({
    id: "merged-p2",
    title: "merged billing",
    status: "done",
    prState: "MERGED",
    settledAt: FRESH + 35,
    updatedAt: FRESH + 35,
    projectId: "p2",
  }),
  thread({
    id: "billing-idle",
    title: "billing idle",
    status: "idle",
    updatedAt: FRESH + 10,
    projectId: "p2",
  }),
];

function cardTitles(m: Awaited<ReturnType<typeof mount>>): string[] {
  return m
    .queryAll("[data-thread-card]")
    .map((el) => el.getAttribute("data-thread-card") || "");
}

function groupHeader(
  m: Awaited<ReturnType<typeof mount>>,
  slug: string,
): HTMLElement {
  const el = m
    .queryAll("button")
    .find((b) => (b.textContent || "").includes(slug));
  assert.ok(el, `group header for ${slug} must render`);
  return el as HTMLElement;
}

/** ALL PROJECTS section header (collapse/expand all). */
function allProjectsHeader(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLButtonElement {
  const el = m.query(
    "[data-projects-section]",
  ) as HTMLButtonElement | null;
  assert.ok(el, "ALL PROJECTS section header must render");
  return el;
}

function groupChevron(
  m: Awaited<ReturnType<typeof mount>>,
  groupKey: string,
): HTMLElement {
  const el = m.query(
    `[data-group-chevron="${groupKey}"]`,
  ) as HTMLElement | null;
  assert.ok(el, `group chevron for ${groupKey} must render`);
  return el;
}

function settledTailHeader(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLButtonElement {
  // #567: the shelf header reads "Later · N" (snoozed + settled + archived).
  const header = m
    .queryAll("button")
    .find((b) => (b.textContent || "").includes("Later ·")) as
    | HTMLButtonElement
    | undefined;
  assert.ok(header, "global Later · N header must exist");
  return header;
}

/** Install jsdom via a throwaway mount, then clear localStorage for a clean slate. */
async function clearSidebarStorage(): Promise<void> {
  const shell = await mount(<div />);
  window.localStorage.clear();
  shell.unmount();
}

/** Sorted keys from coder.sidebar.collapsedGroups (empty when missing/bad). */
function collapsedFromStorage(): string[] {
  try {
    const raw = window.localStorage.getItem("coder.sidebar.collapsedGroups");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String).sort() : [];
  } catch {
    return [];
  }
}

/** Sorted keys from coder.sidebar.settledCollapsed (empty = tail expanded). */
function settledCollapsedFromStorage(): string[] {
  try {
    const raw = window.localStorage.getItem("coder.sidebar.settledCollapsed");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String).sort() : [];
  } catch {
    return [];
  }
}

describe("t3 paging constants are fixed facts", () => {
  // Literal pins: a symbolic test that reads SETTLED_TAIL_* survives mutating
  // 10→4 or 25→1. These asserts die if the constants drift from t3.
  it("INITIAL is 10 and PAGE is 25", () => {
    assert.equal(SETTLED_TAIL_INITIAL_COUNT, 10, "t3 SETTLED_TAIL_INITIAL_COUNT");
    assert.equal(SETTLED_TAIL_PAGE_COUNT, 25, "t3 SETTLED_TAIL_PAGE_COUNT");
  });
});

describe("Sidebar project groups keep attention only (round 40)", () => {
  it("keeps fresh done in the project list; hides MERGED from project groups", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const ids = cardTitles(m);
    assert.ok(ids.includes("busy"), "working stays in the project list");
    assert.ok(ids.includes("finished"), "fresh done stays visible (not settled)");
    assert.ok(ids.includes("broken"), "failed stays visible");
    assert.ok(ids.includes("billing-idle"), "other project's attention shows");
    // The tail is expanded by default (t3), so merged rows DO render — but
    // only as slim settled rows, never as group cards.
    const onlySettledRows = (id: string) =>
      m
        .queryAll(`[data-thread-card="${id}"]`)
        .every((el) => el.getAttribute("data-settled") === "true");
    assert.ok(
      onlySettledRows("merged-p1"),
      "MERGED must leave the project group for the global tail",
    );
    assert.ok(
      onlySettledRows("merged-p2"),
      "MERGED from a second project also leaves its group",
    );
    m.unmount();
  });

  it("group header carries no working/unread summary (t3 flatten #566)", async () => {
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const header = groupHeader(m, "acme/ledger").textContent || "";
    assert.ok(
      !header.includes("working"),
      "groupHeaderSummary was deleted — no working count on headers",
    );
    assert.ok(!header.includes("unread"), "no unread count on headers either");
    m.unmount();
  });

  it("archived wins over settled: MERGED+archived renders as a Later archived row", async () => {
    // #567: the per-group "N archived" toggle is gone; archived threads live
    // on the Later shelf as dim rows with an unarchive hover action.
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
      "per-group archived toggle is gone (#567)",
    );
    assert.ok(
      (settledTailHeader(m).textContent || "").includes("Later · 1"),
      "archived thread counts into the Later shelf header",
    );
    const row = m.query('[data-thread-card="gone"]');
    assert.ok(row, "archived thread renders on the Later shelf");
    assert.equal(
      row!.getAttribute("data-archived"),
      "true",
      "archived beats settled: the row is archived, not settled",
    );
    assert.equal(
      row!.getAttribute("data-settled"),
      null,
      "archived MERGED must not present as a settled row",
    );
    assert.ok(
      !Array.from(row!.querySelectorAll("button")).some(
        (b) => b.getAttribute("aria-label") === "Keep thread active",
      ),
      "archived rows have no keep-active affordance",
    );
    const unarchive = m.query(
      '[data-unarchive-btn="gone"]',
    ) as HTMLButtonElement | null;
    assert.ok(unarchive, "archived row offers an unarchive hover button");
    assert.equal((unarchive!.textContent || "").trim(), "unarchive");
    await m.click(unarchive!);
    assert.deepEqual(
      archiveCalls,
      [["gone", false]],
      "unarchive calls setArchived(id, false)",
    );
    m.unmount();
  });

  it("shows Nothing active when a project's threads are all on the Later shelf", async () => {
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
          // Second project so the list is not a single empty shell.
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
    assert.ok(
      m.text().includes("Nothing active"),
      "fully-settled project must not claim No threads yet",
    );
    assert.ok(
      !m
        .queryAll("[class*='emptyThreads']")
        .some((el) => (el.textContent || "") === "No threads yet"),
      "the empty-group copy for an all-Later project is Nothing active",
    );
    m.unmount();
  });
});

describe("Sidebar global settled tail (round 40)", () => {
  it("expands by default (t3) with a Later · N header spanning projects", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const header = settledTailHeader(m);
    assert.ok(
      (header.textContent || "").includes("Later · 2"),
      "shelf header counts settled from every project",
    );
    assert.equal(
      header.getAttribute("aria-expanded"),
      "true",
      "tail is expanded by default (t3): settle transitions stay visible",
    );
    assert.ok(cardTitles(m).includes("merged-p1"));
    assert.ok(cardTitles(m).includes("merged-p2"));
    m.unmount();
  });

  it("collapsing the tail persists across remounts; absence of the key means expanded", async () => {
    await clearSidebarStorage();
    const m1 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m1.click(settledTailHeader(m1));
    assert.equal(
      settledTailHeader(m1).getAttribute("aria-expanded"),
      "false",
      "click collapses",
    );
    assert.ok(!cardTitles(m1).includes("merged-p1"));
    assert.deepEqual(
      settledCollapsedFromStorage(),
      ["tail"],
      "collapse persists via coder.sidebar.settledCollapsed",
    );
    m1.unmount();

    const m2 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.equal(
      settledTailHeader(m2).getAttribute("aria-expanded"),
      "false",
      "stored collapse survives a remount",
    );
    assert.ok(!cardTitles(m2).includes("merged-p1"));
    m2.unmount();
    await clearSidebarStorage();
  });

  it("Settle all on the shelf bar settles attention threads, skips working and pinned", async () => {
    const calls: Array<[string, string]> = [];
    const withPinned = [
      ...THREADS,
      // #567: pinned rows are Active but Settle all must leave them alone.
      thread({
        id: "pinned-idle",
        title: "pinned idle",
        status: "idle",
        pinnedAt: FRESH,
        updatedAt: FRESH + 5,
        projectId: "p1",
      }),
    ];
    const m = await mount(
      sidebar(withPinned, {
        projects: [p1, p2],
        onSetSettled: (id, o) => calls.push([id, o]),
      }),
    );
    const btn = m.query("[data-settle-all]") as HTMLButtonElement | null;
    assert.ok(btn, "Settle all button must render on the Later shelf bar");
    await m.click(btn!);
    assert.deepEqual(
      calls.map(([id]) => id).sort(),
      ["billing-idle", "broken", "finished"],
      "settles every attention thread except the working and pinned ones",
    );
    assert.ok(
      calls.every(([, o]) => o === "settled"),
      "payload is the settled override",
    );
    m.unmount();
  });

  it("shows settled from every project, newest first; collapse hides them again", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.equal(settledTailHeader(m).getAttribute("aria-expanded"), "true");
    const ids = cardTitles(m);
    assert.ok(ids.includes("merged-p1"), "p1 settled appears in the global tail");
    assert.ok(ids.includes("merged-p2"), "p2 settled appears in the same tail");
    const i2 = ids.indexOf("merged-p2");
    const i1 = ids.indexOf("merged-p1");
    assert.ok(i2 >= 0 && i1 >= 0 && i2 < i1, "newest-settled first across projects");
    await m.click(settledTailHeader(m));
    assert.ok(
      !cardTitles(m).includes("merged-p1"),
      "collapsing the tail hides its rows again",
    );
    m.unmount();
    await clearSidebarStorage();
  });

  it("pages the shelf: 40 settled → 10 visible, Show more → 35, header stays Later · 40", async () => {
    // Literal 40 / 10 / 35 so mutating INITIAL 10→4 or PAGE 25→1 fails.
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
        updatedAt: FRESH + 2000,
        projectId: "p1",
      }),
    );
    const m = await mount(sidebar(many, { projects: [p1, p2] }));
    const header = settledTailHeader(m);
    assert.ok(
      (header.textContent || "").includes("Later · 40"),
      "header reports the full Later count, not the page size",
    );
    // Default-expanded (t3): the first page is already on screen.
    const shown = cardTitles(m).filter((id) => id.startsWith("s"));
    assert.equal(shown.length, 10, "initial expand shows exactly 10 (t3 INITIAL)");
    const more = m.byText("Show more");
    assert.ok(more, "Show more appears when more than 10 settled remain");
    await m.click(more!);
    const after = cardTitles(m).filter((id) => id.startsWith("s"));
    assert.equal(
      after.length,
      35,
      "one Show more adds exactly 25 (t3 PAGE) → 10+25=35",
    );
    assert.ok(
      (header.textContent || "").includes("Later · 40"),
      "header still says Later · 40 after paging",
    );
    m.unmount();
  });

  it("exactly 10 settled shows no Show more (default-expanded)", async () => {
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
    const header = settledTailHeader(m);
    assert.ok((header.textContent || "").includes("Later · 10"));
    assert.equal(
      cardTitles(m).filter((id) => id.startsWith("exact")).length,
      10,
    );
    // Prefer a boolean check: assert.equal(el, null) can hang serialising a DOM node.
    assert.equal(
      m.byText("Show more") != null,
      false,
      "Show more must not appear at exactly INITIAL (dies if > becomes >=)",
    );
    m.unmount();
  });

  it("SettledRow age text uses settledAt when it diverges from updatedAt", async () => {
    // The shared-resolver invariant: label and sort use one clock. Fixtures
    // with settledAt === updatedAt cannot catch a label that reads updatedAt.
    const wrapUp = FRESH - 5 * DAY_MS; // ~5d ago
    const recentTouch = FRESH; // "now"
    const t = thread({
      id: "divergent-age",
      title: "divergent wrap up",
      status: "done",
      prState: "MERGED",
      settledAt: wrapUp,
      updatedAt: recentTouch,
      projectId: "p1",
    });
    // Mount SettledRow directly so we control `now` (Sidebar ticks Date.now()).
    const m = await mount(
      <SettledRow
        thread={t}
        slug="acme/ledger"
        active={false}
        now={FRESH}
        onSelect={() => {}}
      />,
    );
    const age = m.query(".settledAge") || m.container.querySelector("[class*='settledAge']");
    assert.ok(age, "settled age element must render");
    assert.equal(
      (age!.textContent || "").trim(),
      "5d",
      "age label must come from settledAt (5d), not updatedAt (now)",
    );
    assert.notEqual(
      (age!.textContent || "").trim(),
      "now",
      "reading updatedAt would show now and fail this pin",
    );
    m.unmount();
  });

  it("carve-out: selected settled thread stays visible while the tail is collapsed", async () => {
    // Selected is deliberately NOT index 0 of THREADS (busy is 0).
    await clearSidebarStorage();
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        activeThreadId: "merged-p2",
      }),
    );
    // Default is expanded (t3); collapse to exercise the carve-out.
    await m.click(settledTailHeader(m));
    assert.ok(
      cardTitles(m).includes("merged-p2"),
      "open settled thread must never vanish behind the collapsed shelf",
    );
    assert.ok(
      !cardTitles(m).includes("merged-p1"),
      "other settled rows stay hidden while collapsed",
    );
    m.unmount();
    await clearSidebarStorage();
  });

  it("opening a settled thread selects it and does not call setSettled", async () => {
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
    const select = m.query(
      'button[aria-label="Select thread: merged billing"]',
    );
    assert.ok(select, "settled row is selectable");
    await m.click(select!);
    assert.deepEqual(selects, ["merged-p2"], "click navigates only");
    assert.equal(
      settleCalls.length,
      0,
      "opening a settled thread must NOT un-settle (history stays readable)",
    );
    m.unmount();
  });

  it("Keep thread active on a settled row calls setSettled active", async () => {
    const settleCalls: Array<{ id: string; o: string }> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onSetSettled: (id, o) => {
          settleCalls.push({ id, o });
        },
      }),
    );
    const keep = m
      .queryAll("button")
      .find((b) => b.getAttribute("aria-label") === "Keep thread active") as
      | HTMLButtonElement
      | undefined;
    assert.ok(keep, "settled rows keep the un-settle hover affordance");
    await m.click(keep!);
    assert.equal(settleCalls.length, 1);
    assert.equal(settleCalls[0]!.o, "active");
    m.unmount();
  });

  it("attention card menu settle sends override settled (payload, not label)", async () => {
    // Restored from round 39: hardcoding ThreadCard's override to "active"
    // must fail this test. Settle now lives in the "…" actions menu (#566).
    const settleCalls: Array<{ id: string; o: string }> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onSetSettled: (id, o) => {
          settleCalls.push({ id, o });
        },
      }),
    );
    // "finished" is a non-working attention card, so its settle item is enabled.
    await m.click(m.query('[data-more-btn="finished"]'));
    const item = m.query(
      '[data-settle-item="finished"]',
    ) as HTMLButtonElement | null;
    assert.ok(item, "actions menu offers Settle thread");
    assert.equal(item!.disabled, false, "not working → settle enabled");
    assert.equal((item!.textContent || "").trim(), "Settle thread");
    await m.click(item!);
    assert.deepEqual(
      settleCalls,
      [{ id: "finished", o: "settled" }],
      "attention → settle must send override settled, not active",
    );
    // Working cards keep the item but disabled.
    await m.click(m.query('[data-more-btn="busy"]'));
    const busyItem = m.query(
      '[data-settle-item="busy"]',
    ) as HTMLButtonElement | null;
    assert.ok(busyItem, "working card still lists the settle item");
    assert.equal(busyItem!.disabled, true, "disabled while status=working");
    m.unmount();
  });
});

describe("Sidebar project collapse", () => {
  it("collapses a group to its header and persists across mounts", async () => {
    await clearSidebarStorage();
    const m1 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m1.click(groupHeader(m1, "acme/ledger"));
    assert.ok(!cardTitles(m1).includes("busy"));
    assert.ok(!cardTitles(m1).includes("finished"));
    assert.equal(
      groupHeader(m1, "acme/ledger").getAttribute("aria-expanded"),
      "false",
    );
    m1.unmount();

    const m2 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.ok(
      !cardTitles(m2).includes("busy"),
      "collapse must survive a remount via localStorage",
    );
    await m2.click(groupHeader(m2, "acme/ledger"));
    assert.ok(cardTitles(m2).includes("busy"));
    m2.unmount();
    await clearSidebarStorage();
  });

  it("collapsed project's settled threads still appear in the global tail", async () => {
    // Non-blocker: the collapse comment claimed this without asserting it.
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m.click(groupHeader(m, "acme/ledger"));
    assert.ok(!cardTitles(m).includes("busy"), "attention is hidden");
    // Tail is expanded by default (t3) — no shelf toggle needed.
    assert.ok(
      cardTitles(m).includes("merged-p1"),
      "p1 settled must still show in the global tail while its project is collapsed",
    );
    m.unmount();
  });

  it("search surfaces settled hits (bypasses the collapsed global tail)", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    // Tail defaults to expanded (t3); collapse it so the bypass is exercised.
    await m.click(settledTailHeader(m));
    assert.ok(!cardTitles(m).includes("merged-p1"));

    const input = m.query("input") as HTMLInputElement;
    assert.ok(input);
    await m.type(input, "merged ledger");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.deepEqual(
      cardTitles(m),
      ["merged-p1"],
      "a settled thread must surface as a search hit while the tail stays collapsed",
    );
    m.unmount();
    await clearSidebarStorage();
  });

  it("search surfaces hits inside a collapsed project group", async () => {
    // Restored half: removing !searching from the collapsed calc must fail.
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m.click(groupHeader(m, "acme/ledger"));
    assert.ok(!cardTitles(m).includes("finished"), "collapsed hides attention");

    const input = m.query("input") as HTMLInputElement;
    assert.ok(input);
    await m.type(input, "finished work");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.ok(
      cardTitles(m).includes("finished"),
      "search must override project collapse so hits inside it surface",
    );
    m.unmount();
  });

  it("search surfaces hits when every project is collapsed via collapse-all", async () => {
    // Extends the pinned search-override pin to the all-collapsed state.
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m.click(allProjectsHeader(m));
    assert.ok(!cardTitles(m).includes("finished"), "collapse-all hides attention");
    assert.ok(!cardTitles(m).includes("billing-idle"));

    const input = m.query("input") as HTMLInputElement;
    assert.ok(input);
    await m.type(input, "finished work");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.ok(
      cardTitles(m).includes("finished"),
      "search must surface hits even when collapse-all left every group collapsed",
    );
    m.unmount();
  });
});

describe("Sidebar collapse-all / expand-all (round 42)", () => {
  it("collapse-all collapses every group and persists across remount", async () => {
    await clearSidebarStorage();
    const m1 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.ok(cardTitles(m1).includes("busy"), "p1 attention visible by default");
    assert.ok(
      cardTitles(m1).includes("billing-idle"),
      "p2 attention visible by default",
    );
    assert.equal(
      allProjectsHeader(m1).getAttribute("aria-expanded"),
      "true",
      "ALL PROJECTS aria-expanded when any group is open",
    );

    await m1.click(allProjectsHeader(m1));
    assert.ok(!cardTitles(m1).includes("busy"), "p1 collapsed");
    assert.ok(!cardTitles(m1).includes("billing-idle"), "p2 collapsed");
    assert.equal(
      groupHeader(m1, "acme/ledger").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      groupHeader(m1, "acme/billing").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      allProjectsHeader(m1).getAttribute("aria-expanded"),
      "false",
      "ALL PROJECTS aria-expanded false when every group is collapsed",
    );
    m1.unmount();

    const m2 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.ok(
      !cardTitles(m2).includes("busy"),
      "collapse-all must persist via coder.sidebar.collapsedGroups",
    );
    assert.ok(!cardTitles(m2).includes("billing-idle"));
    assert.equal(allProjectsHeader(m2).getAttribute("aria-expanded"), "false");
    m2.unmount();
    await clearSidebarStorage();
  });

  it("expand-all clears collapse-all (every group open again)", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m.click(allProjectsHeader(m));
    assert.equal(allProjectsHeader(m).getAttribute("aria-expanded"), "false");

    await m.click(allProjectsHeader(m));
    assert.ok(cardTitles(m).includes("busy"), "p1 re-expanded");
    assert.ok(cardTitles(m).includes("billing-idle"), "p2 re-expanded");
    assert.equal(
      allProjectsHeader(m).getAttribute("aria-expanded"),
      "true",
      "ALL PROJECTS expanded-any after expand-all",
    );
    assert.equal(
      groupHeader(m, "acme/ledger").getAttribute("aria-expanded"),
      "true",
    );
    m.unmount();
    await clearSidebarStorage();
  });

  it("per-group toggle after collapse-all yields mixed state; header reflects any-expanded", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m.click(allProjectsHeader(m));
    assert.equal(allProjectsHeader(m).getAttribute("aria-expanded"), "false");
    assert.deepEqual(
      collapsedFromStorage(),
      ["p1", "p2"],
      "collapse-all persists both group keys",
    );

    // Re-open only ledger — mixed state.
    await m.click(groupHeader(m, "acme/ledger"));
    assert.ok(cardTitles(m).includes("busy"), "re-opened group shows attention");
    assert.ok(
      !cardTitles(m).includes("billing-idle"),
      "other group stays collapsed",
    );
    assert.equal(
      allProjectsHeader(m).getAttribute("aria-expanded"),
      "true",
      "ANY expanded group makes ALL PROJECTS aria-expanded true",
    );
    assert.equal(
      groupHeader(m, "acme/billing").getAttribute("aria-expanded"),
      "false",
    );
    // Storage: only the re-opened key is removed; the other remains.
    assert.deepEqual(
      collapsedFromStorage(),
      ["p2"],
      "re-expand removes just that key from localStorage",
    );
    m.unmount();
    await clearSidebarStorage();
  });

  it("collapse-all does not hide the settled tail (own toggle)", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m.click(allProjectsHeader(m));
    assert.ok(
      settledTailHeader(m),
      "settled tail header remains after collapse-all",
    );
    assert.equal(
      settledTailHeader(m).getAttribute("aria-expanded"),
      "true",
      "tail stays expanded through collapse-all (own toggle)",
    );
    assert.ok(
      cardTitles(m).includes("merged-p1"),
      "settled rows still show independently of collapse-all",
    );
    m.unmount();
    await clearSidebarStorage();
  });

  it("chevron data-open flips with collapse state (not CSS)", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.equal(
      groupChevron(m, "p1").getAttribute("data-open"),
      "true",
      "expanded group chevron data-open=true",
    );
    const sectionChevron = () =>
      allProjectsHeader(m).querySelector("[data-open]") as HTMLElement | null;
    assert.ok(sectionChevron(), "section header has a data-open chevron");
    assert.equal(
      sectionChevron()!.getAttribute("data-open"),
      "true",
      "ALL PROJECTS chevron open when any expanded",
    );

    await m.click(groupHeader(m, "acme/ledger"));
    assert.equal(
      groupChevron(m, "p1").getAttribute("data-open"),
      "false",
      "collapsed group flips data-open to false",
    );

    await m.click(allProjectsHeader(m));
    assert.equal(groupChevron(m, "p1").getAttribute("data-open"), "false");
    assert.equal(groupChevron(m, "p2").getAttribute("data-open"), "false");
    assert.equal(
      sectionChevron()!.getAttribute("data-open"),
      "false",
      "ALL PROJECTS chevron data-open=false when all collapsed",
    );
    m.unmount();
    await clearSidebarStorage();
  });

  it("title tooltips match collapse state on group and ALL PROJECTS headers", async () => {
    // B2: M4/M5 hardcoded a single title string — both states must be asserted.
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));

    assert.equal(
      groupHeader(m, "acme/ledger").getAttribute("title"),
      "Collapse project",
      "expanded group title",
    );
    assert.equal(
      allProjectsHeader(m).getAttribute("title"),
      "Collapse all projects",
      "any-expanded section title",
    );

    await m.click(allProjectsHeader(m));

    assert.equal(
      groupHeader(m, "acme/ledger").getAttribute("title"),
      "Expand project",
      "collapsed group title",
    );
    assert.equal(
      allProjectsHeader(m).getAttribute("title"),
      "Expand all projects",
      "all-collapsed section title",
    );
    m.unmount();
    await clearSidebarStorage();
  });

  it("header click during search after collapse-all does not clear the set (B1)", async () => {
    // B1 / M10: render used `searching ||` but click omitted it, so collapse-all
    // → search → click inverted into expand-all. Shared predicate must keep
    // every key collapsed after search is cleared.
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m.click(allProjectsHeader(m));
    assert.deepEqual(collapsedFromStorage(), ["p1", "p2"]);
    assert.ok(!cardTitles(m).includes("busy"));

    const input = m.query("input") as HTMLInputElement;
    assert.ok(input);
    await m.type(input, "finished work");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();

    // During search the header presents as expanded-any (search override).
    assert.equal(
      allProjectsHeader(m).getAttribute("aria-expanded"),
      "true",
      "search presents ALL PROJECTS as expanded-any",
    );
    assert.equal(
      allProjectsHeader(m).getAttribute("title"),
      "Collapse all projects",
    );

    // Click must re-collapse, not clear the set.
    await m.click(allProjectsHeader(m));
    await m.flush();
    assert.deepEqual(
      collapsedFromStorage(),
      ["p1", "p2"],
      "mid-search header click must not clear collapse-all keys",
    );

    // Leave search mode: 1 char is below MIN_SEARCH_LEN (2), so searching
    // flips false and any expand-all inversion becomes visible.
    await m.type(input, "f");
    await m.flush();

    assert.ok(
      !cardTitles(m).includes("busy"),
      "p1 still collapsed after search→header click→exit search",
    );
    assert.ok(
      !cardTitles(m).includes("billing-idle"),
      "p2 still collapsed after search→header click→exit search",
    );
    assert.deepEqual(
      collapsedFromStorage(),
      ["p1", "p2"],
      "localStorage still holds every collapse-all key",
    );
    assert.equal(
      allProjectsHeader(m).getAttribute("aria-expanded"),
      "false",
      "exiting search must show all-collapsed, not expand-all inversion",
    );
    m.unmount();
    await clearSidebarStorage();
  });

  it("project added after collapse-all renders expanded (new work visible)", async () => {
    // Absent from the collapsed set → expanded by default (see anyGroupExpandedState).
    await clearSidebarStorage();
    const m1 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m1.click(allProjectsHeader(m1));
    assert.deepEqual(collapsedFromStorage(), ["p1", "p2"]);
    m1.unmount();

    const p3: ProjectInfo = {
      id: "p3",
      slug: "acme/new",
      name: "new",
      path: "/tmp/new",
    };
    const withNew = [
      ...THREADS,
      thread({
        id: "new-work",
        title: "brand new",
        projectId: "p3",
        status: "working",
        runStartedAt: FRESH,
        updatedAt: FRESH + 60,
      }),
    ];
    const m2 = await mount(sidebar(withNew, { projects: [p1, p2, p3] }));
    assert.ok(
      !cardTitles(m2).includes("busy"),
      "previously collapse-all'd groups stay collapsed",
    );
    assert.ok(
      cardTitles(m2).includes("new-work"),
      "new project after collapse-all must show its threads",
    );
    assert.equal(
      groupHeader(m2, "acme/new").getAttribute("aria-expanded"),
      "true",
    );
    m2.unmount();
    await clearSidebarStorage();
  });
});

describe("Sidebar remove project (round 41, t3-style)", () => {
  // Fixture discipline: two projects; exercise the NON-first (p2).
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

  it("exposes a separately focusable remove control per group header", async () => {
    const m = await mount(
      sidebar(removeThreads, {
        projects: [p1, p2],
        onRemoveProject: () => {},
      }),
    );
    const removeP1 = m.query('[data-project-remove="p1"]');
    const removeP2 = m.query('[data-project-remove="p2"]');
    assert.ok(removeP1, "remove affordance on first project");
    assert.ok(removeP2, "remove affordance on second project");
    assert.equal(
      removeP2!.getAttribute("aria-label"),
      "Remove project acme/billing",
    );
    // Sibling of the collapse button — not nested inside it (thread-card pattern).
    const header = groupHeader(m, "acme/billing");
    assert.ok(
      !header.contains(removeP2!),
      "remove must not be nested inside the collapse control",
    );
    assert.equal(
      removeP2!.parentElement,
      header.parentElement,
      "remove and collapse share one header row",
    );
    m.unmount();
  });

  it("confirm shows REAL thread count, path, and both t3 sentences", async () => {
    const m = await mount(
      sidebar(removeThreads, {
        projects: [p1, p2],
        onRemoveProject: () => {},
      }),
    );
    // Remove the NON-first project.
    await m.click(m.query('[data-project-remove="p2"]'));
    const dialog = m.query('[data-remove-confirm="p2"]');
    assert.ok(dialog, "destructive confirm dialog must open");
    const text = dialog!.textContent || "";
    // t3 title: "Remove project X and delete its N threads?"
    assert.ok(
      text.includes(
        "Remove project acme/billing and delete its 3 threads?",
      ),
      "title must name slug + real count (attention+archived+settled = 3)",
    );
    assert.ok(text.includes("/tmp/billing"), "dialog must show the path");
    assert.ok(
      text.includes(
        "This permanently clears conversation history for those threads.",
      ),
    );
    assert.ok(text.includes("This removes only this project entry."));
    m.unmount();
  });

  it("Cancel records nothing; Confirm records the project id (non-vacuous pair)", async () => {
    const removed: string[] = [];
    const m = await mount(
      sidebar(removeThreads, {
        projects: [p1, p2],
        onRemoveProject: (id) => {
          removed.push(id);
        },
      }),
    );
    await m.click(m.query('[data-project-remove="p2"]'));
    await m.click(m.byText("Cancel"));
    assert.deepEqual(removed, [], "cancel must not remove");
    assert.equal(m.query('[data-remove-confirm="p2"]'), null);

    await m.click(m.query('[data-project-remove="p2"]'));
    await m.click(m.query('[data-remove-confirm-submit="p2"]'));
    await m.flush();
    assert.deepEqual(
      removed,
      ["p2"],
      "confirm must pass the NON-first project id — proves the recorder works",
    );
    m.unmount();
  });

  it("singular thread count wording", async () => {
    const m = await mount(
      sidebar([thread({ id: "only", title: "only", projectId: "p2" })], {
        projects: [p1, p2],
        onRemoveProject: () => {},
      }),
    );
    await m.click(m.query('[data-project-remove="p2"]'));
    const text = m.query('[data-remove-confirm="p2"]')?.textContent || "";
    assert.ok(
      text.includes("Remove project acme/billing and delete its 1 thread?"),
      "singular: thread not threads",
    );
    m.unmount();
  });

  it("confirm submit disables while remove is in flight; second click records nothing", async () => {
    // M9: removing disabled={removePending}, aria-busy, and the re-entry
    // guard left the suite green. Hold the remove promise so we can assert
    // mid-flight state.
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
    await m.click(m.query('[data-project-remove="p2"]'));
    const submit = m.query(
      '[data-remove-confirm-submit="p2"]',
    ) as HTMLButtonElement | null;
    assert.ok(submit, "confirm submit must render");
    assert.equal(submit!.disabled, false, "enabled before the first click");

    // First click starts the call; recording is proven live here (length → 1).
    await m.click(submit!);
    await m.flush();

    assert.deepEqual(calls, ["p2"], "first click records the project id once");

    const inflight = m.query(
      '[data-remove-confirm-submit="p2"]',
    ) as HTMLButtonElement | null;
    assert.ok(inflight, "dialog stays open while the promise is held");
    assert.equal(
      inflight!.disabled,
      true,
      "submit must be disabled while removePending",
    );
    assert.equal(
      inflight!.getAttribute("aria-busy"),
      "true",
      "aria-busy marks the in-flight confirm",
    );

    // Second click must not enqueue another call (disabled + re-entry guard).
    await m.click(inflight!);
    await m.flush();
    assert.deepEqual(
      calls,
      ["p2"],
      "second click while in flight records nothing",
    );

    await inAct(async () => {
      resolveRemove();
      await Promise.resolve();
    });
    await m.flush();

    assert.equal(
      m.query('[data-remove-confirm="p2"]'),
      null,
      "dialog closes after the held promise resolves",
    );
    assert.deepEqual(calls, ["p2"], "still exactly one recorded call");
    m.unmount();
  });
});


describe("Sidebar unread indicators (round 43)", () => {
  /**
   * Fixture discipline: unread thread is neither index 0 nor the selected one.
   * selected = "sel" (second); unread = "u-mid" (third).
   */
  const baseVisited = FRESH;
  const UNREAD_THREADS = [
    thread({
      id: "visited-first",
      title: "visited first",
      status: "idle",
      updatedAt: baseVisited,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    }),
    thread({
      id: "sel",
      title: "selected open",
      status: "idle",
      // Technically unread (updatedAt > lastVisitedAt) but SELECTED — no dot.
      updatedAt: baseVisited + 200,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    }),
    thread({
      id: "u-mid",
      title: "unread mid",
      status: "done",
      updatedAt: baseVisited + 300,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    }),
    thread({
      id: "legacy-null",
      title: "legacy null",
      status: "idle",
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
      updatedAt: baseVisited + 350,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    }),
  ];

  it("marks a non-selected unread attention card (data-unread + sr-only)", async () => {
    // #566: cards no longer paint a data-unread-dot; the card attribute,
    // an sr-only "unread" span, and the select label carry the state.
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
    const select = m.query('button[aria-label="Select thread: unread mid, unread"]');
    assert.ok(select, "select aria-label must suffix , unread");
    m.unmount();
  });

  it("suppresses unread on the selected thread even when technically unread", async () => {
    const m = await mount(
      sidebar(UNREAD_THREADS, { projects: [p1], activeThreadId: "sel" }),
    );
    assert.equal(
      m.query('[data-thread-card="sel"]')?.getAttribute("data-unread"),
      null,
      "selected card must not mark unread",
    );
    m.unmount();
  });

  it("does not paint unread for legacy null lastVisitedAt", async () => {
    const m = await mount(
      sidebar(UNREAD_THREADS, { projects: [p1], activeThreadId: "sel" }),
    );
    assert.equal(
      m.query('[data-thread-card="legacy-null"]')?.getAttribute("data-unread"),
      null,
      "legacy null is never unread",
    );
    m.unmount();
  });

  it("shows unread on a settled row when the tail is open", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(UNREAD_THREADS, { projects: [p1], activeThreadId: "sel" }),
    );
    // Tail is open by default (t3), so settled rows paint immediately.
    await m.flush();
    const settledDot = m.query('[data-unread-dot="settled-unread"]');
    assert.ok(settledDot, "settled unread must paint a dot in the tail");
    assert.ok(
      (settledTailHeader(m).textContent || "").includes("unread"),
      "settled tail header must include · N unread",
    );
    m.unmount();
  });

  /**
   * B2: pin zero-unread omission on the settled tail header.
   * B3: pin SettledRow's !active guard (selected + technically unread → no dot).
   */
  it("settled tail omits unread when none; selected settled unread paints no dot", async () => {
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
    // Technically unread, but we open it as the active selection (B3).
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
    // Attention noise so the project group is non-empty (not "All settled").
    const attention = thread({
      id: "att-noise",
      title: "attention noise",
      status: "idle",
      updatedAt: baseVisited,
      lastVisitedAt: baseVisited,
      projectId: "p1",
    });

    // --- B2: no settled row is unread → tail header must not say "unread" ---
    const mZero = await mount(
      sidebar([attention, settledVisited], {
        projects: [p1],
        activeThreadId: "att-noise",
      }),
    );
    const zeroHeader = settledTailHeader(mZero).textContent || "";
    assert.ok(
      zeroHeader.includes("Later ·"),
      `shelf header must still count its rows, got: ${zeroHeader}`,
    );
    assert.ok(
      !zeroHeader.includes("unread"),
      `zero-unread tail must omit the unread fragment (kills "· 0 unread"), got: ${zeroHeader}`,
    );
    mZero.unmount();

    // --- B3: active + technically unread settled row → no dot ---
    const mSel = await mount(
      sidebar([attention, settledVisited, settledSelectedUnread], {
        projects: [p1],
        // Open the settled unread; the expanded tail paints its row.
        activeThreadId: "settled-sel-unread",
      }),
    );
    assert.ok(
      mSel.query('[data-thread-card="settled-sel-unread"]'),
      "selected settled row must render in the tail",
    );
    assert.equal(
      mSel.query('[data-unread-dot="settled-sel-unread"]') != null,
      false,
      "selected settled row must not paint unread even when technically unread",
    );
    assert.equal(
      mSel
        .query('[data-thread-card="settled-sel-unread"]')
        ?.getAttribute("data-unread") ?? null,
      null,
    );
    mSel.unmount();
  });
});


describe("Sidebar new-thread reveal (t3: new work must be visible)", () => {
  it("expands a collapsed target group, flashes the new card, clears the request", async () => {
    await clearSidebarStorage();
    // p1 starts collapsed; the reveal must re-expand it (and persist that).
    window.localStorage.setItem(
      "coder.sidebar.collapsedGroups",
      JSON.stringify(["p1"]),
    );
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
    assert.deepEqual(
      collapsedFromStorage(),
      [],
      "reveal removes the target group from the persisted collapsed set",
    );
    assert.equal(
      groupHeader(m, "acme/ledger").getAttribute("aria-expanded"),
      "true",
      "collapsed target group auto-expands",
    );
    // Scroll + highlight land on the next animation frame.
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
    await clearSidebarStorage();
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
    assert.equal(handledCalls, 1, "missing thread still clears the request");
    m.unmount();
  });

  it("global + names the target project: selected thread's project, else first", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(THREADS, { projects: [p1, p2], activeThreadId: "billing-idle" }),
    );
    assert.ok(
      m.query('button[aria-label="New thread in acme/billing"]'),
      "aria-label names the selected thread's project",
    );
    m.unmount();

    const m2 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const btn = m2.query('button[aria-label="New thread in acme/ledger"]');
    assert.ok(btn, "no selection falls back to the first project");
    assert.equal(
      btn!.getAttribute("title"),
      "New thread in acme/ledger",
      "tooltip names the same target",
    );
    m2.unmount();
  });
});

describe("Sidebar waiting-on badge (issue #42)", () => {
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

  it("an orchestrator with live workers says what it is waiting on (dot title)", async () => {
    // #566: the status dot carries the wait flags and the tooltip carries the
    // words. The visible count line stays too (kept by request): delegation
    // must be readable at rest, and the line vanishes when workers finish.
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1" }), worker({ id: "w2" })]),
    );

    const row = m.query('[data-wait-row="orch"]');
    assert.ok(row, "visible wait line renders while delegation is live");
    assert.match(row!.textContent || "", /Waiting on 2 workers/);

    const dot = m.query('[data-wait-badge="orch"]');
    assert.ok(dot, "orchestrator dot carries the wait flag");
    assert.equal(
      dot!.getAttribute("data-status-dot"),
      "working",
      "delegating parent reads as working tone",
    );
    assert.equal(dot!.getAttribute("data-delegating"), "orch");
    assert.match(dot!.getAttribute("title") || "", /Waiting on 2 workers/);
    assert.match(dot!.getAttribute("title") || "", /w1/, "tooltip names workers");
    assert.equal(
      dot!.getAttribute("data-attention"),
      null,
      "nothing blocked: quiet styling",
    );
    assert.equal(
      m.query('[data-wait-badge="w1"]'),
      null,
      "a leaf worker waits on nothing",
    );
    m.unmount();
  });

  it("a worker blocked on a prompt turns the dot into attention", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1", awaitingInput: true })]),
    );

    const dot = m.query('[data-wait-badge="orch"]');
    assert.ok(dot, "wait flag still present");
    assert.equal(dot!.getAttribute("data-status-dot"), "attention");
    assert.equal(dot!.getAttribute("data-attention"), "true");
    assert.match(dot!.getAttribute("title") || "", /blocked on you/);
    m.unmount();
  });

  it("no badge once the fan-out lands", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1", status: "done", runStartedAt: null })]),
    );
    assert.equal(m.query('[data-wait-badge="orch"]'), null);
    assert.equal(m.query('[data-wait-row="orch"]'), null);
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

    const dot = m.query('[data-wait-badge="solo"]');
    assert.ok(dot, "working thread with a running subagent carries the flag");
    const title = dot!.getAttribute("title") || "";
    assert.match(title, /Waiting on 1 worker:/);
    assert.match(title, /Background research/);
    assert.ok(
      !/Waiting on 1 worker · \d/.test(title),
      "no false elapsed for in-agent subagents (no spawn timestamp)",
    );
    m.unmount();
  });
});

describe("Sidebar group overflow cap + card density (issue #70)", () => {
  /** 12 attention threads in p1, createdAt desc: t0 newest … t11 oldest. */
  const manyThreads = (n: number, projectId = "p1") =>
    Array.from({ length: n }, (_, i) =>
      thread({
        id: `${projectId}-t${i}`,
        title: `${projectId} thread ${i}`,
        createdAt: FRESH + 1000 - i,
        updatedAt: FRESH + 1000 - i,
        projectId,
      }),
    );

  const p1Cards = (m: Awaited<ReturnType<typeof mount>>) =>
    cardTitles(m).filter((id) => id.startsWith("p1-t"));

  it("caps a group at 8 attention cards behind a 'Show N more' disclosure", async () => {
    const m = await mount(sidebar(manyThreads(12)));
    assert.deepEqual(
      p1Cards(m),
      Array.from({ length: 8 }, (_, i) => `p1-t${i}`),
      "newest 8 render in order; the oldest hide behind the disclosure",
    );
    const more = m.byText("Show 4 more");
    assert.ok(more, "disclosure counts the hidden remainder");
    await m.click(more!);
    assert.equal(p1Cards(m).length, 12, "expanded group renders everything");
    const fewer = m.byText("Show fewer");
    assert.ok(fewer, "expanded group offers to re-cap");
    await m.click(fewer!);
    assert.equal(p1Cards(m).length, 8, "re-capped back to the newest 8");
    m.unmount();
  });

  it("no disclosure at or under the cap", async () => {
    const m = await mount(sidebar(manyThreads(8)));
    assert.equal(p1Cards(m).length, 8);
    assert.ok(!m.byText("Show fewer"), "exactly at the cap: no toggle");
    m.unmount();
  });

  it("the open thread never vanishes past the cap", async () => {
    const m = await mount(
      sidebar(manyThreads(12), { activeThreadId: "p1-t10" }),
    );
    const shown = p1Cards(m);
    assert.equal(shown.length, 11, "slice extends to include the active thread");
    assert.ok(shown.includes("p1-t10"));
    assert.ok(!shown.includes("p1-t11"), "threads past the open one stay hidden");
    m.unmount();
  });

  it("search bypasses the cap so every hit renders", async () => {
    const m = await mount(sidebar(manyThreads(12)));
    assert.equal(p1Cards(m).length, 8);
    const input = m.query("input") as HTMLInputElement;
    assert.ok(input);
    await m.type(input, "p1 thread");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.equal(p1Cards(m).length, 12, "search renders all hits, uncapped");
    assert.ok(!m.byText("Show 4 more"), "no disclosure while searching");
    m.unmount();
  });

  it("cards in a named group drop the duplicated slug; orphan cards keep it", async () => {
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
    const homeCard = m.query('[data-thread-card="home"]');
    assert.ok(homeCard, "named-group card renders");
    assert.ok(
      !(homeCard!.textContent || "").includes("acme/ledger"),
      "group header already carries the slug — the card must not repeat it",
    );
    const orphanCard = m.query('[data-thread-card="orphan-1"]');
    assert.ok(orphanCard, "orphan card renders");
    assert.ok(
      (orphanCard!.textContent || "").includes("unknown"),
      "orphan group has no header slug, so the card keeps it",
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

describe("Sidebar update indicator (issue #138)", () => {
  it("dots Settings when an update is waiting, not otherwise", async () => {
    const available = await mount(
      sidebar(THREADS, { updateState: "available" }),
    );
    const availableBtn = settingsButton(available);
    assert.ok(
      availableBtn.querySelector(".settingsDot"),
      "dot present when updateState=available",
    );
    assert.equal(availableBtn.title, "Update available");
    available.unmount();

    const none = await mount(sidebar(THREADS, { updateState: "none" }));
    assert.equal(
      settingsButton(none).querySelector(".settingsDot"),
      null,
      "dot absent when updateState=none",
    );
    none.unmount();

    const unset = await mount(sidebar(THREADS));
    assert.equal(
      settingsButton(unset).querySelector(".settingsDot"),
      null,
      "dot absent when updateState is unset",
    );
    unset.unmount();
  });
});

describe("Sidebar subagent rows (issue #542)", () => {
  it("nests running subagents under their thread card; click selects the parent", async () => {
    const t = thread({
      id: "orch",
      title: "orchestrating",
      status: "working",
      runStartedAt: FRESH,
      updatedAt: FRESH + 60,
      projectId: "p1",
      subagents: [
        {
          id: "sa1",
          description: "Explore the codebase",
          agentType: "Explore",
          status: "running",
        },
        {
          id: "sa2",
          description: "Write the tests",
          agentType: null,
          status: "done",
        },
      ],
    });
    const selects: string[] = [];
    const m = await mount(
      sidebar([t], {
        onSelectThread: (id) => {
          selects.push(id);
        },
      }),
    );
    assert.ok(
      m.query('[data-subagent-list="orch"]'),
      "subagent list renders under the thread card",
    );
    const rows = m.queryAll("[data-subagent-row]");
    assert.equal(
      rows.length,
      1,
      "running subagents only; done rows stay on the Agents panel roster",
    );
    assert.ok(
      (rows[0].textContent || "").includes("Explore the codebase"),
      "row shows the subagent description",
    );
    await m.click(rows[0] as HTMLElement);
    assert.deepEqual(selects, ["orch"], "row click selects the parent thread");
    m.unmount();
  });

  it("renders no subagent list when nothing is running", async () => {
    const t = thread({
      id: "plain",
      title: "plain work",
      status: "idle",
      projectId: "p1",
      subagents: [
        {
          id: "sa1",
          description: "old finished one",
          agentType: null,
          status: "done",
        },
        {
          id: "sa2",
          description: "old failed one",
          agentType: null,
          status: "failed",
        },
      ],
    });
    const m = await mount(sidebar([t]));
    assert.equal(
      m.query('[data-subagent-list="plain"]'),
      null,
      "done/failed subagents leave no sidebar rows",
    );
    m.unmount();
  });
});
