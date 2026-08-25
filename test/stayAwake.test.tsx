/**
 * Stay-awake footer control (issue #364, item 5): three-state cycle
 * (agent → on → off), live blocking/battery tooltip, and the App-level
 * wiring that persists the mode through settings.set and follows
 * stayAwake:changed pushes.
 *
 * Run: npm run test:renderer -- --test-name-pattern stayAwake
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { inAct, mount } from "./support/dom";
import App from "../src/App";
import { StayAwakeControl } from "../src/components/StayAwakeControl";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder";
import type { StayAwakeMode, StayAwakeStatus } from "../src/shared/ipc";

function state(over: Partial<StayAwakeStatus> = {}): StayAwakeStatus {
  return {
    mode: "agent",
    blocking: false,
    onBattery: false,
    anyWorking: false,
    ...over,
  };
}

describe("StayAwakeControl", () => {
  it("cycles agent → on → off → agent", async () => {
    const seen: StayAwakeMode[] = [];
    const m = await mount(
      <StayAwakeControl state={state()} onSetMode={(mode) => seen.push(mode)} />,
    );
    const btn = m.query("[data-stay-awake]");
    assert.ok(btn, "control renders");
    assert.equal(btn.getAttribute("data-stay-awake-mode"), "agent");

    await m.click(btn);
    assert.deepEqual(seen, ["on"]);
    // Re-render with the new mode and keep cycling.
    m.unmount();

    const m2 = await mount(
      <StayAwakeControl
        state={state({ mode: "on" })}
        onSetMode={(mode) => seen.push(mode)}
      />,
    );
    await m2.click(m2.query("[data-stay-awake]"));
    assert.deepEqual(seen, ["on", "off"]);
    m2.unmount();

    const m3 = await mount(
      <StayAwakeControl
        state={state({ mode: "off" })}
        onSetMode={(mode) => seen.push(mode)}
      />,
    );
    await m3.click(m3.query("[data-stay-awake]"));
    assert.deepEqual(seen, ["on", "off", "agent"]);
    m3.unmount();
  });

  it("marks the blocking state and says so in the tooltip", async () => {
    const m = await mount(
      <StayAwakeControl
        state={state({ mode: "agent", blocking: true, anyWorking: true })}
        onSetMode={() => {}}
      />,
    );
    const btn = m.query("[data-stay-awake]");
    assert.ok(btn?.hasAttribute("data-stay-awake-blocking"));
    assert.match(btn?.getAttribute("title") ?? "", /Keeping this Mac awake/);
    m.unmount();
  });

  it("explains the battery cutoff in the tooltip", async () => {
    const m = await mount(
      <StayAwakeControl
        state={state({ mode: "on", blocking: false, onBattery: true })}
        onSetMode={() => {}}
      />,
    );
    const btn = m.query("[data-stay-awake]");
    assert.ok(!btn?.hasAttribute("data-stay-awake-blocking"));
    assert.match(
      btn?.getAttribute("title") ?? "",
      /Suspended on battery power/,
    );
    m.unmount();
  });
});

describe("stay-awake app wiring (#364)", () => {
  it("footer control persists the mode through settings.set and follows pushes", async () => {
    const fake = createFakeCoder();
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);
    await m.flush();

    const btn = m.query("[data-stay-awake]");
    assert.ok(btn, "sidebar footer shows the control after boot");
    assert.equal(btn.getAttribute("data-stay-awake-mode"), "agent");

    await m.click(btn);
    await m.flush();
    assert.deepEqual(fake.only("settings.set").args, [{ stayAwake: "on" }]);
    assert.equal(
      m.query("[data-stay-awake]")?.getAttribute("data-stay-awake-mode"),
      "on",
    );

    // Main pushes the derived state: the indicator flips to blocking.
    await inAct(() =>
      fake.emitStayAwake({
        mode: "on",
        blocking: true,
        onBattery: false,
        anyWorking: true,
      }),
    );
    await m.flush();
    const live = m.query("[data-stay-awake]");
    assert.ok(live?.hasAttribute("data-stay-awake-blocking"));
    assert.match(live?.getAttribute("title") ?? "", /Keeping this Mac awake/);
    m.unmount();
  });
});
