/**
 * Detect automation_create tool results and parse the card payload (#1589).
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/automationCard.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../src/shared/ipc";
import {
  isAutomationCreateMessage,
  parseAutomationCreateResult,
} from "../src/automationCard";

function msg(
  over: Partial<ChatMessage> & { name?: string; output?: string | null },
): ChatMessage {
  return {
    id: over.id ?? "m1",
    role: over.role ?? "tool",
    text: over.text ?? "automation_create",
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? "run-1",
    tool: {
      id: "tc1",
      name: over.name ?? "mcp__coder-threads__automation_create",
      input: "{}",
      output: over.output === undefined ? '{"ok":true,"id":"a1","name":"Triage CI"}' : over.output,
      done: over.tool?.done ?? true,
      isError: over.tool?.isError ?? false,
    },
  };
}

describe("isAutomationCreateMessage", () => {
  it("matches the MCP-prefixed name and the bare tool name", () => {
    assert.equal(isAutomationCreateMessage(msg({ name: "mcp__coder-threads__automation_create" })), true);
    assert.equal(isAutomationCreateMessage(msg({ name: "automation_create" })), true);
    assert.equal(isAutomationCreateMessage(msg({ name: "Read" })), false);
    assert.equal(
      isAutomationCreateMessage({
        id: "a",
        role: "assistant",
        text: "ok",
        createdAt: 1,
      }),
      false,
    );
  });
});

describe("parseAutomationCreateResult", () => {
  it("reads id and name from pretty-printed MCP JSON", () => {
    const parsed = parseAutomationCreateResult(
      JSON.stringify(
        {
          ok: true,
          id: "auto-1",
          name: "Triage CI",
          preset: "hourly",
          trigger: {
            type: "github",
            event: "ci_completed",
            branch: "main",
            conclusion: "failure",
          },
        },
        null,
        2,
      ),
    );
    assert.equal(parsed?.id, "auto-1");
    assert.equal(parsed?.name, "Triage CI");
    assert.equal(parsed?.preset, "hourly");
    assert.equal(parsed?.trigger?.event, "ci_completed");
    assert.equal(parsed?.trigger?.branch, "main");
  });

  it("returns null for junk", () => {
    assert.equal(parseAutomationCreateResult("not json"), null);
    assert.equal(parseAutomationCreateResult('{"ok":true}'), null);
  });
});
