/**
 * InsightsView: ranked failure modes, click-through, empty/error.
 * Run: npm run test:renderer -- test/insightsView.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { InsightsView } from "../src/components/InsightsView";
import type { FailureMode } from "../src/shared/ipc";

const HOUR = 3_600_000;

function mode(over: Partial<FailureMode> & Pick<FailureMode, "id">): FailureMode {
  return {
    signature: over.signature ?? over.id,
    sample: over.sample ?? "raw sample",
    count: over.count ?? 2,
    lastAt: over.lastAt ?? Date.now(),
    offenders: over.offenders ?? [
      {
        threadId: "t1",
        threadTitle: "First offender",
        projectId: "p1",
        provider: "claude",
        kind: "failed",
        at: Date.now(),
      },
    ],
    ...over,
  };
}

describe("InsightsView", () => {
  it("renders ranked modes with signature, count, sample, and kind badges", async () => {
    const now = Date.now();
    const loadFailureModes = async (): Promise<FailureMode[]> => [
      mode({
        id: "enoent",
        signature: "Error: spawn <cmd> ENOENT",
        sample: "Error: spawn claude ENOENT",
        count: 3,
        lastAt: now,
        offenders: [
          {
            threadId: "t1",
            threadTitle: "Ship ledger",
            projectId: "p1",
            provider: "claude",
            kind: "failed",
            at: now,
          },
          {
            threadId: "t2",
            threadTitle: "Retry billing",
            projectId: "p1",
            provider: "codex",
            kind: "retried",
            at: now - HOUR,
          },
          {
            threadId: "t3",
            threadTitle: "Stuck review",
            projectId: "p1",
            provider: "kimi",
            kind: "stalled",
            at: now - 2 * HOUR,
          },
        ],
      }),
      mode({
        id: "budget",
        signature: "Daily budget of $<n> reached",
        sample: "Daily budget of $20 reached",
        count: 2,
        lastAt: now - 2 * HOUR,
      }),
    ];
    const m = await mount(
      <InsightsView
        loadFailureModes={loadFailureModes}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    const text = m.text();
    assert.ok(m.query("[data-insights]"), "root");
    assert.ok(m.query('[data-insights-mode="enoent"]'), "first mode");
    assert.ok(m.query('[data-insights-mode="budget"]'), "second mode");
    assert.ok(text.includes("Error: spawn <cmd> ENOENT"));
    assert.ok(text.includes("3 threads"));
    assert.ok(text.includes("Error: spawn claude ENOENT"));
    assert.ok(text.includes("Ship ledger"));
    assert.ok(text.includes("claude"));
    assert.ok(text.includes("failed"));
    assert.ok(text.includes("retried"));
    assert.ok(text.includes("stalled"));
    assert.ok(m.query('[data-kind="failed"]'), "failed badge");
    assert.ok(m.query('[data-kind="retried"]'), "retried badge");
    assert.ok(m.query('[data-kind="stalled"]'), "stalled badge");
    assert.ok(text.includes("Daily budget of $<n> reached"));
    m.unmount();
  });

  it("selects the thread when an offender is clicked", async () => {
    let selected: string | null = null;
    const m = await mount(
      <InsightsView
        loadFailureModes={async () => [
          mode({
            id: "hit",
            signature: "boom",
            offenders: [
              {
                threadId: "t-hit",
                threadTitle: "click me",
                projectId: "p1",
                provider: "grok",
                kind: "failed",
                at: Date.now(),
              },
            ],
          }),
        ]}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const select = m.query('button[aria-label="Select thread: click me"]');
    assert.ok(select, "offender select button");
    await m.click(select);
    assert.equal(selected, "t-hit");
    m.unmount();
  });

  it("opens a live offender by id when the live set is known", async () => {
    let selected: string | null = null;
    const now = Date.now();
    const m = await mount(
      <InsightsView
        loadFailureModes={async () => [
          mode({
            id: "dup",
            signature: "boom",
            offenders: [
              {
                threadId: "t-live",
                threadTitle: "Same title",
                projectId: "p1",
                provider: "grok",
                kind: "failed",
                at: now,
              },
              {
                threadId: "t-gone",
                threadTitle: "Same title",
                projectId: "p1",
                provider: "claude",
                kind: "retried",
                at: now - HOUR,
              },
            ],
          }),
        ]}
        existingThreadIds={["t-live"]}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const live = m.query('[data-insights-offender="t-live"]');
    const gone = m.query('[data-insights-offender="t-gone"]');
    assert.ok(live, "live offender stays");
    assert.ok(gone, "deleted offender stays");
    const buttons = live!.querySelectorAll(
      'button[aria-label="Select thread: Same title"]',
    );
    assert.equal(buttons.length, 1, "live row keeps one select control");
    await m.click(buttons[0] as HTMLElement);
    assert.equal(selected, "t-live");
    m.unmount();
  });

  it("keeps a missing offender visible and does not navigate", async () => {
    let selected: string | null = null;
    const m = await mount(
      <InsightsView
        loadFailureModes={async () => [
          mode({
            id: "gone",
            signature: "boom",
            offenders: [
              {
                threadId: "t-gone",
                threadTitle: "Deleted offender",
                projectId: "p1",
                provider: "grok",
                kind: "failed",
                at: Date.now(),
              },
            ],
          }),
        ]}
        existingThreadIds={["t-other"]}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const row = m.query('[data-insights-offender="t-gone"]');
    assert.ok(row, "historical offender stays");
    assert.match(row!.textContent ?? "", /unavailable/i);
    assert.equal(
      row!.querySelector(
        'button[aria-label="Select thread: Deleted offender"]',
      ),
      null,
      "missing thread has no open action",
    );
    const kind = row!.querySelector('[data-kind="failed"]');
    assert.ok(kind, "kind badge stays");
    assert.equal(
      kind!.closest("button"),
      null,
      "meta cells stay outside the hit target",
    );
    await m.click(row);
    assert.equal(selected, null, "deleted offender must not navigate");
    m.unmount();
  });

  it("treats omitted live ids as openable so boot does not flash unavailable", async () => {
    let selected: string | null = null;
    const m = await mount(
      <InsightsView
        loadFailureModes={async () => [
          mode({
            id: "boot",
            signature: "boom",
            offenders: [
              {
                threadId: "t-boot",
                threadTitle: "Still loading",
                projectId: "p1",
                provider: "grok",
                kind: "failed",
                at: Date.now(),
              },
            ],
          }),
        ]}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const row = m.query('[data-insights-offender="t-boot"]');
    assert.ok(row, "row renders during boot");
    assert.equal(
      /unavailable/i.test(row!.textContent ?? ""),
      false,
      "omitted live set must not mark rows unavailable",
    );
    const select = m.query('button[aria-label="Select thread: Still loading"]');
    assert.ok(select, "row stays openable before the list arrives");
    await m.click(select);
    assert.equal(selected, "t-boot");
    m.unmount();
  });

  it("renders the empty state when there are no recurring modes", async () => {
    const m = await mount(
      <InsightsView
        loadFailureModes={async () => []}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("No recurring failure modes"));
    assert.ok(m.text().includes("good outcome"));
    assert.ok(m.query("[data-insights-empty]"), "empty marker");
    assert.equal(m.query("[data-insights-mode]"), null);
    m.unmount();
  });

  it("renders an error when the load rejects", async () => {
    const m = await mount(
      <InsightsView
        loadFailureModes={async () => {
          throw new Error("store locked");
        }}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.query("[data-insights-error]"), "error marker");
    assert.ok(m.text().includes("store locked"));
    assert.ok(m.query('[role="alert"]'), "error uses role=alert");
    assert.equal(m.query("[data-insights-mode]"), null);
    m.unmount();
  });

  it("truncates a long sample until expanded", async () => {
    const sample = `Error: ${"x".repeat(200)}`;
    const m = await mount(
      <InsightsView
        loadFailureModes={async () => [
          mode({
            id: "long",
            signature: "long sample",
            sample,
          }),
        ]}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    const shown = m.query('[data-insights-sample="long"]')?.textContent ?? "";
    assert.ok(shown.endsWith("…"), "sample is truncated");
    assert.ok(shown.length < sample.length, "truncated shorter than raw");
    const toggle = m.byText("Show sample");
    assert.ok(toggle, "expand control");
    await m.click(toggle);
    const full = m.query('[data-insights-sample="long"]')?.textContent ?? "";
    assert.equal(full, sample);
    m.unmount();
  });
});
