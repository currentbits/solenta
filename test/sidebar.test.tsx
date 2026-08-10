/**
 * Sidebar collapse + settled behavior (round 39), in jsdom with real clicks.
 *
 * Round 39: settled is effectiveSettled (PR/inactivity/override), not
 * status==="done". A fresh done thread stays visible; MERGED folds.
 *
 * Run: npm run test:renderer (jsdom via test/support/dom.ts mount()).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { inAct, mount } from "./support/dom";
import { Sidebar } from "../src/components/Sidebar";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
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

/** Recent activity so inactivity auto-settle does not fold every fixture. */
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
  over: { onSetSettled?: (id: string, o: "settled" | "active") => void } = {},
) {
  return (
    <Sidebar
      appName="Coder"
      searchPlaceholder="Search threads..."
      projectsHeader="All projects"
      projects={[project]}
      threads={threads}
      providers={providers}
      activeThreadId={null}
      onSelectThread={() => {}}
      onCreateThread={() => {}}
      onAddProject={() => {}}
      onSetSettled={over.onSetSettled}
      // Title-substring stub: the sidebar's list is entirely server-fed while
      // searching, so an empty stub would make every search test vacuous.
      searchThreads={async ({ query }) =>
        threads.filter((t) => t.title.includes(query))
      }
    />
  );
}

/**
 * Fixture mix: interesting settled case is MERGED at mid-list (not index 0).
 * Fresh done must stay in attention (round 39 change from round 38).
 */
const THREADS = [
  thread({
    id: "busy",
    title: "busy work",
    status: "working",
    runStartedAt: FRESH,
    updatedAt: FRESH + 5,
  }),
  thread({
    id: "finished",
    title: "finished work",
    status: "done",
    updatedAt: FRESH + 4,
  }),
  thread({
    id: "merged",
    title: "merged work",
    status: "done",
    prState: "MERGED",
    updatedAt: FRESH + 3,
  }),
  thread({
    id: "broken",
    title: "broken work",
    status: "failed",
    updatedAt: FRESH + 2,
  }),
];

function cardTitles(m: Awaited<ReturnType<typeof mount>>): string[] {
  return m
    .queryAll("[data-thread-card]")
    .map((el) => el.getAttribute("data-thread-card") || "");
}

function groupHeader(m: Awaited<ReturnType<typeof mount>>): HTMLElement {
  const el = m
    .queryAll("button")
    .find((b) => (b.textContent || "").includes("acme/ledger"));
  assert.ok(el, "the project group header button must render");
  return el as HTMLElement;
}

