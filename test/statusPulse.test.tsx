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

  it("does not pulse waiting, even when the agent needs input", () => {
    assert.equal(
      statusPulseFor(
        thread({ status: "working", awaitingInput: true }),
        NOW,
        null,
        false,
      ),
      null,
    );
  });

  it("does not pulse a parent whose workers are blocked on you", () => {
    const orch = thread({ id: "orch", status: "done" });
    const worker = thread({
      id: "w1",
      handoffFrom: "orch",
      orchWorker: true,
      status: "working",
      awaitingInput: true,
    });
    const wait = waitFor([orch, worker]).get("orch") ?? null;
    assert.equal(statusPulseFor(orch, NOW, wait, false), null);
  });

  it("does not pulse a working parent whose descendant is blocked", () => {
    const orch = thread({
      id: "orch",
      status: "working",
      runStartedAt: NOW,
    });
    const worker = thread({
      id: "w1",
      handoffFrom: "orch",
      orchWorker: true,
      status: "working",
      awaitingInput: true,
    });
    const wait = waitFor([orch, worker]).get("orch") ?? null;
    assert.equal(statusPulseFor(orch, NOW, wait, false), null);
  });

  it("does not pulse delegating; only actual working moves", () => {
    const orch = thread({ id: "orch", status: "done" });
    const worker = thread({
      id: "w1",
      handoffFrom: "orch",
      orchWorker: true,
      status: "working",
      runStartedAt: NOW - 60_000,
    });
    const wait = waitFor([orch, worker]).get("orch") ?? null;
    assert.equal(statusPulseFor(orch, NOW, wait, false), null);
  });

  it("does not pulse unread finished work", () => {
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
      null,
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

  it("leaves waiting as a static label with no pulse", async () => {
    const { m } = await card({ status: "working", awaitingInput: true });
    assert.equal(m.query("[data-status-dot]"), null);
    assert.ok(m.query("[data-status-label]"));
    m.unmount();
  });

  it("leaves a delegating parent as a static label with no pulse", async () => {
    const { m } = await card({ id: "orch", status: "done", title: "orchestrate" }, [
      thread({
        id: "w1",
        handoffFrom: "orch",
        orchWorker: true,
        status: "working",
        runStartedAt: NOW - 60_000,
      }),
    ]);
    assert.equal(m.query("[data-status-dot]"), null);
    m.unmount();
  });

  it("leaves unread finished work without a pulse", async () => {
    const { m } = await card({
      status: "done",
      updatedAt: NOW,
      lastVisitedAt: NOW - 1,
    });
    assert.equal(m.query("[data-status-dot]"), null);
    m.unmount();
  });

  it("keeps the colored status label next to the pulse", async () => {
    const { m } = await card({ status: "working", runStartedAt: NOW });
    assert.ok(m.query("[data-status-label]"), "text label stays");
    assert.ok(m.query("[data-status-dot]"), "pulse is additive");
    m.unmount();
  });
});
