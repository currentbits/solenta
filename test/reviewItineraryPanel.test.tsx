/**
 * Review itinerary UI in the Changes panel (issue #421).
 *
 * Run: node --import=./test/support/render.mjs --test test/reviewItineraryPanel.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  DiffResult,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
} from "../src/shared/ipc";

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
    modelInfo: [],
    efforts: [],
  },
];

const DIFF: DiffResult = {
  files: [
    { path: ".github/workflows/ci.yml", status: "M", additions: 6, deletions: 1 },
    { path: "src/App.tsx", status: "M", additions: 5, deletions: 1 },
    { path: "src/reviewItinerary.ts", status: "A", additions: 40, deletions: 0 },
    { path: "electron/updater.js", status: "M", additions: 8, deletions: 2 },
    { path: "test/reviewItinerary.test.ts", status: "A", additions: 20, deletions: 0 },
  ],
  patch: [
    "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
    "--- a/.github/workflows/ci.yml",
    "+++ b/.github/workflows/ci.yml",
    "@@ -1,1 +1,2 @@",
    " name: ci",
    "+  run: npm test",
    "diff --git a/src/reviewItinerary.ts b/src/reviewItinerary.ts",
    "--- /dev/null",
    "+++ b/src/reviewItinerary.ts",
    "@@ -0,0 +1,2 @@",
    "+export function formatUsd() {}",
    "+export function buildReviewItinerary() {}",
    "diff --git a/electron/updater.js b/electron/updater.js",
    "--- a/electron/updater.js",
    "+++ b/electron/updater.js",
    "@@ -1,1 +1,2 @@",
    " module.exports = {}",
    "+function extra() {}",
  ].join("\n"),
  truncated: false,
};

function thread(): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "Review itinerary",
    branch: "coder/review-itinerary",
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
    lastVisitedAt: null,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
  };
}

function detail(): ThreadDetail {
  return {
    thread: thread(),
    messages: [
      {
        id: "m1",
        role: "user",
        text: "GitHub issue #421: Review itinerary: an ordered plan\n\nExperts don't read diffs top-to-bottom.",
        createdAt: 1,
      },
    ],
    workLog: [],
    workflow: null,
    usage: null,
  };
}

async function mountItinerary(opts?: {
  accepted?: string[];
  onAccept?: (hashes: string[]) => void;
}) {
  const accepted: string[][] = [];
  const view = await mount(
    <ThreadView
      detail={detail()}
      project={project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={async () => ({ id: "w", name: "s", phases: [] })}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      changesOpen={true}
      changesNonce={1}
      onCloseChanges={() => {}}
      onFetchDiff={async () => DIFF}
      onFetchReviewContext={async () => ({
        annotation: {
          version: 1,
          readOrder: ["ci-config", "impl"],
          chunks: [
            { area: "impl", rationale: "the planner itself", risks: ["hash drift"] },
          ],
          risks: ["forgot a test for binary files"],
        },
        symbols: [{ name: "formatUsd", path: "src/format.ts" }],
        acceptedHunks: opts?.accepted ?? [],
      })}
      onSetReviewAccepted={async (hashes) => {
        accepted.push(hashes);
        opts?.onAccept?.(hashes);
      }}
      onCommitChanges={async (message) => ({ subject: message })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
    />,
  );
  return { view, accepted };
}

describe("review itinerary panel", () => {
  it("shows the hard-stop, reuse hit, plan mismatch, and author notes", async () => {
    const { view } = await mountItinerary();
    assert.ok(view.container.querySelector("[data-review-itinerary]"));
    assert.ok(view.container.querySelector("[data-review-hard-stop]"));
    assert.match(
      view.container.querySelector("[data-review-hard-stop]")?.textContent || "",
      /ci\.yml/,
    );
    assert.ok(view.container.querySelector("[data-review-reuse]"));
    assert.match(
      view.container.querySelector("[data-review-reuse]")?.textContent || "",
      /formatUsd/,
    );
    assert.match(
      view.container.querySelector("[data-review-mismatch]")?.textContent || "",
      /issue says Review itinerary/,
    );
    assert.match(
      view.container.querySelector("[data-review-mismatch]")?.textContent || "",
      /updater\.js/,
    );
    assert.match(
      view.container.querySelector("[data-review-annotation]")?.textContent || "",
      /forgot a test/,
    );
    const files = [
      ...view.container.querySelectorAll("[data-review-chunk]"),
    ].map((el) => el.getAttribute("data-review-chunk"));
    assert.deepEqual(files[0], "ci-config");
    assert.ok(files.indexOf("tests") > files.indexOf("ci-config"));
  });

  it("tests-first moves the tests chunk ahead of implementation", async () => {
    const { view } = await mountItinerary();
    const before = [
      ...view.container.querySelectorAll("[data-review-chunk]"),
    ].map((el) => el.getAttribute("data-review-chunk"));
    assert.ok(before.indexOf("tests") > before.indexOf("critical"));
    await view.click(view.container.querySelector("[data-review-tests-first]")!);
    const after = [
      ...view.container.querySelectorAll("[data-review-chunk]"),
    ].map((el) => el.getAttribute("data-review-chunk"));
    assert.ok(after.indexOf("tests") < after.indexOf("critical"));
    assert.equal(after[0], "ci-config");
  });

  it("marking a hunk reviewed persists the hash", async () => {
    const { view, accepted } = await mountItinerary();
    const btn = view.container.querySelector<HTMLButtonElement>(
      "[data-review-hunk] button",
    );
    assert.ok(btn);
    assert.equal(btn.getAttribute("aria-pressed"), "false");
    await view.click(btn);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.length, 1);
    assert.equal(
      view.container
        .querySelector("[data-review-hunk-accepted]")
        ?.getAttribute("data-review-hunk-accepted"),
      "",
    );
  });
});
