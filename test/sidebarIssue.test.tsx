/**
 * Sidebar "New thread from GitHub issue" inline form.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom";
import { Sidebar } from "../src/components/Sidebar";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../src/shared/ipc";

const project: ProjectInfo = {
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

const FRESH = Date.now();

const thread: ThreadInfo = {
  id: "t1",
  projectId: "p1",
  title: "existing",
  branch: null,
  prNumber: null,
  prUrl: null,
  status: "idle",
  createdAt: FRESH,
  updatedAt: FRESH,
  runStartedAt: null,
  archived: false,
  settledOverride: null,
  settledAt: null,
  pinnedAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  lastVisitedAt: FRESH,
  prState: null,
  provider: "claude",
  model: null,
  sessionId: null,
  permissionMode: "default",
  reasoningEffort: null,
  worktreePath: null,
  handoffFrom: null,
};

describe("Sidebar issue form", () => {
  it("opens the form, submits the pasted ref, and shows an error", async () => {
    const calls: Array<{ projectId: string; projectPath: string; ref: string }> =
      [];
    const m = await mount(
      <Sidebar
        appName="Solenta"
        searchPlaceholder="Search threads..."
        projectsHeader="All projects"
        projects={[project]}
        threads={[thread]}
        providers={providers}
        activeThreadId={null}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onAddProject={() => {}}
        searchThreads={async () => []}
        onCreateThreadFromIssue={async (input) => {
          calls.push(input);
          return { ok: false, reason: "issue not found" };
        }}
      />,
    );

    const openBtn = m.query('[data-issue-thread-btn="p1"]');
    assert.ok(openBtn, "icon button must render when the optional prop is set");
    assert.equal(
      openBtn!.getAttribute("title"),
      "New thread from GitHub issue",
    );
    assert.equal(m.query('[data-issue-form="p1"]'), null);

    await m.click(openBtn);
    const form = m.query('[data-issue-form="p1"]');
    assert.ok(form, "clicking the icon opens the inline form");

    const input = m.query('[data-issue-input="p1"]') as HTMLInputElement | null;
    assert.ok(input, "form has an issue ref input");
    await m.type(input, "https://github.com/acme/ledger/issues/99");

    const create = m.query('[data-issue-create="p1"]');
    assert.ok(create, "form has a Create button");
    await m.click(create);

    assert.equal(calls.length, 1, "submit calls the optional handler once");
    assert.deepEqual(calls[0], {
      projectId: "p1",
      projectPath: "/tmp/ledger",
      ref: "https://github.com/acme/ledger/issues/99",
    });

    const error = m.query('[data-issue-error="p1"]');
    assert.ok(error, "error line must render");
    assert.equal(error!.textContent, "issue not found");
    assert.ok(
      m.query('[data-issue-form="p1"]'),
      "form stays open on error so the user can retry",
    );

    await m.click(m.query('[data-issue-cancel="p1"]'));
    assert.equal(m.query('[data-issue-form="p1"]'), null);

    m.unmount();
  });

  it("does not render the icon when the optional prop is omitted", async () => {
    const m = await mount(
      <Sidebar
        appName="Solenta"
        searchPlaceholder="Search threads..."
        projectsHeader="All projects"
        projects={[project]}
        threads={[thread]}
        providers={providers}
        activeThreadId={null}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onAddProject={() => {}}
        searchThreads={async () => []}
      />,
    );
    assert.equal(m.query('[data-issue-thread-btn="p1"]'), null);
    assert.ok(m.byText("New thread"), "existing New thread button remains");
    m.unmount();
  });
});
