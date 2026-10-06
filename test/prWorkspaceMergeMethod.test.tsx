/**
 * PR list workspace: merge method picker in the merge confirm bar (#1493 D).
 * Run: npm run test:renderer
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

describe("PrWorkspacePanel merge method", () => {
  it("merges with the repo default, or the method the user picks", async () => {
    const shell = await mount(<div />);
    const w = window as unknown as { coder?: unknown };
    const prev = w.coder;
    const asked: unknown[] = [];
    w.coder = {
      git: {
        mergeOptions: async (input: unknown) => {
          asked.push(input);
          return { ok: true, methods: ["squash", "rebase"], defaultMethod: "rebase" };
        },
      },
    };
    shell.unmount();
    const merges: Array<{ method?: string }> = [];
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
          prMergeAt={async (input) => {
            merges.push({ method: input.method });
            return ok({ ...pr, state: "MERGED" });
          }}
          onSelectThread={() => {}}
          onClose={() => {}}
        />,
      );
      await m.flush();
      assert.deepEqual(asked, [{ projectPath: "/tmp/ledger" }]);
      await m.click(m.query("[data-pr-merge]"));
      const picker = m.query("[data-merge-method]") as HTMLSelectElement;
      assert.equal(picker.value, "rebase");
      assert.match(m.query("[data-pr-confirm-yes]")?.textContent || "", /Rebase merge/);
      await m.change(picker, "squash");
      await m.click(m.query("[data-pr-confirm-yes]"));
      await m.flush();
      assert.deepEqual(merges, [{ method: "squash" }]);
      m.unmount();
    } finally {
      w.coder = prev;
    }
  });
});
