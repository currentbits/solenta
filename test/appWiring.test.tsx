/**
 * App-level IPC wiring: does the app hand the RIGHT preload channel to each
 * component, with the right arguments?
 *
 * Every component test to date stubs the props a component receives, so all of
 * them pass if App wires `searchMemory` where `recentMemory` belongs, or aims
 * Stop at the wrong thread. tsc cannot see it either, because the signatures
 * match. These tests mount the real App against a recording `window.coder`.
 *
 * Run: node --import=./test/support/render.mjs --test test/appWiring.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount, inAct } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { ProviderInfo } from "../src/shared/ipc";

async function boot(fake: FakeCoder) {
  // window must exist before the fake is installed, and dom.ts creates it on
  // first mount, so mount an empty shell first.
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

describe("App boot wiring", () => {
  it("loads projects, threads, providers and workflows on boot", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    for (const channel of [
      "projects.list",
      "threads.list",
      "providers.list",
      "workflows.list",
    ]) {
      assert.equal(
        fake.of(channel).length,
        1,
        `${channel} must be called exactly once on boot`,
      );
    }
    m.unmount();
  });

  it("subscribes to both push channels", async () => {
    // Losing either subscription means the UI silently stops updating while
    // agents keep running.
    const fake = createFakeCoder();
    const m = await boot(fake);
    assert.ok(
      fake.channels().includes("on:threads:changed"),
      "must subscribe to threads:changed",
    );
    assert.ok(
      fake.channels().includes("on:thread:updated"),
      "must subscribe to thread:updated",
    );
    m.unmount();
  });

  it("unsubscribes on unmount", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    assert.ok(fake.liveSubscriptions() > 0, "subscriptions must be live");
    m.unmount();
    assert.equal(
      fake.liveSubscriptions(),
      0,
      "every subscription must be torn down, or a dead tree keeps receiving",
    );
  });

  it("renders the threads the server returned, not a placeholder", async () => {
    const fake = createFakeCoder({
      threads: [thread({ id: "t9", title: "unmistakable thread title" })],
    });
    const m = await boot(fake);
    assert.ok(
      m.text().includes("unmistakable thread title"),
      `boot data must reach the sidebar, got: ${m.text().slice(0, 160)}`,
    );
    m.unmount();
  });

  it("applies a pushed threads:changed instead of ignoring it", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    assert.ok(!m.text().includes("pushed later"));
    await m.flush();
    await inAct(() =>
      fake.emitThreads([thread({ id: "t2", title: "pushed later" })]),
    );
    await m.flush();
    assert.ok(
      m.text().includes("pushed later"),
      "a pushed thread list must reach the UI",
    );
    m.unmount();
  });
});

describe("App thread selection wiring", () => {
  it("fetches the detail of the thread that was clicked", async () => {
    const fake = createFakeCoder({
      threads: [
        thread({ id: "ta", title: "alpha thread" }),
        thread({ id: "tb", title: "beta thread" }),
      ],
      details: {
        tb: detail({ thread: thread({ id: "tb", title: "beta thread" }) }),
      },
    });
    const m = await boot(fake);
    // The select control is an EMPTY stretched overlay button (round 27's
    // single-tab-stop fix), so it must be found by accessible name, not text.
    const target = m.query('button[aria-label="Select thread: beta thread"]');
    assert.ok(target, "the beta thread card must be present");
    await m.click(target);

    const gets = fake.of("threads.get");
    assert.ok(gets.length > 0, "selecting a thread must fetch its detail");
    assert.equal(
      gets[gets.length - 1].args[0],
      "tb",
      "the detail fetched must be for the thread that was clicked",
    );
    m.unmount();
  });

  it("never renders the previous thread's transcript under a new selection (issue #83)", async () => {
    // Over --serve-web latency the detail fetch for a freshly clicked thread
    // stays pending while the sidebar already shows the new selection. The
    // old transcript must not render in that window — a fast send would go
    // to the new thread while the user reads the old one.
    const ta = thread({ id: "ta", title: "alpha thread" });
    const tb = thread({ id: "tb", title: "beta thread" });
    const tbDetail = detail({
      thread: tb,
      messages: [
        {
          id: "mb",
          role: "assistant",
          text: "beta transcript marker",
          createdAt: Date.now(),
        },
      ],
    });
    const fake = createFakeCoder({
      threads: [ta, tb],
      details: {
        ta: detail({
          thread: ta,
          messages: [
            {
              id: "ma",
              role: "assistant",
              text: "alpha transcript marker",
              createdAt: Date.now(),
            },
          ],
        }),
        tb: tbDetail,
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();
      assert.ok(
        m.text().includes("alpha transcript marker"),
        "precondition: the boot-selected thread's transcript renders",
      );

      // Simulate latency: threads.get for tb stays pending until the test
      // resolves it. Recording continues so the fetch is still observable.
      const origGet = fake.api.threads.get;
      let resolveTb: ((d: typeof tbDetail) => void) | null = null;
      fake.api.threads.get = ((id: string) => {
        if (id === "tb") {
          fake.calls.push({ channel: "threads.get", args: [id] });
          return new Promise((res) => {
            resolveTb = res;
          });
        }
        return origGet(id);
      }) as typeof fake.api.threads.get;

      const card = m.query('button[aria-label="Select thread: beta thread"]');
      assert.ok(card, "the beta thread card must be present");
      await m.click(card);
      await m.flush();

      assert.ok(
        fake.of("threads.get").some((c) => c.args[0] === "tb"),
        "selecting beta must fetch its detail",
      );
      assert.ok(
        !m.text().includes("alpha transcript marker"),
        "the previous thread's transcript must not render under the new selection",
      );
      assert.ok(
        m.text().includes("Select a thread"),
        "the gated view must fall back to the empty state while loading",
      );

      // When the fetch resolves, the NEW thread's transcript appears.
      await inAct(async () => {
        resolveTb!(tbDetail);
        await Promise.resolve();
      });
      await m.flush();
      assert.ok(
        m.text().includes("beta transcript marker"),
        "the fetched detail must render once it resolves",
      );
    } finally {
      m.unmount();
    }
  });

  it("surfaces a failed detail load with an error + retry that re-fetches the same thread (issue #82)", async () => {
    // threads.get rejecting used to dead-end on the neutral "Select a thread"
    // state, and re-clicking the same thread was a no-op (selection state
    // unchanged, so the effect never re-ran). The UI must show the failure
    // and Retry must re-run the fetch for the ALREADY-selected thread.
    const ta = thread({ id: "ta", title: "alpha thread" });
    const taDetail = detail({
      thread: ta,
      messages: [
        {
          id: "ma",
          role: "assistant",
          text: "alpha transcript marker",
          createdAt: Date.now(),
        },
      ],
    });
    const fake = createFakeCoder({
      threads: [ta],
      details: { ta: taDetail },
    });
    const origGet = fake.api.threads.get;
    let failing = true;
    fake.api.threads.get = ((id: string) => {
      if (failing) {
        fake.calls.push({ channel: "threads.get", args: [id] });
        return Promise.reject(new Error("disk on fire"));
      }
      return origGet(id);
    }) as typeof fake.api.threads.get;

    const m = await boot(fake);
    try {
      await m.flush();
      assert.ok(
        fake.of("threads.get").some((c) => c.args[0] === "ta"),
        "precondition: boot selected alpha and fetched its detail",
      );
      assert.ok(
        m.text().includes("Couldn’t load this thread"),
        `the load failure must surface, got: ${m.text().slice(0, 200)}`,
      );
      assert.ok(
        m.text().includes("disk on fire"),
        "the rejection message must be visible",
      );
      assert.ok(
        !m.text().includes("Choose a thread from the sidebar"),
        "a failed load must not fall back to the neutral empty state",
      );

      failing = false;
      await m.click(m.byText("Retry"));
      await m.flush();

      assert.equal(
        fake.of("threads.get").filter((c) => c.args[0] === "ta").length,
        2,
        "retry must re-run threads.get for the already-selected thread",
      );
      assert.ok(
        m.text().includes("alpha transcript marker"),
        "the detail must render after a successful retry",
      );
    } finally {
      m.unmount();
    }
  });
});

describe("App memory wiring", () => {
  it("hands the Memory tab the RECENT channel, not search", async () => {
    // The two have compatible shapes, so swapping them typechecks and every
    // component-level test still passes.
    const fake = createFakeCoder({
      projects: [project()],
      threads: [thread()],
    });
    const m = await boot(fake);
    const memoryTab = m
      .queryAll("button")
      .find((b) => (b.textContent || "").trim() === "Memory");
    assert.ok(memoryTab, "the Memory tab control must exist");
    await m.click(memoryTab);

    assert.ok(
      fake.of("memory.recent").length > 0,
      "opening Memory must load recent entries",
    );
    assert.equal(
      fake.of("memory.search").length,
      0,
      "opening Memory with no query must not call search",
    );
    m.unmount();
  });

  it("scopes the memory list to the selected project", async () => {
    const fake = createFakeCoder({
      projects: [project({ id: "p1", slug: "owner/repo" })],
      threads: [thread({ id: "t1", projectId: "p1" })],
    });
    const m = await boot(fake);
    const target = m.query('button[aria-label="Select thread: first thread"]');
    assert.ok(target, "the thread card must be present");
    await m.click(target);
    const memoryTab = m
      .queryAll("button")
      .find((b) => (b.textContent || "").trim() === "Memory");
    assert.ok(memoryTab);
    await m.click(memoryTab);

    const recent = fake.of("memory.recent");
    assert.ok(recent.length > 0, "memory.recent must be called");
    const arg = recent[recent.length - 1].args[0] as { project?: string };
    // The VALUE, not just the key: asserting "project" in arg passed while the
    // app scoped memory to a project that does not exist. Scope is the repo
    // PATH, never the display slug — the memory server canonicalizes paths,
    // and a slug like "owner/repo" lands in a scope no agent writes to.
    assert.equal(
      arg?.project,
      "/tmp/repo",
      `memory.recent must be scoped to the selected project's path, got: ${JSON.stringify(arg)}`,
    );
    m.unmount();
  });
});

describe("App archive undo toast wiring", () => {
  /**
   * Load-bearing for handleSetArchived / undoArchive / the pre-move id capture.
   * A local Host harness that re-implements the same flow is vacuous (ISSUES
   * flavour #12): gutting undoArchive in App.tsx must fail THIS test.
   */
  it("archives through the real UI and Undo records setArchived false for the captured id", async () => {
    // Distinct id mid-list, not "t1" / index 0 (fixture discipline).
    const target = thread({
      id: "t-to-archive",
      title: "thread marked for archive undo",
      projectId: "p1",
    });
    const keeper = thread({
      id: "t-stays",
      title: "keeper stays visible",
      projectId: "p1",
      updatedAt: (target.updatedAt ?? Date.now()) - 1000,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      // Target first so boot selects it (preferred = first non-archived).
      threads: [target, keeper],
      details: {
        "t-to-archive": detail({ thread: target }),
        "t-stays": detail({ thread: keeper }),
      },
    });
    const m = await boot(fake);

    // Boot already selects the first thread; open its overflow and archive.
    const menuBtn = m
      .queryAll("button")
      .find((b) => b.getAttribute("aria-label") === "Thread actions");
    assert.ok(menuBtn, "Thread actions menu must be present on the open thread");
    await m.click(menuBtn as HTMLElement);

    const archiveItem = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Archive thread"));
    assert.ok(archiveItem, "Archive thread menu item must exist");
    await m.click(archiveItem as HTMLElement);

    const archivedCalls = fake.of("threads.setArchived");
    assert.ok(
      archivedCalls.length >= 1,
      "archive must hit threads.setArchived",
    );
    assert.deepEqual(
      archivedCalls[archivedCalls.length - 1]!.args[0],
      { threadId: "t-to-archive", archived: true },
      "the archive call must name the open thread and archived:true",
    );

    assert.ok(
      m.text().includes("Archived"),
      "App-level toast must appear after archive",
    );
    const undo = m.byText("Undo");
    assert.ok(undo, "toast Undo control must be present");
    await m.click(undo!);

    const unarchive = fake
      .of("threads.setArchived")
      .map((c) => c.args[0] as { threadId: string; archived: boolean })
      .find((a) => a.archived === false);
    assert.ok(
      unarchive,
      "Undo must call threads.setArchived with archived:false",
    );
    assert.deepEqual(
      unarchive,
      { threadId: "t-to-archive", archived: false },
      "Undo must restore the CAPTURED id, not whatever is selected after archive",
    );
    m.unmount();
  });
});

