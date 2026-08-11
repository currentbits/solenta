/**
 * Dev harness parity for round 43 lastVisitedAt (Worker A scope).
 * Run: CODER_GROK_MCP_DISABLE=1 node --experimental-strip-types --test test/devCoderLastVisited.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

describe("devCoder lastVisitedAt", () => {
  it("createThread stamps lastVisitedAt = createdAt", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Fresh",
    });
    assert.equal(t.lastVisitedAt, t.createdAt);
    assert.equal(t.lastVisitedAt, t.updatedAt);
  });

  it("threads.get stamps lastVisitedAt without bumping updatedAt", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Visit",
    });
    const beforeUpdated = t.updatedAt;
    // Wait so stamp can advance past create time.
    await new Promise((r) => setTimeout(r, 5));
    const beforeCall = Date.now();
    const detail = await api.threads.get(t.id);
    assert.ok(detail.thread.lastVisitedAt! >= beforeCall);
    assert.equal(
      detail.thread.updatedAt,
      beforeUpdated,
      "visiting must not bump updatedAt",
    );
  });

  it("seeds: most visited, thread-2 genuinely unread", async () => {
    const api = createDevCoder();
    const list = await api.threads.list();
    const unread = list.find((t) => t.id === "thread-2");
    assert.ok(unread, "seed thread-2 must exist");
    assert.ok(
      unread.lastVisitedAt != null && unread.updatedAt > unread.lastVisitedAt,
      "thread-2 is the unread demo seed",
    );
    const others = list.filter((t) => t.id !== "thread-2");
    assert.ok(others.length > 0);
    for (const t of others) {
      assert.ok(
        t.lastVisitedAt != null && t.lastVisitedAt >= t.updatedAt,
        `${t.id} should look visited in the seed`,
      );
    }
  });
});
