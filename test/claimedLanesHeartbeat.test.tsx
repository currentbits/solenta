/**
 * ClaimedLanesHeartbeat keeps claimed lanes alive across every local
 * project (#346 follow-on / #1114). The selected-project beater (#1113)
 * still lets a claimed lane on another local project recycle after
 * 30 minutes while the lead is looking elsewhere. This beater lists
 * every local project and stamps each claimed lane on the same 15s
 * cadence. Remote projects are skipped. Recycle stays off this surface.
 *
 * Run: node --import=./test/support/render.mjs --test test/claimedLanesHeartbeat.test.tsx
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  ClaimedLanesHeartbeat,
  LANE_HEARTBEAT_MS,
} from "../src/components/LaneHeartbeat";

function beat(
  opts: {
    projects?: { id: string; remoteHost?: string }[];
    lanesByProject?: Record<string, { threadId: string }[]>;
    heartbeat?: (input: { threadId: string }) => Promise<null>;
    listLanes?: (input: { projectId: string }) => Promise<{ threadId: string }[]>;
  } = {},
) {
  const lanesByProject = opts.lanesByProject ?? {};
  return (
    <ClaimedLanesHeartbeat
      projects={opts.projects ?? [{ id: "p-selected" }]}
      listLanes={
        opts.listLanes ??
        (async (input) => lanesByProject[input.projectId] ?? [])
      }
      heartbeatLane={
        opts.heartbeat ??
        (async () => null)
      }
    />
  );
}

describe("ClaimedLanesHeartbeat (#1114)", () => {
  it("beats claimed lanes on every local project, not only the selected one", async () => {
    const listed: string[] = [];
    const calls: { threadId: string }[] = [];
    const m = await mount(
      beat({
        projects: [{ id: "p-selected" }, { id: "p-background" }],
        listLanes: async (input) => {
          listed.push(input.projectId);
          return input.projectId === "p-background"
            ? [{ threadId: "t-other-project" }]
            : [{ threadId: "t-selected-project" }];
        },
        heartbeat: async (input) => {
          calls.push(input);
          return null;
        },
      }),
    );
    await m.flush();
    assert.deepEqual(listed.sort(), ["p-background", "p-selected"]);
    const ids = calls.map((c) => c.threadId).sort();
    assert.deepEqual(ids, ["t-other-project", "t-selected-project"]);
    m.unmount();
  });

  it("does not heartbeat a remote project mixed with local ones", async () => {
    const listed: string[] = [];
    const calls: { threadId: string }[] = [];
    const m = await mount(
      beat({
        projects: [
          { id: "p-local" },
          { id: "p-remote", remoteHost: "box.example" },
        ],
        listLanes: async (input) => {
          listed.push(input.projectId);
          return [{ threadId: `t-${input.projectId}` }];
        },
        heartbeat: async (input) => {
          calls.push(input);
          return null;
        },
      }),
    );
    await m.flush();
    assert.deepEqual(listed, ["p-local"]);
    assert.deepEqual(calls, [{ threadId: "t-p-local" }]);
    m.unmount();
  });

  it("does not heartbeat when every project is remote", async () => {
    const listed: string[] = [];
    const calls: { threadId: string }[] = [];
    const m = await mount(
      beat({
        projects: [{ id: "p-remote", remoteHost: "box.example" }],
        listLanes: async (input) => {
          listed.push(input.projectId);
          return [{ threadId: "t-remote" }];
        },
        heartbeat: async (input) => {
          calls.push(input);
          return null;
        },
      }),
    );
    await m.flush();
    assert.deepEqual(listed, []);
    assert.deepEqual(calls, []);
    m.unmount();
  });

  it("does not heartbeat when no projects are listed", async () => {
    const calls: { threadId: string }[] = [];
    const m = await mount(
      beat({
        projects: [],
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

  it("App mounts the beater with every project, above the agents pane", () => {
    const app = fs.readFileSync("src/App.tsx", "utf8");
    const mountAt = app.indexOf("<ClaimedLanesHeartbeat");
    const pane = app.indexOf('id="pane-agents"');
    assert.notEqual(mountAt, -1, "App mounts the beater so leaving the Git tab does not stop beats");
    assert.notEqual(pane, -1, "agents pane is present");
    assert.ok(
      mountAt < pane,
      "beater is not gated on the agents rail being expanded",
    );
    const snippet = app.slice(mountAt, mountAt + 280);
    assert.match(
      snippet,
      /projects=\{projects\}/,
      "beater receives the full project list, not only the selected project",
    );
    assert.doesNotMatch(
      snippet,
      /projectId=\{project\?\.id/,
      "selected-project-only wiring would leave background local projects unbeaten",
    );
  });

  it("does not call recycleWedgedLanes from the beater", () => {
    const src = fs.readFileSync("src/components/LaneHeartbeat.tsx", "utf8");
    const start = src.indexOf("export function ClaimedLanesHeartbeat");
    assert.ok(start >= 0, "ClaimedLanesHeartbeat is exported");
    const next = src.indexOf("\nexport function ", start + 1);
    const body = next >= 0 ? src.slice(start, next) : src.slice(start);
    assert.doesNotMatch(body, /recycleWedgedLanes/);
    assert.doesNotMatch(body, /completeIssue|completeThreadIssue/);
    assert.match(
      body,
      /setInterval\([^,]+, LANE_HEARTBEAT_MS\)/,
      "listed lanes share the 15s LaneHeartbeat / runner stall cadence",
    );
    assert.match(
      body,
      /listLanes/,
      "re-lists claimed lanes so a new background claim is beaten without the Git tab",
    );
  });

  it("uses the same 15s interval as LaneHeartbeat", () => {
    assert.equal(LANE_HEARTBEAT_MS, 15_000);
    const src = fs.readFileSync("src/components/LaneHeartbeat.tsx", "utf8");
    assert.match(src, /export const LANE_HEARTBEAT_MS = 15_000/);
  });
});
