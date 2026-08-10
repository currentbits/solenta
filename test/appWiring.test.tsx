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
    // app scoped memory to a project that does not exist.
    assert.equal(
      arg?.project,
      "owner/repo",
      `memory.recent must be scoped to the selected project, got: ${JSON.stringify(arg)}`,
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
