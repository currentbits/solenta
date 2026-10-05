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
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom";
import App from "../src/App";
import {
  SettledRow,
  ThreadCard,
  displayWorkerTitle,
} from "../src/components/Sidebar";
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
} from "../src/shared/ipc";
import {
  p1,
  p2,
  providers,
  FRESH,
  DAY_MS,
  thread,
  sidebar,
  openMoreMenu,
  THREADS,
  cardTitles,
  searchInput,
  snoozedToggle,
  settledToggle,
  openSettledShelf,
  openSnoozedShelf,
  openScopeMenu,
  openCreateMenu,
  clearSidebarStorage,
  portalMenu,
} from "./support/sidebarFixtures";

describe("displayWorkerTitle", () => {
  it("strips repeated Fork: prefixes and leaves a bare title alone", () => {
    assert.equal(
      displayWorkerTitle("Fork: Fork: Review permissions"),
      "Review permissions",
    );
    assert.equal(displayWorkerTitle("Review permissions"), "Review permissions");
    assert.equal(displayWorkerTitle("Fork:"), "Fork:");
  });
});

describe("t3 paging constants are fixed facts", () => {
  it("INITIAL is 10 and PAGE is 25", () => {
    assert.equal(SETTLED_TAIL_INITIAL_COUNT, 10, "t3 SETTLED_TAIL_INITIAL_COUNT");
    assert.equal(SETTLED_TAIL_PAGE_COUNT, 25, "t3 SETTLED_TAIL_PAGE_COUNT");
  });
});

