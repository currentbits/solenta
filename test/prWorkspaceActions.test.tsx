/**
 * PR workspace panel: update branch, edit-your-own-comment, and reactions
 * (issue #1795 features 1/2/3).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { PrWorkspacePanel } from "../src/components/PrWorkspacePanel";
import type { PrDetail, PrDetailResult } from "../src/shared/ipc";

const basePr = {
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

const noop = {
  prDetail: async () => ok(basePr),
  prEdit: async () => ok(basePr),
  prComment: async () => ({ ok: true as const, url: basePr.url }),
  prClose: async () => ok(basePr),
  prReady: async () => ok(basePr),
  prMergeAt: async () => ok(basePr),
};

describe("PrWorkspacePanel update branch (#1795 feature 1)", () => {
  it("shows Update branch only when mergeStateStatus is BEHIND", async () => {
    const behind = { ...basePr, mergeStateStatus: "BEHIND" as const };
    const calls: unknown[] = [];
    const m = await mount(
      <PrWorkspacePanel
        projectPath="/tmp/ledger"
        prNumber={11}
        matchedThread={null}
        {...noop}
        prDetail={async () => ok(behind)}
        prUpdateBranch={async (input) => {
          calls.push(input);
          return ok({ ...behind, mergeStateStatus: "CLEAN" });
        }}
        onSelectThread={() => {}}
        onClose={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.query("[data-pr-update-branch]"), "button shows when BEHIND");
    await m.click(m.query("[data-pr-update-branch]"));
    await m.flush();
    assert.deepEqual(calls, [{ projectPath: "/tmp/ledger", prNumber: 11 }]);
    m.unmount();
  });

  it("hides the button when clean, or when the caller omits prUpdateBranch", async () => {
    const clean = { ...basePr, mergeStateStatus: "CLEAN" as const };
    const m1 = await mount(
      <PrWorkspacePanel
        projectPath="/tmp/ledger"
        prNumber={11}
        matchedThread={null}
        {...noop}
        prDetail={async () => ok(clean)}
        prUpdateBranch={async () => ok(clean)}
        onSelectThread={() => {}}
        onClose={() => {}}
      />,
    );
    await m1.flush();
    assert.equal(m1.query("[data-pr-update-branch]"), null, "clean PR hides the button");
    m1.unmount();

    const behind = { ...basePr, mergeStateStatus: "BEHIND" as const };
    const m2 = await mount(
      <PrWorkspacePanel
        projectPath="/tmp/ledger"
        prNumber={11}
        matchedThread={null}
        {...noop}
        prDetail={async () => ok(behind)}
        onSelectThread={() => {}}
        onClose={() => {}}
      />,
    );
    await m2.flush();
    assert.equal(m2.query("[data-pr-update-branch]"), null, "no prop means no button");
    m2.unmount();
  });
});

describe("PrWorkspacePanel comment edit (#1795 feature 2)", () => {
  it("shows Edit only on the viewer's own comment, and saves the body", async () => {
    const withComments = {
      ...basePr,
      comments: [
        { id: 1, type: "issue" as const, author: "octocat", body: "mine", createdAt: "2026-10-01T00:00:00Z", mine: true },
        { id: 2, type: "issue" as const, author: "someone-else", body: "theirs", createdAt: "2026-10-01T00:00:00Z", mine: false },
      ],
    };
    const edits: unknown[] = [];
    const m = await mount(
      <PrWorkspacePanel
        projectPath="/tmp/ledger"
        prNumber={11}
        matchedThread={null}
        {...noop}
        prDetail={async () => ok(withComments)}
        prCommentEdit={async (input) => {
          edits.push(input);
          return ok({
            ...withComments,
            comments: withComments.comments.map((c) =>
              c.id === input.commentId ? { ...c, body: input.body } : c,
            ),
          });
        }}
        onSelectThread={() => {}}
        onClose={() => {}}
      />,
    );
    await m.flush();
    const editButtons = m.queryAll("[data-pr-comment-edit]");
    assert.equal(editButtons.length, 1, "only the viewer's own comment offers Edit");

    await m.click(editButtons[0]);
    const textarea = m.query("[data-pr-comment-edit-body]") as HTMLTextAreaElement;
    assert.equal(textarea.value, "mine");
    await m.type(textarea, "mine, edited");
    await m.click(m.query("[data-pr-comment-edit-save]"));
    await m.flush();
    assert.deepEqual(edits, [
      { projectPath: "/tmp/ledger", prNumber: 11, commentId: 1, type: "issue", body: "mine, edited" },
    ]);
    assert.equal(m.query("[data-pr-comment-edit-form]"), null, "editor closes after save");
    m.unmount();
  });
});

describe("PrWorkspacePanel reactions (#1795 feature 3)", () => {
  it("toggles a reaction optimistically and rolls back on failure", async () => {
    const withComment = {
      ...basePr,
      comments: [
        {
          id: 1,
          type: "issue" as const,
          author: "octocat",
          body: "hi",
          createdAt: "2026-10-01T00:00:00Z",
          reactions: [{ content: "THUMBS_UP" as const, count: 1, viewerHasReacted: false }],
        },
      ],
    };
    let shouldFail = false;
    const m = await mount(
      <PrWorkspacePanel
        projectPath="/tmp/ledger"
        prNumber={11}
        matchedThread={null}
        {...noop}
        prDetail={async () => ok(withComment)}
        prReaction={async (input) => {
          if (shouldFail) return { ok: false, reason: "boom" };
          return input.remove ? { ok: true } : { ok: true, reactionId: 42 };
        }}
        onSelectThread={() => {}}
        onClose={() => {}}
      />,
    );
    await m.flush();
    const chip = m.query('[data-pr-reaction="THUMBS_UP"]');
    assert.ok(chip);
    assert.equal(chip?.textContent?.includes("1"), true);

    // Add: open the picker and click the same emoji -> count goes 1 -> 2.
    await m.click(m.query("[data-pr-reaction-add]"));
    await m.click(m.query('[data-pr-reaction-option="+1"]'));
    await m.flush();
    assert.equal(m.query('[data-pr-reaction="THUMBS_UP"]')?.textContent?.includes("2"), true);

    // Remove: click the now-pressed chip -> back to 1, optimistic rollback on failure.
    shouldFail = true;
    await m.click(m.query('[data-pr-reaction="THUMBS_UP"]'));
    await m.flush();
    assert.equal(
      m.query('[data-pr-reaction="THUMBS_UP"]')?.textContent?.includes("2"),
      true,
      "failed remove rolls back to the prior count",
    );
    assert.ok(m.query("[data-pr-workspace-error]"));
    m.unmount();
  });
});


describe("PrWorkspacePanel comment context", () => {
  it("retries partial comment loading and keeps review-summary ids separate from editable comments", async () => {
    let loads = 0;
    const pr: PrDetail = {
      ...basePr,
      commentsError: "Some PR comments couldn't be loaded.",
      comments: [
        { id: 1, type: "issue", author: "me", body: "ordinary", createdAt: "", mine: true },
        { id: 1, type: "review-summary", author: "reviewer", body: "summary", createdAt: "" },
      ],
    };
    const m = await mount(
      <PrWorkspacePanel
        projectPath="/tmp/ledger"
        prNumber={11}
        matchedThread={null}
        {...noop}
        prDetail={async () => {
          loads++;
          return ok(loads > 1 ? { ...pr, commentsError: undefined } : pr);
        }}
        prCommentEdit={async () => ok(pr)}
        onSelectThread={() => {}}
        onClose={() => {}}
      />,
    );
    await m.click(m.query("[data-pr-comment-edit]"));
    assert.equal(m.queryAll("[data-pr-comment-edit-form]").length, 1);
    assert.match(m.queryAll("[data-pr-comment-item]")[1].textContent || "", /summary/);
    await m.click(m.byText("Retry comments"));
    await m.flush();
    assert.equal(loads, 2);
    assert.equal(m.byText("Retry comments"), null);
    m.unmount();
  });

  it("preserves edits and available comments across partial or failed retries", async () => {
    let loads = 0;
    const pr: PrDetail = {
      ...basePr,
      commentsError: "Some PR comments couldn't be loaded.",
      comments: [{ id: 1, type: "review", author: "reviewer", body: "available inline", createdAt: "" }],
    };
    const m = await mount(
      <PrWorkspacePanel
        projectPath="/tmp/ledger"
        prNumber={11}
        matchedThread={null}
        {...noop}
        prDetail={async () => {
          loads++;
          if (loads === 3) throw new Error("Offline");
          return ok(loads === 1 ? pr : {
            ...pr,
            comments: [{ id: 2, type: "issue", author: "reviewer", body: "new ordinary", createdAt: "" }],
          });
        }}
        onSelectThread={() => {}}
        onClose={() => {}}
      />,
    );
    await m.type(m.query("[data-pr-edit-title]"), "Unsaved title");
    await m.type(m.query("[data-pr-edit-body]"), "Unsaved description");
    for (let retry = 0; retry < 2; retry++) {
      await m.click(m.byText("Retry comments"));
      await m.flush();
      assert.equal(m.queryAll("[data-pr-comment-item]").length, 2);
      assert.equal((m.query("[data-pr-edit-title]") as HTMLInputElement).value, "Unsaved title");
      assert.equal((m.query("[data-pr-edit-body]") as HTMLTextAreaElement).value, "Unsaved description");
    }
    assert.match(m.query("[data-pr-workspace-error]").textContent || "", /Offline/);
    m.unmount();
  });
});
