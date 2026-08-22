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

    await m.click(m.query("[data-new-thread-caret]"));
    const openBtn = m.query("[data-create-from-issue]");
    assert.ok(openBtn, "from-issue item renders when the optional prop is set");
    assert.equal(m.query("[data-issue-form]"), null);

    await m.click(openBtn);
    const form = m.query("[data-issue-form]");
    assert.ok(form, "clicking the item opens the inline form under the header");

    const input = m.query("[data-issue-input]") as HTMLInputElement | null;
    assert.ok(input, "form has an issue ref input");
    assert.match(
      input.placeholder,
      /Linear/i,
      "placeholder must mention Linear so pasted ENG-123 refs are discoverable",
    );
    await m.type(input, "https://github.com/acme/ledger/issues/99");

    const create = m.query("[data-issue-create]");
    assert.ok(create, "form has a Create button");
    await m.click(create);

    assert.equal(calls.length, 1, "submit calls the optional handler once");
    assert.deepEqual(calls[0], {
      projectId: "p1",
      projectPath: "/tmp/ledger",
      ref: "https://github.com/acme/ledger/issues/99",
    });

    const error = m.query("[data-issue-error]");
    assert.ok(error, "error line must render");
    assert.equal(error!.textContent, "issue not found");
    assert.ok(
      m.query("[data-issue-form]"),
      "form stays open on error so the user can retry",
    );

    await m.click(m.query("[data-issue-cancel]"));
    assert.equal(m.query("[data-issue-form]"), null);

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
    await m.click(m.query("[data-new-thread-caret]"));
    assert.equal(m.query("[data-create-from-issue]"), null);
    assert.ok(m.query("[data-new-thread]"), "existing New thread button remains");
    m.unmount();
  });
});
