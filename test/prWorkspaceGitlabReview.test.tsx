import assert from "node:assert/strict";
import { it } from "node:test";
import * as React from "react";
import { act } from "react";
import { mount } from "./support/dom.ts";
import { PrWorkspacePanel, type PrWorkspacePanelProps } from "../src/components/PrWorkspacePanel";
import type { GitlabReview, PrDetail, PrDetailResult, PrRequestChangesResult, ThreadInfo } from "../src/shared/ipc";

const review: GitlabReview = {
  reviewers: [{ id: "42", login: "alice", state: "unreviewed" }],
  viewerId: "gid://gitlab/User/42", canRequestChanges: true,
};
const pr: PrDetail = {
  forge: "gitlab", number: 7, title: "Merge request", body: "Original description",
  url: "https://gitlab.example/team/private/-/merge_requests/7",
  state: "OPEN", isDraft: false, headRefName: "feature", comments: [], gitlabReview: review,
};
const requested: GitlabReview = {
  ...review, reviewers: [{ id: "42", login: "alice", state: "requested_changes" }],
  canRequestChanges: false, reason: "You have already requested changes",
};
const ok = (value: PrDetail): PrDetailResult => ({ ok: true, pr: value });
const props: PrWorkspacePanelProps = {
  projectPath: "/repo", prNumber: 7, matchedThread: null,
  prDetail: async () => ok(pr), prEdit: async () => ok(pr),
  prComment: async () => ({ ok: true }), prClose: async () => ok(pr),
  prReady: async () => ok(pr), prMergeAt: async () => ok(pr),
  onSelectThread() {}, onClose() {},
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("shows reviewer verdicts and submits the viewer identity without discarding description edits", async () => {
  const calls: unknown[] = [];
  const pending = deferred<PrRequestChangesResult>();
  const m = await mount(<PrWorkspacePanel {...props} prRequestChanges={(input) => { calls.push(input); return pending.promise; }} />);
  await m.flush();
  assert.match(m.text(), /@alice: Awaiting review/);
  const description = m.query("[data-pr-body]") || m.query("textarea");
  await m.type(description, "Unsaved description");
  await m.click(m.query("[data-pr-request-changes]"));
  assert.equal((m.query("[data-pr-request-changes]") as HTMLButtonElement).disabled, true);
  await m.click(m.query("[data-pr-request-changes]"));
  assert.deepEqual(calls, [{ projectPath: "/repo", prNumber: 7, viewerId: review.viewerId }]);
  await act(async () => pending.resolve({ ok: true, review: requested }));
  await m.flush();
  assert.match(m.text(), /@alice: Changes requested/);
  assert.equal((description as HTMLTextAreaElement).value, "Unsaved description");
  assert.equal((m.query("[data-pr-request-changes]") as HTMLButtonElement).disabled, true);
  m.unmount();
});

it("disables unavailable or denied GitLab submission with an honest reason, while GitHub stays unchanged", async () => {
  for (const reason of ["Request changes unavailable on this GitLab host: Unknown field", "This GitLab account must be assigned as a reviewer", "This GitLab account does not have permission to request changes"]) {
    const m = await mount(<PrWorkspacePanel {...props} prDetail={async () => ok({ ...pr, gitlabReview: { ...review, canRequestChanges: false, reason } })} prRequestChanges={async () => { throw new Error("should not submit"); }} />);
    await m.flush();
    assert.equal((m.query("[data-pr-request-changes]") as HTMLButtonElement).disabled, true);
    assert.ok(m.text().includes(reason));
    m.unmount();
  }
  const m = await mount(<PrWorkspacePanel {...props} prDetail={async () => ok({ ...pr, forge: "github", gitlabReview: undefined })} />);
  await m.flush();
  assert.equal(m.query("[data-pr-review]"), null);
  m.unmount();
});

it("keeps the review verdict unchanged on a failed or rejected submission", async () => {
  for (const rejects of [false, true]) {
    const m = await mount(<PrWorkspacePanel {...props} prRequestChanges={async () => {
      if (rejects) throw new Error("GitLab offline");
      return { ok: false, reason: "GitLab did not confirm your requested-changes verdict" };
    }} />);
    await m.flush();
    await m.click(m.query("[data-pr-request-changes]"));
    assert.match(m.text(), /@alice: Awaiting review/);
    assert.match(m.text(), rejects ? /GitLab offline/ : /GitLab did not confirm/);
    m.unmount();
  }
});

it("scopes a linked MR submission to its selected subgroup repo", async () => {
  const calls: unknown[] = [];
  const linked = { prLinks: [{ number: 7, url: pr.url }, { number: 8, repo: "other/subgroup/project", url: "https://gitlab.example/other/subgroup/project/-/merge_requests/8" }] } as ThreadInfo;
  const m = await mount(<PrWorkspacePanel {...props} matchedThread={linked}
    prDetail={async (input) => ok({ ...pr, number: input.prNumber })}
    prRequestChanges={async (input) => { calls.push(input); return { ok: true, review: requested }; }} />);
  await m.flush();
  await m.change(m.query("[data-pr-link]"), "other/subgroup/project#8");
  await m.flush();
  await m.click(m.query("[data-pr-request-changes]"));
  assert.deepEqual(calls, [{ projectPath: "/repo", prNumber: 8, repo: "other/subgroup/project", viewerId: review.viewerId }]);
  m.unmount();
});

it("ignores an old submission result after switching project or MR and disables the old capability during loading", async () => {
  for (const nextSelection of [{ projectPath: "/other-repo", prNumber: 7 }, { projectPath: "/repo", prNumber: 8 }]) {
    const pending = deferred<PrRequestChangesResult>();
    const detail = deferred<PrDetailResult>();
    const calls: unknown[] = [];
    const submit: NonNullable<PrWorkspacePanelProps["prRequestChanges"]> = (input) => { calls.push(input); return pending.promise; };
    const m = await mount(<PrWorkspacePanel {...props} prRequestChanges={submit} />);
    await m.flush();
    await m.click(m.query("[data-pr-request-changes]"));
    await m.rerender(<PrWorkspacePanel {...props} {...nextSelection} prDetail={async () => detail.promise} prRequestChanges={submit} />);
    assert.equal((m.query("[data-pr-request-changes]") as HTMLButtonElement).disabled, true);
    await m.click(m.query("[data-pr-request-changes]"));
    assert.equal(calls.length, 1);
    await act(async () => detail.resolve(ok({ ...pr, number: nextSelection.prNumber, gitlabReview: { ...review, reviewers: [{ id: "42", login: "alice", state: "reviewed" }] } })));
    await m.flush();
    await act(async () => pending.resolve({ ok: true, review: requested }));
    await m.flush();
    assert.match(m.text(), /@alice: Reviewed/);
    assert.doesNotMatch(m.text(), /@alice: Changes requested/);
    assert.equal((m.query("[data-pr-request-changes]") as HTMLButtonElement).disabled, false);
    m.unmount();
  }
});

it("ignores an old detail result after changing the selected project", async () => {
  const old = deferred<PrDetailResult>();
  const m = await mount(<PrWorkspacePanel {...props} prDetail={async () => old.promise} />);
  await m.rerender(<PrWorkspacePanel {...props} projectPath="/other-repo" prDetail={async () => ok({ ...pr, gitlabReview: requested })} />);
  await m.flush();
  await act(async () => old.resolve(ok(pr)));
  await m.flush();
  assert.match(m.text(), /@alice: Changes requested/);
  m.unmount();
});
