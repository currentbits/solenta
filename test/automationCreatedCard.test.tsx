/**
 * Result card for coder-threads automation_create (#1589).
 * Run: npm run test:renderer -- test/automationCreatedCard.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { MessageBlock } from "../src/components/thread/messages";
import type { ChatMessage } from "../src/shared/ipc";

function createdMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "tool",
    text: "automation_create",
    createdAt: 1,
    tool: {
      id: "tc1",
      name: "mcp__coder-threads__automation_create",
      input: '{"name":"Triage CI"}',
      output: JSON.stringify({
        id: "a-ci",
        name: "Triage CI",
        provider: "claude",
        trigger: {
          type: "github",
          event: "ci_completed",
          branch: "main",
          conclusion: "failure",
        },
      }),
      done: true,
      isError: false,
    },
    ...over,
  };
}

describe("automation created card (#1589)", () => {
  it("shows the name, trigger, and Open in Automations", async () => {
    const opened: string[] = [];
    const m = await mount(
      <MessageBlock
        message={createdMessage()}
        autoExpandTool
        onOpenAutomations={(id) => {
          if (id) opened.push(id);
        }}
      />,
    );
    const card = m.query("[data-automation-created]");
    assert.ok(card, "result card");
    assert.match(card.textContent ?? "", /Triage CI/);
    assert.match(card.textContent ?? "", /CI completed/);
    const btn = m.query("[data-open-automations]");
    assert.ok(btn, "Open in Automations");
    await m.click(btn);
    assert.deepEqual(opened, ["a-ci"]);
    m.unmount();
  });

  it("does not show Open when the call failed", async () => {
    const m = await mount(
      <MessageBlock
        message={createdMessage({
          tool: {
            id: "tc1",
            name: "automation_create",
            input: "{}",
            output: "Unknown trigger event: boom",
            done: true,
            isError: true,
          },
        })}
        autoExpandTool
        onOpenAutomations={() => {}}
      />,
    );
    assert.equal(m.query("[data-open-automations]"), null);
    m.unmount();
  });
});
