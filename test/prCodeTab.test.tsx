/**
 * PR workspace Code tab: commit picker + viewed mark (#1527).
 * Run: npm run test:renderer -- test/prCodeTab.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { PrWorkspacePanel } from "../src/components/PrWorkspacePanel";
import type { PrDetail, PrDetailResult } from "../src/shared/ipc";

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
