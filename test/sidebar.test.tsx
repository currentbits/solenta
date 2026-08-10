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
import { Sidebar } from "../src/components/Sidebar";
import {
  SETTLED_TAIL_INITIAL_COUNT,
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
});

describe("Sidebar global settled tail (round 40)", () => {
  it("collapses by default with a Settled · N header spanning projects", async () => {
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const header = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Settled ·"));
    assert.ok(header, "global Settled · N header must exist");
    assert.ok(
      (header!.textContent || "").includes("Settled · 2"),
      "tail header counts settled from every project",
    );
    assert.equal(
      header!.getAttribute("aria-expanded"),
      "false",
      "tail is collapsed by default",
    );
    // No settled rows while collapsed (except carve-out, which needs selection).
    assert.ok(!cardTitles(m).includes("merged-p1"));
    assert.ok(!cardTitles(m).includes("merged-p2"));
    m.unmount();
  });

  it("expands to show settled from every project, newest first", async () => {
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const header = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Settled ·")) as
      | HTMLButtonElement
      | undefined;
    assert.ok(header);
    await m.click(header!);
    assert.equal(header!.getAttribute("aria-expanded"), "true");
    const ids = cardTitles(m);
    assert.ok(ids.includes("merged-p1"), "p1 settled appears in the global tail");
    assert.ok(ids.includes("merged-p2"), "p2 settled appears in the same tail");
    // Newest settledAt first: merged-p2 (FRESH+35) before merged-p1 (FRESH+30).
    const i2 = ids.indexOf("merged-p2");
    const i1 = ids.indexOf("merged-p1");
    assert.ok(i2 >= 0 && i1 >= 0 && i2 < i1, "newest-settled first across projects");
    m.unmount();
  });

  it("pages the tail: 11 settled shows 10 + Show more reveals the rest", async () => {
    const many = Array.from({ length: SETTLED_TAIL_INITIAL_COUNT + 1 }, (_, i) =>
      thread({
        id: `s${i}`,
        title: `settled ${i}`,
        status: "done",
        prState: "MERGED",
        // Descending settledAt so s0 is newest.
        settledAt: FRESH + 1000 - i,
        updatedAt: FRESH + 1000 - i,
        // Alternate projects so not all one project.
        projectId: i % 2 === 0 ? "p1" : "p2",
      }),
    );
    // Attention noise so projects are not empty-only.
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
    const header = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Settled ·")) as
      | HTMLButtonElement
      | undefined;
    assert.ok(header);
    assert.ok(
      (header!.textContent || "").includes(
        `Settled · ${SETTLED_TAIL_INITIAL_COUNT + 1}`,
      ),
    );
    await m.click(header!);
    const shown = cardTitles(m).filter((id) => id.startsWith("s"));
    assert.equal(
      shown.length,
      SETTLED_TAIL_INITIAL_COUNT,
      "initial expand shows only the first page",
    );
    const more = m.byText("Show more");
    assert.ok(more, "Show more appears when more settled remain");
    await m.click(more!);
    const after = cardTitles(m).filter((id) => id.startsWith("s"));
    assert.equal(
      after.length,
      SETTLED_TAIL_INITIAL_COUNT + 1,
      "Show more reveals the remaining settled row",
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
    const header = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Settled ·")) as
      | HTMLButtonElement
      | undefined;
    assert.ok(header);
    await m.click(header!);
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
    const header = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Settled ·")) as
      | HTMLButtonElement
      | undefined;
    assert.ok(header);
    await m.click(header!);
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
});

describe("Sidebar project collapse", () => {
  it("collapses a group to its header and persists across mounts", async () => {
    window.localStorage.clear();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await m.click(groupHeader(m, "acme/ledger"));
    // Settled tail still present; only the ledger project cards vanish.
    assert.ok(!cardTitles(m).includes("busy"));
    assert.ok(!cardTitles(m).includes("finished"));
    assert.equal(
      groupHeader(m, "acme/ledger").getAttribute("aria-expanded"),
      "false",
    );
    m.unmount();

    const m2 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.ok(
      !cardTitles(m2).includes("busy"),
      "collapse must survive a remount via localStorage",
    );
    await m2.click(groupHeader(m2, "acme/ledger"));
    assert.ok(cardTitles(m2).includes("busy"));
    m2.unmount();
    window.localStorage.clear();
  });

  it("search surfaces settled hits (bypasses the collapsed global tail)", async () => {
    window.localStorage.clear();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    // Tail is collapsed; settled not in cards.
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
    window.localStorage.clear();
  });
});
