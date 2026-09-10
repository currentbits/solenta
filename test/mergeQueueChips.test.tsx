/**
 * Lead-facing merge-queue chips (#346 / #1115): claim a numbered lane,
 * preview it onto the main checkout, restore, recycle wedged lanes.
 * Chips show lane n, PORT, path, and branch. Promote stays
 * git.mergeWorktree (not on this card).
 *
 * Run: node --import=./test/support/render.mjs --test test/mergeQueueChips.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { MergeQueueCard } from "../src/components/AgentsPanel";
import type {
  MergeLaneClaim,
  MergeLaneInfo,
  MergeLanePreview,
  MergeLaneRecycle,
  MergeLaneRestore,
  MergeSpotlight,
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
  claim?: (input: { threadId: string }) => Promise<MergeLaneClaim>;
  list?: (input: { projectId: string }) => Promise<MergeLaneInfo[]>;
  preview?: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
  restore?: (input: { projectId: string }) => Promise<MergeLaneRestore>;
  recycle?: (input: { projectId: string }) => Promise<MergeLaneRecycle[]>;
  spotlight?: boolean;
  setSpotlight?: (input: {
    projectId: string;
    enabled: boolean;
  }) => Promise<MergeSpotlight>;
  spotlightLane?: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
}) {
  let lanes = opts.lanes ?? [];
  return (
    <MergeQueueCard
      threadId={opts.threadId === undefined ? "t1" : opts.threadId}
      projectId={opts.projectId === undefined ? "p1" : opts.projectId}
      remote={opts.remote}
      claimLane={
        opts.claim ??
        (async (input) => {
          const claimed = {
            n: 1,
            port: 3001,
            path: "/tmp/lane-1",
            branch: "lane/1",
          };
          lanes = [
            lane({
              n: claimed.n,
              port: claimed.port,
              threadId: input.threadId,
              path: claimed.path,
              branch: claimed.branch,
            }),
          ];
          return claimed;
        })
      }
      listLanes={opts.list ?? (async () => lanes)}
      previewLane={
        opts.preview ??
        (async (input) => ({
          lane: input.lane,
          sha: "abc",
          files: ["src/a.ts"],
          path: "/tmp/repo",
        }))
      }
      restorePreview={
        opts.restore ?? (async () => ({ restored: true, sha: "abc" }))
      }
      recycleWedgedLanes={
        opts.recycle ?? (async () => [])
      }
      spotlight={opts.spotlight}
      setSpotlight={opts.setSpotlight}
      spotlightLane={opts.spotlightLane}
    />
  );
}

describe("MergeQueueCard (#346)", () => {
  it("claims a numbered lane and shows lane n and PORT", async () => {
    const claims: { threadId: string }[] = [];
    const m = await mount(
      card({
        lanes: [],
        claim: async (input) => {
          claims.push(input);
          return { n: 2, port: 3002, path: "/tmp/lane-2", branch: "lane/2" };
        },
        list: async () => [],
      }),
    );
    await m.flush();
    const claimBtn = m.query("[data-lane-claim]");
    assert.ok(claimBtn, "Claim chip is present when the thread has no lane");
    await m.click(claimBtn);
    assert.deepEqual(claims, [{ threadId: "t1" }]);
    const chip = m.query("[data-lane-chip='2']");
    assert.ok(chip, "claimed lane chip");
    assert.match((chip!.textContent || "").replace(/\s+/g, " "), /lane 2/);
    assert.match((chip!.textContent || "").replace(/\s+/g, " "), /PORT 3002/);
    m.unmount();
  });

  it("lists claimed lanes with lane n, PORT, path, and branch", async () => {
    const m = await mount(
      card({
        lanes: [
          lane({ n: 1, port: 3001, threadId: "t1", path: "/tmp/lane-1", branch: "lane/1" }),
          lane({ n: 3, port: 3003, threadId: "t9", path: "/tmp/lane-3", branch: "lane/3" }),
        ],
      }),
    );
    await m.flush();
    const one = m.query("[data-lane-chip='1']");
    const three = m.query("[data-lane-chip='3']");
    assert.ok(one && three, "both lane chips");
    assert.match((one!.textContent || "").replace(/\s+/g, " "), /lane 1/);
    assert.match((one!.textContent || "").replace(/\s+/g, " "), /PORT 3001/);
    assert.match((one!.textContent || "").replace(/\s+/g, " "), /\/tmp\/lane-1/);
    assert.match((one!.textContent || "").replace(/\s+/g, " "), /lane\/1/);
    assert.match((three!.textContent || "").replace(/\s+/g, " "), /lane 3/);
    assert.match((three!.textContent || "").replace(/\s+/g, " "), /PORT 3003/);
    assert.match((three!.textContent || "").replace(/\s+/g, " "), /\/tmp\/lane-3/);
    assert.match((three!.textContent || "").replace(/\s+/g, " "), /lane\/3/);
    assert.equal(one!.getAttribute("data-lane-current"), "true");
    assert.equal(three!.getAttribute("data-lane-current"), null);
    assert.equal(m.query("[data-lane-claim]"), null);
    m.unmount();
  });

  it("previews a lane onto the main checkout", async () => {
    const previews: { projectId: string; lane: number }[] = [];
    const m = await mount(
      card({
        lanes: [lane()],
        preview: async (input) => {
          previews.push(input);
          return {
            lane: input.lane,
            sha: "def",
            files: ["src/a.ts"],
            path: "/tmp/repo",
          };
        },
      }),
    );
    await m.flush();
    const previewBtn = m.query("[data-lane-preview='1']");
    assert.ok(previewBtn, "Preview chip");
    await m.click(previewBtn);
    assert.deepEqual(previews, [{ projectId: "p1", lane: 1 }]);
    m.unmount();
  });

  it("restores the main checkout after a preview", async () => {
    const restores: { projectId: string }[] = [];
    const m = await mount(
      card({
        lanes: [lane()],
        restore: async (input) => {
          restores.push(input);
          return { restored: true, sha: "abc" };
        },
      }),
    );
    await m.flush();
    const restoreBtn = m.query("[data-lane-restore]");
    assert.ok(restoreBtn, "Restore chip");
    await m.click(restoreBtn);
    assert.deepEqual(restores, [{ projectId: "p1" }]);
    m.unmount();
  });

  it("omits path and branch on the chip when listLanes returns null", async () => {
    const m = await mount(
      card({
        lanes: [lane({ path: null, branch: null })],
      }),
    );
    await m.flush();
    const chip = m.query("[data-lane-chip='1']");
    assert.ok(chip, "lane chip");
    const text = (chip!.textContent || "").replace(/\s+/g, " ");
    assert.match(text, /lane 1/);
    assert.match(text, /PORT 3001/);
    assert.equal(m.query("[data-lane-path]"), null);
    assert.equal(m.query("[data-lane-branch]"), null);
    m.unmount();
  });

  it("recycles wedged lanes via recycleWedgedLanes and refreshes the list", async () => {
    const recycles: { projectId: string }[] = [];
    let lanes = [lane()];
    const m = await mount(
      card({
        lanes,
        list: async () => lanes,
        recycle: async (input) => {
          recycles.push(input);
          lanes = [];
          return [{ n: 1, threadId: "t1" }];
        },
      }),
    );
    await m.flush();
    const recycleBtn = m.query("[data-lane-recycle]");
    assert.ok(recycleBtn, "Recycle chip");
    await m.click(recycleBtn);
    assert.deepEqual(recycles, [{ projectId: "p1" }]);
    await m.flush();
    assert.equal(m.query("[data-lane-chip='1']"), null);
    m.unmount();
  });

  it("does not offer promote or mergeWorktree", async () => {
    const m = await mount(card({ lanes: [lane()] }));
    await m.flush();
    assert.equal(m.query("[data-lane-promote]"), null);
    assert.equal(m.query("[data-merge-worktree]"), null);
    const labels = (m.text() || "").toLowerCase();
    assert.ok(!labels.includes("promote"));
    assert.ok(!labels.includes("merge worktree"));
    m.unmount();
  });

  it("is hidden on a remote project", async () => {
    const m = await mount(card({ remote: true, lanes: [lane()] }));
    await m.flush();
    assert.equal(m.query("[data-lanes]"), null);
    assert.equal(m.query("[data-lane-claim]"), null);
    m.unmount();
  });

  it("is hidden without a project", async () => {
    const m = await mount(card({ projectId: null }));
    await m.flush();
    assert.equal(m.query("[data-lanes]"), null);
    m.unmount();
  });

  it("opts into Spotlight per repo and previews through spotlightLane", async () => {
    const toggles: { projectId: string; enabled: boolean }[] = [];
    const spots: { projectId: string; lane: number }[] = [];
    const previews: { projectId: string; lane: number }[] = [];
    const m = await mount(
      card({
        lanes: [lane()],
        spotlight: false,
        setSpotlight: async (input) => {
          toggles.push(input);
          return { spotlight: input.enabled };
        },
        spotlightLane: async (input) => {
          spots.push(input);
          return {
            lane: input.lane,
            sha: "spot",
            files: ["from-a.txt"],
            path: "/tmp/repo",
            spotlight: true,
          };
        },
        preview: async (input) => {
          previews.push(input);
          return {
            lane: input.lane,
            sha: "abc",
            files: ["src/a.ts"],
            path: "/tmp/repo",
          };
        },
      }),
    );
    await m.flush();
    const box = m.query("[data-lane-spotlight]") as HTMLInputElement | null;
    assert.ok(box, "Spotlight opt-in is on the Lanes card");
    assert.equal(box.checked, false);
    await m.click(box);
    assert.deepEqual(toggles, [{ projectId: "p1", enabled: true }]);
    m.unmount();

    const on = await mount(
      card({
        lanes: [lane()],
        spotlight: true,
        setSpotlight: async (input) => ({ spotlight: input.enabled }),
        spotlightLane: async (input) => {
          spots.push(input);
          return {
            lane: input.lane,
            sha: "spot",
            files: ["from-a.txt"],
            path: "/tmp/repo",
            spotlight: true,
          };
        },
        preview: async (input) => {
          previews.push(input);
          return {
            lane: input.lane,
            sha: "abc",
            files: ["src/a.ts"],
            path: "/tmp/repo",
          };
        },
      }),
    );
    await on.flush();
    const onBox = on.query("[data-lane-spotlight]") as HTMLInputElement | null;
    assert.ok(onBox && onBox.checked, "opt-in is checked when the project flag is on");
    await on.click(on.query("[data-lane-preview='1']"));
    assert.deepEqual(spots, [{ projectId: "p1", lane: 1 }]);
    assert.deepEqual(previews, []);
    on.unmount();
  });
});
