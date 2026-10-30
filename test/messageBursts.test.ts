/**
 * Back-to-back user messages (#1789): queued follow-ups, steer messages, and
 * quick corrections with no agent output between them group into one bubble
 * cluster. Pure helper, over the same row list ThreadView renders
 * (toolGroups' DisplayEntry[]) — no DOM needed.
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/messageBursts.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { userMessageBursts } from "../src/components/thread/messages.tsx";
import type { DisplayEntry } from "../src/toolGroups.ts";
import type { AttachmentInfo, ChatMessage, ToolCallInfo } from "../src/shared/ipc.ts";

function userMsg(id: string, over: Partial<ChatMessage> = {}): DisplayEntry {
  return {
    kind: "message",
    timestamp: over.createdAt ?? 1,
    message: {
      id,
      role: "user",
      text: over.text ?? "hi",
      createdAt: over.createdAt ?? 1,
      runId: over.runId ?? null,
      attachments: over.attachments,
      ...over,
    },
  };
}

function assistantMsg(id: string): DisplayEntry {
  return {
    kind: "message",
    timestamp: 1,
    message: {
      id,
      role: "assistant",
      text: "ok",
      createdAt: 1,
      runId: null,
    },
  };
}

function toolGroupEntry(): DisplayEntry {
  const info: ToolCallInfo = {
    id: "t-1",
    name: "bash",
    input: "",
    output: "ok",
    done: true,
    isError: false,
  };
  const tool: ChatMessage = {
    id: "t-1",
    role: "tool",
    text: "bash: ls",
    createdAt: 1,
    runId: "run-1",
    tool: info,
  };
  return {
    kind: "group",
    timestamp: 1,
    group: { id: "g-1", runId: "run-1", messages: [tool], hasError: false },
  };
}

describe("userMessageBursts", () => {
  it("marks a lone user message as single", () => {
    const positions = userMessageBursts([userMsg("m1")]);
    assert.deepEqual([...positions], [["m1", "single"]]);
  });

  it("groups consecutive user messages into first/middle/.../last", () => {
    const positions = userMessageBursts([
      userMsg("m1"),
      userMsg("m2"),
      userMsg("m3"),
      userMsg("m4"),
    ]);
    assert.deepEqual(
      [...positions],
      [
        ["m1", "first"],
        ["m2", "middle"],
        ["m3", "middle"],
        ["m4", "last"],
      ],
    );
  });

  it("a run of exactly two is first then last, no middle", () => {
    const positions = userMessageBursts([userMsg("m1"), userMsg("m2")]);
    assert.deepEqual(
      [...positions],
      [
        ["m1", "first"],
        ["m2", "last"],
      ],
    );
  });

  it("breaks the run on an assistant message between two user messages", () => {
    const positions = userMessageBursts([
      userMsg("m1"),
      assistantMsg("a1"),
      userMsg("m2"),
    ]);
    assert.deepEqual(
      [...positions],
      [
        ["m1", "single"],
        ["m2", "single"],
      ],
    );
  });

  it("breaks the run on a tool group between two user messages", () => {
    const positions = userMessageBursts([
      userMsg("m1"),
      userMsg("m2"),
      toolGroupEntry(),
      userMsg("m3"),
    ]);
    assert.deepEqual(
      [...positions],
      [
        ["m1", "first"],
        ["m2", "last"],
        ["m3", "single"],
      ],
    );
  });

  it("keeps grouping a message that carries attachments", () => {
    const attachments: AttachmentInfo[] = [
      { kind: "image", name: "shot.png", path: "/tmp/shot.png" },
    ];
    const positions = userMessageBursts([
      userMsg("m1"),
      userMsg("m2", { text: "", attachments }),
    ]);
    assert.deepEqual(
      [...positions],
      [
        ["m1", "first"],
        ["m2", "last"],
      ],
    );
  });

  it("returns nothing for an empty row list", () => {
    assert.equal(userMessageBursts([]).size, 0);
  });
});
