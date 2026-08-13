/**
 * Dev harness git.createPr / git.prStatus behaviour.
 * Run: node --experimental-strip-types --test test/devCoderPr.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

async function threadWithBranch(title = "PR harness thread") {
  const api = createDevCoder();
  const projects = await api.projects.list();
  let t = await api.threads.create({
    projectId: projects[0]!.id,
    title,
  });
  t = await api.git.setupWorktree({ threadId: t.id });
  assert.ok(t.branch, "setupWorktree must assign a branch");
  assert.equal(t.prNumber, null);
  assert.equal(t.prUrl, null);
  return { api, threadId: t.id, branch: t.branch!, project: projects[0]! };
}

describe("git.prStatus", () => {
  it("returns null when the thread has no PR", async () => {
    const { api, threadId } = await threadWithBranch();
    const status = await api.git.prStatus({ threadId });
    assert.equal(status, null);
  });

  it("rejects for an unknown thread rather than resolving", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () => api.git.prStatus({ threadId: "missing-thread" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Thread not found/);
        return true;
      },
    );
  });
});

describe("git.createPr", () => {
  it("creates a PR, stamps prNumber/prUrl on the thread, created:true", async () => {
    const { api, threadId, branch, project } = await threadWithBranch(
      "Ship the PR control",
    );
    const pr = await api.git.createPr({
      threadId,
      title: "Ship the PR control",
      body: "Renderer half",
      draft: true,
    });
    assert.equal(pr.created, true);
    assert.equal(pr.state, "OPEN");
    assert.equal(pr.branch, branch);
    assert.equal(typeof pr.number, "number");
    assert.ok(pr.number >= 900, "harness numbers start at 900");
    assert.equal(
      pr.url,
      `https://github.com/${project.slug}/pull/${pr.number}`,
    );

    const detail = await api.threads.get(threadId);
    assert.equal(detail.thread.prNumber, pr.number);
    assert.equal(detail.thread.prUrl, pr.url);

    const list = await api.threads.list();
    const row = list.find((t) => t.id === threadId);
    assert.ok(row);
    assert.equal(row!.prNumber, pr.number);
    assert.equal(row!.prUrl, pr.url);
  });

  it("returns the existing PR with created:false on a second call", async () => {
    const { api, threadId } = await threadWithBranch();
    const first = await api.git.createPr({
      threadId,
      title: "First open",
    });
    assert.equal(first.created, true);

    const second = await api.git.createPr({
      threadId,
      title: "Different title ignored",
      draft: true,
    });
    assert.equal(second.created, false);
    assert.equal(second.number, first.number);
    assert.equal(second.url, first.url);
    assert.equal(second.state, first.state);
  });

  it("prStatus reflects a created PR", async () => {
    const { api, threadId, branch } = await threadWithBranch();
    const created = await api.git.createPr({
      threadId,
      title: "Status check",
    });
    const status = await api.git.prStatus({ threadId });
    assert.ok(status);
    assert.equal(status!.created, false);
    assert.equal(status!.number, created.number);
    assert.equal(status!.url, created.url);
    assert.equal(status!.state, "OPEN");
    assert.equal(status!.branch, branch);
  });

  it("rejects when the thread has no branch", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "No branch yet",
    });
    assert.equal(t.branch, null);
    await assert.rejects(
      () => api.git.createPr({ threadId: t.id, title: "Nope" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /No branch/i);
        return true;
      },
    );
  });

  it("rejects an empty title rather than resolving", async () => {
    const { api, threadId } = await threadWithBranch();
    await assert.rejects(
      () => api.git.createPr({ threadId, title: "   " }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /title/i);
        return true;
      },
    );
  });

  it("rejects for an unknown thread rather than resolving", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () =>
        api.git.createPr({
          threadId: "does-not-exist",
          title: "Ghost",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Thread not found/);
        return true;
      },
    );
  });

  it("seeded threads with prNumber expose prUrl and prStatus", async () => {
    const api = createDevCoder();
    const list = await api.threads.list();
    const withPr = list.find((t) => t.prNumber != null);
    assert.ok(withPr, "mock seeds include threads with PR numbers");
    assert.ok(withPr!.prUrl, "seed must pair prUrl with prNumber");
    assert.match(withPr!.prUrl!, /\/pull\/\d+$/);
    assert.ok(
      withPr!.prUrl!.endsWith(`/pull/${withPr!.prNumber}`),
      "url must include the seeded number",
    );

    const status = await api.git.prStatus({ threadId: withPr!.id });
    assert.ok(status);
    assert.equal(status!.number, withPr!.prNumber);
    assert.equal(status!.url, withPr!.prUrl);
    assert.equal(status!.created, false);

    // Idempotent: createPr on a seeded PR re-returns it.
    const again = await api.git.createPr({
      threadId: withPr!.id,
      title: "already open",
    });
    assert.equal(again.created, false);
    assert.equal(again.number, withPr!.prNumber);
  });
});

describe("git.prChecks / git.prMerge", () => {
  it("returns in-band no PR when the thread has none", async () => {
    const { api, threadId } = await threadWithBranch();
    const result = await api.git.prChecks({ threadId });
    assert.deepEqual(result, { ok: false, reason: "no PR" });
  });

  it("squash-merges an OPEN PR and reports MERGED", async () => {
    const { api, threadId } = await threadWithBranch("Merge harness");
    await api.git.createPr({ threadId, title: "Merge harness" });
    const checks = await api.git.prChecks({ threadId });
    assert.equal(checks.ok, true);
    const merged = await api.git.prMerge({ threadId });
    assert.equal(merged.state, "MERGED");
    const status = await api.git.prStatus({ threadId });
    assert.equal(status?.state, "MERGED");
    await assert.rejects(
      () => api.git.prMerge({ threadId }),
      /not open/i,
    );
  });
});
