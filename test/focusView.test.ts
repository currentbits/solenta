/**
 * Per-turn Focus summaries (issue #461): hide tool rows, do not drop them.
 * Run: node --experimental-strip-types --test test/focusView.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../src/shared/ipc.ts";
import {
  cycleTranscriptViewMode,
  latestTurnKey,
  mapFocusTurns,
  summarizeActivity,
  turnKey,
  turnKeyForRun,
} from "../src/focusView.ts";

function msg(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">,
): ChatMessage {
  return {
    id: over.id ?? `m-${over.role}-${over.createdAt ?? 1}`,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? null,
    tool: over.tool,
    thinking: over.thinking,
  };
}

function tool(
  name: string,
  over: Partial<NonNullable<ChatMessage["tool"]>> & { text?: string } = {},
): ChatMessage {
  return msg({
    id: over.id ?? `tool-${name}-${over.text ?? "x"}`,
    role: "tool",
    text: over.text ?? `${name}: x`,
    createdAt: 10,
    runId: "r1",
    tool: {
      id: over.id ?? `tc-${name}`,
      name,
      input: over.input ?? "{}",
      output: over.output ?? "ok",
      done: over.done ?? true,
      isError: over.isError ?? false,
    },
  });
}

describe("cycleTranscriptViewMode", () => {
  it("walks summary → normal → verbose → summary", () => {
    assert.equal(cycleTranscriptViewMode("summary"), "normal");
    assert.equal(cycleTranscriptViewMode("normal"), "verbose");
    assert.equal(cycleTranscriptViewMode("verbose"), "summary");
  });
});

describe("summarizeActivity", () => {
  it("groups reads, commands, and writes into one line", () => {
    const label = summarizeActivity([
      tool("Read", { text: "Read a.ts" }),
      tool("Read", { text: "Read b.ts" }),
      tool("Bash", { text: "Bash: npm test" }),
      tool("Edit", { text: "Edit a.ts" }),
    ]);
    assert.equal(label, "Read 2 files · Ran 1 command · Changed 1 file");
  });

  it("names a thinking-only fold from the timestamp span", () => {
    const label = summarizeActivity([
      msg({
        id: "th1",
        role: "event",
        text: "hmm",
        thinking: true,
        createdAt: 1_000,
        runId: "r1",
      }),
      msg({
        id: "th2",
        role: "event",
        text: "still",
        thinking: true,
        createdAt: 5_000,
        runId: "r1",
      }),
    ]);
    assert.equal(label, "Thought for 4s");
  });

  it("appends the live tool name while a call is still running", () => {
    const label = summarizeActivity([
      tool("Read", { text: "Read a.ts", done: true }),
      tool("Bash", {
        id: "tc-live",
        text: "Bash: npm test",
        done: false,
        output: null,
      }),
    ]);
    assert.equal(label, "Read 1 file · Ran 1 command · Running Bash");
  });
});

describe("mapFocusTurns", () => {
  const user = msg({
    id: "u1",
    role: "user",
    text: "fix it",
    createdAt: 1,
    runId: "r1",
  });
  const read = tool("Read", { id: "tc-read", text: "Read a.ts" });
  read.id = "t-read";
  read.createdAt = 2;
  const bash = tool("Bash", { id: "tc-bash", text: "Bash: npm test" });
  bash.id = "t-bash";
  bash.createdAt = 3;
  const assistant = msg({
    id: "a1",
    role: "assistant",
    text: "done",
    createdAt: 4,
    runId: "r1",
  });

  it("emits one summary per user turn covering that turn's activity", () => {
    const turns = mapFocusTurns([user, read, bash, assistant]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.key, "u1");
    assert.equal(turns[0]!.firstActivityId, "t-read");
    assert.deepEqual(turns[0]!.activityIds, ["t-read", "t-bash"]);
    assert.equal(turns[0]!.label, "Read 1 file · Ran 1 command");
    assert.equal(turns[0]!.live, false);
  });

  it("marks the latest turn live when asked", () => {
    const turns = mapFocusTurns([user, read, bash, assistant], {
      liveTurnKey: "u1",
    });
    assert.equal(turns[0]!.live, true);
  });

  it("does not invent a turn when there is no tool or thinking activity", () => {
    const turns = mapFocusTurns([
      user,
      msg({ id: "a2", role: "assistant", text: "just words", createdAt: 2 }),
    ]);
    assert.deepEqual(turns, []);
  });
});

describe("mapFocusTurns folds a settled turn's earlier replies (#1796)", () => {
  const user = msg({ id: "u1", role: "user", text: "fix it", createdAt: 1 });
  const reply1 = msg({
    id: "a1",
    role: "assistant",
    text: "first reply",
    createdAt: 2,
    runId: "r1",
  });
  const reply2 = msg({
    id: "a2",
    role: "assistant",
    text: "second reply",
    createdAt: 3,
    runId: "r1",
  });
  const reply3 = msg({
    id: "a3",
    role: "assistant",
    text: "final reply",
    createdAt: 4,
    runId: "r1",
  });

  it("folds all but the last reply alongside tool activity, in document order", () => {
    const read = tool("Read", { id: "tc-read", text: "Read a.ts" });
    read.id = "t-read";
    read.createdAt = 0.5; // before the first reply
    const turns = mapFocusTurns([user, read, reply1, reply2, reply3]);
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]!.activityIds, ["t-read", "a1", "a2"]);
    assert.equal(turns[0]!.firstActivityId, "t-read");
    assert.equal(turns[0]!.label, "Show 2 earlier replies and tool activity");
  });

  it("folds replies alone (no tool activity) with the plain 'Show N' wording", () => {
    const turns = mapFocusTurns([user, reply1, reply2, reply3]);
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]!.activityIds, ["a1", "a2"]);
    assert.equal(turns[0]!.firstActivityId, "a1");
    assert.equal(turns[0]!.label, "Show 2 earlier replies");
  });

  it("singular wording for exactly one earlier reply", () => {
    const turns = mapFocusTurns([user, reply1, reply2]);
    assert.equal(turns[0]!.label, "Show 1 earlier reply");
    assert.deepEqual(turns[0]!.activityIds, ["a1"]);
  });

  it("a lone reply never folds on its own", () => {
    const turns = mapFocusTurns([user, reply1]);
    assert.deepEqual(turns, []);
  });

  it("never folds the live turn's replies", () => {
    const turns = mapFocusTurns([user, reply1, reply2, reply3], {
      liveTurnKey: "u1",
    });
    assert.equal(turns[0]!.live, true);
    // Folding membership is independent of live; ThreadView is the one that
    // skips rendering/hiding for a live turn (see hiddenFocusActivity).
    assert.deepEqual(turns[0]!.activityIds, ["a1", "a2"]);
  });
});

describe("turn keys", () => {
  it("walks back to the preceding user message", () => {
    const messages = [
      msg({ id: "u1", role: "user", text: "one", createdAt: 1 }),
      msg({ id: "a1", role: "assistant", text: "ok", createdAt: 2, runId: "r1" }),
      tool("Read", { id: "tc1", text: "Read x" }),
    ];
    messages[2]!.id = "t1";
    messages[2]!.createdAt = 3;
    assert.equal(turnKey(messages, 2), "u1");
    assert.equal(latestTurnKey(messages), "u1");
    assert.equal(turnKeyForRun(messages, "r1"), "u1");
  });
});
