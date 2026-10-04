import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  memoryStepText,
  memoryToolOp,
  parseMemoryStep,
} from "../src/memorySteps.ts";
import type { ChatMessage } from "../src/shared/ipc.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z");

function tool(name: string, input: string, output: string | null, done = true): ChatMessage {
  return {
    id: "m",
    role: "tool",
    text: name,
    createdAt: 1,
    tool: { id: "t", name, input, output, done, isError: false },
  } as ChatMessage;
}

describe("memory moments (#1429 F5)", () => {
  it("recognises coder-memory tools across provider naming", () => {
    assert.equal(memoryToolOp("mcp__coder-memory__memory_search"), "memory_search");
    assert.equal(memoryToolOp("coder_memory.memory_get"), "memory_get");
    assert.equal(memoryToolOp("Read"), null);
    assert.equal(memoryToolOp("mcp__other__memory_search"), null);
  });

  it("counts recalled entries with their agent and age", () => {
    const out = JSON.stringify([
      { title: "Overrides live in store.js", agent: "codex", created_at: "2026-10-02T12:00:00Z" },
      { title: "Keys survive migration", agent: null, created_at: "2026-09-13T12:00:00Z" },
    ]);
    const step = parseMemoryStep(tool("mcp__coder-memory__memory_search", "{}", out), NOW);
    assert.deepEqual(step, {
      kind: "recall",
      count: 2,
      running: false,
      items: [
        { title: "Overrides live in store.js", agent: "codex", age: "2d" },
        { title: "Keys survive migration", agent: null, age: "3w" },
      ],
    });
    assert.deepEqual(memoryStepText(step!), {
      before: "Recalled ",
      mark: "2 memories",
      after: " from shared memory",
    });
  });

  it("unwraps MCP text blocks and falls back to a title count", () => {
    const wrapped = JSON.stringify([
      { type: "text", text: JSON.stringify({ title: "One", agent: "claude" }) },
    ]);
    const a = parseMemoryStep(tool("mcp__coder-memory__memory_get", "{}", wrapped), NOW);
    assert.equal(a?.kind === "recall" && a.count, 1);
    const flat = 'results: {"title": "A"} {"title": "B"} trailing';
    const b = parseMemoryStep(tool("mcp__coder-memory__memory_recent", "{}", flat), NOW);
    assert.equal(b?.kind === "recall" && b.count, 2);
  });

  it("says Searched shared memory when nothing parses", () => {
    const step = parseMemoryStep(tool("mcp__coder-memory__memory_search", "{}", "no hits"), NOW);
    assert.equal(memoryStepText(step!).before, "Searched shared memory");
  });

  it("labels a store with its title", () => {
    const step = parseMemoryStep(
      tool("mcp__coder-memory__memory_store", JSON.stringify({ title: "Use cp -Rc" }), "{}"),
      NOW,
    );
    assert.deepEqual(memoryStepText(step!), {
      before: "Saved a memory: ",
      mark: null,
      after: "Use cp -Rc",
    });
  });
});
