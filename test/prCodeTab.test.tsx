/**
 * PR workspace Code tab: commit picker + viewed mark (#1527).
 * Run: npm run test:renderer -- test/prCodeTab.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { PrWorkspacePanel } from "../src/components/PrWorkspacePanel";
import { PrCodeTab } from "../src/components/PrCodeTab";
import { ChangesPanel } from "../src/components/thread/ChangesPanel";
import { setDiffHideTests } from "../src/uiPrefs";
import type { DiffResult, FileChange, PrDetail, PrDetailResult } from "../src/shared/ipc";

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
