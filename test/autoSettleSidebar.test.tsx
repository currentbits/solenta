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
      appName="Coder"
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
    // Settled tail should include quiet-4d
    assert.ok(
      m.query("[data-settled-tail]"),
      "settled tail present under default 3",
    );
    const header = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Settled ·"));
    assert.ok(header, "settled header");
    await m.click(header!);
    await m.flush();
    assert.ok(
      m.query('[data-thread-card="quiet-4d"][data-settled="true"]'),
      "quiet 4d is settled under window 3",
    );
    m.unmount();
  });

  it("quiet 4-day thread stays in attention when setting is 7", async () => {
    const m = await mount(<Host days={7} />);
    // No settled tail (or empty of quiet-4d)
    assert.equal(
      m.query("[data-settled-tail]") != null,
      false,
      "no settled tail when window is 7 days",
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
      m.query("[data-settled-tail]") != null,
      false,
      "null disables inactivity settle — tail empty",
    );
    assert.ok(m.query('[data-thread-card="quiet-4d"]'));
    m.unmount();
  });
});

describe("Settings auto-settle fakeCoder round-trip (round 45)", () => {
  it("saves autoSettleAfterDays through the real Settings modal", async () => {
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "t1", projectId: "p1" })],
      settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3 },
      details: {
        t1: detail({ thread: thread({ id: "t1", projectId: "p1" }) }),
      },
    });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);
    try {
      await m.flush();
      const gear = m.byText("Settings");
      assert.ok(gear, "settings control must exist");
      await m.click(gear!);
      await m.flush();

      const input = m.query("#auto-settle-days");
      assert.ok(input, "auto-settle field in modal");
      await m.type(input, "7");
      const saves = m
        .queryAll("button")
        .filter((b) => (b.textContent || "").includes("Save"));
      await m.click(saves[saves.length - 1]!);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();

      const setCalls = fake.of("settings.set");
      assert.ok(setCalls.length >= 1, "settings.set must fire");
      const last = setCalls[setCalls.length - 1]!.args[0] as {
        autoSettleAfterDays?: number | null;
      };
      assert.equal(last.autoSettleAfterDays, 7);

      const got = await fake.api.settings.get();
      assert.equal(got.autoSettleAfterDays, 7);
    } finally {
      m.unmount();
    }
  });
});
