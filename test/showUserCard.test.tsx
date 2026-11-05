/**
 * coder-threads show_user card (#293): live cards open their pane once,
 * history only offers Show.
 * Run: npm run test:renderer -- test/showUserCard.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { MessageBlock } from "../src/components/thread/messages";
import type { ChatMessage } from "../src/shared/ipc";
import { isGroupable } from "../src/toolGroups";
import { parseShowUserResult, type ShowUserAction } from "../src/showUser";

const result = {
  shown: true,
  target: "file",
  path: "src/a.ts",
  line: 12,
  reason: "the race is here",
};

function shown(done = true): ChatMessage {
  return {
    id: "m1",
    role: "tool",
    text: "show_user",
    createdAt: 1,
    tool: {
      id: "tc1",
      name: "mcp__coder-threads__show_user",
      input: "{}",
      // Claude wraps MCP results in content blocks.
      output: done
        ? JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] })
        : "",
      done,
      isError: false,
    },
  };
}

describe("show_user card (#293)", () => {
  it("parses wrapped results and rejects a file without a path", () => {
    assert.deepEqual(parseShowUserResult(JSON.stringify(result)), {
      target: "file",
      path: "src/a.ts",
      line: 12,
      reason: "the race is here",
    });
    assert.equal(parseShowUserResult('{"target":"file","path":null}'), null);
    assert.equal(parseShowUserResult("Unknown thread"), null);
    assert.equal(isGroupable(shown()), false);
  });

  it("Codex names the tool coder-threads/show_user (#1844)", async () => {
    const msg = shown();
    msg.tool!.name = "coder-threads/show_user";
    const m = await mount(<MessageBlock message={msg} autoExpandTool />);
    assert.ok(m.query("[data-show-user=file]"), "Codex call renders as a Show card");
    assert.equal(isGroupable(msg), false);
    m.unmount();
  });

  it("a live card opens its pane once; Show re-opens it", async () => {
    const calls: ShowUserAction[] = [];
    const m = await mount(
      <MessageBlock
        message={shown()}
        autoExpandTool
        animateIn
        onShowUser={(a) => calls.push(a)}
      />,
    );
    const card = m.query("[data-show-user=file]");
    assert.ok(card, "card");
    assert.match(card.textContent ?? "", /src\/a\.ts:12/);
    assert.match(card.textContent ?? "", /the race is here/);
    assert.equal(calls.length, 1);
    await m.click(m.query("[data-show-user-open]")!);
    assert.equal(calls.length, 2);
    m.unmount();
  });

  it("a history card waits for a click", async () => {
    const calls: ShowUserAction[] = [];
    const m = await mount(
      <MessageBlock
        message={shown()}
        autoExpandTool
        onShowUser={(a) => calls.push(a)}
      />,
    );
    assert.equal(calls.length, 0);
    m.unmount();
  });

  it("a running call renders as a plain tool card", async () => {
    const calls: ShowUserAction[] = [];
    const m = await mount(
      <MessageBlock
        message={shown(false)}
        autoExpandTool
        animateIn
        onShowUser={(a) => calls.push(a)}
      />,
    );
    assert.equal(m.query("[data-show-user]"), null);
    assert.equal(calls.length, 0);
    m.unmount();
  });
});
