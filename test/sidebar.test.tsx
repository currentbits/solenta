/**
 * Sidebar: project collapse + global settled tail (round 40), jsdom.
 *
 * Round 40: settled is ONE global tail at the bottom (t3 placement), not
 * per-project folds. Fresh done stays in project groups; MERGED goes to tail.
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
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../src/shared/ipc";

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
  return {
    projectId: "p1",
    title: over.id,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: FRESH,
    updatedAt: FRESH,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
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
    onSelectThread?: (id: string) => void;
    onRemoveProject?: (projectId: string) => void;
    projectError?: string | null;
  } = {},
) {
  const projects = over.projects ?? [p1];
  return (
    <Sidebar
      appName="Coder"
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

function settledTailHeader(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLButtonElement {
  const header = m
    .queryAll("button")
    .find((b) => (b.textContent || "").includes("Settled ·")) as
    | HTMLButtonElement
    | undefined;
  assert.ok(header, "global Settled · N header must exist");
  return header;
}

/** Install jsdom via a throwaway mount, then clear localStorage for a clean slate. */
async function clearSidebarStorage(): Promise<void> {
  const shell = await mount(<div />);
  window.localStorage.clear();
  shell.unmount();
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
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const ids = cardTitles(m);
    assert.ok(ids.includes("busy"), "working stays in the project list");
    assert.ok(ids.includes("finished"), "fresh done stays visible (not settled)");
    assert.ok(ids.includes("broken"), "failed stays visible");
    assert.ok(ids.includes("billing-idle"), "other project's attention shows");
    assert.ok(
      !ids.includes("merged-p1"),
      "MERGED must leave the project group for the global tail",
    );
    assert.ok(
      !ids.includes("merged-p2"),
      "MERGED from a second project also leaves its group",
    );
    m.unmount();
  });

  it("shows working-only summary on the group header (no settled half)", async () => {
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.match(
      groupHeader(m, "acme/ledger").textContent || "",
      /1 working/,
      "header still counts working",
    );
    assert.ok(
      !(groupHeader(m, "acme/ledger").textContent || "").includes("settled"),
      "settled half must leave project headers",
    );
    m.unmount();
  });

  it("archived wins over settled for a MERGED thread", async () => {
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
        { projects: [p1] },
      ),
    );
    assert.ok(m.byText("1 archived"), "archived toggle claims the thread");
    assert.ok(
      !m.text().includes("Settled ·"),
      "archived MERGED must not enter the global settled tail",
    );
    m.unmount();
  });

  it("shows All settled when a project has only settled threads", async () => {
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
      m.text().includes("All settled"),
      "fully-settled project must not claim No threads yet",
    );
    assert.ok(
      !m
        .queryAll("[class*='emptyThreads']")
        .some((el) => (el.textContent || "") === "No threads yet"),
      "the empty-group copy for a settled-only project is All settled",
    );
    m.unmount();
  });
});

describe("Sidebar global settled tail (round 40)", () => {
  it("collapses by default with a Settled · N header spanning projects", async () => {
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const header = settledTailHeader(m);
    assert.ok(
      (header.textContent || "").includes("Settled · 2"),
      "tail header counts settled from every project",
    );
    assert.equal(
      header.getAttribute("aria-expanded"),
      "false",
      "tail is collapsed by default",
    );
    assert.ok(!cardTitles(m).includes("merged-p1"));
    assert.ok(!cardTitles(m).includes("merged-p2"));
    m.unmount();
  });

  it("expands to show settled from every project, newest first", async () => {
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const header = settledTailHeader(m);
    await m.click(header);
    assert.equal(header.getAttribute("aria-expanded"), "true");
    const ids = cardTitles(m);
    assert.ok(ids.includes("merged-p1"), "p1 settled appears in the global tail");
    assert.ok(ids.includes("merged-p2"), "p2 settled appears in the same tail");
    const i2 = ids.indexOf("merged-p2");
    const i1 = ids.indexOf("merged-p1");
    assert.ok(i2 >= 0 && i1 >= 0 && i2 < i1, "newest-settled first across projects");
    m.unmount();
  });

  it("pages the tail: 40 settled → 10 visible, Show more → 35, header stays Settled · 40", async () => {
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
      (header.textContent || "").includes("Settled · 40"),
      "header reports the full settled count, not the page size",
    );
    await m.click(header);
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
      (header.textContent || "").includes("Settled · 40"),
      "header still says Settled · 40 after paging",
    );
    m.unmount();
  });

  it("exactly 10 settled shows no Show more after expand", async () => {
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
    assert.ok((header.textContent || "").includes("Settled · 10"));
    await m.click(header);
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
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        activeThreadId: "merged-p2",
      }),
    );
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
    await m.click(settledTailHeader(m));
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
    await m.click(settledTailHeader(m));
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

  it("attention card settle click sends override settled (payload, not label)", async () => {
    // Restored from round 39: hardcoding ThreadCard's override to "active"
    // must fail this test.
    const settleCalls: Array<{ id: string; o: string }> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onSetSettled: (id, o) => {
          settleCalls.push({ id, o });
        },
      }),
    );
    const settleBtn = m
      .queryAll("button")
      .find(
        (b) =>
          b.getAttribute("aria-label") === "Settle thread" &&
          !(b as HTMLButtonElement).disabled,
      ) as HTMLButtonElement | undefined;
    assert.ok(settleBtn, "attention cards offer Settle thread");
    await m.click(settleBtn);
    assert.equal(settleCalls.length, 1, "one settle call");
    assert.equal(
      settleCalls[0]!.o,
      "settled",
      "attention → settle must send override settled, not active",
    );
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
    await m.click(settledTailHeader(m));
    assert.ok(
      cardTitles(m).includes("merged-p1"),
      "p1 settled must still show in the global tail while its project is collapsed",
    );
    m.unmount();
  });

  it("search surfaces settled hits (bypasses the collapsed global tail)", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
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
});
