/**
 * Round 44 pin + snooze sidebar UI + honest fakeCoder round-trips.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { dismissContextMenu } from "../src/contextMenuFallback";
import * as React from "react";
import { useState } from "react";
import { inAct, mount } from "./support/dom";
import { Sidebar } from "../src/components/Sidebar";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
} from "./support/fakeCoder";
import App from "../src/App";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../src/shared/ipc";

const FRESH = Date.now();
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

function th(
  over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">,
): ThreadInfo {
  return thread({
    projectId: "p1",
    title: over.id,
    ...over,
  });
}

function Host({
  initial,
  activeThreadId = "noise",
}: {
  initial: ThreadInfo[];
  activeThreadId?: string;
}) {
  const [threads, setThreads] = useState(initial);
  return (
    <Sidebar
      appName="Solenta"
      searchPlaceholder="Search"
      projectsHeader="All projects"
      projects={[p1, p2]}
      threads={threads}
      providers={providers}
      activeThreadId={activeThreadId}
      onSelectThread={() => {}}
      onCreateThread={() => {}}
      onAddProject={() => {}}
      onSetSettled={(id, override) => {
        setThreads((prev) =>
          prev.map((row) =>
            row.id !== id
              ? row
              : {
                  ...row,
                  settledOverride: override,
                  settledAt: override ? Date.now() : null,
                  pinnedAt: override === "settled" ? null : row.pinnedAt,
                  snoozedUntil: override === "settled" ? null : row.snoozedUntil,
                  snoozedAt: override === "settled" ? null : row.snoozedAt,
                },
          ),
        );
      }}
      onSetPinned={(id, pinned) => {
        const now = Date.now();
        setThreads((prev) =>
          prev.map((row) =>
            row.id !== id
              ? row
              : {
                  ...row,
                  pinnedAt: pinned ? now : null,
                  settledOverride:
                    pinned && row.settledOverride === "settled"
                      ? null
                      : row.settledOverride,
                  settledAt:
                    pinned && row.settledOverride === "settled"
                      ? null
                      : row.settledAt,
                },
          ),
        );
      }}
      onSetSnoozed={(id, until) => {
        const now = Date.now();
        setThreads((prev) =>
          prev.map((row) =>
            row.id !== id
              ? row
              : {
                  ...row,
                  snoozedUntil: until,
                  snoozedAt: until == null ? null : now,
                },
          ),
        );
      }}
      searchThreads={async () => threads}
    />
  );
}

async function boot(fake: ReturnType<typeof createFakeCoder>) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function snoozedToggle(m: { query(sel: string): Element | null }) {
  return m.query("[data-snoozed-shelf-toggle]");
}

function settledToggle(m: { query(sel: string): Element | null }) {
  return m.query("[data-settled-shelf-toggle]");
}

async function openSnoozedShelf(m: Awaited<ReturnType<typeof mount>>) {
  const btn = snoozedToggle(m);
  if (btn && btn.getAttribute("aria-expanded") !== "true") {
    await m.click(btn);
    await m.flush();
  }
}

async function openSettledShelf(m: Awaited<ReturnType<typeof mount>>) {
  const btn = settledToggle(m);
  if (btn && btn.getAttribute("aria-expanded") !== "true") {
    await m.click(btn);
    await m.flush();
  }
}

async function clickPinItem(
  m: Awaited<ReturnType<typeof mount>>,
  id: string,
) {
  const more = m.query(`[data-more-btn="${id}"]`);
  assert.ok(more, `data-more-btn=${id}`);
  await m.click(more);
  await m.flush();
  // #592: the actions menu portals onto document.body.
  const item = document.querySelector(`[data-pin-item="${id}"]`);
  assert.ok(item, `data-pin-item=${id} in overflow`);
  await m.click(item as HTMLElement);
  await m.flush();
}

describe("Sidebar pin + snooze shelves (round 44)", () => {
  // Fixture discipline: two projects; pin/snooze not index 0; selected = noise.
  const noise = th({
    id: "noise",
    projectId: "p1",
    title: "noise first",
    createdAt: FRESH + 100,
    updatedAt: FRESH + 100,
  });
  // Pinned AND merged: without the pin this thread would auto-settle into
  // Later (MERGED + settledAt). Pin beats settle → stays Active in its group.
  const pinnedMid = th({
    id: "pin-mid",
    projectId: "p2",
    title: "pinned mid",
    pinnedAt: FRESH - 5000,
    status: "done",
    prState: "MERGED",
    settledAt: FRESH - 100,
    updatedAt: FRESH + 50,
  });
  const settled = th({
    id: "settled-row",
    projectId: "p2",
    title: "settled row",
    status: "done",
    prState: "MERGED",
    settledAt: FRESH - 100,
    updatedAt: FRESH - 100,
  });

  it("pinned block sits at the top (oldest-pin-first), flagged, and beats settle", async () => {
    // Newer creation than pin-mid: static active order would put it first —
    // the pin block must still sit above the inbox.
    const p2Fresh = th({
      id: "p2-fresh",
      projectId: "p2",
      title: "p2 fresh",
      createdAt: FRESH + 200,
      updatedAt: FRESH + 200,
    });
    const m = await mount(
      <Host
        initial={[noise, pinnedMid, settled, p2Fresh]}
        activeThreadId="noise"
      />,
    );
    try {
      assert.equal(m.query("[data-pinned-section]"), null);
      assert.equal(m.query("[data-later-shelf]"), null);
      assert.equal(m.query("[data-pin-btn]"), null, "hover pin button retired");
      const card = m.query('[data-thread-card="pin-mid"][data-pinned="true"]');
      assert.ok(card, "pinned thread is a normal card with data-pinned");
      assert.ok(card!.querySelector("[data-pin-flag]"), "pin glyph on card");
      assert.ok(
        card!
          .querySelector("button[aria-label]")
          ?.getAttribute("aria-label")
          ?.includes(", pinned"),
        "select aria-label announces pinned",
      );
      assert.ok(m.query("[data-pinned-divider]"), "divider after the pin block");
      assert.equal(
        m.queryAll('[data-thread-card="pin-mid"]').length,
        1,
        "pinned thread renders exactly once",
      );
      const order = m
        .queryAll("[data-thread-card]")
        .map((el) => el.getAttribute("data-thread-card"));
      assert.ok(
        order.indexOf("pin-mid") < order.indexOf("p2-fresh"),
        `pinned block sits above active cards, got ${order.join(",")}`,
      );
      assert.equal(order[0], "pin-mid", "oldest pin is first in the pin block");
    } finally {
      m.unmount();
    }
  });

  it("Snoozed shelf: own toggle, default collapsed, collapse persists, carve-out", async () => {
    const soon = th({
      id: "snooze-soon",
      projectId: "p2",
      title: "snooze soon",
      snoozedUntil: FRESH + 10_000,
      snoozedAt: FRESH,
      updatedAt: FRESH - 100,
    });
    // Snoozed AND pinned: snooze wins — snoozed shelf row, not a pinned card.
    const late = th({
      id: "snooze-late",
      projectId: "p1",
      title: "snooze late",
      snoozedUntil: FRESH + 90_000,
      snoozedAt: FRESH,
      pinnedAt: FRESH - 1000,
      updatedAt: FRESH - 100,
    });
    const m = await mount(
      <Host initial={[noise, soon, late, settled]} activeThreadId="noise" />,
    );
    assert.equal(m.query("[data-later-shelf]"), null, "Later shelf is gone");
    const snoozed = snoozedToggle(m);
    assert.ok(snoozed, "Snoozed shelf toggle");
    assert.match(snoozed!.textContent || "", /Snoozed \(2\)/);
    assert.equal(
      snoozed!.getAttribute("aria-expanded"),
      "false",
      "snoozed defaults collapsed",
    );
    const settledH = settledToggle(m);
    assert.ok(settledH, "Settled is a separate shelf");
    assert.match(settledH!.textContent || "", /Settled \(1\)/);

    await openSnoozedShelf(m);
    const rows = m
      .queryAll('[data-snoozed="true"]')
      .map((el) => el.getAttribute("data-thread-card"));
    assert.deepEqual(rows, ["snooze-soon", "snooze-late"]);
    assert.equal(
      m.queryAll('[data-thread-card="snooze-late"]').length,
      1,
      "snoozed+pinned renders once, on the snoozed shelf",
    );
    assert.ok(
      m
        .query('[data-wake-label="snooze-soon"]')
        ?.textContent?.includes("until"),
    );
    await m.click(snoozedToggle(m)!);
    await m.flush();
    assert.equal(
      m.queryAll('[data-snoozed="true"]').length,
      0,
      "collapsed snoozed shelf hides rows",
    );
    m.unmount();

    const m2 = await mount(
      <Host initial={[noise, soon, late, settled]} activeThreadId="snooze-late" />,
    );
    try {
      assert.equal(
        snoozedToggle(m2)!.getAttribute("aria-expanded"),
        "false",
        "collapse persisted across mount",
      );
      assert.ok(
        m2.query(
          '[data-thread-card="snooze-late"][data-snoozed="true"][data-active="true"]',
        ),
        "selected snoozed carved out while shelf collapsed",
      );
      assert.equal(
        m2.queryAll('[data-snoozed="true"]').length,
        1,
        "only the carve-out row while collapsed",
      );
    } finally {
      m2.unmount();
    }
  });

  it("pin moves a card into the pin block; keep-active + pin pulls a settled row off Settled; unpin restores order", async () => {
    const settledOverride = th({
      id: "t-was-settled",
      projectId: "p2",
      title: "was settled",
      status: "done",
      settledOverride: "settled",
      settledAt: FRESH - 50,
      createdAt: FRESH - 50,
      updatedAt: FRESH - 50,
      prState: "MERGED",
    });
    const pinTarget = th({
      id: "t-pin-target",
      projectId: "p1",
      title: "pin target",
      createdAt: FRESH + 10,
      updatedAt: FRESH + 10,
    });
    const m = await mount(
      <Host
        initial={[noise, pinTarget, settledOverride]}
        activeThreadId="noise"
      />,
    );
    try {
      const header = settledToggle(m);
      assert.ok(header, "Settled shelf present before pin");
      assert.match(header!.textContent || "", /Settled \(1\)/);
      await openSettledShelf(m);
      assert.ok(
        m.query('[data-thread-card="t-was-settled"][data-settled="true"]'),
        "settled-override row on the expanded Settled shelf",
      );

      await clickPinItem(m, "t-pin-target");

      const pinnedCard = m.query(
        '[data-thread-card="t-pin-target"][data-pinned="true"]',
      );
      assert.ok(pinnedCard, "target card gains data-pinned");
      assert.ok(pinnedCard!.querySelector("[data-pin-flag]"), "pin glyph");
      assert.ok(m.query("[data-pinned-divider]"));
      const order = m
        .queryAll("[data-thread-card]")
        .map((el) => el.getAttribute("data-thread-card"));
      assert.ok(
        order.indexOf("t-pin-target") < order.indexOf("noise"),
        `pin block sits above the inbox, got ${order.join(",")}`,
      );

      const keep =
        m.query("[data-unsettle-btn]") ||
        m
          .queryAll("button")
          .find((b) => b.getAttribute("aria-label") === "Keep thread active");
      assert.ok(keep, "keep-active on settled row");
      await m.click(keep!);
      await m.flush();
      assert.equal(
        settledToggle(m),
        null,
        "empty Settled shelf unmounts after keep-active",
      );

      await clickPinItem(m, "t-was-settled");
      assert.ok(
        m.query('[data-thread-card="t-was-settled"][data-pinned="true"]'),
        "formerly settled thread lands in the pin block",
      );
      assert.equal(m.queryAll('[data-thread-card="t-was-settled"]').length, 1);

      await clickPinItem(m, "t-pin-target");
      assert.equal(
        m
          .query('[data-thread-card="t-pin-target"]')
          ?.getAttribute("data-pinned"),
        null,
        "unpinned card loses the flag",
      );
      const after = m
        .queryAll("[data-thread-card]")
        .map((el) => el.getAttribute("data-thread-card"));
      assert.ok(
        after.indexOf("noise") < after.indexOf("t-pin-target"),
        `unpin restores createdAt-desc among active cards, got ${after.join(",")}`,
      );
    } finally {
      m.unmount();
    }
  });
});

describe("fakeCoder setPinned/setSnoozed honesty (round 44)", () => {
  it("setPinned clears settled override; setSnoozed rejects non-future", async () => {
    const row = thread({
      id: "t1",
      settledOverride: "settled",
      settledAt: FRESH,
      status: "done",
    });
    const fake = createFakeCoder({ threads: [row] });
    const pinned = await fake.api.threads.setPinned({
      threadId: "t1",
      pinned: true,
    });
    assert.ok(pinned.pinnedAt != null);
    assert.equal(pinned.settledOverride, null);
    assert.equal(pinned.settledAt, null);

    await assert.rejects(
      () =>
        fake.api.threads.setSnoozed({
          threadId: "t1",
          until: Date.now() - 1000,
        }),
      /future/,
    );
    const snoozed = await fake.api.threads.setSnoozed({
      threadId: "t1",
      until: Date.now() + 60_000,
    });
    assert.ok(snoozed.snoozedUntil != null);
    assert.ok(snoozed.snoozedAt != null);
    // Pin preserved under snooze (suspends, never clears).
    assert.ok(snoozed.pinnedAt != null);
  });

  it("App pin round-trip through fakeCoder", async () => {
    // Explicit createdAt: static group order is creation-desc, so t-open sits
    // first until the pin reorders t-mid above it.
    const tOpen = thread({
      id: "t-open",
      projectId: "p1",
      title: "already open",
      createdAt: FRESH + 200,
      updatedAt: FRESH + 200,
    });
    const tMid = thread({
      id: "t-mid",
      projectId: "p1",
      title: "mid pin me",
      createdAt: FRESH + 50,
      updatedAt: FRESH + 50,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tOpen, tMid],
      details: {
        "t-open": detail({ thread: tOpen }),
        "t-mid": detail({ thread: tMid }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();
      await clickPinItem(m, "t-mid");
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      assert.equal(m.query("[data-pinned-section]"), null);
      assert.equal(m.query("[data-pin-btn]"), null);
      const pinnedCard = m.query(
        '[data-thread-card="t-mid"][data-pinned="true"]',
      );
      assert.ok(pinnedCard, "card gains data-pinned after pin");
      assert.ok(pinnedCard!.querySelector("[data-pin-flag]"), "pin glyph");
      assert.ok(m.query("[data-pinned-divider]"));
      const order = m
        .queryAll("[data-thread-card]")
        .map((el) => el.getAttribute("data-thread-card"));
      assert.ok(
        order.indexOf("t-mid") < order.indexOf("t-open"),
        `pinned block sits above the inbox, got ${order.join(",")}`,
      );
      assert.ok(
        fake.of("threads.setPinned").some((c) => {
          const a = c.args[0] as { threadId: string; pinned: boolean };
          return a.threadId === "t-mid" && a.pinned === true;
        }),
      );

      await clickPinItem(m, "t-mid");
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      assert.ok(
        fake.of("threads.setPinned").some((c) => {
          const a = c.args[0] as { threadId: string; pinned: boolean };
          return a.threadId === "t-mid" && a.pinned === false;
        }),
        "unpin round-trips pinned: false",
      );
      assert.equal(
        m.query('[data-thread-card="t-mid"]')?.getAttribute("data-pinned"),
        null,
        "flag gone after unpin",
      );
      const after = m
        .queryAll("[data-thread-card]")
        .map((el) => el.getAttribute("data-thread-card"));
      assert.ok(
        after.indexOf("t-open") < after.indexOf("t-mid"),
        `static order restored after unpin, got ${after.join(",")}`,
      );
    } finally {
      m.unmount();
    }
  });

  /**
   * B1: menu → preset → onSetSnoozed must hit useCoder + fakeCoder with THAT
   * preset's until. Host-injected callbacks cannot mask a rewired pipeline.
   */
  it("App snooze menu preset + clear round-trip through fakeCoder", async () => {
    // Freeze Date.now so Sidebar's `now` tick and expected until share a clock.
    // Hard-coded target: a mutant that rewires every preset to in-3-days must
    // fail lastSet.until === expectedUntil (not a helper self-match).
    const frozen = new Date(2024, 5, 15, 14, 0, 0, 0).getTime();
    const expectedUntil = new Date(2024, 5, 15, 18, 0, 0, 0).getTime();
    const realNow = Date.now;
    Date.now = () => frozen;
    try {

      const tOpen = thread({
        id: "t-open",
        projectId: "p1",
        title: "already open",
        updatedAt: frozen + 200,
      });
      // Mid-list, not selected (fixture discipline).
      const tMid = thread({
        id: "t-snooze-mid",
        projectId: "p1",
        title: "snooze mid me",
        updatedAt: frozen + 50,
      });
      const fake = createFakeCoder({
        projects: [project({ id: "p1" })],
        threads: [tOpen, tMid],
        details: {
          "t-open": detail({ thread: tOpen }),
          "t-snooze-mid": detail({ thread: tMid }),
        },
      });
      const m = await boot(fake);
      try {
        await m.flush();

        const snoozeBtn = m.query('[data-snooze-btn="t-snooze-mid"]');
        assert.ok(snoozeBtn, "data-snooze-btn opens the existing presets");
        await m.click(snoozeBtn!);
        await m.flush();
        assert.ok(
          document.querySelector("[data-context-menu]"),
          "snooze menu opens",
        );

        const preset = document.querySelector('[data-snooze-preset="evening"]');
        assert.ok(preset, "data-snooze-preset=evening must open in menu");
        await m.click(preset as HTMLElement);
        await m.flush();
        await inAct(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        await m.flush();

        const setCalls = fake.of("threads.setSnoozed");
        assert.ok(setCalls.length >= 1, "setSnoozed must fire");
        const lastSet = setCalls[setCalls.length - 1]!.args[0] as {
          threadId: string;
          until: number | null;
        };
        assert.equal(lastSet.threadId, "t-snooze-mid");
        assert.equal(
          lastSet.until,
          expectedUntil,
          "must record THIS preset's until, not a rewired constant",
        );

        const header = snoozedToggle(m);
        assert.ok(header, "thread lands on the Snoozed shelf");
        assert.match(header!.textContent || "", /Snoozed \(1\)/);
        await openSnoozedShelf(m);
        assert.ok(
          m.query('[data-thread-card="t-snooze-mid"][data-snoozed="true"]'),
          "snoozed row on the Snoozed shelf",
        );
        const wake =
          m.query('[data-wake-btn="t-snooze-mid"]') ||
          m.query("[data-snooze-clear]");
        assert.ok(wake, "slim snoozed row wakes via data-wake-btn");
        await m.click(wake!);
        await m.flush();
        await inAct(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        await m.flush();

        const clearCalls = fake.of("threads.setSnoozed");
        const lastClear = clearCalls[clearCalls.length - 1]!.args[0] as {
          threadId: string;
          until: number | null;
        };
        assert.equal(lastClear.threadId, "t-snooze-mid");
        assert.equal(lastClear.until, null, "clear must record until: null");

        const listed = await fake.api.threads.list();
        const mid = listed.find((x) => x.id === "t-snooze-mid");
        assert.equal(mid?.snoozedUntil ?? null, null);
        assert.equal(mid?.snoozedAt ?? null, null);

        assert.equal(
          snoozedToggle(m),
          null,
          "empty Snoozed shelf unmounts after wake",
        );
        assert.ok(
          m.query('[data-thread-card="t-snooze-mid"]'),
          "woken thread back in the active list",
        );
      } finally {
        m.unmount();
      }
    } finally {
      Date.now = realNow;
    }
  });

  it("Woke pill shows after a timer wake until the thread is selected", async () => {
    const now = Date.now();
    const selected = th({
      id: "noise",
      projectId: "p1",
      title: "noise first",
      updatedAt: now + 100,
    });
    const woke = th({
      id: "woke-mid",
      projectId: "p2",
      title: "just woke",
      snoozedUntil: now - 1000,
      snoozedAt: now - 60_000,
      lastVisitedAt: now - 120_000,
      updatedAt: now - 60_000,
    });
    const m = await mount(
      <Host
        initial={[selected, woke]}
        activeThreadId="noise"
      />,
    );
    try {
      const pill =
        m.query("[data-woke]") ||
        m.query('[data-thread-card="woke-mid"] [data-status-label]');
      assert.ok(pill, "Woke status must render on a timer-woken unread row");
      assert.equal(pill!.getAttribute("title"), "Woke from snooze");
      assert.equal(m.query("[data-status-dot]"), null);
    } finally {
      m.unmount();
    }
  });

  it("Wake on a snoozed shelf row unsnoozes the thread back to active", async () => {
    const frozen = Date.now();
    const tOpen = thread({
      id: "t-open",
      projectId: "p1",
      title: "already open",
      updatedAt: frozen + 200,
    });
    const tMid = thread({
      id: "t-settle-snooze",
      projectId: "p1",
      title: "snoozed then settle",
      snoozedUntil: frozen + 86_400_000,
      snoozedAt: frozen - 1000,
      lastVisitedAt: frozen - 2000,
      updatedAt: frozen - 2000,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tOpen, tMid],
      details: {
        "t-open": detail({ thread: tOpen }),
        "t-settle-snooze": detail({ thread: tMid }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();
      assert.ok(snoozedToggle(m), "Snoozed shelf present");
      await openSnoozedShelf(m);
      const wake = m.query('[data-wake-btn="t-settle-snooze"]');
      assert.ok(wake, "snoozed slim row offers wake");
      await m.click(wake!);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      const listed = await fake.api.threads.list();
      const mid = listed.find((x) => x.id === "t-settle-snooze");
      assert.equal(mid?.snoozedUntil ?? null, null);
      assert.equal(mid?.snoozedAt ?? null, null);
      assert.equal(m.queryAll('[data-snoozed="true"]').length, 0);
      assert.ok(
        m.query('[data-thread-card="t-settle-snooze"]'),
        "woken thread is back in the active list",
      );
      assert.equal(
        m.query('[data-thread-card="t-settle-snooze"]')?.getAttribute("data-settled"),
        null,
      );
    } finally {
      m.unmount();
    }
  });

  /**
   * Issue #87: the mute item lives in the same menu. Round-trip through
   * useCoder + fakeCoder, and the label must follow the thread's own flag
   * (a hardcoded "Mute" would pass a click test but strand a muted thread).
   */
  it("App mute menu item round-trips through fakeCoder and flips its label", async () => {
    const tOpen = thread({ id: "t-open", projectId: "p1", title: "open" });
    const tMid = thread({
      id: "t-mute-mid",
      projectId: "p1",
      title: "noisy worker",
      updatedAt: FRESH - 50,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tOpen, tMid],
      details: {
        "t-open": detail({ thread: tOpen }),
        "t-mute-mid": detail({ thread: tMid }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();

      await m.click(m.query('[data-more-btn="t-mute-mid"]'));
      await m.flush();
      const item = document.querySelector('[data-mute-toggle="t-mute-mid"]');
      assert.ok(item, "mute item must be in the card menu");
      assert.equal(item!.textContent, "Mute notifications");

      await m.click(item!);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      const calls = fake.of("threads.setMuted");
      assert.equal(calls.length, 1, "setMuted must fire once");
      assert.deepEqual(calls[0]!.args[0], {
        threadId: "t-mute-mid",
        muted: true,
      });
      assert.equal(
        (await fake.api.threads.list()).find((x) => x.id === "t-mute-mid")
          ?.muted,
        true,
      );

      // Reopen: the item now offers the way back out.
      await m.click(m.query('[data-more-btn="t-mute-mid"]'));
      await m.flush();
      assert.equal(
        document.querySelector('[data-mute-toggle="t-mute-mid"]')?.textContent,
        "Unmute notifications",
      );
    } finally {
      m.unmount();
    }
  });
});

afterEach(() => {
  dismissContextMenu();
});
