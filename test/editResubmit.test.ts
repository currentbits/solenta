/**
 * Pure edit-and-resubmit decisions (issue #254).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../src/shared/ipc";
import {
  isEditableUserMessage,
  rewindConfirmText,
  rewindDroppedCount,
} from "../src/editResubmit";

function m(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text" | "id">,
): ChatMessage {
  return {
    id: over.id,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? null,
    tool: over.tool,
  };
}

describe("isEditableUserMessage", () => {
  const user = m({ id: "u1", role: "user", text: "fix the chip" });

  it("is true for a user message when no run is active", () => {
    assert.equal(isEditableUserMessage(user, "idle"), true);
    assert.equal(isEditableUserMessage(user, "done"), true);
    assert.equal(isEditableUserMessage(user, "failed"), true);
  });

  it("is false while a run is active", () => {
    assert.equal(isEditableUserMessage(user, "working"), false);
  });

  it("is false for non-user roles even when idle", () => {
    assert.equal(
      isEditableUserMessage(m({ id: "a1", role: "assistant", text: "ok" }), "idle"),
      false,
    );
    assert.equal(
      isEditableUserMessage(m({ id: "e1", role: "event", text: "Run error" }), "idle"),
      false,
    );
  });
});

describe("rewindDroppedCount", () => {
  const msgs = [
    m({ id: "u1", role: "user", text: "first" }),
    m({ id: "a1", role: "assistant", text: "reply" }),
    m({ id: "u2", role: "user", text: "second" }),
    m({ id: "a2", role: "assistant", text: "later" }),
  ];

  it("counts the target and every message after it", () => {
    assert.equal(rewindDroppedCount(msgs, "u1"), 4);
    assert.equal(rewindDroppedCount(msgs, "u2"), 2);
    assert.equal(rewindDroppedCount(msgs, "a2"), 1);
  });

  it("is 0 when the id is missing", () => {
    assert.equal(rewindDroppedCount(msgs, "nope"), 0);
    assert.equal(rewindDroppedCount([], "u1"), 0);
  });
});

describe("rewindConfirmText", () => {
  it("uses singular for one message", () => {
    assert.equal(
      rewindConfirmText(1),
      "This removes 1 message from this thread (this one and everything after it) and resubmits the edited text.",
    );
  });

  it("uses plural for several messages", () => {
    assert.equal(
      rewindConfirmText(4),
      "This removes 4 messages from this thread (this one and everything after it) and resubmits the edited text.",
    );
  });
});
