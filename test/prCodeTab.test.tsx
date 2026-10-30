/**
 * PR workspace Code tab: commit picker + viewed mark (#1527).
 * Run: npm run test:renderer -- test/prCodeTab.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { PrWorkspacePanel } from "../src/components/PrWorkspacePanel";
import { PrCodeTab } from "../src/components/PrCodeTab";
import { ChangesPanel } from "../src/components/thread/ChangesPanel";
import { setDiffHideTests, setDiffTreeView } from "../src/uiPrefs";
import type { DiffResult, FileChange, PrDetail, PrDetailResult } from "../src/shared/ipc";

// Top-level, like changesPanel.test.tsx's reset: registered before any
// describe()'s own hooks, so dom.ts's unmountAll (registered when it was
// imported, above) runs first and this fires on an already-unmounted tree.
afterEach(() => setDiffTreeView(false));

const pr = {
  number: 11,
  title: "Feature",
  body: "",
  url: "https://github.com/acme/ledger/pull/11",
  state: "OPEN",
  isDraft: false,
  headRefName: "feat/11",
  comments: [],
} as PrDetail;
const ok = (p: PrDetail): PrDetailResult => ({ ok: true, pr: p });

describe("PrWorkspacePanel Code tab", () => {
  it("loads the PR diff when the Code tab is opened", async () => {
    const diffs: unknown[] = [];
    // jsdom (and window) only exist after the first mount.
    const shell = await mount(<div />);
    const w = window as unknown as { coder?: unknown };
    const prev = w.coder;
    w.coder = {
      git: {
        mergeOptions: async () => ({ ok: true, methods: ["squash"], defaultMethod: "squash" }),
        prStack: async () => ({ ok: true, stack: [], defaultBase: "main" }),
        prDiff: async (input: unknown) => {
          diffs.push(input);
          return {
            ok: true,
            headSha: "abc1234",
            commits: [{ sha: "abc1234", title: "feat" }],
            files: [
              {
                path: "src/app.ts",
                status: "M",
                additions: 1,
                deletions: 0,
                viewed: "unseen",
              },
            ],
            patch:
              "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n keep\n+add\n",
            truncated: false,
          };
        },
      },
    };
    shell.unmount();
    try {
      const m = await mount(
        <PrWorkspacePanel
          projectPath="/tmp/ledger"
          prNumber={11}
          matchedThread={null}
          prDetail={async () => ok(pr)}
          prEdit={async () => ok(pr)}
          prComment={async () => ({ ok: true, url: pr.url })}
          prClose={async () => ok(pr)}
          prReady={async () => ok(pr)}
          prMergeAt={async () => ok({ ...pr, state: "MERGED" })}
          onSelectThread={() => {}}
          onClose={() => {}}
        />,
      );
      await m.flush();
      assert.ok(m.query("[data-pr-tab=code]"));
      await m.click(m.query("[data-pr-tab=code]"));
      await m.flush();
      assert.ok(m.query("[data-pr-code]"));
      assert.ok(m.query("[data-pr-code-file='src/app.ts']"));
      assert.equal(diffs.length, 1);
      m.unmount();
    } finally {
      w.coder = prev;
    }
  });
});

describe("PR Code tab Hide tests (#1745)", () => {
  const file = (path: string): FileChange => ({ path, status: "M", additions: 1, deletions: 0 });
  const files = [file("src/app.ts"), file("test/app.test.ts"), file("pkg/server_test.go")];

  it("hides tests, restores them from the count, and shares the setting with the Git pane", async () => {
    const shell = await mount(<div />);
    const w = window as unknown as { coder?: unknown };
    const prev = w.coder;
    w.coder = {
      git: {
        prDiff: async () => ({
          ok: true,
          headSha: "abc1234",
          commits: [],
          files,
          patch: "",
          truncated: false,
        }),
      },
    };
    shell.unmount();
    try {
      const m = await mount(<PrCodeTab projectPath="/tmp/ledger" prNumber={11} />);
      await m.flush();
      const listed = () =>
        m.queryAll("[data-pr-code-file]").map((el) => el.getAttribute("data-pr-code-file"));
      assert.equal(listed().length, 3);

      await m.click(m.query("[data-hide-tests]"));
      await m.flush();
      assert.deepEqual(listed(), ["src/app.ts"]);
      assert.equal(m.query("[data-tests-hidden]")?.textContent, "2 test files hidden");
      assert.equal(window.localStorage.getItem("coder.diffHideTests"), "on");

      const diff: DiffResult = { files, patch: "", truncated: false };
      const git = await mount(
        <ChangesPanel
          open
          threadId="t-share"
          threadTitle="share"
          planText=""
          openNonce={1}
          onFetchDiff={async () => diff}
          onCommit={async (message) => ({ subject: message })}
          onRevert={async (path) => ({ path })}
          onSuggest={async () => ({ message: "x" })}
        />,
      );
      await git.flush();
      assert.deepEqual(
        git.queryAll("[data-file-row]").map((el) => el.getAttribute("data-file-path")),
        ["src/app.ts"],
        "the Git pane reads the same setting",
      );

      await m.click(m.query("[data-tests-hidden]"));
      await m.flush();
      await git.flush();
      assert.equal(listed().length, 3);
      assert.equal(git.queryAll("[data-file-row]").length, 3);
      git.unmount();
      m.unmount();
    } finally {
      setDiffHideTests(false);
      w.coder = prev;
    }
  });
});

async function withFakePrDiff<T>(
  files: FileChange[],
  run: () => Promise<T>,
): Promise<T> {
  const shell = await mount(<div />);
  const w = window as unknown as { coder?: unknown };
  const prev = w.coder;
  w.coder = {
    git: {
      prDiff: async () => ({
        ok: true,
        headSha: "abc1234",
        commits: [],
        files,
        patch: "",
        truncated: false,
      }),
    },
  };
  shell.unmount();
  try {
    return await run();
  } finally {
    w.coder = prev;
  }
}

describe("PR Code tab Tree view (#1772)", () => {
  const files: FileChange[] = [
    { path: "src/components/thread/a.tsx", status: "M", additions: 2, deletions: 1 },
    { path: "src/components/thread/b.tsx", status: "M", additions: 3, deletions: 0 },
    { path: "README.md", status: "M", additions: 1, deletions: 1 },
  ];

  it("List is the default flat list; Tree groups under a compressed directory and collapses it", async () => {
    await withFakePrDiff(files, async () => {
      const m = await mount(<PrCodeTab projectPath="/tmp/ledger" prNumber={11} />);
      await m.flush();

      assert.equal(
        m.query("[data-tree-toggle='list']")?.getAttribute("aria-pressed"),
        "true",
      );
      assert.equal(m.query("[data-dir-row]"), null);
      assert.deepEqual(
        m.queryAll("[data-pr-code-file]").map((el) => el.getAttribute("data-pr-code-file")),
        ["src/components/thread/a.tsx", "src/components/thread/b.tsx", "README.md"],
      );

      await m.click(m.query("[data-tree-toggle='tree']"));
      await m.flush();
      const dir = m.query("[data-dir-row='src/components/thread']");
      assert.ok(dir, "single-child chain compresses into one directory row");
      assert.equal(
        dir!.querySelector(".fileStats")?.textContent,
        "2+5−1",
      );

      await m.click(dir!);
      await m.flush();
      assert.equal(dir!.getAttribute("aria-expanded"), "false");
      assert.deepEqual(
        m.queryAll("[data-pr-code-file]").map((el) => el.getAttribute("data-pr-code-file")),
        ["README.md"],
      );
      m.unmount();
    });
  });
});

describe("PR Code tab copy path (#1772)", () => {
  const files: FileChange[] = [
    { path: "src/app.ts", status: "M", additions: 1, deletions: 0 },
  ];

  it("copies the file's repo-relative path", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
      configurable: true,
    });
    await withFakePrDiff(files, async () => {
      const m = await mount(<PrCodeTab projectPath="/tmp/ledger" prNumber={11} />);
      await m.flush();
      const btn = m.query(
        "[data-file-copy-path='src/app.ts']",
      ) as HTMLButtonElement | null;
      assert.ok(btn, "copy path button");
      await m.click(btn);
      assert.deepEqual(copied, ["src/app.ts"]);
      assert.equal(btn!.textContent, "✓");
      m.unmount();
    });
  });
});
