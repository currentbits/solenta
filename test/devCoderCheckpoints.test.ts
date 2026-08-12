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

async function waitDone(api: ReturnType<typeof createDevCoder>, threadId: string) {
  for (let i = 0; i < 50; i++) {
    const d = await api.threads.get(threadId);
    if (d.thread.status === "done" || d.thread.status === "failed") {
      return d;
    }
    await sleep(200);
  }
  throw new Error("run did not finish");
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
    const detail = await waitDone(api, t.id);
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
    // Start a long-ish run so status is working. Assertion is unconditional
    // (ISSUES.md bans if (status === "working") wrappers).
    await api.runs.start({ threadId: t.id, prompt: "hold" });
    const mid = await api.threads.get(t.id);
    assert.equal(
      mid.thread.status,
      "working",
      "run must still be active for the restore guard probe",
    );
    await assert.rejects(
      () => api.git.restoreCheckpoint({ threadId: t.id, sha: "whatever" }),
      (err: Error) => {
        assert.equal(
          err.message,
          "Cannot restore a checkpoint while a run is active",
        );
        return true;
      },
    );
    await api.runs.stop({ threadId: t.id });
  });

  it("A-B2: restore truncates list; next run reuses freed turn numbers", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Truncate",
    });
    await api.git.setupWorktree({ threadId: t.id });

    await api.runs.start({ threadId: t.id, prompt: "turn 1" });
    await waitDone(api, t.id);
    await api.runs.start({ threadId: t.id, prompt: "turn 2" });
    await waitDone(api, t.id);

    let list = await api.git.listCheckpoints({ threadId: t.id });
    assert.deepEqual(
      list.map((c) => c.turn),
      [2, 1],
      "two successful runs → turns 2 then 1 newest-first",
    );
    const turn1 = list.find((c) => c.turn === 1)!;
    const turn2Sha = list.find((c) => c.turn === 2)!.sha;

    await api.git.restoreCheckpoint({ threadId: t.id, sha: turn1.sha });
    list = await api.git.listCheckpoints({ threadId: t.id });
    assert.deepEqual(
      list.map((c) => c.turn),
      [1],
      "restore to turn 1 truncates newer entries (not [2,1])",
    );

    await api.runs.start({ threadId: t.id, prompt: "turn 2 again" });
    await waitDone(api, t.id);
    list = await api.git.listCheckpoints({ threadId: t.id });
    assert.deepEqual(
      list.map((c) => c.turn),
      [2, 1],
      "next run reuses turn 2, not 3",
    );
    assert.notEqual(
      list[0]!.sha,
      turn2Sha,
      "fresh sha after restore, not the discarded turn-2 object",
    );
  });
});
