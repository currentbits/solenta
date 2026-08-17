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
