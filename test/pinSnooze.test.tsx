/**
 * Round 44 pin + snooze sidebar UI + honest fakeCoder round-trips.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

/** The single Later-shelf header button ("Later · N[ · M unread]"). */
function laterHeader(m: { queryAll(sel: string): Element[] }) {
  return m
    .queryAll("button")
    .find((b) => (b.textContent || "").includes("Later ·"));
}

describe("Sidebar pin + snooze shelves (round 44)", () => {
  // Fixture discipline: two projects; pin/snooze not index 0; selected = noise.
  const noise = th({
    id: "noise",
    projectId: "p1",
    title: "noise first",
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

  it("#567: no Pinned shelf; pinned renders first in its group, flagged, and beats settle", async () => {
    // Newer creation than pin-mid: static order would put it first — the pin
    // must override.
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
      assert.equal(
        m.query("[data-pinned-section]"),
        null,
        "the Pinned shelf is gone (#567)",
      );
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
      assert.ok(
        card!.querySelector('[data-pin-btn="pin-mid"]'),
        "hover unpin control keeps its id",
      );
      assert.equal(
        m.queryAll('[data-thread-card="pin-mid"]').length,
        1,
        "pinned thread renders exactly once",
      );
      assert.equal(
        m.query('[data-later-shelf] [data-thread-card="pin-mid"]'),
        null,
        "pin beats settle: MERGED+pinned never lands on Later",
      );
      // Sorted FIRST in its project group despite newer siblings.
      const order = m
        .queryAll("[data-thread-card]")
        .map((el) => el.getAttribute("data-thread-card"));
      assert.ok(
        order.indexOf("pin-mid") < order.indexOf("p2-fresh"),
        `pinned sorts before newer group siblings, got ${order.join(",")}`,
      );
    } finally {
      m.unmount();
    }
  });

  it("Later shelf: snoozed rows on top, expanded by default, collapse persists, carve-out", async () => {
    const soon = th({
      id: "snooze-soon",
      projectId: "p2",
      title: "snooze soon",
      snoozedUntil: FRESH + 10_000,
      snoozedAt: FRESH,
      updatedAt: FRESH - 100,
    });
    // Snoozed AND pinned: snooze wins — Later shelf row, not an Active card.
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
    assert.equal(m.query("[data-snoozed-shelf]"), null, "no Snoozed shelf");
    assert.equal(m.query("[data-snoozed-header]"), null, "no Snoozed header");
    assert.ok(m.query("[data-later-shelf]"), "single Later shelf");
    const header = laterHeader(m);
    assert.ok(header, "Later header button");
    assert.ok(
      (header!.textContent || "").includes("Later · 3"),
      `header counts snoozed + settled, got: ${header!.textContent}`,
    );
    assert.ok(
      !(header!.textContent || "").includes("unread"),
      "no unread suffix when every later row is read",
    );
    assert.equal(header!.getAttribute("aria-expanded"), "true", "default expanded");
    // Snoozed first (wake-soonest), then settled — no click needed.
    const rows = m
      .queryAll("[data-later-shelf] [data-thread-card]")
      .map((el) => el.getAttribute("data-thread-card"));
    assert.deepEqual(
      rows,
      ["snooze-soon", "snooze-late", "settled-row"],
      "snoozed (wake-soonest) above settled",
    );
    assert.equal(
      m.queryAll('[data-snoozed="true"]').length,
      2,
      "both snoozed rows render as SnoozedRows",
    );
    assert.equal(
      m.queryAll('[data-thread-card="snooze-late"]').length,
      1,
      "snoozed+pinned renders once, on the shelf (snooze beats pin)",
    );
    assert.ok(
      m
        .query('[data-wake-label="snooze-soon"]')
        ?.textContent?.includes("until"),
    );
    // Collapse persists across mounts.
    await m.click(header!);
    await m.flush();
    assert.equal(
      m.queryAll("[data-later-shelf] [data-thread-card]").length,
      0,
      "collapsed shelf hides rows",
    );
    m.unmount();

    const m2 = await mount(
      <Host initial={[noise, soon, late, settled]} activeThreadId="snooze-late" />,
    );
    try {
      assert.equal(
        laterHeader(m2)!.getAttribute("aria-expanded"),
        "false",
        "collapse persisted across mount",
      );
      // Carve-out: selected later thread renders above the bar as active.
      assert.ok(
        m2.query(
          '[data-later-shelf] [data-thread-card="snooze-late"][data-snoozed="true"][data-active="true"]',
        ),
        "selected snoozed carved out while shelf collapsed",
      );
      assert.equal(
        m2.queryAll("[data-later-shelf] [data-thread-card]").length,
        1,
        "only the carve-out row while collapsed",
      );
    } finally {
      // Restore the persisted default for the rest of the file.
      await m2.click(laterHeader(m2)!);
      await m2.flush();
      m2.unmount();
    }
  });

  it("pin keeps a card Active in-group; keep-active + pin pulls a settled row off Later; unpin restores order", async () => {
    const settledOverride = th({
      id: "t-was-settled",
      projectId: "p2",
      title: "was settled",
      status: "done",
      settledOverride: "settled",
      settledAt: FRESH - 50,
      updatedAt: FRESH - 50,
      prState: "MERGED",
    });
    // Attention card we can pin; mid-list, not selected.
    const pinTarget = th({
      id: "t-pin-target",
      projectId: "p1",
      title: "pin target",
      updatedAt: FRESH + 10,
    });
    const m = await mount(
      <Host
        initial={[noise, pinTarget, settledOverride]}
        activeThreadId="noise"
      />,
    );
    try {
      // Later shelf defaults to expanded; click only if a stored collapse holds.
      assert.ok(
        m.query("[data-later-shelf]"),
        "Later shelf present before pin",
      );
      const header = laterHeader(m);
      assert.ok(header, "Later shelf header");
      assert.ok(
        (header!.textContent || "").includes("Later · 1"),
        `settled-override counts into Later, got: ${header!.textContent}`,
      );
      if (header!.getAttribute("aria-expanded") === "false") {
        await m.click(header!);
        await m.flush();
      }
      assert.ok(
        m.query(
          '[data-later-shelf] [data-thread-card="t-was-settled"][data-settled="true"]',
        ),
        "settled-override row on the expanded Later shelf",
      );

      // Pin the attention target: it stays a card in its group, sorted first.
      const pinBtn = m.query('[data-pin-btn="t-pin-target"]');
      assert.ok(pinBtn, "pin control on attention card");
      await m.click(pinBtn!);
      await m.flush();

      assert.equal(
        m.query("[data-pinned-section]"),
        null,
        "no Pinned shelf after pin (#567)",
      );
      const pinnedCard = m.query(
        '[data-thread-card="t-pin-target"][data-pinned="true"]',
      );
      assert.ok(pinnedCard, "target card gains data-pinned in place");
      assert.ok(pinnedCard!.querySelector("[data-pin-flag]"), "pin glyph");
      assert.equal(
        m.query('[data-later-shelf] [data-thread-card="t-pin-target"]'),
        null,
        "pinned card is not a Later row",
      );
      const order = m
        .queryAll("[data-thread-card]")
        .map((el) => el.getAttribute("data-thread-card"));
      assert.ok(
        order.indexOf("t-pin-target") < order.indexOf("noise"),
        `pin reorders it first in the group, got ${order.join(",")}`,
      );

      // Keep-active the settled row, then pin: leaves Later for its group.
      const keep = m
        .queryAll("button")
        .find((b) => b.getAttribute("aria-label") === "Keep thread active");
      assert.ok(keep, "keep-active on settled row");
      await m.click(keep!);
      await m.flush();
      assert.equal(
        m.query("[data-later-shelf]"),
        null,
        "empty Later shelf unmounts after keep-active",
      );

      const pinSettled = m.query('[data-pin-btn="t-was-settled"]');
      assert.ok(pinSettled, "pin on formerly settled thread");
      await m.click(pinSettled!);
      await m.flush();

      assert.ok(
        m.query('[data-thread-card="t-was-settled"][data-pinned="true"]'),
        "formerly settled thread pinned in its group",
      );
      assert.equal(
        m.queryAll('[data-thread-card="t-was-settled"]').length,
        1,
        "renders once, in the group",
      );

      // Unpin pin-target via the same hover control → back to normal order.
      const unpin = m.query('[data-pin-btn="t-pin-target"]');
      assert.equal(unpin?.getAttribute("aria-label"), "Unpin thread");
      await m.click(unpin!);
      await m.flush();
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
        `unpin restores static order, got ${after.join(",")}`,
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
      const pinBtn = m.query('[data-pin-btn="t-mid"]');
      assert.ok(pinBtn, "pin button on mid thread");
      await m.click(pinBtn!);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      assert.equal(
        m.query("[data-pinned-section]"),
        null,
        "no Pinned shelf ever (#567)",
      );
      const pinnedCard = m.query(
        '[data-thread-card="t-mid"][data-pinned="true"]',
      );
      assert.ok(pinnedCard, "card gains data-pinned in its group after pin");
      assert.ok(pinnedCard!.querySelector("[data-pin-flag]"), "pin glyph");
      const order = m
        .queryAll("[data-thread-card]")
        .map((el) => el.getAttribute("data-thread-card"));
      assert.ok(
        order.indexOf("t-mid") < order.indexOf("t-open"),
        `pinned sorts first in group, got ${order.join(",")}`,
      );
      assert.ok(
        fake.of("threads.setPinned").some((c) => {
          const a = c.args[0] as { threadId: string; pinned: boolean };
          return a.threadId === "t-mid" && a.pinned === true;
        }),
      );

      // Unpin via the same hover control (id unchanged).
      const unpin = m.query('[data-pin-btn="t-mid"]');
      assert.equal(unpin?.getAttribute("aria-label"), "Unpin thread");
      await m.click(unpin!);
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

        // #566: snooze presets live in the single "…" menu now.
        const moreBtn = m.query('[data-more-btn="t-snooze-mid"]');
        assert.ok(moreBtn, "data-more-btn must be present");
        await m.click(moreBtn!);
        await m.flush();
        assert.ok(
          m.query('[data-snooze-menu="t-snooze-mid"]'),
          "card menu opens",
        );

        const snoozeItem = m.query("[data-snooze-item]");
        assert.ok(snoozeItem, "Snooze is one first-level item (#583)");
        await m.click(snoozeItem);
        await m.flush();
        const preset = m.query('[data-snooze-preset="evening"]');
        assert.ok(preset, "data-snooze-preset=evening must open in nested panel");
        await m.click(preset!);
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

        assert.ok(
          m.query("[data-later-shelf]"),
          "thread lands on the Later shelf",
        );
        const header = laterHeader(m);
        assert.ok(header, "Later header");
        assert.ok(
          (header!.textContent || "").includes("Later · 1"),
          `snoozed counts into Later, got: ${header!.textContent}`,
        );
        // Default expanded; click only if a stored collapse is in effect.
        if (header!.getAttribute("aria-expanded") === "false") {
          await m.click(header!);
          await m.flush();
        }
        assert.ok(
          m.query(
            '[data-later-shelf] [data-thread-card="t-snooze-mid"][data-snoozed="true"]',
          ),
          "snoozed row at the top of the Later shelf",
        );
        const clearBtn = m.query(
          '[data-snooze-clear][data-snooze-clear-btn="t-snooze-mid"], [data-snooze-clear-btn="t-snooze-mid"]',
        ) ?? m.query("[data-snooze-clear]");
        assert.ok(clearBtn, "data-snooze-clear must be present on shelf row");
        await m.click(clearBtn!);
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
          m.query("[data-later-shelf]") != null,
          false,
          "empty Later shelf unmounts after clear",
        );
        assert.ok(
          m.query('[data-thread-card="t-snooze-mid"]'),
          "woken thread back in its project group",
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
      // #566: the pill is now a status dot; the wording lives in its title.
      const pill = m.query("[data-woke]");
      assert.ok(pill, "Woke dot must render on a timer-woken unread row");
      assert.equal(pill!.getAttribute("data-status-dot"), "attention");
      assert.equal(pill!.getAttribute("title"), "Woke from snooze");
    } finally {
      m.unmount();
    }
  });

  it("Settle on a snoozed shelf row unsnoozes and folds the thread", async () => {
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
      assert.ok(m.query("[data-later-shelf]"), "Later shelf present");
      const header = laterHeader(m);
      assert.ok(header, "Later header");
      // Default expanded; click only if a stored collapse is in effect.
      if (header!.getAttribute("aria-expanded") === "false") {
        await m.click(header!);
        await m.flush();
      }
      const settleBtn = m.query('[data-snooze-settle-btn="t-settle-snooze"]');
      assert.ok(settleBtn, "snoozed row offers Settle");
      await m.click(settleBtn!);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      const listed = await fake.api.threads.list();
      const mid = listed.find((x) => x.id === "t-settle-snooze");
      assert.equal(mid?.settledOverride, "settled");
      assert.equal(mid?.snoozedUntil ?? null, null);
      assert.equal(mid?.snoozedAt ?? null, null);
      // Same shelf, different row kind: snoozed row becomes a settled row.
      assert.equal(m.queryAll('[data-snoozed="true"]').length, 0);
      assert.ok(
        m.query(
          '[data-later-shelf] [data-thread-card="t-settle-snooze"][data-settled="true"]',
        ),
        "thread stays on the Later shelf as a settled row",
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
      const item = m.query('[data-mute-toggle="t-mute-mid"]');
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
        m.query('[data-mute-toggle="t-mute-mid"]')?.textContent,
        "Unmute notifications",
      );
    } finally {
      m.unmount();
    }
  });
});
