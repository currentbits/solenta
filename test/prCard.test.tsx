/**
 * The Git tab must actually hand the selected thread to the PR card.
 *
 * A reviewer showed that `<PrCard thread={null}>` removes the only path to
 * opening a PR while the whole suite, tsc and vite build stay green. The
 * mutation is at the CALL SITE, so testing PrCard directly cannot catch it:
 * GitTab is the smallest unit that contains the wiring.
 *
 * Static markup covers wiring. The checks rollup, merge confirm, and merged
 * result run through the DOM harness so effects and clicks actually fire.
 *
 * Run: node --import=./test/support/render.mjs --test test/prCard.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GitTab } from "../src/components/AgentsPanel";
import { mount } from "./support/dom.ts";
import type {
  ThreadInfo,
  ProjectInfo,
  PrCheckInfo,
  PrInfo,
} from "../src/shared/ipc";

const project = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
} as ProjectInfo;

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "ship it",
    branch: "coder/ship-it-abc123",
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
    worktreePath: "/tmp/wt",
    ...over,
  } as ThreadInfo;
}

const openPr: PrInfo = {
  number: 12,
  url: "https://github.com/owner/repo/pull/12",
  state: "OPEN",
  branch: "coder/ship-it-abc123",
  created: false,
  title: "ship it",
  additions: 4,
  deletions: 1,
  changedFiles: 2,
};

const passingFailing: PrCheckInfo[] = [
  { name: "test", bucket: "pass" },
  { name: "lint", bucket: "pass" },
  { name: "types", bucket: "pass" },
  { name: "e2e", bucket: "fail" },
];

function gitTabProps(
  t: ThreadInfo | null,
  over: {
    prStatus?: () => Promise<PrInfo | null>;
    prChecks?: () => Promise<{ ok: true; checks: PrCheckInfo[] } | { ok: false; reason: string }>;
    prMerge?: () => Promise<PrInfo>;
  } = {},
) {
  return {
    thread: t,
    project,
    onSetupWorktree: async () => {},
    onMergeWorktree: async () => {},
    onRemoveWorktree: async () => {},
    onViewChanges: () => {},
    onPush: async () => ({ remote: "origin", branch: "b" }),
    createPr: async () =>
      ({
        number: 1,
        url: "https://github.com/owner/repo/pull/1",
        state: "OPEN",
        branch: "b",
        created: true,
      }) as PrInfo,
    prStatus: over.prStatus ?? (async () => null),
    prChecks: over.prChecks ?? (async () => ({ ok: true as const, checks: [] })),
    prMerge:
      over.prMerge ??
      (async () => ({ ...openPr, state: "MERGED" as const })),
    listCheckpoints: async () => [],
    restoreCheckpoint: async () => {},
    listLocalServers: async () => [],
    listDevScripts: async () => [],
    startDevServer: async () => ({ running: false }),
    stopDevServer: async () => ({ running: false }),
    devServerStatus: async () => ({ running: false }),
  };
}

function render(t: ThreadInfo | null): string {
  return renderToStaticMarkup(<GitTab {...gitTabProps(t)} />);
}

describe("Git tab wires the PR card to the selected thread", () => {
  it("renders the create form for a thread with a branch and no PR", () => {
    const html = render(thread());
    assert.ok(html.includes("Create PR"), "the create control must be present");
    assert.ok(
      html.includes('aria-label="PR title"'),
      "the title field must render",
    );
    assert.ok(
      !html.includes("Select a thread to open a PR"),
      "the card must receive the real thread, not null",
    );
  });

  it("shows the empty state only when no thread is selected", () => {
    const html = render(null);
    assert.ok(html.includes("Select a thread to open a PR"));
    assert.ok(!html.includes('aria-label="PR title"'));
  });

  it("cannot create without a title", () => {
    // canCreate requires a non-empty title; the button must start disabled.
    const html = render(thread());
    const idx = html.indexOf("Create PR");
    const button = html.lastIndexOf("<button", idx);
    const tag = html.slice(button, idx);
    assert.ok(
      tag.includes("disabled"),
      `Create PR must be disabled with an empty title, got: ${tag}`,
    );
  });

  it("cannot create without a branch", () => {
    // No `if (html.includes(...))` guard: a conditional assertion passes
    // silently when the button disappears, which is the exact failure this
    // test exists to catch.
    const html = render(thread({ branch: null, worktreePath: null }));
    assert.ok(html.includes("Create PR"), "the create control must still render");
    const idx = html.indexOf("Create PR");
    const button = html.lastIndexOf("<button", idx);
    assert.ok(
      html.slice(button, idx).includes("disabled"),
      "Create PR must be disabled without a branch",
    );
  });
});

describe("PrCard checks rollup and merge", () => {
  function threadWithPr(): ThreadInfo {
    return thread({
      prNumber: 12,
      prUrl: openPr.url,
      prState: "OPEN",
    });
  }

  it("renders the checks rollup under the stats line", async () => {
    const m = await mount(
      <GitTab
        {...gitTabProps(threadWithPr(), {
          prStatus: async () => openPr,
          prChecks: async () => ({ ok: true, checks: passingFailing }),
        })}
      />,
    );
    await m.flush();
    const line = m.query("[data-pr-checks]");
    assert.ok(line, "checks rollup line must render");
    assert.equal((line.textContent || "").trim(), "Checks: 3 passing · 1 failing");
    const tip = line.getAttribute("title") || "";
    assert.ok(tip.includes("test: pass"), tip);
    assert.ok(tip.includes("e2e: fail"), tip);
    assert.ok(m.query("[data-pr-merge]"), "OPEN PR must offer Merge");
  });

  it("arms an inline confirm, then shows MERGED after confirm", async () => {
    let merged = false;
    const m = await mount(
      <GitTab
        {...gitTabProps(threadWithPr(), {
          prStatus: async () => openPr,
          prChecks: async () => ({ ok: true, checks: passingFailing }),
          prMerge: async () => {
            merged = true;
            return { ...openPr, state: "MERGED" };
          },
        })}
      />,
    );
    await m.flush();
    const mergeBtn = m.query("[data-pr-merge]");
    assert.ok(mergeBtn, "Merge button");
    await m.click(mergeBtn);
    await m.flush();
    assert.ok(
      m.query("[data-pr-merge-confirm]"),
      "inline confirm must replace Merge",
    );
    assert.ok(
      m.text().includes("Confirm merge? This squashes into the base branch."),
    );
    await m.click(m.byText("Confirm"));
    await m.flush();
    assert.equal(merged, true, "prMerge must run on Confirm");
    assert.ok(m.text().includes("MERGED"), "card must show the merged state");
    assert.equal(m.query("[data-pr-merge]"), null, "Merge is only for OPEN PRs");
    assert.equal(m.query("[data-pr-merge-confirm]"), null);
  });

  it("Cancel leaves the PR open and the Merge button back", async () => {
    let merged = false;
    const m = await mount(
      <GitTab
        {...gitTabProps(threadWithPr(), {
          prStatus: async () => openPr,
          prChecks: async () => ({ ok: true, checks: passingFailing }),
          prMerge: async () => {
            merged = true;
            return { ...openPr, state: "MERGED" };
          },
        })}
      />,
    );
    await m.flush();
    await m.click(m.query("[data-pr-merge]"));
    await m.flush();
    await m.click(m.byText("Cancel"));
    await m.flush();
    assert.equal(merged, false, "Cancel must not call prMerge");
    assert.ok(m.query("[data-pr-merge]"), "Merge returns after Cancel");
    assert.ok(m.text().includes("OPEN"));
  });
});
