/**
 * Renders real components to markup and asserts the PR feature is actually
 * wired to them.
 *
 * These exist because a reviewer proved that passing `prNumber: null` into the
 * sidebar badge, or `thread={null}` into the PR card, deletes every visible
 * part of this feature while the suite, tsc and vite build all stay green. The
 * pure decisions in src/prUi.ts were well tested; nothing checked that the
 * components call them with real data.
 *
 * Run: node --import=./test/support/render.mjs --test test/prRender.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "../src/components/Sidebar";
import type { ProjectInfo, ThreadInfo, ProviderInfo } from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
  } as ProviderInfo,
];

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "add pr support",
    branch: "coder/add-pr-support-abc123",
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    worktreePath: null,
    ...over,
  } as ThreadInfo;
}

function renderSidebar(t: ThreadInfo): string {
  return renderToStaticMarkup(
    <Sidebar
      appName="Coder"
      searchPlaceholder="Search"
      projectsHeader="Projects"
      projects={[project]}
      threads={[t]}
      providers={providers}
      activeThreadId={t.id}
      onSelectThread={() => {}}
      onCreateThread={() => {}}
      onAddProject={() => {}}
      searchThreads={async () => []}
    />,
  );
}

describe("sidebar PR badge (rendered)", () => {
  it("renders a real link to the PR when the thread has one", () => {
    const html = renderSidebar(
      thread({
        prNumber: 842,
        prUrl: "https://github.com/owner/repo/pull/842",
      }),
    );
    assert.ok(html.includes("PR #842"), "the PR number must be visible");
    assert.ok(
      html.includes('href="https://github.com/owner/repo/pull/842"'),
      "the badge must link to the PR",
    );
  });

  it("opens the PR link safely, outside the app", () => {
    const html = renderSidebar(
      thread({ prNumber: 7, prUrl: "https://github.com/owner/repo/pull/7" }),
    );
    const anchor = html.slice(
      html.indexOf("<a "),
      html.indexOf("</a>") + 4,
    );
    assert.ok(anchor.includes('target="_blank"'), "must leave the app window");
    // noreferrer implies noopener: without it the opened page gets window.opener.
    assert.ok(
      anchor.includes('rel="noreferrer"') || anchor.includes('rel="noopener'),
      `PR link needs rel=noreferrer, got: ${anchor}`,
    );
  });

  it("shows the number without a link when the url is missing", () => {
    const html = renderSidebar(thread({ prNumber: 99, prUrl: null }));
    assert.ok(html.includes("PR #99"), "number still shown");
    assert.ok(
      !html.includes("<a "),
      "must not invent a link when there is no url",
    );
  });

  it("shows no PR chip at all when the thread has no PR", () => {
    const html = renderSidebar(thread());
    assert.ok(!html.includes("PR #"), "no PR chip without a PR");
  });

  it("does not nest interactive elements inside the thread card", () => {
    // A nested <a> or <button> inside a <button> is invalid HTML and drops
    // clicks. This shipped once already, in a different component.
    const html = renderSidebar(
      thread({ prNumber: 5, prUrl: "https://github.com/owner/repo/pull/5" }),
    );
    const opens = [...html.matchAll(/<button\b|<\/button>|<a\b|<\/a>/g)];
    let depth = 0;
    for (const m of opens) {
      const tag = m[0];
      if (tag === "<button" || tag === "<a") {
        depth += 1;
        assert.ok(
          depth <= 1,
          `interactive element nested inside another at index ${m.index}`,
        );
      } else {
        depth -= 1;
      }
    }
  });
});
