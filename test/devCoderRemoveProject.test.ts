/**
 * Dev harness projects.remove parity with electron/services.js removeProject.
 * Run: CODER_GROK_MCP_DISABLE=1 node --experimental-strip-types --test test/devCoderRemoveProject.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

const WORKTREE_MSG =
  "Thread still has a worktree. Merge or delete it in the Git tab first.";
const ACTIVE_RUN_MSG = "Cannot remove a project while a run is active";

describe("projects.remove (devCoder)", () => {
  it("removes project + threads + messages/workLog/usage; leaves other project intact", async () => {
    const api = createDevCoder();
    const projectA = await api.projects.add("/Users/demo/demo-org/remove-me");
    const projectB = await api.projects.add("/Users/demo/demo-org/keep-me");

    const t1 = await api.threads.create({
      projectId: projectA.id,
      title: "A-one",
    });
    const t2 = await api.threads.create({
      projectId: projectA.id,
      title: "A-two",
    });
    const tOther = await api.threads.create({
      projectId: projectB.id,
      title: "B-keep",
    });

    // Seed history via a run that finishes quickly enough for get().
    await api.runs.start({ threadId: t1.id, prompt: "seed a1" });
    await api.runs.stop({ threadId: t1.id });
    await api.runs.start({ threadId: t2.id, prompt: "seed a2" });
    await api.runs.stop({ threadId: t2.id });
    await api.runs.start({ threadId: tOther.id, prompt: "keep me" });
    await api.runs.stop({ threadId: tOther.id });

    const beforeOther = await api.threads.get(tOther.id);
    assert.ok(beforeOther.messages.length >= 1);

    await api.projects.remove({ projectId: projectA.id });

    const projects = await api.projects.list();
    assert.equal(
      projects.some((p) => p.id === projectA.id),
      false,
    );
    assert.ok(projects.some((p) => p.id === projectB.id));

    const threads = await api.threads.list();
    assert.equal(
      threads.some((t) => t.id === t1.id || t.id === t2.id),
      false,
    );
    assert.ok(threads.some((t) => t.id === tOther.id));

    await assert.rejects(
      () => api.threads.get(t1.id),
      /Thread not found/,
    );
    await assert.rejects(
      () => api.threads.get(t2.id),
      /Thread not found/,
    );

    const otherDetail = await api.threads.get(tOther.id);
    assert.ok(otherDetail.messages.length >= 1);
    assert.equal(otherDetail.thread.projectId, projectB.id);
  });

  it("rejects unknown projectId naming it", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () => api.projects.remove({ projectId: "no-such-project" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "Unknown project: no-such-project");
        return true;
      },
    );
  });

  it("rejects while a thread is working before any deletion", async () => {
    const api = createDevCoder();
    const projectA = await api.projects.add("/Users/demo/demo-org/work-a");
    const projectB = await api.projects.add("/Users/demo/demo-org/work-b");

    const tFirst = await api.threads.create({
      projectId: projectA.id,
      title: "idle-first",
    });
    const tSecond = await api.threads.create({
      projectId: projectA.id,
      title: "working-second",
    });

    // SECOND thread gets the active run — first must still exist after reject.
    await api.runs.start({ threadId: tSecond.id, prompt: "busy work" });
    const mid = await api.threads.get(tSecond.id);
    assert.equal(mid.thread.status, "working");

    await assert.rejects(
      () => api.projects.remove({ projectId: projectA.id }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, ACTIVE_RUN_MSG);
        return true;
      },
    );

    const projects = await api.projects.list();
    assert.ok(projects.some((p) => p.id === projectA.id));
    assert.ok(projects.some((p) => p.id === projectB.id));
    const threads = await api.threads.list();
    assert.ok(threads.some((t) => t.id === tFirst.id));
    assert.ok(threads.some((t) => t.id === tSecond.id));
    // First thread detail still reachable (not partially purged).
    const firstDetail = await api.threads.get(tFirst.id);
    assert.equal(firstDetail.thread.id, tFirst.id);

    await api.runs.stop({ threadId: tSecond.id });
  });

  it("rejects when any thread has a worktree with the production string", async () => {
    const api = createDevCoder();
    const project = await api.projects.add("/Users/demo/demo-org/wt-proj");
    const t1 = await api.threads.create({
      projectId: project.id,
      title: "clean",
    });
    const t2 = await api.threads.create({
      projectId: project.id,
      title: "has-wt",
    });
    await api.git.setupWorktree({ threadId: t2.id });
    const withWt = await api.threads.get(t2.id);
    assert.ok(withWt.thread.worktreePath);

    await assert.rejects(
      () => api.projects.remove({ projectId: project.id }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, WORKTREE_MSG);
        return true;
      },
    );

    const threads = await api.threads.list();
    assert.ok(threads.some((t) => t.id === t1.id));
    assert.ok(threads.some((t) => t.id === t2.id));
    assert.ok((await api.projects.list()).some((p) => p.id === project.id));
  });
});
