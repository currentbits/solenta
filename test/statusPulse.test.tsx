/**
 * Sidebar title-adjacent status pulse (#763).
 *
 * Working / waiting / delegating / unread-done get a colored pulse next to
 * the thread title. Failed, stalled, quota, queued, and woke stay text-only.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { statusPulseFor, ThreadCard } from "../src/components/Sidebar";
import { thread } from "./support/fakeCoder.ts";
import { buildWaitStates } from "../src/waiting.ts";
import type { ProviderInfo, ThreadInfo } from "../src/shared/ipc";

const NOW = 1_000_000;

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

function waitFor(rows: ThreadInfo[]) {
  return buildWaitStates(rows);
}

describe("statusPulseFor", () => {
  it("pulses working blue", () => {
    assert.equal(
      statusPulseFor(thread({ status: "working", runStartedAt: NOW }), NOW, null, false),
      "working",
    );
  });

  it("pulses waiting amber when the agent needs input", () => {
    assert.equal(
      statusPulseFor(
        thread({ status: "working", awaitingInput: true }),
        NOW,
        null,
        false,
      ),
      "waiting",
    );
  });

  it("pulses waiting amber when workers are blocked on you", () => {
    const orch = thread({ id: "orch", status: "done" });
    const worker = thread({
      id: "w1",
      handoffFrom: "orch",
      status: "working",
      awaitingInput: true,
    });
    const wait = waitFor([orch, worker]).get("orch") ?? null;
    assert.equal(statusPulseFor(orch, NOW, wait, false), "waiting");
  });

  it("pulses delegating violet when a parent is waiting on live workers", () => {
    const orch = thread({ id: "orch", status: "done" });
    const worker = thread({
      id: "w1",
      handoffFrom: "orch",
      status: "working",
      runStartedAt: NOW - 60_000,
    });
    const wait = waitFor([orch, worker]).get("orch") ?? null;
    assert.equal(statusPulseFor(orch, NOW, wait, false), "delegating");
  });

  it("pulses done green only for unread finished work", () => {
    assert.equal(
      statusPulseFor(
        thread({
          status: "done",
          updatedAt: NOW,
          lastVisitedAt: NOW - 1,
        }),
        NOW,
        null,
        false,
      ),
      "done",
    );
    assert.equal(
      statusPulseFor(
        thread({ status: "done", updatedAt: NOW, lastVisitedAt: NOW }),
        NOW,
        null,
        false,
      ),
      null,
    );
    assert.equal(
      statusPulseFor(
        thread({
          status: "done",
          updatedAt: NOW,
          lastVisitedAt: NOW - 1,
        }),
        NOW,
        null,
        true,
      ),
      null,
      "selected thread is being read, so no done pulse",
    );
  });

  it("does not pulse failed, stalled, quota, queued, or woke", () => {
    assert.equal(
      statusPulseFor(thread({ status: "failed" }), NOW, null, false),
      null,
    );
    assert.equal(
      statusPulseFor(
        thread({
          status: "working",
          runStartedAt: NOW - 70 * 60 * 1000,
          stalledAt: NOW - 12 * 60 * 1000,
        }),
        NOW,
        null,
        false,
      ),
      null,
    );
    assert.equal(
      statusPulseFor(
        thread({ status: "quota-wait", quotaWaitUntil: NOW + 3_600_000 }),
        NOW,
        null,
        false,
      ),
      null,
    );
    assert.equal(
      statusPulseFor(
        thread({
          status: "idle",
          queued: { prompt: "then update the changelog" },
        }),
        NOW,
        null,
        false,
      ),
      null,
    );
    assert.equal(
      statusPulseFor(
        thread({
          status: "idle",
          snoozedUntil: NOW - 1000,
          snoozedAt: NOW - 60_000,
          lastVisitedAt: NOW - 120_000,
          updatedAt: NOW - 60_000,
        }),
        NOW,
        null,
        false,
      ),
      null,
    );
  });
});

describe("ThreadCard status pulse", () => {
  async function card(over: Partial<ThreadInfo>, wait: ThreadInfo[] = []) {
    const t = thread({ title: "pulse target", ...over });
    const waits = wait.length ? waitFor([t, ...wait]) : null;
    const m = await mount(
      <ThreadCard
        thread={t}
        slug="acme/ledger"
        providers={providers}
        active={false}
        now={NOW}
        wait={waits?.get(t.id) ?? null}
        onSelect={() => {}}
      />,
    );
    return { m, t };
  }

  it("puts a working pulse on the title line", async () => {
    const { m } = await card({ status: "working", runStartedAt: NOW });
    const dot = m.query("[data-status-dot]");
    assert.ok(dot, "working thread must show a pulse");
    assert.equal(dot!.getAttribute("data-status-dot"), "working");
    assert.match(dot!.parentElement!.textContent || "", /pulse target/);
    m.unmount();
  });

  it("puts a waiting pulse on the title line", async () => {
    const { m } = await card({ status: "working", awaitingInput: true });
    const dot = m.query("[data-status-dot]");
    assert.ok(dot, "waiting thread must show a pulse");
    assert.equal(dot!.getAttribute("data-status-dot"), "waiting");
    m.unmount();
  });

  it("puts a delegating pulse on the title line", async () => {
    const { m } = await card({ id: "orch", status: "done", title: "orchestrate" }, [
      thread({
        id: "w1",
        handoffFrom: "orch",
        status: "working",
        runStartedAt: NOW - 60_000,
      }),
    ]);
    const dot = m.query("[data-status-dot]");
    assert.ok(dot, "delegating parent must show a pulse");
    assert.equal(dot!.getAttribute("data-status-dot"), "delegating");
    m.unmount();
  });

  it("puts a done pulse on unread finished work", async () => {
    const { m } = await card({
      status: "done",
      updatedAt: NOW,
      lastVisitedAt: NOW - 1,
    });
    const dot = m.query("[data-status-dot]");
    assert.ok(dot, "unread done must show a pulse");
    assert.equal(dot!.getAttribute("data-status-dot"), "done");
    m.unmount();
  });

  it("keeps the colored status label next to the pulse", async () => {
    const { m } = await card({ status: "working", runStartedAt: NOW });
    assert.ok(m.query("[data-status-label]"), "text label stays");
    assert.ok(m.query("[data-status-dot]"), "pulse is additive");
    m.unmount();
  });
});
