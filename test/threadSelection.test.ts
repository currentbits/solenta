/**
 * Next-thread selection after archive/delete.
 * Run: node --experimental-strip-types --test test/threadSelection.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextVisibleThreadId } from "../src/threadSelection.ts";
import type { ThreadInfo } from "../src/shared/ipc.ts";

function thread(
  partial: Partial<ThreadInfo> & Pick<ThreadInfo, "id" | "projectId">,
): ThreadInfo {
  return {
    title: partial.title ?? partial.id,
    branch: partial.branch ?? null,
    prNumber: partial.prNumber ?? null,
    prUrl: partial.prUrl ?? null,
    status: partial.status ?? "idle",
    createdAt: partial.createdAt ?? 1,
    updatedAt: partial.updatedAt ?? 1,
    runStartedAt: partial.runStartedAt ?? null,
    archived: partial.archived ?? false,
    settledOverride: partial.settledOverride ?? null,
    settledAt: partial.settledAt ?? null,
    pinnedAt: partial.pinnedAt ?? null,
    snoozedUntil: partial.snoozedUntil ?? null,
    snoozedAt: partial.snoozedAt ?? null,
    lastVisitedAt:
      partial.lastVisitedAt !== undefined
        ? partial.lastVisitedAt
        : (partial.createdAt ?? partial.updatedAt ?? 1),
    prState: partial.prState ?? null,
    provider: partial.provider ?? "claude",
    model: partial.model ?? null,
    sessionId: partial.sessionId ?? null,
    permissionMode: partial.permissionMode ?? "default",
    reasoningEffort: partial.reasoningEffort ?? null,
    worktreePath: partial.worktreePath ?? null,
    ...partial,
  };
}

describe("nextVisibleThreadId", () => {
  it("returns null when no other non-archived threads exist", () => {
    const threads = [
      thread({ id: "a", projectId: "p1", archived: false }),
      thread({ id: "b", projectId: "p1", archived: true }),
    ];
    assert.equal(nextVisibleThreadId(threads, "a"), null);
  });

  it("skips the leaving thread and archived peers", () => {
    const threads = [
      thread({ id: "a", projectId: "p1", updatedAt: 30 }),
      thread({ id: "b", projectId: "p1", updatedAt: 20, archived: true }),
      thread({ id: "c", projectId: "p1", updatedAt: 10 }),
    ];
    assert.equal(nextVisibleThreadId(threads, "a"), "c");
  });

  it("prefers another thread in the same project when available", () => {
    const threads = [
      thread({ id: "other-proj", projectId: "p2", updatedAt: 99 }),
      thread({ id: "leave", projectId: "p1", updatedAt: 50 }),
      thread({ id: "same", projectId: "p1", updatedAt: 10 }),
    ];
    assert.equal(nextVisibleThreadId(threads, "leave"), "same");
  });

  it("falls back to any non-archived thread in another project", () => {
    const threads = [
      thread({ id: "leave", projectId: "p1", updatedAt: 50 }),
      thread({ id: "other", projectId: "p2", updatedAt: 10 }),
    ];
    assert.equal(nextVisibleThreadId(threads, "leave"), "other");
  });

  it("ignores the leaving id even if it is already marked archived", () => {
    const threads = [
      thread({ id: "leave", projectId: "p1", archived: true, updatedAt: 50 }),
      thread({ id: "keep", projectId: "p1", updatedAt: 10 }),
    ];
    assert.equal(nextVisibleThreadId(threads, "leave"), "keep");
  });
});
