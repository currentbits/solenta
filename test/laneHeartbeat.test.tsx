/**
 * Lead UI heartbeat for a claimed merge-queue lane (#346).
 * Recycle is not on this surface.
 *
 * Run: node --import=./test/support/render.mjs --test test/laneHeartbeat.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { LaneHeartbeat } from "../src/components/LaneHeartbeat";

describe("LaneHeartbeat (#346)", () => {
  it("beats the claimed lane on mount", async () => {
    const calls: { threadId: string }[] = [];
    const m = await mount(
      <LaneHeartbeat
        threadId="t1"
        claimed
        heartbeatLane={async (input) => {
          calls.push(input);
          return { n: 1, port: 3001, claimedAt: 1, lastBeat: 2 };
        }}
      />,
    );
    await m.flush();
    assert.deepEqual(calls, [{ threadId: "t1" }]);
    m.unmount();
  });

  it("does not beat when the thread has no claimed lane", async () => {
    const calls: { threadId: string }[] = [];
    const m = await mount(
      <LaneHeartbeat
        threadId="t1"
        claimed={false}
        heartbeatLane={async (input) => {
          calls.push(input);
          return null;
        }}
      />,
    );
    await m.flush();
    assert.deepEqual(calls, []);
    m.unmount();
  });

  it("does not beat without a thread", async () => {
    const calls: { threadId: string }[] = [];
    const m = await mount(
      <LaneHeartbeat
        threadId={null}
        claimed
        heartbeatLane={async (input) => {
          calls.push(input);
          return null;
        }}
      />,
    );
    await m.flush();
    assert.deepEqual(calls, []);
    m.unmount();
  });
});
