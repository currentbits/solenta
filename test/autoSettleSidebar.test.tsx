/**
 * Round 45: Sidebar settleOpts reacts to autoSettleAfterDays.
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
import { AUTO_SETTLE_AFTER_DAYS } from "../src/threadSettle";

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const p1: ProjectInfo = {
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

/** Quiet for 4 days — settles under default 3, stays attention at 7. */
function quietThread(): ThreadInfo {
  return thread({
    id: "quiet-4d",
    projectId: "p1",
    title: "quiet four days",
    status: "idle",
    updatedAt: NOW - 4 * DAY_MS,
    createdAt: NOW - 10 * DAY_MS,
    lastVisitedAt: NOW - 4 * DAY_MS,
  });
}

function noise(): ThreadInfo {
  return thread({
    id: "noise",
    projectId: "p1",
    title: "fresh noise",
    updatedAt: NOW,
    lastVisitedAt: NOW,
  });
}

function Host({ days }: { days: number | null | undefined }) {
  const [threads] = useState([noise(), quietThread()]);
  return (
    <Sidebar
      appName="Solenta"
      searchPlaceholder="Search"
      projectsHeader="All projects"
      projects={[p1]}
      threads={threads}
      providers={providers}
      activeThreadId="noise"
      onSelectThread={() => {}}
      onCreateThread={() => {}}
      onAddProject={() => {}}
      autoSettleAfterDays={days}
      searchThreads={async () => threads}
    />
  );
}

describe("Sidebar auto-settle window (round 45)", () => {
  it("quiet 4-day thread settles under default constant (3)", async () => {
    assert.equal(AUTO_SETTLE_AFTER_DAYS, 3);
    // undefined = loading → constant 3
    const m = await mount(<Host days={undefined} />);
    const header = m.query("[data-settled-shelf-toggle]");
    assert.ok(header, "Settled shelf present under default 3");
    assert.match(
      header!.textContent || "",
      /Settled \(1\)/,
      `settled thread counts into Settled, got: ${header!.textContent}`,
    );
    if (header!.getAttribute("aria-expanded") !== "true") {
      await m.click(header!);
      await m.flush();
    }
    assert.ok(
      m.query('[data-thread-card="quiet-4d"][data-settled="true"]'),
      "quiet 4d is a settled row under window 3",
    );
    m.unmount();
  });

  it("quiet 4-day thread stays in attention when setting is 7", async () => {
    const m = await mount(<Host days={7} />);
    // No Settled shelf (or empty of quiet-4d)
    assert.equal(
      m.query("[data-settled-shelf-toggle]") != null,
      false,
      "no Settled shelf when window is 7 days",
    );
    assert.ok(
      m.query('[data-thread-card="quiet-4d"]'),
      "quiet thread remains in attention",
    );
    assert.equal(
      m.query('[data-thread-card="quiet-4d"]')?.getAttribute("data-settled"),
      null,
    );
    m.unmount();
  });

  it("quiet 4-day thread stays attention when setting is null (Never)", async () => {
    const m = await mount(<Host days={null} />);
    assert.equal(
      m.query("[data-settled-shelf-toggle]") != null,
      false,
      "null disables inactivity settle — shelf empty",
    );
    assert.ok(m.query('[data-thread-card="quiet-4d"]'));
    m.unmount();
  });
});

/**
 * App→Sidebar wire (ISSUES 2026-08-07): render the PARENT that owns the call
 * site. Mounting Sidebar with the prop cannot kill a mutant that hardcodes
 * autoSettleAfterDays={undefined} in App.tsx.
 */
