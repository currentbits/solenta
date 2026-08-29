/**
 * Pure T3-style tool grouping (#768).
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/toolGroups.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, ToolCallInfo } from "../src/shared/ipc";
import { buildTimeline } from "../src/timeline";
import {
  collapseTimeline,
  isGroupable,
  liveGroupLabel,
  summarizeToolGroup,
  toolAction,
} from "../src/toolGroups";

function tool(
  over: Partial<ChatMessage> & { name: string; id: string },
): ChatMessage {
  const info: ToolCallInfo = {
    id: over.id,
    name: over.name,
    input: "",
    output: "ok",
    done: over.tool?.done ?? true,
    isError: over.tool?.isError ?? false,
  };
  return {
    id: over.id,
    role: "tool",
    text: over.text ?? `${over.name}: x`,
    createdAt: over.createdAt ?? 1,
    runId: over.runId === undefined ? "run-1" : over.runId,
    tool: { ...info, ...over.tool },
  };
}

function thinking(over: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    id: over.id,
    role: "event",
    text: over.text ?? "reasoning",
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? "run-1",
    thinking: true,
  };
}

describe("isGroupable", () => {
  it("treats tools and thinking events as groupable", () => {
    assert.equal(isGroupable(tool({ id: "t", name: "Read" })), true);
    assert.equal(isGroupable(thinking({ id: "th" })), true);
    assert.equal(
      isGroupable({
        id: "e",
        role: "event",
        text: "failed",
        createdAt: 1,
      }),
      false,
    );
    assert.equal(
      isGroupable({
        id: "a",
        role: "assistant",
        text: "done",
        createdAt: 1,
        runId: "run-1",
      }),
      false,
    );
  });
});

describe("toolAction", () => {
  it("maps provider names after normalizing case and underscores", () => {
    assert.equal(toolAction("Read"), "read");
    assert.equal(toolAction("ReadFile"), "read");
    assert.equal(toolAction("run_terminal_command"), "command");
    assert.equal(toolAction("WebSearch"), "search");
    assert.equal(toolAction("Grep"), "code-search");
    assert.equal(toolAction("Edit"), "edit");
    assert.equal(toolAction("mcp__other"), "other");
  });
});

describe("summarizeToolGroup", () => {
  it("uses singular and T3 joiners", () => {
    assert.equal(
      summarizeToolGroup([tool({ id: "r", name: "Read" })]),
      "Read 1 file",
    );
    assert.equal(
      summarizeToolGroup([
        tool({ id: "r1", name: "Read" }),
        tool({ id: "b1", name: "Bash" }),
      ]),
      "Read 1 file and ran 1 command",
    );
    assert.equal(
      summarizeToolGroup([
        tool({ id: "r1", name: "Read" }),
        tool({ id: "r2", name: "Read" }),
        tool({ id: "b1", name: "Bash" }),
        tool({ id: "e1", name: "Edit" }),
      ]),
      "Read 2 files, ran 1 command, and changed 1 file",
    );
  });

  it("ignores thinking rows when counting", () => {
    assert.equal(
      summarizeToolGroup([
        thinking({ id: "th" }),
        tool({ id: "r", name: "Read" }),
      ]),
      "Read 1 file",
    );
  });
});

describe("liveGroupLabel", () => {
  it("uses the first token after ': ' for an in-progress tool", () => {
    assert.equal(
      liveGroupLabel([
        tool({
          id: "b",
          name: "Bash",
          text: "Bash: npm test",
          tool: {
            id: "b",
            name: "Bash",
            input: "",
            output: null,
            done: false,
            isError: false,
          },
        }),
      ]),
      "Running npm",
    );
  });

  it("is Thinking when only a live thinking row is present", () => {
    assert.equal(liveGroupLabel([thinking({ id: "th" })]), "Thinking");
  });
});

describe("collapseTimeline", () => {
  it("collapses consecutive same-run tools and drops work-log cards", () => {
    const messages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        text: "fix it",
        createdAt: 10,
      },
      tool({ id: "r1", name: "Read", createdAt: 20 }),
      tool({ id: "r2", name: "Read", createdAt: 21 }),
      {
        id: "a1",
        role: "assistant",
        text: "done",
        createdAt: 30,
        runId: "run-1",
      },
    ];
    const entries = buildTimeline(messages, [
      { id: "w1", runId: "run-1", label: "STEP", done: true, timestamp: 15 },
    ]);
    const rows = collapseTimeline(entries, { working: false });
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["message", "group", "message"],
    );
    const group = rows[1];
    assert.equal(group.kind, "group");
    if (group.kind !== "group") return;
    assert.equal(summarizeToolGroup(group.group.messages), "Read 2 files");
    assert.equal(group.group.hasError, false);
    assert.ok(!rows.some((r) => "kind" in r && r.kind === "worklog"));
  });

  it("does not merge tools across a missing runId", () => {
    const entries = buildTimeline(
      [
        tool({ id: "a", name: "Read", runId: "run-1", createdAt: 1 }),
        tool({ id: "b", name: "Read", runId: null, createdAt: 2 }),
      ],
      [],
    );
    const rows = collapseTimeline(entries, { working: false });
    assert.equal(rows.filter((r) => r.kind === "group").length, 2);
  });

  it("hides completed thinking-only groups and shows live ones", () => {
    const done = buildTimeline([thinking({ id: "th", createdAt: 1 })], []);
    assert.deepEqual(collapseTimeline(done, { working: false }), []);

    const live = collapseTimeline(done, { working: true });
    assert.equal(live.length, 1);
    assert.equal(live[0]?.kind, "group");
    if (live[0]?.kind !== "group") return;
    assert.equal(liveGroupLabel(live[0].group.messages), "Thinking");
  });

  it("marks a group error when any tool failed", () => {
    const entries = buildTimeline(
      [
        tool({
          id: "b",
          name: "Bash",
          createdAt: 1,
          tool: {
            id: "b",
            name: "Bash",
            input: "",
            output: "no",
            done: true,
            isError: true,
          },
        }),
      ],
      [],
    );
    const rows = collapseTimeline(entries, { working: false });
    assert.equal(rows[0]?.kind, "group");
    if (rows[0]?.kind !== "group") return;
    assert.equal(rows[0].group.hasError, true);
  });
});
