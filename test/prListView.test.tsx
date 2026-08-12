/**
 * PrListView: groups, match-click, error retry.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { PrListView } from "../src/components/PrListView";
import type {
  ListPrsResult,
  PrListItem,
  ProjectInfo,
  ThreadInfo,
} from "../src/shared/ipc";

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

const pr = (over: Partial<PrListItem> & Pick<PrListItem, "number">): PrListItem => ({
  title: `Fix ${over.number}`,
  url: `https://github.com/acme/ledger/pull/${over.number}`,
  state: "OPEN",
  headRefName: `feat/${over.number}`,
  additions: 10,
  deletions: 1,
  updatedAt: "2026-08-12T18:00:00Z",
  ...over,
});

function thread(over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">): ThreadInfo {
  return {
    projectId: "p1",
    title: over.id,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: 1,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

describe("PrListView", () => {
  it("groups rows under each project slug", async () => {
    const listPrs = async (projectPath: string): Promise<ListPrsResult> => {
      if (projectPath === p1.path) {
        return { ok: true, prs: [pr({ number: 11, title: "Ledger fix" })] };
      }
      return { ok: true, prs: [pr({ number: 22, title: "Billing fix" })] };
    };
    const m = await mount(
      <PrListView
        projects={[p1, p2]}
        threads={[]}
        listPrs={listPrs}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.query('[data-pr-group="acme/ledger"]'), "ledger group");
    assert.ok(m.query('[data-pr-group="acme/billing"]'), "billing group");
    assert.ok(m.text().includes("Ledger fix"));
    assert.ok(m.text().includes("Billing fix"));
    assert.ok(m.text().includes("#11"));
    assert.ok(m.text().includes("#22"));
    assert.ok(m.text().includes("+10 -1"));
    m.unmount();
  });

  it("selects the matching thread when a row is clicked", async () => {
    let selected: string | null = null;
    const listPrs = async (): Promise<ListPrsResult> => ({
      ok: true,
      prs: [pr({ number: 5, headRefName: "coder/hit" })],
    });
    const m = await mount(
      <PrListView
        projects={[p1]}
        threads={[thread({ id: "t-hit", branch: "coder/hit" })]}
        listPrs={listPrs}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const row = m.query('[data-pr-row="5"] button');
    assert.ok(row, "row select button");
    await m.click(row);
    assert.equal(selected, "t-hit");
    m.unmount();
  });

  it("shows a per-project error with Retry that reloads that project", async () => {
    let calls = 0;
    const listPrs = async (): Promise<ListPrsResult> => {
      calls += 1;
      if (calls === 1) return { ok: false, reason: "auth" };
      return {
        ok: true,
        prs: [pr({ number: 9, title: "Recovered PR" })],
      };
    };
    const m = await mount(
      <PrListView
        projects={[p1]}
        threads={[]}
        listPrs={listPrs}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("Couldn't load PR data"));
    assert.ok(!m.text().includes("Recovered PR"));
    const retry = m.byText("Retry");
    assert.ok(retry, "Retry button");
    await m.click(retry);
    await m.flush();
    assert.ok(m.text().includes("Recovered PR"));
    assert.ok(!m.text().includes("Couldn't load PR data"));
    assert.equal(calls, 2);
    m.unmount();
  });

  it("renders the all-empty state when every project has no PRs", async () => {
    const m = await mount(
      <PrListView
        projects={[p1, p2]}
        threads={[]}
        listPrs={async () => ({ ok: true, prs: [] })}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("No open pull requests"));
    assert.ok(!m.query("[data-pr-row]"));
    m.unmount();
  });
});