describe("Sidebar settled threads (round 39)", () => {
  it("keeps fresh done visible; folds MERGED behind a count", async () => {
    const m = await mount(sidebar(THREADS));
    assert.deepEqual(
      cardTitles(m),
      ["busy", "finished", "broken"],
      "working, fresh-done, and failed stay visible; MERGED is folded",
    );
    assert.ok(
      !cardTitles(m).includes("merged"),
      "a MERGED-prState thread IS in the settled fold (not shown by default)",
    );
    const toggle = m
      .queryAll("button")
      .find((b) => (b.textContent || "").trim() === "1 settled") as
      | HTMLButtonElement
      | undefined;
    assert.ok(toggle, "the fold must say how many threads it hides");
    await m.click(toggle);
    assert.ok(
      cardTitles(m).includes("merged"),
      "expanding must reveal the MERGED settled thread",
    );
    await m.click(m.byText("Hide settled")!);
    assert.deepEqual(cardTitles(m), ["busy", "finished", "broken"]);
    m.unmount();
  });

  it("override active keeps a MERGED thread out of the fold", async () => {
    // Interesting case is not alone / not index 0.
    const m = await mount(
      sidebar([
        thread({
          id: "busy2",
          title: "busy2",
          status: "working",
          runStartedAt: FRESH,
          updatedAt: FRESH + 9,
        }),
        thread({
          id: "pinned",
          title: "pinned active",
          status: "done",
          prState: "MERGED",
          settledOverride: "active",
          updatedAt: FRESH + 8,
        }),
        thread({
          id: "other-merged",
          title: "other merged",
          status: "done",
          prState: "MERGED",
          updatedAt: FRESH + 7,
        }),
      ]),
    );
    assert.ok(
      cardTitles(m).includes("pinned"),
      "override active MERGED thread is NOT in the fold",
    );
    assert.ok(
      !cardTitles(m).includes("other-merged"),
      "a plain MERGED sibling still folds",
    );
    m.unmount();
  });

  it("archived wins over settled for a MERGED thread", async () => {
    const m = await mount(
      sidebar([
        thread({
          id: "kept",
          title: "kept",
          status: "working",
          runStartedAt: 1,
        }),
        thread({
          id: "gone",
          title: "gone",
          status: "done",
          prState: "MERGED",
          archived: true,
        }),
      ]),
    );
    assert.ok(
      m.byText("1 archived"),
      "the archived toggle must claim the thread",
    );
    assert.equal(
      m
        .queryAll("button")
        .find((b) => (b.textContent || "").trim() === "1 settled"),
      undefined,
      "the settled fold must not double-count an archived MERGED thread",
    );
    m.unmount();
  });

  it("shows the t3-style summary on the group header", async () => {
    const m = await mount(sidebar(THREADS));
    assert.match(
      groupHeader(m).textContent || "",
      /1 working · 1 settled/,
      "the header must count working and effective-settled",
    );
    m.unmount();
  });

  it("settle hover action calls onSetSettled with the right override", async () => {
    const calls: Array<{ id: string; o: "settled" | "active" }> = [];
    const m = await mount(
      sidebar(THREADS, {
        onSetSettled: (id, o) => {
          calls.push({ id, o });
        },
      }),
    );
    // Fresh done is in attention → Settle thread. Prefer a non-disabled
    // control: the working card also renders Settle thread but disabled.
    const settleBtn = m
      .queryAll("button")
      .find(
        (b) =>
          b.getAttribute("aria-label") === "Settle thread" &&
          !(b as HTMLButtonElement).disabled,
      ) as HTMLButtonElement | undefined;
    assert.ok(settleBtn, "attention cards offer Settle thread");
    await m.click(settleBtn);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.o, "settled");
    // Expand settled fold and click Keep thread active.
    const toggle = m
      .queryAll("button")
      .find((b) => (b.textContent || "").trim() === "1 settled") as
      | HTMLButtonElement
      | undefined;
    assert.ok(toggle);
    await m.click(toggle);
    const keepBtn = m
      .queryAll("button")
      .find((b) => b.getAttribute("aria-label") === "Keep thread active") as
      | HTMLButtonElement
      | undefined;
    assert.ok(keepBtn, "settled cards offer Keep thread active");
    await m.click(keepBtn);
    assert.equal(calls[calls.length - 1]!.o, "active");
    // Working card's settle control is disabled.
    const workingCard = m.query('[data-thread-card="busy"]')!;
    const workingSettle = workingCard.querySelector(
      'button[aria-label="Settle thread"]',
    ) as HTMLButtonElement | null;
    assert.ok(workingSettle);
    assert.equal(workingSettle.disabled, true);
    assert.equal(
      workingSettle.title,
      "Cannot settle while a run is active",
    );
    m.unmount();
  });
});

describe("Sidebar project collapse", () => {
  it("collapses a group to its header and persists across mounts", async () => {
    window.localStorage.clear();
    const m = await mount(sidebar(THREADS));
    await m.click(groupHeader(m));
    assert.deepEqual(cardTitles(m), [], "a collapsed group shows no cards");
    assert.equal(
      groupHeader(m).getAttribute("aria-expanded"),
      "false",
      "the header must announce the collapsed state",
    );
    m.unmount();

    const m2 = await mount(sidebar(THREADS));
    assert.deepEqual(
      cardTitles(m2),
      [],
      "the collapse must survive a remount via localStorage",
    );
    await m2.click(groupHeader(m2));
    assert.deepEqual(cardTitles(m2), ["busy", "finished", "broken"]);
    m2.unmount();
    window.localStorage.clear();
  });

  it("search results override both collapse and the settled fold", async () => {
    window.localStorage.clear();
    const m = await mount(sidebar(THREADS));
    await m.click(groupHeader(m));
    assert.deepEqual(cardTitles(m), []);

    const input = m.query("input") as HTMLInputElement;
    assert.ok(input, "the search input must render");
    // Search for the MERGED thread, which is folded when not searching.
    await m.type(input, "merged");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.deepEqual(
      cardTitles(m),
      ["merged"],
      "a MERGED thread inside a collapsed group must still surface as a hit",
    );
    m.unmount();
    window.localStorage.clear();
  });
});
