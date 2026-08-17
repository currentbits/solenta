/**
 * setReasoningEffort / setPermissionMode honor an explicit thread id.
 * Run: node --import=./test/support/render.mjs --test test/setterThreadId.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  thread,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import { useCoder } from "../src/useCoder";

function Probe() {
  const {
    selectedThreadId,
    setReasoningEffort,
    setPermissionMode,
  } = useCoder();
  return (
    <div>
      <span data-selected="">{selectedThreadId ?? ""}</span>
      <button
        data-effort=""
        onClick={() => void setReasoningEffort("high", "t-other")}
      />
      <button
        data-perm=""
        onClick={() => void setPermissionMode("acceptEdits", "t-other")}
      />
    </div>
  );
}

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<Probe />);
  await m.flush();
  return m;
}

describe("setters target the passed thread id", () => {
  it("setReasoningEffort and setPermissionMode hit the arg, not the selection", async () => {
    const fake = createFakeCoder({
      threads: [
        thread({ id: "t-selected", title: "open" }),
        thread({ id: "t-other", title: "other" }),
      ],
    });
    const m = await boot(fake);
    assert.equal(
      m.query("[data-selected]")?.textContent,
      "t-selected",
      "the open thread is the one useCoder auto-selected",
    );

    await m.click(m.query("[data-effort]"));
    const effort = fake.only("threads.setReasoningEffort").args[0] as {
      threadId: string;
      effort: string;
    };
    assert.deepEqual(effort, { threadId: "t-other", effort: "high" });

    await m.click(m.query("[data-perm]"));
    const perm = fake.only("threads.setPermissionMode").args[0] as {
      threadId: string;
      mode: string;
    };
    assert.deepEqual(perm, { threadId: "t-other", mode: "acceptEdits" });
    m.unmount();
  });
});
