/**
 * repeatDraftFromDetail: first non-empty user message becomes the prompt.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { repeatDraftFromDetail } from "../src/repeatThread";
import { detail, thread } from "./support/fakeCoder.ts";
import type { ChatMessage } from "../src/shared/ipc";

function msg(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">,
): ChatMessage {
  return {
    id: over.id ?? `m-${over.role}-${over.createdAt ?? 1}`,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? null,
  };
}

describe("repeatDraftFromDetail", () => {
  it("picks the FIRST non-empty user message, not a follow-up", () => {
    const t = thread({
      id: "t-done",
      projectId: "p1",
      title: "Nightly review",
      provider: "claude",
      model: "opus",
    });
    const draft = repeatDraftFromDetail(
      detail({
        thread: t,
        messages: [
          msg({ role: "user", text: "   " }),
          msg({ role: "assistant", text: "waiting" }),
          msg({ role: "user", text: "  Review the ledger  " }),
          msg({ role: "assistant", text: "looks clean" }),
          msg({ role: "user", text: "Also check last week" }),
        ],
      }),
    );
    assert.ok(draft);
    assert.equal(draft.threadId, "t-done");
    assert.equal(draft.projectId, "p1");
    assert.equal(draft.name, "Nightly review");
    assert.equal(draft.prompt, "Review the ledger");
    assert.equal(draft.provider, "claude");
    assert.equal(draft.model, "opus");
  });

  it("returns null when there is no user message", () => {
    assert.equal(repeatDraftFromDetail(null), null);
    assert.equal(repeatDraftFromDetail(undefined), null);
    assert.equal(
      repeatDraftFromDetail(
        detail({
          messages: [
            msg({ role: "assistant", text: "hello" }),
            msg({ role: "user", text: "   " }),
          ],
        }),
      ),
      null,
    );
  });
});
