/**
 * ⌘K "Restart agent session" (#1762): PALETTE_ACTIONS carries the entry the
 * palette lists, and useCoder's restartAgentSession (what App.tsx's
 * runPaletteAction calls for that id) reaches threads:restartAgentSession
 * for the SELECTED thread, surfacing a refusal the same way every other
 * run-scoped action does.
 *
 * Run: node --import=./test/support/render.mjs --test test/restartAgentSession.test.tsx
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
import { PALETTE_ACTIONS } from "../src/commandPalette";

function Probe() {
  const { selectedThreadId, restartAgentSession, error } = useCoder();
  return (
    <div>
      <span data-selected="">{selectedThreadId ?? ""}</span>
      <span data-error="">{error?.scope === "run" ? error.message : ""}</span>
      <button
        data-restart=""
        onClick={() => void restartAgentSession().catch(() => {})}
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

describe("commandPalette #1762: restart-agent-session entry", () => {
  it("is listed with a title the user recognizes", () => {
    const action = PALETTE_ACTIONS.find((a) => a.id === "restart-agent-session");
    assert.ok(action, "PALETTE_ACTIONS must carry restart-agent-session");
    assert.equal(action!.title, "Restart agent session");
  });
});

describe("Restart agent session reaches the IPC for the selected thread (#1762)", () => {
  it("calls threads.restartAgentSession with the selected thread id", async () => {
    const fake = createFakeCoder({
      threads: [thread({ id: "t-selected", title: "open" })],
    });
    const m = await boot(fake);
    assert.equal(m.query("[data-selected]")?.textContent, "t-selected");

    await m.click(m.query("[data-restart]"));
    const call = fake.only("threads.restartAgentSession").args[0] as {
      threadId: string;
    };
    assert.deepEqual(call, { threadId: "t-selected" });
    assert.equal(
      m.query("[data-error]")?.textContent,
      "",
      "a successful restart must not leave a run-error banner",
    );
    m.unmount();
  });

  it("surfaces a refusal while a run is active as the usual run-error banner", async () => {
    const fake = createFakeCoder({
      threads: [thread({ id: "t-selected", title: "open", status: "working" })],
      fail: {
        "threads.restartAgentSession": new Error(
          "Cannot restart the agent session while a run is active",
        ),
      },
    });
    const m = await boot(fake);

    await m.click(m.query("[data-restart]"));
    await m.flush();
    assert.match(
      m.query("[data-error]")?.textContent ?? "",
      /active/i,
    );
    m.unmount();
  });
});
