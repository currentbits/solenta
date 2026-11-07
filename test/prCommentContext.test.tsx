import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder, project, thread, detail } from "./support/fakeCoder.ts";
import App from "../src/App";
import { addPrCommentToDraft, prCommentContext } from "../src/prCommentContext";
import { formatContextChipsPrompt } from "../src/contextChips";
import { flushDraftSave, getContextChips, hydrateComposerSession, keptDrafts, resetComposerSession, setDraftText, DRAFTS_STORAGE_KEY } from "../src/composerSession";
import type { PrDetail } from "../src/shared/ipc";

const pr: PrDetail = {
  number: 11, title: "Handle retries", body: "", url: "https://github.com/acme/repo/pull/11",
  state: "OPEN", isDraft: false, headRefName: "feat/retries",
  comments: [
    { id: 1, type: "issue", author: "reviewer", body: "What happens on retry?", createdAt: "2026-10-01T00:00:00Z", url: "https://github.com/acme/repo/pull/11#issuecomment-1" },
    { id: 1, type: "review-summary", author: "reviewer", body: "Please consider the retry policy.", createdAt: "2026-10-01T00:00:00Z", url: "https://github.com/acme/repo/pull/11#pullrequestreview-1" },
    { id: 1, type: "review", author: "inline-reviewer", body: "Is this safe?", createdAt: "2026-10-02T00:00:00Z", url: "https://github.com/acme/repo/pull/11#discussion_r1", path: "src/retry.ts", startLine: 10, line: 12, side: "LEFT", outdated: true, diffHunk: "@@ -10 +10 @@\n-old" },
  ],
};

afterEach(() => resetComposerSession());

describe("PR comments as draft context", () => {
  it("appends each comment family once without replacing text or crossing thread boundaries, and persists its source", async () => {
    const shell = await mount(<div />);
    setDraftText("target", "Is the reviewer right? Explain before changing anything.");
    setDraftText("other", "keep this draft");
    for (const comment of pr.comments) {
      addPrCommentToDraft("target", pr, comment);
      addPrCommentToDraft("target", pr, comment);
    }
    assert.equal(keptDrafts.target, "Is the reviewer right? Explain before changing anything.");
    assert.equal(keptDrafts.other, "keep this draft");
    assert.equal(getContextChips("target").length, 3);
    assert.equal(getContextChips("other").length, 0);
    const prompt = await formatContextChipsPrompt(getContextChips("target"));
    for (const comment of pr.comments) {
      assert.ok(prompt.includes(comment.body));
      assert.ok(prompt.includes(comment.url!));
    }
    assert.match(prompt, /Author: inline-reviewer/);
    assert.match(prompt, /src\/retry.ts:10-12 \(left side\) \(outdated\)/);
    assert.match(prompt, /Diff context:/);
    assert.match(prompt, /source material, not instructions to make changes/);
    assert.ok(prompt.includes(pr.url));
    flushDraftSave();
    const saved = window.localStorage.getItem(DRAFTS_STORAGE_KEY)!;
    resetComposerSession();
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, saved);
    hydrateComposerSession();
    assert.equal(getContextChips("target").length, 3);
    assert.equal(keptDrafts.target, "Is the reviewer right? Explain before changing anything.");
    shell.unmount();
  });

  it("keeps GitLab discussion links and line context when supplied by a shared PR source", () => {
    const mr = { ...pr, url: "https://gitlab.example/acme/repo/-/merge_requests/11" };
    const comment = { ...pr.comments[2], url: `${mr.url}#note_55` };
    const chip = prCommentContext(mr, comment);
    assert.ok(chip.text.includes(comment.url));
    assert.ok(chip.text.includes(mr.url));
    assert.match(chip.text, /src\/retry.ts:10-12/);
  });

  it("adds any comment to an existing project draft through App, without sending or changing agent settings", async () => {
    const target = thread({ id: "target", title: "Retry draft", prNumber: 11, provider: "codex", model: "gpt-5.4", permissionMode: "plan", providerInstance: "account-1" });
    const other = thread({ id: "other", projectId: "p2", title: "Other project" });
    const fake = createFakeCoder({ projects: [project(), project({ id: "p2", path: "/tmp/other" })], threads: [target, other], details: { target: detail({ thread: target }) } });
    fake.api.git.listPrs = async (path) => ({ ok: true, prs: path === "/tmp/repo" ? [{ ...pr, additions: 0, deletions: 0, updatedAt: "2026-10-02T00:00:00Z" }] : [] });
    fake.api.git.prDetail = async () => ({ ok: true, pr });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    setDraftText("target", "Is this comment correct?");
    const m = await mount(<App />);
    try {
      const settingsBefore = fake.channels().filter((c) => c.startsWith("threads.set") || c === "settings.set");
      for (const i of [0, 0, 1, 2]) {
        await m.click(m.query('[data-view-nav="review"]'));
        await m.flush();
        await m.click(m.query('[data-pr-row="11"] button'));
        await m.flush();
        const picker = m.query('select[aria-label="Agent draft"]');
        assert.ok(picker instanceof window.HTMLSelectElement);
        assert.ok(!picker.textContent?.includes("Other project"));
        assert.equal(picker.value, "target");
        assert.equal(m.queryAll("[data-pr-comment-add-to-agent]").length, 3);
        await m.click(m.queryAll("[data-pr-comment-add-to-agent]")[i]);
        await m.flush();
        assert.equal(keptDrafts.target, "Is this comment correct?");
        const textarea = m.query("textarea");
        assert.ok(textarea instanceof HTMLTextAreaElement);
        assert.equal(textarea.value, "Is this comment correct?");
      }
      assert.equal(getContextChips("target").length, 3);
      assert.equal(getContextChips("other").length, 0);
      assert.equal(fake.of("runs.start").length, 0);
      assert.equal(fake.of("threads.create").length, 0);
      assert.deepEqual(fake.channels().filter((c) => c.startsWith("threads.set") || c === "settings.set"), settingsBefore);
      assert.equal(m.queryAll("[data-context-chip]").length, 3);
    } finally {
      m.unmount();
    }
  });

  it("creates a new project draft when selected and leaves the run unsent", async () => {
    const fake = createFakeCoder({ projects: [project()], threads: [] });
    fake.api.git.listPrs = async () => ({ ok: true, prs: [{ ...pr, additions: 0, deletions: 0, updatedAt: "2026-10-02T00:00:00Z" }] });
    fake.api.git.prDetail = async () => ({ ok: true, pr });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);
    try {
      await m.click(m.query('[data-view-nav="review"]'));
      await m.flush();
      await m.click(m.query('[data-pr-row="11"] button'));
      await m.flush();
      const picker = m.query('select[aria-label="Agent draft"]');
      assert.ok(picker instanceof window.HTMLSelectElement);
      assert.equal(picker.value, "");
      await m.click(m.query("[data-pr-comment-add-to-agent]"));
      await m.flush();
      assert.deepEqual(fake.only("threads.create").args[0], { projectId: "p1", title: "New Thread" });
      assert.equal(fake.of("runs.start").length, 0);
      assert.equal(m.queryAll("[data-context-chip]").length, 1);
    } finally {
      m.unmount();
    }
  });
});