describe("Sidebar is a flat list (no project groups)", () => {
  it("folds quietly working threads into a collapsed Working shelf", async () => {
    await clearSidebarStorage();
    window.localStorage.removeItem("sidebar:workingOpen");
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const toggle = m.query("[data-working-shelf-toggle]")!;
    assert.ok(toggle, "Working shelf renders");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.match(toggle.textContent ?? "", /^Working · \d+/);
    assert.ok(!cardTitles(m).includes("busy"), "busy is folded away");
    assert.ok(cardTitles(m).includes("finished"), "done stays in the inbox");
    await m.click(toggle);
    assert.ok(cardTitles(m).includes("busy"), "expanding shows busy");
    assert.equal(window.localStorage.getItem("sidebar:workingOpen"), "1");
    m.unmount();
  });

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
    assert.ok(ids.includes("busy"), "working shows on the open Working shelf");
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
      /Settled · 1/,
      "archived counts into Settled · N",
    );
    assert.equal(header.getAttribute("aria-expanded"), "false");

    await openSettledShelf(m);
    assert.match(settledToggle(m).textContent || "", /^Settled · 1$/);
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
      /Settled · 2/,
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
    assert.match(settledToggle(m).textContent || "", /^Settled · 2$/);
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
    assert.match(settledToggle(m).textContent || "", /Settled · 40/);
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
    assert.match(settledToggle(m).textContent || "", /Settled · 10/);
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
    assert.match(snoozedToggle(m).textContent || "", /Snoozed · 2/);
    assert.equal(snoozedToggle(m).getAttribute("aria-expanded"), "false");
    assert.ok(!cardTitles(m).includes("snooze-soon"));

    await openSnoozedShelf(m);
    assert.match(snoozedToggle(m).textContent || "", /^Snoozed · 2$/);
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

describe("Sidebar app navigation", () => {
  const wired = {
    projects: [p1, p2],
    onOpenActivity: () => {},
    onOpenKanban: () => {},
    onOpenAutomations: () => {},
    onOpenUsage: () => {},
    onOpenFleet: () => {},
    onOpenInsights: () => {},
    onOpenDigest: () => {},
  };

  it("More lists only destinations that have an opener", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenActivity: () => {},
        onOpenUsage: () => {},
      }),
    );
    await openMoreMenu(m);
    const ids = [
      ...m.queryAll("[data-app-more-menu] [data-view-nav]"),
    ].map((el) => el.getAttribute("data-view-nav"));
    assert.deepEqual(ids, ["activity", "usage"]);
    m.unmount();
  });

  it("marks the open destination instead of treating every other view as Threads", async () => {
    await clearSidebarStorage();
    const usage = await mount(sidebar(THREADS, { ...wired, activeView: "usage" }));
    assert.equal(usage.query("[data-app-more]")?.getAttribute("aria-current"), "page");
    assert.equal(usage.query("[data-app-more]")?.getAttribute("aria-label"), "Insights, Usage");
    await openMoreMenu(usage);
    assert.equal(
      usage.query('[data-view-nav="usage"]')?.getAttribute("aria-current"),
      "page",
    );
    assert.equal(
      usage.query('[data-view-nav="activity"]')?.getAttribute("aria-current"),
      null,
    );
    usage.unmount();

    const board = await mount(
      sidebar(THREADS, { ...wired, activeView: "planboard" }),
    );
    assert.equal(
      board.query('[data-view-nav="planboard"]')?.getAttribute("aria-current"),
      "page",
    );
    assert.equal(board.query("[data-app-more]")?.getAttribute("aria-current"), null);
    board.unmount();

    const review = await mount(sidebar(THREADS, { ...wired, activeView: "prs" }));
    assert.equal(
      review.query('[data-view-nav="review"]')?.getAttribute("aria-current"),
      "page",
    );
    review.unmount();
  });

  it("ArrowDown moves in More and Escape returns focus to the trigger", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, wired));
    await openMoreMenu(m);
    assert.equal(
      (document.activeElement as HTMLElement | null)?.getAttribute("data-view-nav"),
      "activity",
    );
    await m.pressFocused("ArrowDown");
    assert.equal(
      (document.activeElement as HTMLElement | null)?.getAttribute("data-view-nav"),
      "kanban",
    );
    await m.pressFocused("Escape");
    assert.equal(m.query("[data-app-more-menu]"), null);
    assert.equal(document.activeElement, m.query("[data-app-more]"));
    m.unmount();
  });

  it("Tab and Shift+Tab close More without taking the key from the browser", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, wired));
    const pressTab = async (shiftKey: boolean) => {
      const focused = document.activeElement as HTMLElement;
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      await inAct(() => {
        focused.dispatchEvent(event);
      });
      await m.flush();
      return event;
    };

    await openMoreMenu(m);
    assert.equal(
      (document.activeElement as HTMLElement | null)?.getAttribute("data-view-nav"),
      "activity",
    );
    const tab = await pressTab(false);
    assert.equal(tab.defaultPrevented, false);
    assert.equal(m.query("[data-app-more-menu]"), null);
    assert.equal(document.activeElement, m.query("[data-app-more]"));

    await openMoreMenu(m);
    const shiftTab = await pressTab(true);
    assert.equal(shiftTab.defaultPrevented, false);
    assert.equal(m.query("[data-app-more-menu]"), null);
    assert.equal(document.activeElement, m.query("[data-app-more]"));

    await openMoreMenu(m);
    await m.pressFocused("End");
    assert.equal(
      (document.activeElement as HTMLElement | null)?.getAttribute("data-view-nav"),
      "digest",
    );
    const endTab = await pressTab(false);
    assert.equal(endTab.defaultPrevented, false);
    assert.equal(m.query("[data-app-more-menu]"), null);
    assert.equal(document.activeElement, m.query("[data-app-more]"));
    m.unmount();
  });

  it("closes More on an outside click", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, wired));
    await openMoreMenu(m);
    const search = m.query('input[aria-label="Search threads"]');
    assert.ok(search);
    await inAct(() => {
      search.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await m.flush();
    assert.equal(m.query("[data-app-more-menu]"), null);
    m.unmount();
  });

  it("re-clicking the active Planboard returns to threads without creating or selecting", async () => {
    await clearSidebarStorage();
    const created: Array<string | undefined> = [];
    const selected: string[] = [];
    let opened = false;
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        activeView: "planboard",
        onOpenPlanboard: () => {},
        activeThreadId: "billing-idle",
        onCreateThread: (pid) => {
          created.push(pid);
        },
        onSelectThread: (id) => {
          selected.push(id);
        },
        onOpenThreads: () => {
          opened = true;
        },
      }),
    );
    await m.click(m.query('[data-view-nav="planboard"]'));
    assert.equal(opened, true);
    assert.deepEqual(created, []);
    assert.deepEqual(selected, []);
    assert.ok(m.query('[data-thread-card="billing-idle"]'));
    m.unmount();
  });

  it("re-clicking the active Review returns to threads when nothing is selected", async () => {
    await clearSidebarStorage();
    let opened = 0;
    const created: unknown[] = [];
    const m = await mount(
      sidebar([], {
        projects: [p1],
        activeView: "prs",
        onOpenReview: () => {},
        activeThreadId: null,
        onCreateThread: (pid) => {
          created.push(pid);
        },
        onOpenThreads: () => {
          opened += 1;
        },
      }),
    );
    await m.click(m.query('[data-view-nav="review"]'));
    assert.equal(opened, 1);
    assert.deepEqual(created, []);
    m.unmount();
  });

  it("keeps the status filter when Planboard is opened", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        activeThreadId: "broken",
        onOpenPlanboard: () => {},
      }),
    );
    await m.click(m.query("[data-status-filter-trigger]"));
    await m.click(m.query('[data-status-filter="failed"]'));
    await m.flush();
    const before = cardTitles(m);
    assert.ok(before.includes("broken"));
    assert.ok(!before.includes("busy"));
    await m.click(m.query('[data-view-nav="planboard"]'));
    assert.deepEqual(cardTitles(m), before);
    assert.equal(
      m.query("[data-status-filter-trigger]")?.getAttribute("data-active"),
      "true",
    );
    m.unmount();
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

  it("exposes edit + remove per project and New project inside the scope menu", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(removeThreads, {
        projects: [p1, p2],
        onRemoveProject: () => {},
        onEditProject: () => {},
        onAddProject: () => {},
      }),
    );
    assert.equal(m.query("[data-new-project]"), null, "no standalone New project row");
    await openScopeMenu(m);
    assert.ok(m.query("[data-new-project]"), "New project sits in the scope menu");
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

  it("Escape dismisses the remove confirm without removing", async () => {
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
    const dialog = m.query('[data-remove-confirm="p2"]');
    assert.ok(dialog, "confirm must open");
    await m.press(dialog, "Escape");
    assert.ok(
      !m.query('[data-remove-confirm="p2"]'),
      "Escape must dismiss the confirm",
    );
    assert.deepEqual(removed, []);
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

  it("opening remove confirm moves focus out of the opener; Tab stays inside; Escape restores", async () => {
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
    const opener = m.query('[data-project-remove="p2"]') as HTMLElement;
    assert.ok(opener, "remove opener");
    opener.focus();
    await m.click(opener);
    const dialog = m.query('[data-remove-confirm="p2"]') as HTMLElement | null;
    assert.ok(dialog, "destructive confirm dialog must open");
    assert.ok(
      dialog.contains(document.activeElement),
      "opening the dialog must move focus inside it",
    );
    assert.notEqual(document.activeElement, opener);

    await m.pressFocused("Tab");
    const first = document.activeElement as HTMLElement;
    assert.ok(dialog.contains(first), "Tab stays inside");
    assert.equal(first.tagName, "BUTTON");

    await m.pressFocused("Tab");
    const second = document.activeElement as HTMLElement;
    assert.ok(dialog.contains(second), "second Tab stays inside");
    assert.notEqual(second, first);

    await m.pressFocused("Tab");
    assert.equal(document.activeElement, first, "Tab wraps inside the dialog");

    await m.pressFocused("Escape");
    assert.equal(m.query('[data-remove-confirm="p2"]'), null);
    assert.equal(
      document.activeElement,
      opener,
      "Escape restores opener focus",
    );
    assert.deepEqual(removed, []);
    m.unmount();
  });

  it("Escape is ignored while remove is in flight; Tab stays inside", async () => {
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
    await m.click(m.query('[data-remove-confirm-submit="p2"]')!);
    await m.flush();
    const dialog = m.query('[data-remove-confirm="p2"]') as HTMLElement | null;
    assert.ok(dialog, "confirm stays mounted while remove is pending");
    assert.deepEqual(calls, ["p2"]);

    await m.pressFocused("Escape");
    assert.ok(
      m.query('[data-remove-confirm="p2"]'),
      "Escape is inert while removePending",
    );
    assert.deepEqual(calls, ["p2"]);

    await m.pressFocused("Tab");
    assert.ok(
      dialog.contains(document.activeElement),
      "Tab stays inside while pending",
    );

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
      orchWorker: true,
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

  it("an orchestrator with live workers keeps a collapsed family summary", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1" }), worker({ id: "w2" })]),
    );
    const row = m.query('[data-family-summary="orch"]');
    assert.ok(row, "collapsed crew lead summarizes its workers");
    assert.match(row!.textContent || "", /2 workers/);
    assert.match(row!.textContent || "", /2 running/);
    assert.equal(
      m.query('[data-thread-card="w1"]'),
      null,
      "workers stay folded until the family is opened",
    );
    const label = m.query('[data-thread-card="orch"] [data-status-label]');
    assert.ok(label, "delegating parent still has a status label");
    assert.equal(
      label!.textContent,
      "Delegating",
      "a parent waiting on workers reads Delegating, not Working",
    );
    m.unmount();
  });

  it("a worker blocked on a prompt turns the family summary into attention", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1", awaitingInput: true })]),
    );
    const row = m.query('[data-family-summary="orch"]');
    assert.ok(row);
    assert.equal(row!.getAttribute("data-attention"), "true");
    assert.match(row!.textContent || "", /needs you/);
    m.unmount();
  });

  it("finished workers stay in the family as ready, not integrated", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1", status: "done", runStartedAt: null })]),
    );
    const row = m.query('[data-family-summary="orch"]');
    assert.ok(row);
    assert.match(row!.textContent || "", /1 ready/);
    assert.equal((row!.textContent || "").includes("integrated"), false);
    m.unmount();
  });

  it("explicit settle files a worker to the Settled shelf (#1315)", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([
        ORCH,
        worker({
          id: "w-settled",
          title: "Fork: Import existing CLI agent sessions",
          status: "done",
          runStartedAt: null,
          settledOverride: "settled",
        }),
      ]),
    );
    assert.equal(
      m.query('[data-thread-card="w-settled"]'),
      null,
      "explicit settle is not nested in Active while Settled is collapsed",
    );
    assert.ok(
      m.query("[data-settled-shelf-toggle]"),
      "the settled worker lives on the Settled shelf",
    );
    m.unmount();
  });

  it("expanding a family shows compact worker rows", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([
        ORCH,
        worker({
          id: "w1",
          title: "Fork: Fork: Review permissions",
        }),
      ]),
    );
    const toggle = m.query('[data-family-toggle="orch"]');
    assert.ok(toggle);
    await m.click(toggle!);
    const card = m.query('[data-thread-card="w1"]');
    assert.ok(card, "expanded family reveals the worker");
    assert.equal(card!.getAttribute("data-compact"), "true");
    assert.equal(card!.getAttribute("data-nested"), "true");
    assert.equal(
      card!.querySelector("[data-card-slug]"),
      null,
      "compact workers do not repeat project metadata",
    );
    const title = card!.querySelector("[title]");
    assert.ok(title);
    assert.equal(title!.textContent, "Review permissions");
    assert.equal(
      title!.getAttribute("title"),
      "Fork: Fork: Review permissions",
      "stored title stays on the tooltip and is not rewritten",
    );
    m.unmount();
  });

  it("a selected worker stays reachable without opening siblings", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1" }), worker({ id: "w2" })], {
        activeThreadId: "w1",
      }),
    );
    assert.ok(m.query('[data-thread-card="orch"]'));
    assert.ok(m.query('[data-thread-card="w1"]'), "selected worker stays visible");
    assert.equal(
      m.query('[data-thread-card="w2"]'),
      null,
      "siblings stay collapsed",
    );
    const toggle = m.query('[data-family-toggle="orch"]');
    assert.ok(toggle);
    assert.equal(toggle!.getAttribute("aria-expanded"), "false");
    m.unmount();
  });

  it("collapsing a family with a selected worker hides siblings only", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([ORCH, worker({ id: "w1" }), worker({ id: "w2" })], {
        activeThreadId: "w1",
      }),
    );
    const toggle = m.query('[data-family-toggle="orch"]');
    assert.ok(toggle);
    await m.click(toggle!);
    assert.equal(toggle!.getAttribute("aria-expanded"), "true");
    assert.ok(m.query('[data-thread-card="w2"]'), "expand shows siblings");
    await m.click(toggle!);
    assert.equal(toggle!.getAttribute("aria-expanded"), "false");
    assert.ok(
      m.query('[data-thread-card="w1"]'),
      "selected worker remains reachable",
    );
    assert.equal(
      m.query('[data-thread-card="w2"]'),
      null,
      "siblings hide on explicit collapse",
    );
    m.unmount();
  });

  it("search finds a worker and shows its task context", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([
        ORCH,
        worker({ id: "w1", title: "Review permissions" }),
        worker({ id: "w2", title: "Unrelated sibling" }),
      ]),
    );
    await m.type(searchInput(m), "permissions");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.ok(m.query('[data-thread-card="orch"]'), "parent comes along as context");
    assert.ok(m.query('[data-thread-card="w1"]'));
    assert.equal(
      m.query('[data-thread-card="w2"]'),
      null,
      "unrelated siblings stay hidden",
    );
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
    const provider = card!.querySelector("[data-card-provider]");
    assert.ok(provider);
    assert.equal(provider!.getAttribute("data-card-provider"), "claude");
    assert.equal(provider!.getAttribute("aria-label"), "Claude Code");
    assert.equal(provider!.getAttribute("title"), "Claude Code");
    assert.ok(
      provider!.querySelector("svg"),
      "provider shows as a logo, not the harness name",
    );
    assert.equal(
      (provider!.textContent || "").trim(),
      "",
      "logo replaces the raw provider id text",
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

  it("explicit settle of a pinned parent's worker files it to Settled", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([
        thread({
          id: "orch",
          title: "orchestrate the fix",
          status: "idle",
          pinnedAt: FRESH - 1000,
          updatedAt: FRESH,
        }),
        thread({
          id: "w-settled",
          title: "Fork: Import existing CLI agent sessions",
          status: "done",
          handoffFrom: "orch",
          orchWorker: true,
          runStartedAt: null,
          settledOverride: "settled",
          updatedAt: FRESH,
        }),
        thread({
          id: "active-card",
          title: "active",
          createdAt: FRESH + 100,
          updatedAt: FRESH + 100,
        }),
      ]),
    );
    assert.equal(m.query('[data-thread-card="w-settled"]'), null);
    assert.ok(m.query("[data-settled-shelf-toggle]"));
    assert.ok(m.query("[data-pinned-divider]"));
    const order = cardTitles(m);
    assert.ok(order.indexOf("orch") < order.indexOf("active-card"));
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

describe("Sidebar move-to-project menu (#737)", () => {
  const MENU_THREAD = [
    thread({
      id: "menu-src",
      title: "menu source",
      status: "idle",
      updatedAt: FRESH + 80,
      projectId: "p1",
    }),
  ];

  it("offers other projects in a submenu and calls onSetThreadProject", async () => {
    const moves: Array<[string, string]> = [];
    const m = await mount(
      sidebar(MENU_THREAD, {
        projects: [p1, p2],
        onSetThreadProject: (id, projectId) => {
          moves.push([id, projectId]);
        },
      }),
    );
    await m.click(m.query('[data-more-btn="menu-src"]'));
    const menu = portalMenu();
    assert.ok(menu, "… menu must open");
    const trigger = menu.querySelector(
      "[data-move-project]",
    ) as HTMLElement | null;
    assert.ok(trigger, "Move to project…");
    await m.click(trigger);
    const dest = document.querySelector(
      '[data-move-project-id="p2"]',
    ) as HTMLElement | null;
    assert.ok(dest, "destination project is listed");
    assert.equal(
      document.querySelector('[data-move-project-id="p1"]'),
      null,
      "current project omitted",
    );
    await m.click(dest);
    assert.deepEqual(moves, [["menu-src", "p2"]]);
    m.unmount();
  });

  it("hides Move to project when there is only one project", async () => {
    const m = await mount(
      sidebar(MENU_THREAD, {
        projects: [p1],
        onSetThreadProject: () => {},
        onSetPinned: () => {},
      }),
    );
    await m.click(m.query('[data-more-btn="menu-src"]'));
    const menu = portalMenu();
    assert.ok(menu);
    assert.equal(menu.querySelector("[data-move-project]"), null);
    m.unmount();
  });

  it("disables Move to project on a worktree thread and does not call through", async () => {
    const moves: Array<[string, string]> = [];
    const m = await mount(
      sidebar(
        [
          thread({
            id: "menu-src",
            title: "menu source",
            status: "idle",
            updatedAt: FRESH + 80,
            projectId: "p1",
            worktreePath: "/tmp/wt",
          }),
        ],
        {
          projects: [p1, p2],
          onSetThreadProject: (id, projectId) => {
            moves.push([id, projectId]);
          },
        },
      ),
    );
    await m.click(m.query('[data-more-btn="menu-src"]'));
    const trigger = portalMenu()?.querySelector(
      "[data-move-project]",
    ) as HTMLButtonElement | null;
    assert.ok(trigger, "Move to project…");
    assert.equal(trigger.disabled, true);
    await m.click(trigger);
    assert.equal(
      document.querySelector("[data-move-project-id]"),
      null,
      "destinations stay closed while disabled",
    );
    assert.deepEqual(moves, []);
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

describe("Sidebar recently deleted shelf (#940)", () => {
  it("lists trashed threads with restore, expiry, and permanent delete", async () => {
    await clearSidebarStorage();
    const restored: string[] = [];
    const purged: string[] = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1],
        trashedThreads: [
          {
            id: "gone-1",
            title: "accidentally deleted",
            projectId: "p1",
            projectSlug: "acme/ledger",
            projectMissing: false,
            trashedAt: Date.now() - 1000,
            expiresAt: Date.now() + 6 * DAY_MS,
          },
          {
            id: "orphan-1",
            title: "lost project",
            projectId: "missing",
            projectSlug: null,
            projectMissing: true,
            trashedAt: Date.now() - 2000,
            expiresAt: Date.now() + 5 * DAY_MS,
          },
        ],
        onRestoreThread: (id) => restored.push(id),
        onPurgeThread: (id) => purged.push(id),
      }),
    );
    const toggle = m.query("[data-trashed-shelf-toggle]");
    assert.ok(toggle, "Recently deleted shelf toggle is present");
    assert.match(toggle!.textContent || "", /Recently deleted · 2/);
    await m.click(toggle!);
    await m.flush();
    assert.ok(m.query('[data-trashed-row="gone-1"]'));
    assert.ok(m.text().includes("Expires in 6d"));
    assert.ok(m.text().includes("Project unavailable"));
    const restore = m.query('[data-restore-btn="gone-1"]') as HTMLButtonElement;
    assert.ok(restore);
    await m.click(restore);
    assert.deepEqual(restored, ["gone-1"]);
    const blocked = m.query(
      '[data-restore-btn="orphan-1"]',
    ) as HTMLButtonElement;
    assert.ok(blocked);
    assert.equal(blocked.disabled, true);
    await m.click(m.query('[data-purge-btn="gone-1"]')!);
    await m.click(m.query('[data-purge-confirm="gone-1"]')!);
    assert.deepEqual(purged, ["gone-1"]);
    m.unmount();
  });

  it("shows the shared-memory count in the footer beside a compact Awake (#1429)", async () => {
    await clearSidebarStorage();
    const stayAwake = { mode: "agent", blocking: true, onBattery: false, anyWorking: true } as const;
    const m = await mount(sidebar(THREADS, { memoryEntries: 1284, stayAwake }));
    const pulse = m.query("[data-memory-pulse]");
    assert.ok(pulse, "memory pulse renders");
    assert.match(pulse!.textContent || "", /1,284 memories/);
    const awake = m.query("[data-stay-awake]");
    assert.ok(awake, "Awake control still renders");
    assert.ok(awake!.hasAttribute("data-compact"), "Awake goes compact");
    assert.match(awake!.getAttribute("aria-label") || "", /^Stay awake: Agent/);
    m.unmount();
  });

  it("hides the memory count when the server is down (null)", async () => {
    await clearSidebarStorage();
    const stayAwake = { mode: "agent", blocking: false, onBattery: false, anyWorking: true } as const;
    const m = await mount(sidebar(THREADS, { memoryEntries: null, stayAwake }));
    assert.equal(m.query("[data-memory-pulse]"), null);
    assert.ok(!m.query("[data-stay-awake]")!.hasAttribute("data-compact"));
    m.unmount();
  });
});
