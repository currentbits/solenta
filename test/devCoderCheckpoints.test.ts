/**
 * Dev-mode twins for round 50 checkpoints.
 * Run: node --experimental-strip-types --test test/devCoderCheckpoints.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("devCoder checkpoints", () => {
  it("list empty without worktree; appends on successful run with worktree", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Ck",
    });
    assert.deepEqual(await api.git.listCheckpoints({ threadId: t.id }), []);

    await api.git.setupWorktree({ threadId: t.id });
    const withWt = await api.threads.get(t.id);
    assert.ok(withWt.thread.worktreePath);

    await api.runs.start({ threadId: t.id, prompt: "edit something" });
    // Wait for the fake run to complete (TICK_MS * a few steps).
    for (let i = 0; i < 40; i++) {
      const d = await api.threads.get(t.id);
      if (d.thread.status === "done") break;
      await sleep(200);
    }
    const detail = await api.threads.get(t.id);
    assert.equal(detail.thread.status, "done");

    const list = await api.git.listCheckpoints({ threadId: t.id });
    assert.ok(list.length >= 1);
    assert.equal(list[0]!.turn, 1);
    assert.equal(list[0]!.message, "coder-checkpoint: turn 1");
    assert.ok(list[0]!.sha);
  });

  it("restore guards use production error strings in order", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () => api.git.restoreCheckpoint({ threadId: "nope", sha: "abc" }),
      (err: Error) => {
        assert.equal(err.message, "Unknown thread: nope");
        return true;
      },
    );

    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Guards",
    });

    await assert.rejects(
      () => api.git.restoreCheckpoint({ threadId: t.id, sha: "abc" }),
      (err: Error) => {
        assert.equal(
          err.message,
          `Thread ${t.id} has no worktree; call setupWorktree first`,
        );
        return true;
      },
    );

    await api.git.setupWorktree({ threadId: t.id });
    await assert.rejects(
      () =>
        api.git.restoreCheckpoint({
          threadId: t.id,
          sha: "not-a-real-checkpoint",
        }),
      (err: Error) => {
        assert.equal(
          err.message,
          "Unknown checkpoint: not-a-real-checkpoint",
        );
        return true;
      },
    );
  });

  it("restore while running is rejected with production string", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Busy",
    });
    await api.git.setupWorktree({ threadId: t.id });
    // Start a long-ish run so status is working.
    await api.runs.start({ threadId: t.id, prompt: "hold" });
    const mid = await api.threads.get(t.id);
    if (mid.thread.status === "working") {
      await assert.rejects(
        () =>
          api.git.restoreCheckpoint({ threadId: t.id, sha: "whatever" }),
        /Cannot restore a checkpoint while a run is active/,
      );
    }
    // Stop to avoid timer leaks
    await api.runs.stop({ threadId: t.id });
  });
});
