/**
 * Issue #158: "Fork from here" on assistant messages.
 * Kept out of threadView.test.tsx, which sits at the 20s per-file cap on
 * Windows CI.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { MessageBlock } from "../src/components/thread/messages";
import type { ChatMessage } from "../src/shared/ipc";

const reply: ChatMessage = {
  id: "a1",
  role: "assistant",
  text: "Done.",
  createdAt: 20,
  runId: null,
};

afterEach(() => unmountAll());

describe("MessageBlock fork from here (#158)", () => {
  it("forks at that message", async () => {
    const calls: string[] = [];
    const m = await mount(
      <MessageBlock
        message={reply}
        autoExpandTool={false}
        onForkFrom={(id) => calls.push(id)}
      />,
    );
    await m.click(m.query("[data-msg-fork]") as HTMLElement);
    assert.deepEqual(calls, ["a1"]);
  });

  it("is absent without a handler and while streaming", async () => {
    const plain = await mount(
      <MessageBlock message={reply} autoExpandTool={false} />,
    );
    assert.equal(plain.query("[data-msg-fork]"), null);
    const live = await mount(
      <MessageBlock
        message={reply}
        autoExpandTool={false}
        streaming
        onForkFrom={() => {}}
      />,
    );
    assert.equal(live.query("[data-msg-fork]"), null);
  });
});
