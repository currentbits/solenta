/**
 * Round 49: fork / hand-off UI wiring through real App + useCoder.forkThread.
 *
 * Mounts the real App (not a Host injecting onFork). Fixture discipline:
 * source thread not index 0, two projects present, hand-off target provider
 * is not the source's current harness.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { dismissContextMenu } from "../src/contextMenuFallback";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { ProviderInfo, ThreadInfo } from "../src/shared/ipc";

const NOW = Date.now();

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
  {
    id: "grok",
    name: "Grok",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
  {
    id: "kimi",
    name: "Kimi",
    available: false,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function decoy(): ThreadInfo {
  return thread({
    id: "t-decoy",
    projectId: "p1",
    title: "decoy first thread",
    provider: "claude",
    updatedAt: NOW + 5000,
  });
}

function source(): ThreadInfo {
  return thread({
    id: "t-source-fork",
    projectId: "p1",
    title: "source handoff thread",
    provider: "claude",
    model: "claude-opus",
    sessionId: "sess-keep",
    updatedAt: NOW + 1000,
  });
}

function otherProjectThread(): ThreadInfo {
  return thread({
    id: "t-p2",
    projectId: "p2",
    title: "other project row",
    provider: "claude",
    updatedAt: NOW + 2000,
  });
}

async function selectThread(
  m: Awaited<ReturnType<typeof mount>>,
  title: string,
) {
  // aria-label may carry ", unread" / ", working" suffixes (#566).
  const card = m.query(`button[aria-label^="Select thread: ${title}"]`);
  assert.ok(card, `thread card for "${title}" must exist`);
  await m.click(card as HTMLElement);
  await m.flush();
}

/** #566: card actions (Fork / Hand off) live in the single "…" menu now. */
async function openCardMenu(
  m: Awaited<ReturnType<typeof mount>>,
  threadId: string,
) {
  const more = m.query(`[data-more-btn="${threadId}"]`);
  assert.ok(more, `"…" menu button must exist on ${threadId}`);
  await m.click(more as HTMLElement);
  await m.flush();
  // #592: the menu is a native/portal context menu on document.body,
  // outside the mounted tree — m.query cannot see it.
  const menu = document.querySelector("[data-context-menu]");
  assert.ok(menu, "card menu must be open");
  return menu as HTMLElement;
}

