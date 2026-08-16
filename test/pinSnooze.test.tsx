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

describe("Sidebar pin + snooze shelves (round 44)", () => {
  // Fixture discipline: two projects; pin/snooze not index 0; selected = noise.
  const noise = th({
    id: "noise",
    projectId: "p1",
    title: "noise first",
    updatedAt: FRESH + 100,
  });
  const pinnedMid = th({
    id: "pin-mid",
    projectId: "p2",
    title: "pinned mid",
    pinnedAt: FRESH - 5000,
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

  it("renders PINNED section; pinned not duplicated in project groups", async () => {
    const m = await mount(
      <Host initial={[noise, pinnedMid, settled]} activeThreadId="noise" />,
    );
    assert.ok(m.query("[data-pinned-section]"), "pinned section when non-empty");
    assert.ok(
      m.query('[data-thread-card="pin-mid"][data-pinned="true"]'),
      "pinned row in shelf",
    );
    const pinSection = m.query("[data-pinned-section]");
    assert.ok(
      pinSection?.querySelector('[data-thread-card="pin-mid"]'),
      "pin lives under pinned section",
    );
    m.unmount();
  });

  it("Snoozed shelf collapses by default; carve-out; wake-soonest order", async () => {
    const soon = th({
      id: "snooze-soon",
      projectId: "p2",
      title: "snooze soon",
      snoozedUntil: FRESH + 10_000,
      snoozedAt: FRESH,
      updatedAt: FRESH - 100,
    });
    const late = th({
      id: "snooze-late",
      projectId: "p1",
      title: "snooze late",
      snoozedUntil: FRESH + 90_000,
      snoozedAt: FRESH,
      updatedAt: FRESH - 100,
    });
    const m = await mount(
      <Host initial={[noise, soon, late]} activeThreadId="noise" />,
    );
    assert.ok(m.query("[data-snoozed-shelf]"), "snoozed shelf present");
    assert.ok(
      (m.query("[data-snoozed-header]")?.textContent || "").includes(
        "Snoozed · 2",
      ),
    );
    assert.equal(
      m.queryAll('[data-snoozed="true"]').length,
      0,
      "collapsed shelf hides rows",
    );
    await m.click(m.query("[data-snoozed-header]"));
    await m.flush();
    const rows = m
      .queryAll('[data-snoozed="true"]')
      .map((el) => el.getAttribute("data-thread-card"));
    assert.deepEqual(
      rows,
      ["snooze-soon", "snooze-late"],
      "wake-soonest first",
    );
    assert.ok(
      m
        .query('[data-wake-label="snooze-soon"]')
        ?.textContent?.includes("until"),
    );
    m.unmount();

    const m2 = await mount(
      <Host initial={[noise, soon, late]} activeThreadId="snooze-late" />,
    );
    assert.ok(
      m2.query('[data-thread-card="snooze-late"][data-snoozed="true"]'),
      "selected snoozed carved out while shelf collapsed",
    );
    m2.unmount();
  });

  it("pin → pinned shelf → unpin → group; mutual exclusion leaves settled tail", async () => {
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
      // Settled tail defaults to expanded (t3); click only if collapsed.
      assert.ok(
        m.query("[data-settled-tail]"),
        "settled tail present before pin",
      );
      const settledHeader = m
        .queryAll("button")
        .find((b) => (b.textContent || "").includes("Settled ·"));
      assert.ok(settledHeader, "settled tail header");
      if (settledHeader!.getAttribute("aria-expanded") === "false") {
        await m.click(settledHeader!);
        await m.flush();
      }
      assert.ok(
        m.query('[data-thread-card="t-was-settled"][data-settled="true"]'),
        "settled-override row in expanded tail",
      );

      // Pin the attention target.
      const pinBtn = m.query('[data-pin-btn="t-pin-target"]');
      assert.ok(pinBtn, "pin control on attention card");
      await m.click(pinBtn!);
      await m.flush();

      assert.ok(m.query("[data-pinned-section]"), "pinned section after pin");
      assert.ok(
        m.query('[data-thread-card="t-pin-target"][data-pinned="true"]'),
        "target in pinned shelf",
      );

      // Keep-active the settled row, then pin (mutual exclusion → leaves tail).
      const keep = m
        .queryAll("button")
        .find((b) => b.getAttribute("aria-label") === "Keep thread active");
      assert.ok(keep, "keep-active on settled row");
      await m.click(keep!);
      await m.flush();

      const pinSettled = m.query('[data-pin-btn="t-was-settled"]');
      assert.ok(pinSettled, "pin on formerly settled thread");
      await m.click(pinSettled!);
      await m.flush();

      assert.ok(
        m.query('[data-thread-card="t-was-settled"][data-pinned="true"]'),
        "mutual exclusion: thread in pinned shelf",
      );
      assert.equal(
        m.query(
          '[data-settled-tail] [data-thread-card="t-was-settled"]',
        ) != null,
        false,
        "left the settled tail after pin",
      );

      // Unpin pin-target → back to group.
      await m.click(m.query('[data-unpin-btn="t-pin-target"]')!);
      await m.flush();
      assert.ok(
        m.query('[data-pin-btn="t-pin-target"]'),
        "unpinned target back in attention with pin control",
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
    const tOpen = thread({
      id: "t-open",
      projectId: "p1",
      title: "already open",
      updatedAt: FRESH + 200,
    });
    const tMid = thread({
      id: "t-mid",
      projectId: "p1",
      title: "mid pin me",
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

      assert.ok(
        m.query('[data-thread-card="t-mid"][data-pinned="true"]'),
        "appears in pinned section after pin",
      );
      assert.ok(
        fake.of("threads.setPinned").some((c) => {
          const a = c.args[0] as { threadId: string; pinned: boolean };
          return a.threadId === "t-mid" && a.pinned === true;
        }),
      );

      await m.click(m.query('[data-unpin-btn="t-mid"]')!);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      assert.equal(
        m.query("[data-pinned-section]") != null,
        false,
        "pinned section gone when empty",
      );
      assert.ok(
        m.query('[data-pin-btn="t-mid"]'),
        "back in group with pin control",
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
        assert.ok(snoozeBtn, "data-snooze-btn must be present");
        await m.click(snoozeBtn!);
        await m.flush();

        const preset = m.query('[data-snooze-preset="this-evening"]');
        assert.ok(preset, "data-snooze-preset=this-evening must open in menu");
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
          m.query("[data-snoozed-shelf]"),
          "thread lands on the snoozed shelf",
        );
        assert.ok(
          (m.query("[data-snoozed-header]")?.textContent || "").includes(
            "Snoozed · 1",
          ),
        );

        // Expand shelf and clear via data-snooze-clear (shelf wake control).
        await m.click(m.query("[data-snoozed-header]"));
        await m.flush();
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
          m.query("[data-snoozed-shelf]") != null,
          false,
          "empty snoozed shelf unmounts after clear",
        );
      } finally {
        m.unmount();
      }
    } finally {
      Date.now = realNow;
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

      await m.click(m.query('[data-snooze-btn="t-mute-mid"]'));
      await m.flush();
      const item = m.query('[data-mute-toggle="t-mute-mid"]');
      assert.ok(item, "mute item must be in the snooze menu");
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
      await m.click(m.query('[data-snooze-btn="t-mute-mid"]'));
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
