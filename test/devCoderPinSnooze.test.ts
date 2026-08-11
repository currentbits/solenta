/**
 * Dev harness parity for round 44 pin + snooze (Worker A scope).
 * Run: CODER_GROK_MCP_DISABLE=1 node --experimental-strip-types --test test/devCoderPinSnooze.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

describe("devCoder pin + snooze", () => {
  it("createThread defaults pin/snooze fields to null", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Fresh",
    });
    assert.equal(t.pinnedAt, null);
    assert.equal(t.snoozedUntil, null);
    assert.equal(t.snoozedAt, null);
  });

  it("setPinned sets/clears and mutual-excludes settle; never bumps updatedAt", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Pin me",
    });
    const fixed = t.updatedAt;

    await api.threads.setSettled({ threadId: t.id, override: "settled" });
    const pinned = await api.threads.setPinned({
      threadId: t.id,
      pinned: true,
    });
    assert.ok(typeof pinned.pinnedAt === "number" && pinned.pinnedAt > 0);
    assert.equal(pinned.settledOverride, null);
    assert.equal(pinned.settledAt, null);
    assert.equal(pinned.updatedAt, fixed);

    const settled = await api.threads.setSettled({
      threadId: t.id,
      override: "settled",
    });
    assert.equal(settled.settledOverride, "settled");
    assert.equal(settled.pinnedAt, null);
    assert.equal(settled.updatedAt, fixed);

    const unpinned = await api.threads.setPinned({
      threadId: t.id,
      pinned: false,
    });
    assert.equal(unpinned.pinnedAt, null);
  });

  it("setSnoozed future ok; past rejects with named value; null clears both", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Snooze me",
    });
    const fixed = t.updatedAt;
    const past = Date.now() - 1000;
    await assert.rejects(
      () => api.threads.setSnoozed({ threadId: t.id, until: past }),
      (err: Error) => {
        assert.match(err.message, /Snooze time .* is not in the future/);
        assert.ok(err.message.includes(String(past)));
        return true;
      },
    );

    const future = Date.now() + 3_600_000;
    const snoozed = await api.threads.setSnoozed({
      threadId: t.id,
      until: future,
    });
    assert.equal(snoozed.snoozedUntil, future);
    assert.ok(typeof snoozed.snoozedAt === "number");
    assert.equal(snoozed.updatedAt, fixed);

    const cleared = await api.threads.setSnoozed({
      threadId: t.id,
      until: null,
    });
    assert.equal(cleared.snoozedUntil, null);
    assert.equal(cleared.snoozedAt, null);
  });

  it("startRun preserves pin and snooze (dev backend)", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Sticky",
    });
    const until = Date.now() + 86_400_000;
    const pinned = await api.threads.setPinned({
      threadId: t.id,
      pinned: true,
    });
    const snoozed = await api.threads.setSnoozed({
      threadId: t.id,
      until,
    });
    await api.runs.start({ threadId: t.id, prompt: "keep pin and snooze" });
    const detail = await api.threads.get(t.id);
    assert.equal(detail.thread.status, "working");
    assert.equal(detail.thread.pinnedAt, pinned.pinnedAt);
    assert.equal(detail.thread.snoozedUntil, until);
    assert.equal(detail.thread.snoozedAt, snoozed.snoozedAt);
    await api.runs.stop({ threadId: t.id });
  });

  it("seeds: one pinned (thread-4) and one snoozed (thread-5)", async () => {
    const api = createDevCoder();
    const list = await api.threads.list();
    const pin = list.find((x) => x.id === "thread-4");
    const snooze = list.find((x) => x.id === "thread-5");
    assert.ok(pin && pin.pinnedAt != null, "thread-4 is the pin demo seed");
    assert.ok(
      snooze &&
        snooze.snoozedUntil != null &&
        snooze.snoozedUntil > Date.now() &&
        snooze.snoozedAt != null,
      "thread-5 is the snooze demo seed (~tomorrow)",
    );
  });
});