describe("App fork / hand-off wiring (round 49)", () => {
  it("card Fork records threads.fork with id only and selects the new thread", async () => {
    const d = decoy();
    const s = source();
    const o = otherProjectThread();
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      providers,
      // Source not index 0.
      threads: [d, s, o],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-source-fork": detail({ thread: s }),
        "t-p2": detail({ thread: o }),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "source handoff thread");

    await openCardMenu(m, "t-source-fork");
    const forkBtn = document.querySelector('[data-fork-btn="t-source-fork"]');
    assert.ok(forkBtn, "card Fork menu item must exist on the source");
    await m.click(forkBtn as HTMLElement);
    await m.flush();

    const forks = fake.of("threads.fork");
    assert.equal(forks.length, 1, "exactly one threads.fork");
    const arg = forks[0]!.args[0] as {
      threadId: string;
      provider?: string;
      model?: string | null;
    };
    assert.equal(arg.threadId, "t-source-fork");
    assert.equal(
      Object.prototype.hasOwnProperty.call(arg, "provider"),
      false,
      "plain Fork must not pass a provider override",
    );

    // Selection moves to the new thread (createThread-style).
    assert.ok(
      m.text().includes("Fork: source handoff thread"),
      "new forked title must be selected/visible",
    );
    // Active card is the fork, not the source.
    const active = m.query('[data-active="true"]');
    assert.ok(active, "some card is active after fork");
    assert.notEqual(
      active!.getAttribute("data-thread-card"),
      "t-source-fork",
      "selection must leave the source",
    );
    m.unmount();
  });

  it("Hand off to a specific available provider records the override", async () => {
    const d = decoy();
    const s = source();
    const o = otherProjectThread();
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      providers,
      threads: [d, s, o],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-source-fork": detail({ thread: s }),
        "t-p2": detail({ thread: o }),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "source handoff thread");

    // B1: current provider must be ABSENT from the card menu's hand-off items.
    // Mutant that drops `p.id !== thread.provider` re-lists claude here.
    const cardMenu = await openCardMenu(m, "t-source-fork");
    const cardEntries = Array.from(
      cardMenu.querySelectorAll("[data-handoff-provider]"),
    ).map((el) => el.getAttribute("data-handoff-provider"));
    assert.ok(
      !cardEntries.includes("claude"),
      `current provider must not appear in card Hand off menu, got: ${cardEntries.join(",")}`,
    );
    assert.ok(
      cardEntries.includes("grok") && cardEntries.includes("kimi"),
      "other providers must still be listed (positive control)",
    );

    const grok = document.querySelector('[data-handoff-provider="grok"]');
    assert.ok(grok, "Grok (not current provider) must be listed");
    assert.equal(
      (grok as HTMLButtonElement).disabled,
      false,
      "available provider must be enabled",
    );
    await m.click(grok as HTMLElement);
    await m.flush();

    const forks = fake.of("threads.fork");
    assert.equal(forks.length, 1);
    const arg = forks[0]!.args[0] as { threadId: string; provider?: string };
    assert.equal(arg.threadId, "t-source-fork");
    assert.equal(arg.provider, "grok", "hand-off must record provider override");
    m.unmount();
  });

  it("Environment Hand off submenu excludes current provider (and lists others)", async () => {
    const d = decoy();
    const s = source();
    const o = otherProjectThread();
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      providers,
      threads: [d, s, o],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-source-fork": detail({ thread: s }),
        "t-p2": detail({ thread: o }),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "source handoff thread");

    const envHandoff = m.query("[data-thread-handoff]");
    assert.ok(envHandoff, "Environment Hand off to… must render");
    assert.ok(
      envHandoff!.closest("[data-thread-fork-card]"),
      "Hand off lives on the Environment Fork card",
    );
    await m.click(envHandoff as HTMLElement);
    await m.flush();

    assert.ok(m.query("[data-thread-handoff-menu]"), "Environment hand-off menu open");
    const envMenu = m.query("[data-thread-handoff-menu]")!;
    const envEntries = Array.from(
      envMenu.querySelectorAll("[data-handoff-provider]"),
    ).map((el) => el.getAttribute("data-handoff-provider"));
    assert.ok(
      !envEntries.includes("claude"),
      `current provider must not appear in Environment Hand off menu, got: ${envEntries.join(",")}`,
    );
    assert.ok(
      envEntries.includes("grok") && envEntries.includes("kimi"),
      "other providers must still be listed in Environment menu (positive control)",
    );
    m.unmount();
  });

  it("unavailable provider entry is disabled and click-dead (positive control in suite)", async () => {
    const d = decoy();
    const s = source();
    const o = otherProjectThread();
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      providers,
      threads: [d, s, o],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-source-fork": detail({ thread: s }),
        "t-p2": detail({ thread: o }),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "source handoff thread");

    await openCardMenu(m, "t-source-fork");

    const kimi = document.querySelector('[data-handoff-provider="kimi"]');
    assert.ok(kimi, "unavailable Kimi must still be listed");
    assert.equal(
      (kimi as HTMLButtonElement).disabled,
      true,
      "unavailable provider must be disabled",
    );
    await m.click(kimi as HTMLElement);
    await m.flush();
    assert.equal(
      fake.of("threads.fork").length,
      0,
      "disabled hand-off entry must not call threads.fork",
    );

    // Positive control: available Grok still works in the same suite/menu.
    const grok = document.querySelector('[data-handoff-provider="grok"]');
    assert.ok(grok);
    await m.click(grok as HTMLElement);
    await m.flush();
    assert.equal(fake.of("threads.fork").length, 1);
    assert.equal(
      (fake.of("threads.fork")[0]!.args[0] as { provider: string }).provider,
      "grok",
    );
    m.unmount();
  });

  it("provenance chip shows source title, click selects source; deleted source unlinked", async () => {
    const d = decoy();
    const s = source();
    const forked = thread({
      id: "t-forked",
      projectId: "p1",
      title: "Fork: source handoff thread",
      handoffFrom: "t-source-fork",
      provider: "grok",
      updatedAt: NOW + 8000,
    });
    const orphan = thread({
      id: "t-orphan-fork",
      projectId: "p1",
      title: "Fork: gone source",
      handoffFrom: "t-deleted-never-existed",
      provider: "claude",
      updatedAt: NOW + 7000,
    });
    const o = otherProjectThread();
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      providers,
      // Decoy first; forked not index 0.
      threads: [d, forked, orphan, s, o],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-forked": detail({ thread: forked }),
        "t-orphan-fork": detail({ thread: orphan }),
        "t-source-fork": detail({ thread: s }),
        "t-p2": detail({ thread: o }),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "Fork: source handoff thread");

    const banner = m.query("[data-handoff-banner]");
    assert.ok(banner, "provenance banner must render when handoffFrom set");
    assert.ok(
      (banner!.textContent || "").includes("Forked from"),
      "banner labels provenance",
    );
    const link = m.query('[data-handoff-source="t-source-fork"]');
    assert.ok(link, "source title must be a link");
    assert.equal((link!.textContent || "").trim(), "source handoff thread");
    await m.click(link as HTMLElement);
    await m.flush();

    const gets = fake.of("threads.get");
    assert.ok(gets.length > 0);
    assert.equal(
      gets[gets.length - 1]!.args[0],
      "t-source-fork",
      "clicking provenance must select the source thread",
    );

    // Deleted source: unlinked text, no button.
    await selectThread(m, "Fork: gone source");
    const missing = m.query("[data-handoff-missing]");
    assert.ok(missing, "deleted source must render unlinked copy");
    assert.ok(
      (missing!.textContent || "").includes("Forked from a deleted thread"),
    );
    assert.equal(
      m.queryAll("[data-handoff-source]").length,
      0,
      "deleted source must not offer a link",
    );
    m.unmount();
  });

  it("fork failure surfaces error without crashing; selection stays", async () => {
    const d = decoy();
    const s = source();
    const o = otherProjectThread();
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      providers,
      threads: [d, s, o],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-source-fork": detail({ thread: s }),
        "t-p2": detail({ thread: o }),
      },
      fail: {
        "threads.fork": new Error("Unknown thread: t-source-fork"),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "source handoff thread");

    await openCardMenu(m, "t-source-fork");
    await m.click(document.querySelector('[data-fork-btn="t-source-fork"]') as HTMLElement);
    await m.flush();

    assert.equal(fake.of("threads.fork").length, 1);
    assert.ok(
      m.text().includes("Unknown thread: t-source-fork"),
      `error must surface in the UI, got: ${m.text().slice(0, 200)}`,
    );
    // Still on source (active card).
    const active = m.query('[data-thread-card="t-source-fork"][data-active="true"]');
    assert.ok(active, "selection must stay on the source after fork failure");
    m.unmount();
  });

  it("Environment Fork also hits threads.fork without provider", async () => {
    const d = decoy();
    const s = source();
    const o = otherProjectThread();
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      providers,
      threads: [d, s, o],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-source-fork": detail({ thread: s }),
        "t-p2": detail({ thread: o }),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "source handoff thread");

    const envFork = m.query("[data-thread-fork]");
    assert.ok(envFork, "Environment Fork must render");
    assert.ok(
      envFork!.closest("[data-thread-fork-card]"),
      "Fork lives on the Environment card",
    );
    await m.click(envFork as HTMLElement);
    await m.flush();

    const forks = fake.of("threads.fork");
    assert.equal(forks.length, 1);
    const arg = forks[0]!.args[0] as { threadId: string; provider?: string };
    assert.equal(arg.threadId, "t-source-fork");
    assert.equal(
      Object.prototype.hasOwnProperty.call(arg, "provider"),
      false,
    );
    m.unmount();
  });
});

afterEach(() => {
  dismissContextMenu();
});
