import assert from "node:assert/strict";
import { it } from "node:test";
import { conversationMarkdown } from "../src/conversationMarkdown";
import { detail, thread } from "./support/fakeCoder";
import type { ChatMessage } from "../src/shared/ipc";

const messages: ChatMessage[] = [
  { id: "u", role: "user", text: "Find [literal] text", createdAt: 1 },
  { id: "tool", role: "tool", text: "Find [literal] secret tool output", createdAt: 2 },
  { id: "a", role: "assistant", text: "Here is [LITERAL] text", createdAt: 3 },
  { id: "notice", role: "user", text: "Machine notice", createdAt: 4, fromNotice: true },
  { id: "steer", role: "user", text: "A correction", createdAt: 5, steer: true },
  { id: "peer", role: "user", text: "Peer report", createdAt: 6, fromThread: { id: "other", title: "Other" } },
  { id: "thought", role: "event", text: "Private reasoning", thinking: true, createdAt: 7 },
];

it("conversation copy preserves full Markdown and labels machine input without exporting tool internals", () => {
  const copied = conversationMarkdown(detail({ thread: thread({ title: "A conversation" }), messages }));
  assert.match(copied, /# A conversation\n\n## You/);
  assert.match(copied, /## Assistant\n\nHere is \[LITERAL\]/);
  assert.match(copied, /## Automatic follow-up/);
  assert.doesNotMatch(copied, /secret tool output|Private reasoning/);
});
