/**
 * Dev harness threads.setSettled + clear-on-run-start parity with electron.
 * Run: node --experimental-strip-types --test test/devCoderSettle.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

async function idleThread() {
  const api = createDevCoder();
  const projects = await api.projects.list();
  const t = await api.threads.create({
    projectId: projects[0]!.id,
    title: "Settle harness",
  });
  assert.equal(t.settledOverride, null);
  assert.equal(t.settledAt, null);
  assert.equal(t.prState, null);
  return { api, threadId: t.id };
}

describe("threads.setSettled (devCoder)", () => {
  it("accepts settled/active/null without bumping updatedAt", async () => {
    const { api, threadId } = await idleThread();
    const before = await api.threads.get(threadId);
    const frozenAt = before.thread.updatedAt;

    const settled = await api.threads.setSettled({
      threadId,
      override: "settled",
    });
    assert.equal(settled.settledOverride, "settled");
    assert.ok(typeof settled.settledAt === "number");
    assert.equal(settled.updatedAt, frozenAt);

    const active = await api.threads.setSettled({
      threadId,
      override: "active",
    });
    assert.equal(active.settledOverride, "active");
    assert.equal(active.updatedAt, frozenAt);

    const cleared = await api.threads.setSettled({
      threadId,
      override: null,
    });
    assert.equal(cleared.settledOverride, null);
    assert.equal(cleared.settledAt, null);
    assert.equal(cleared.updatedAt, frozenAt);
  });

  it("rejects settling a working thread with the production error string", async () => {
    const { api, threadId } = await idleThread();
    await api.runs.start({ threadId, prompt: "busy" });
    await assert.rejects(
      () => api.threads.setSettled({ threadId, override: "settled" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "Cannot settle a thread while a run is active",
        );
        return true;
      },
    );
  });

  it("startRun clears a settled pin and preserves an active pin", async () => {
    const { api, threadId } = await idleThread();
    await api.threads.setSettled({ threadId, override: "settled" });
    await api.runs.start({ threadId, prompt: "wake from settled" });
    let detail = await api.threads.get(threadId);
    assert.equal(detail.thread.status, "working");
    assert.equal(detail.thread.settledOverride, null);
    assert.equal(detail.thread.settledAt, null);

    await api.runs.stop({ threadId });
    // stop leaves status non-working so we can pin active and start again.
    detail = await api.threads.get(threadId);
    await api.threads.setSettled({ threadId, override: "active" });
    const pinnedAt = (await api.threads.get(threadId)).thread.settledAt;
    await api.runs.start({ threadId, prompt: "keep active" });
    detail = await api.threads.get(threadId);
    assert.equal(detail.thread.settledOverride, "active");
    assert.equal(detail.thread.settledAt, pinnedAt);
  });

  it("createPr stamps prState on the thread", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    let t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "PR state",
    });
    t = await api.git.setupWorktree({ threadId: t.id });
    const pr = await api.git.createPr({
      threadId: t.id,
      title: "Ship",
    });
    assert.equal(pr.state, "OPEN");
    const detail = await api.threads.get(t.id);
    assert.equal(detail.thread.prState, "OPEN");
    assert.equal(detail.thread.prNumber, pr.number);
  });
});