describe("App reasoning-effort wiring", () => {
  const claude = {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: ["claude-opus-5"],
    modelInfo: [
      {
        id: "claude-opus-5",
        label: "Opus (1M context)",
        description: "Best for everyday, complex tasks",
        vendor: "Anthropic",
        recommended: true,
      },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  } as unknown as ProviderInfo;

  it("sends the picked level to setReasoningEffort, with the thread id", async () => {
    // The prop firing is not enough: useCoder could send null, or App could
    // pass a no-op handler, and every component test would still pass.
    const picked = thread({ provider: "claude", model: "claude-opus-5" });
    const fake = createFakeCoder({
      providers: [claude],
      threads: [picked],
      // The composer reads the selected thread's DETAIL, not the list row.
      details: { t1: detail({ thread: picked }) },
    });
    const m = await boot(fake);
    const card = m.query('button[aria-label="Select thread: first thread"]');
    assert.ok(card, "the thread card must be present");
    await m.click(card);

    const trigger = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Opus (1M context)"));
    assert.ok(trigger, "the model trigger must show the label");
    await m.click(trigger);

    const segments = m.queryAll('[aria-label^="Reasoning "]');
    assert.ok(
      segments.length >= 3,
      `expected one segment per supported level, got ${segments.length}`,
    );
    const high = segments.find((s) =>
      (s.getAttribute("aria-label") || "") === "Reasoning High",
    );
    assert.ok(high, "a High segment must exist for claude");
    await m.click(high);

    const call = fake.only("threads.setReasoningEffort");
    assert.deepEqual(
      call.args[0],
      { threadId: "t1", effort: "high" },
      "the picked level and the thread id must both reach the channel",
    );
    m.unmount();
  });
});

describe("App remove-project wiring (round 41)", () => {
  // Fixture discipline: two projects; remove the NON-first; selected thread
  // is not list index 0 (boot prefers first non-archived — we re-select).
  const pFirst = project({
    id: "p-first",
    slug: "acme/first",
    name: "first",
    path: "/tmp/first",
  });
  const pDrop = project({
    id: "p-drop",
    slug: "acme/drop",
    name: "drop",
    path: "/tmp/drop",
  });
  const t0 = thread({
    id: "t0",
    projectId: "p-first",
    title: "index zero",
    updatedAt: Date.now() + 100,
  });
  const tKeep = thread({
    id: "t-keep",
    projectId: "p-first",
    title: "keep me",
    updatedAt: Date.now() + 50,
  });
  const tDrop = thread({
    id: "t-drop",
    projectId: "p-drop",
    title: "drop me",
    updatedAt: Date.now() + 200,
  });

  it("Confirm records projects.remove with the right id; Cancel records nothing", async () => {
    const fake = createFakeCoder({
      projects: [pFirst, pDrop],
      threads: [t0, tKeep, tDrop],
      details: {
        t0: detail({ thread: t0 }),
        "t-keep": detail({ thread: tKeep }),
        "t-drop": detail({ thread: tDrop }),
      },
    });
    const m = await boot(fake);

    // Cancel path first — empty assertion is non-vacuous only if Confirm records.
    await m.click(m.query('[data-project-remove="p-drop"]'));
    await m.click(m.byText("Cancel"));
    await m.flush();
    assert.equal(
      fake.of("projects.remove").length,
      0,
      "Cancel must not call projects.remove",
    );

    await m.click(m.query('[data-project-remove="p-drop"]'));
    await m.click(m.query('[data-remove-confirm-submit="p-drop"]'));
    await m.flush();

    const removeCalls = fake.of("projects.remove");
    assert.equal(removeCalls.length, 1, "Confirm records exactly one remove");
    assert.deepEqual(
      removeCalls[0]!.args[0],
      { projectId: "p-drop" },
      "remove must name the NON-first project",
    );
    m.unmount();
  });

  /**
   * Handoff pin (M10): deleting the openBelongs / nextVisibleThreadId /
   * setSelectedThreadId / setDetail block left appWiring green because the
   * old test only checked that survivor cards still rendered. Assert WHERE
   * selection lands — data-active on the successor card + threads.get for
   * that id. Name is shared-pattern ready for threads.delete handoff.
   */
  it("selection handoff lands on the successor (data-active + threads.get) after remove — same pin for threads.delete", async () => {
    const fake = createFakeCoder({
      projects: [pFirst, pDrop],
      threads: [t0, tKeep, tDrop],
      details: {
        t0: detail({ thread: t0 }),
        "t-keep": detail({ thread: tKeep }),
        "t-drop": detail({ thread: tDrop }),
      },
    });
    const m = await boot(fake);

    // Select NON-index-0 thread that lives in the project we will remove.
    const dropCard = m.query('button[aria-label="Select thread: drop me"]');
    assert.ok(dropCard, "drop thread card must render");
    await m.click(dropCard);
    await m.flush();

    const selectedBefore = m.query(
      '[data-thread-card="t-drop"][data-active="true"]',
    );
    assert.ok(
      selectedBefore,
      "precondition: drop thread is the active selection",
    );

    await m.click(m.query('[data-project-remove="p-drop"]'));
    await m.click(m.query('[data-remove-confirm-submit="p-drop"]'));
    await m.flush();

    assert.deepEqual(
      fake.of("projects.remove").at(-1)?.args[0],
      { projectId: "p-drop" },
    );
    assert.equal(
      m.query('[data-thread-card="t-drop"]'),
      null,
      "removed project's thread must leave the sidebar",
    );

    // nextVisibleThreadId on the post-remove list (t0, t-keep) returns t0 —
    // the first remaining non-archived thread (same rule deleteThread uses).
    const successorCard = m.query(
      '[data-thread-card="t0"][data-active="true"]',
    );
    assert.ok(
      successorCard,
      "successor t0 must carry data-active=true — proves setSelectedThreadId ran",
    );
    assert.equal(
      m.query('[data-thread-card="t-keep"][data-active="true"]'),
      null,
      "only the handoff target is active, not every survivor",
    );

    // useCoder clears detail then loads the new selection — threads.get must
    // name the successor (not the deleted thread).
    const getIds = fake.of("threads.get").map((c) => c.args[0]);
    assert.equal(
      getIds[getIds.length - 1],
      "t0",
      "last threads.get must be the handoff successor id",
    );
    m.unmount();
  });

  it("failure path shows Failed to remove toast without crashing", async () => {
    const fake = createFakeCoder({
      projects: [pFirst, pDrop],
      threads: [t0, tDrop],
      details: {
        t0: detail({ thread: t0 }),
        "t-drop": detail({ thread: tDrop }),
      },
      fail: {
        "projects.remove": new Error(
          "Cannot remove a project while a run is active",
        ),
      },
    });
    const m = await boot(fake);
    await m.click(m.query('[data-project-remove="p-drop"]'));
    await m.click(m.query('[data-remove-confirm-submit="p-drop"]'));
    await m.flush();

    const toast = m.query('[data-toast="error"]');
    assert.ok(toast, "error toast must render on reject");
    assert.ok(
      (toast!.textContent || "").includes('Failed to remove "acme/drop"'),
      "toast title must be Failed to remove \"slug\"",
    );
    // Dialog closed; app still alive.
    assert.equal(m.query('[data-remove-confirm="p-drop"]'), null);
    assert.ok(
      m.query('button[aria-label="Select thread: drop me"]'),
      "failed remove must leave the project intact",
    );
    m.unmount();
  });
});


describe("App selection stamps lastVisitedAt (round 43 unread)", () => {
  /**
   * Round-trip pin (reviewer B1): asserting the dot vanishes while the thread
   * is ACTIVE only re-proves the !active render rule — a neutered fake stamp
   * (R7) or a deleted useCoder list-merge (R8) still "pass". Force the row
   * off the selection first, then require the stamp to still hold.
   */
  it("keeps the unread dot gone after select → select-elsewhere (real stamp + list merge)", async () => {
    // Fixture discipline: unread is neither index 0 nor the boot-selected thread.
    const t0 = Date.now();
    const visited = thread({
      id: "t-open",
      title: "already open",
      projectId: "p1",
      updatedAt: t0,
      lastVisitedAt: t0,
    });
    // Activity in the PAST so a real Date.now() stamp can catch up to it.
    // (A future updatedAt would stay unread forever and hide stamp failures.)
    const unreadVisitedAt = t0 - 60_000;
    const unread = thread({
      id: "t-unread-mid",
      title: "needs a look",
      projectId: "p1",
      updatedAt: t0 - 1_000,
      lastVisitedAt: unreadVisitedAt,
    });
    const keeper = thread({
      id: "t-keeper",
      title: "quiet peer",
      projectId: "p1",
      updatedAt: t0 - 2_000,
      lastVisitedAt: t0 - 2_000,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [visited, unread, keeper],
      details: {
        "t-open": detail({ thread: visited }),
        "t-unread-mid": detail({ thread: unread }),
        "t-keeper": detail({ thread: keeper }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();

      assert.ok(
        m.query('[data-unread-dot="t-unread-mid"]'),
        "before select: unread mid must show a dot",
      );
      // Project header counts the one unread attention row.
      const headerBefore = m
        .queryAll("button")
        .find((b) => (b.textContent || "").includes("owner/repo"));
      assert.ok(
        (headerBefore?.textContent || "").includes("1 unread"),
        `header must count 1 unread before visit, got: ${headerBefore?.textContent}`,
      );

      // Prefer data-thread-card select (stable under aria-label churn).
      const unreadCard = m.query('[data-thread-card="t-unread-mid"]');
      assert.ok(unreadCard, "unread card must render");
      const selectUnread =
        unreadCard!.querySelector("button.cardSelect, button") ??
        m.query('button[aria-label="Select thread: needs a look, unread"]');
      assert.ok(selectUnread, "unread card select control must exist");
      await m.click(selectUnread as HTMLElement);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      assert.ok(
        fake.of("threads.get").some((c) => c.args[0] === "t-unread-mid"),
        "select must call threads.get for the unread thread",
      );

      // Critical: leave the thread so !active no longer hides the dot for free.
      const keeperCard = m.query('[data-thread-card="t-keeper"]');
      assert.ok(keeperCard, "keeper card must render");
      const selectKeeper =
        keeperCard!.querySelector("button") ??
        m.query('button[aria-label="Select thread: quiet peer"]');
      assert.ok(selectKeeper, "keeper select control must exist");
      await m.click(selectKeeper as HTMLElement);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      // Boolean form: assert.equal(el, null) hangs serialising a live DOM node.
      assert.equal(
        m.query('[data-unread-dot="t-unread-mid"]') != null,
        false,
        "after select → select-elsewhere: only a real stamp+merge keeps the dot gone",
      );
      assert.equal(
        m
          .query('[data-thread-card="t-unread-mid"]')
          ?.getAttribute("data-unread") ?? null,
        null,
        "row must not remain data-unread once visited and deselected",
      );

      // Fake state must show lastVisitedAt advanced (dies if get is a passthrough).
      const listed = await fake.api.threads.list();
      const mid = listed.find((t) => t.id === "t-unread-mid");
      assert.ok(mid, "list must still carry t-unread-mid");
      assert.ok(
        mid!.lastVisitedAt != null && mid!.lastVisitedAt > unreadVisitedAt,
        `fake must stamp lastVisitedAt past the pre-visit value, got ${mid!.lastVisitedAt}`,
      );
      assert.ok(
        mid!.lastVisitedAt! >= mid!.updatedAt,
        "stamped visit must leave the row not-unread by the pure predicate",
      );

      // Header unread count must drop (0 → no "unread" fragment).
      const headerAfter = m
        .queryAll("button")
        .find((b) => (b.textContent || "").includes("owner/repo"));
      assert.ok(
        !(headerAfter?.textContent || "").includes("unread"),
        `header must drop unread after visit, got: ${headerAfter?.textContent}`,
      );
    } finally {
      m.unmount();
    }
  });
  async function openPulse(m: Awaited<ReturnType<typeof boot>>) {
    const pulse = m.query('[data-panel-tab="pulse"]');
    assert.ok(pulse, "right sidebar must offer a Pulse tab");
    await m.click(pulse as HTMLElement);
    await m.flush();
  }

  it("Usage nav opens the usage view on the usage.byDay channel", async () => {
    // The view is only as good as its wire: a nav that renders the pane but
    // reads the wrong channel shows an empty chart forever.
    const fake = createFakeCoder();
    const m = await boot(fake);
    try {
      await openPulse(m);
      const nav = m.query('[data-view-nav="usage"]');
      assert.ok(nav, "Pulse tab must offer a Usage row");
      await m.click(nav as HTMLElement);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      assert.equal(
        fake.of("usage.byDay").length,
        1,
        "opening Usage must read the ledger exactly once",
      );
      assert.ok(m.query("[data-usage]"), "usage view must render");
    } finally {
      m.unmount();
    }
  });

  it("Fleet nav opens the fleet view on the fleet.evidence channel", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    try {
      await openPulse(m);
      const nav = m.query('[data-view-nav="fleet"]');
      assert.ok(nav, "Pulse tab must offer a Fleet row");
      await m.click(nav as HTMLElement);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      assert.equal(
        fake.of("fleet.evidence").length,
        1,
        "opening Fleet must read evidence exactly once",
      );
      assert.ok(m.query("[data-fleet]"), "fleet view must render");
    } finally {
      m.unmount();
    }
  });

  it("Environment PR card opens the pull-requests view", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    try {
      assert.equal(
        m.query('[data-view-nav="prs"]'),
        null,
        "left bar must not keep a Pull requests row",
      );
      const btn = m.query("[data-open-prs]");
      assert.ok(btn, "Environment must offer a pull-requests card");
      await m.click(btn as HTMLElement);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();
      assert.ok(m.query("[data-pr-list]"), "PR list must render");
    } finally {
      m.unmount();
    }
  });
});
