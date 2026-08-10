/**
 * Sidebar collapse + settled behavior (round 38), in jsdom with real clicks.
 *
 * Covers the two interactive claims markup tests cannot reach: clicking the
 * project header collapses the group (and persists), and the settled toggle
 * hides/reveals done threads. Search overriding both is asserted here too,
 * because a collapsed group that swallows search hits makes results lie.
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

function thread(over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">): ThreadInfo {
  return {
    projectId: "p1",
    title: over.id,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

function sidebar(threads: ThreadInfo[]) {
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
      // Title-substring stub: the sidebar's list is entirely server-fed while
      // searching, so an empty stub would make every search test vacuous.
      searchThreads={async ({ query }) =>
        threads.filter((t) => t.title.includes(query))
      }
    />
  );
}

const THREADS = [
  thread({ id: "busy", title: "busy work", status: "working", runStartedAt: 1, updatedAt: 5 }),
  thread({ id: "finished", title: "finished work", status: "done", updatedAt: 4 }),
  thread({ id: "broken", title: "broken work", status: "failed", updatedAt: 3 }),
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

describe("Sidebar settled threads", () => {
  it("folds done threads behind a count and reveals them on toggle", async () => {
    const m = await mount(sidebar(THREADS));
    assert.deepEqual(
      cardTitles(m),
      ["busy", "broken"],
      "working and failed stay visible; done is folded",
    );
    // Exact match: the group HEADER's summary also contains "1 settled", and
    // an includes-match would click the header and collapse the group.
    const toggle = m
      .queryAll("button")
      .find((b) => (b.textContent || "").trim() === "1 settled") as
      | HTMLButtonElement
      | undefined;
    assert.ok(toggle, "the fold must say how many threads it hides");
    await m.click(toggle);
    assert.ok(
      cardTitles(m).includes("finished"),
      "expanding must reveal the settled thread",
    );
    await m.click(m.byText("Hide settled")!);
    assert.deepEqual(cardTitles(m), ["busy", "broken"]);
    m.unmount();
  });

  it("archived wins over settled for a done thread", async () => {
    // The split runs on the non-archived list. Splitting the whole group
    // instead would show a done+archived thread in BOTH folds (round 38
    // review: that mutation survived the full suite).
    const m = await mount(
      sidebar([
        thread({ id: "kept", title: "kept", status: "working", runStartedAt: 1 }),
        thread({ id: "gone", title: "gone", status: "done", archived: true }),
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
      "the settled fold must not double-count an archived done thread",
    );
    m.unmount();
  });

  it("shows the t3-style summary on the group header", async () => {
    const m = await mount(sidebar(THREADS));
    assert.match(
      groupHeader(m).textContent || "",
      /1 working · 1 settled/,
      "the header must count working and settled",
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

    // A fresh mount reads the persisted choice, like an app restart.
    const m2 = await mount(sidebar(THREADS));
    assert.deepEqual(
      cardTitles(m2),
      [],
      "the collapse must survive a remount via localStorage",
    );
    await m2.click(groupHeader(m2));
    assert.deepEqual(cardTitles(m2), ["busy", "broken"]);
    m2.unmount();
    window.localStorage.clear();
  });

  it("search results override both collapse and the settled fold", async () => {
    window.localStorage.clear();
    const m = await mount(sidebar(THREADS));
    await m.click(groupHeader(m));
    assert.deepEqual(cardTitles(m), []);

    // The search list is server-fed behind a 250ms debounce; wait it out.
    const input = m.query("input") as HTMLInputElement;
    assert.ok(input, "the search input must render");
    await m.type(input, "finished");
    // The debounce resolves state inside act, or the console gate trips on
    // React's not-wrapped-in-act warning.
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.deepEqual(
      cardTitles(m),
      ["finished"],
      "a done thread inside a collapsed group must still surface as a hit",
    );
    m.unmount();
    window.localStorage.clear();
  });
});