describe("App wires autoSettleAfterDays into Sidebar (round 45)", () => {
  async function bootApp(fake: ReturnType<typeof createFakeCoder>) {
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    return mount(<App />);
  }

  async function openSettings(m: Awaited<ReturnType<typeof mount>>) {
    const gear = m.byText("Settings");
    assert.ok(gear, "settings control must exist");
    await m.click(gear!);
    await m.flush();
  }

  async function saveSettleDays(
    m: Awaited<ReturnType<typeof mount>>,
    value: string,
  ) {
    const input = m.query("#auto-settle-days");
    assert.ok(input, "auto-settle field in modal");
    await m.type(input, value);
    const saves = m
      .queryAll("button")
      .filter((b) => (b.textContent || "").includes("Save"));
    assert.ok(saves.length >= 1, "Save button");
    await m.click(saves[saves.length - 1]!);
    await m.flush();
    await inAct(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await m.flush();
  }

  async function expandSettledShelf(m: Awaited<ReturnType<typeof mount>>) {
    const header = m.query("[data-settled-shelf-toggle]");
    if (!header) return null;
    if (header.getAttribute("aria-expanded") !== "true") {
      await m.click(header);
      await m.flush();
    }
    return header;
  }

  it("live partition: default 3 settles quiet-4d; 7 → attention; Never → no tail; invalid 0 errors", async () => {
    // Fixture discipline: quiet mid-list, selected is noise (index 0).
    const quiet = quietThread();
    const fresh = noise();
    const fake = createFakeCoder({
      projects: [project({ id: "p1", slug: "acme/ledger" })],
      threads: [fresh, quiet],
      settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3 },
      details: {
        noise: detail({ thread: fresh }),
        "quiet-4d": detail({ thread: quiet }),
      },
    });
    const m = await bootApp(fake);
    try {
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      // --- under default 3: quiet sits on the Settled shelf ---
      assert.ok(
        m.query("[data-settled-shelf-toggle]"),
        "Settled shelf under App-wired default 3",
      );
      await expandSettledShelf(m);
      assert.ok(
        m.query('[data-thread-card="quiet-4d"][data-settled="true"]'),
        "quiet-4d settled when App passes loaded setting 3",
      );

      // --- set 7 through REAL modal ---
      await openSettings(m);
      await saveSettleDays(m, "7");
      assert.equal(
        (await fake.api.settings.get()).autoSettleAfterDays,
        7,
        "fake stores 7",
      );
      // Close modal so sidebar is visible (backdrop click / close).
      const close = m.query('button[aria-label="Close"]');
      if (close) {
        await m.click(close);
        await m.flush();
      }

      assert.equal(
        m.query("[data-settled-shelf-toggle]") != null,
        false,
        "after App re-renders with 7, quiet leaves the shelf",
      );
      assert.ok(
        m.query('[data-thread-card="quiet-4d"]'),
        "quiet-4d is attention under window 7",
      );
      assert.equal(
        m.query('[data-thread-card="quiet-4d"]')?.getAttribute("data-settled"),
        null,
      );

      // --- set Never (null) ---
      await openSettings(m);
      await saveSettleDays(m, "");
      assert.equal(
        (await fake.api.settings.get()).autoSettleAfterDays,
        null,
      );
      const close2 = m.query('button[aria-label="Close"]');
      if (close2) {
        await m.click(close2);
        await m.flush();
      }
      assert.equal(
        m.query("[data-settled-shelf-toggle]") != null,
        false,
        "Never: no Settled shelf",
      );
      assert.ok(
        m.query('[data-thread-card="quiet-4d"]'),
        "quiet stays in attention when disabled",
      );

      // --- M6: invalid 0 must error and leave partition unchanged ---
      // Quiet is currently attention with Never. Set back to 3 first so we have
      // a settled tail, then bad 0 must not clear the setting.
      await openSettings(m);
      await saveSettleDays(m, "3");
      const close3 = m.query('button[aria-label="Close"]');
      if (close3) {
        await m.click(close3);
        await m.flush();
      }
      assert.ok(
        m.query("[data-settled-shelf-toggle]"),
        "precondition: settled under 3 before invalid save",
      );
      const settledBefore = m.query("[data-settled-shelf-toggle]") != null;

      await openSettings(m);
      await saveSettleDays(m, "0");
      // Validation error from honest fakeCoder; modal stays open with alert.
      assert.ok(
        m.query('[role="alert"]'),
        "invalid 0 must surface role=alert (kills silent-merge fake)",
      );
      assert.ok(
        m.text().includes("Auto-settle days must be a positive integer"),
        `error text, got: ${m.text().slice(-200)}`,
      );
      assert.equal(
        (await fake.api.settings.get()).autoSettleAfterDays,
        3,
        "invalid 0 must NOT change stored setting",
      );

      const close4 = m.query('button[aria-label="Close"]');
      if (close4) {
        await m.click(close4);
        await m.flush();
      }
      assert.equal(
        m.query("[data-settled-shelf-toggle]") != null,
        settledBefore,
        "partition must not change after rejected save",
      );
      assert.ok(
        m.query("[data-settled-shelf-toggle]"),
        "Settled shelf still present after invalid 0 rejected",
      );
    } finally {
      m.unmount();
    }
  });
});
