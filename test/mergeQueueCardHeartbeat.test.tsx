/**
 * MergeQueueCard keeps every listed claimed lane alive (#346 follow-on).
 * LaneHeartbeat only stamps the SELECTED thread. A background claimed
 * lane with no active run would recycle after 30 minutes while the lead
 * looks elsewhere — the Lanes card beats the whole list on the same 15s
 * cadence. Recycle stays off this surface.
 *
 * Run: node --import=./test/support/render.mjs --test test/mergeQueueCardHeartbeat.test.tsx
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { MergeQueueCard } from "../src/components/AgentsPanel";
import type {
  MergeLaneBeat,
  MergeLaneClaim,
  MergeLaneInfo,
  MergeLanePreview,
  MergeLaneRestore,
} from "../src/shared/ipc";

function lane(over: Partial<MergeLaneInfo> = {}): MergeLaneInfo {
  return {
    n: 1,
    threadId: "t1",
    port: 3001,
    path: "/tmp/lane-1",
    branch: "lane/1",
    claimedAt: 1,
    lastBeat: 1,
    ...over,
  };
}

function card(opts: {
  threadId?: string | null;
  projectId?: string | null;
  remote?: boolean;
  lanes?: MergeLaneInfo[];
  heartbeat?: (input: {
    threadId: string;
  }) => Promise<MergeLaneBeat | null>;
}) {
  const lanes = opts.lanes ?? [];
  return (
    <MergeQueueCard
      threadId={opts.threadId === undefined ? "t-selected" : opts.threadId}
      projectId={opts.projectId === undefined ? "p1" : opts.projectId}
      remote={opts.remote}
      claimLane={async (): Promise<MergeLaneClaim> => ({
        n: 1,
        port: 3001,
        path: "/tmp/lane-1",
        branch: "lane/1",
      })}
      listLanes={async () => lanes}
      previewLane={async (input): Promise<MergeLanePreview> => ({
        lane: input.lane,
        sha: "abc",
        files: ["src/a.ts"],
        path: "/tmp/repo",
      })}
      restorePreview={async (): Promise<MergeLaneRestore> => ({
        restored: true,
        sha: "abc",
      })}
      heartbeatLane={
        opts.heartbeat ??
        (async () => ({ n: 1, port: 3001, claimedAt: 1, lastBeat: 2 }))
      }
    />
  );
}

describe("MergeQueueCard heartbeat (#346)", () => {
  it("beats every listed claimed lane on mount, including a background thread", async () => {
    const calls: { threadId: string }[] = [];
    const m = await mount(
      card({
        threadId: "t-selected",
        lanes: [
          lane({ n: 1, threadId: "t-selected", port: 3001 }),
          lane({ n: 3, threadId: "t-background", port: 3003 }),
        ],
        heartbeat: async (input) => {
          calls.push(input);
          return { n: 1, port: 3001, claimedAt: 1, lastBeat: Date.now() };
        },
      }),
    );
    await m.flush();
    const ids = calls.map((c) => c.threadId).sort();
    assert.deepEqual(ids, ["t-background", "t-selected"]);
    m.unmount();
  });

  it("does not heartbeat a remote project", async () => {
    const calls: { threadId: string }[] = [];
    const m = await mount(
      card({
        remote: true,
        lanes: [
          lane({ n: 1, threadId: "t-selected" }),
          lane({ n: 2, threadId: "t-background" }),
        ],
        heartbeat: async (input) => {
          calls.push(input);
          return null;
        },
      }),
    );
    await m.flush();
    assert.deepEqual(calls, []);
    assert.equal(m.query("[data-lanes]"), null);
    m.unmount();
  });

  it("does not heartbeat when no lanes are listed", async () => {
    const calls: { threadId: string }[] = [];
    const m = await mount(
      card({
        lanes: [],
        heartbeat: async (input) => {
          calls.push(input);
          return null;
        },
      }),
    );
    await m.flush();
    assert.deepEqual(calls, []);
    m.unmount();
  });

  it("does not call recycleWedgedLanes from the card", async () => {
    const src = fs.readFileSync("src/components/AgentsPanel.tsx", "utf8");
    const start = src.indexOf("export function MergeQueueCard");
    assert.ok(start >= 0, "MergeQueueCard is exported");
    const next = src.indexOf("\nexport function ", start + 1);
    const body = next >= 0 ? src.slice(start, next) : src.slice(start);
    assert.doesNotMatch(body, /recycleWedgedLanes/);
    assert.doesNotMatch(body, /completeIssue|completeThreadIssue/);
    assert.match(
      body,
      /setInterval\(beat, LANE_HEARTBEAT_MS\)/,
      "listed lanes share the 15s LaneHeartbeat / runner stall cadence",
    );
  });

  it("uses the same 15s interval as LaneHeartbeat", () => {
    const beat = fs.readFileSync("src/components/LaneHeartbeat.tsx", "utf8");
    assert.match(beat, /export const LANE_HEARTBEAT_MS = 15_000/);
    const cardSrc = fs.readFileSync("src/components/AgentsPanel.tsx", "utf8");
    assert.match(cardSrc, /LANE_HEARTBEAT_MS/);
  });
});
