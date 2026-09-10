/**
 * T3 thread-action item list: Snooze is a parent with children, not a
 * first-level dump of presets.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildThreadActionMenuItems } from "../src/threadActionMenu";
import type { ProviderInfo, ThreadInfo } from "../src/shared/ipc";

const thread = {
  id: "t1",
  title: "one",
  provider: "claude",
  status: "idle",
} as ThreadInfo;

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
  {
    id: "grok",
    name: "Grok",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

const presets = [
  { id: "hour", label: "In 1 hour", whenLabel: "3:04pm", until: 1 },
];

describe("buildThreadActionMenuItems (T3 contract)", () => {
  it("puts snooze presets on Snooze children, not the first level", () => {
    const items = buildThreadActionMenuItems({
      thread,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: true,
      showFork: true,
      showRename: true,
      showMute: true,
      showSettle: true,
    });
    const snooze = items.find((i) => i.id === "snooze");
    assert.ok(snooze, "Snooze parent");
    assert.equal(
      items.some((i) => i.id.startsWith("snooze:")),
      false,
      "presets must not sit on the first level",
    );
    assert.ok(snooze.children?.some((c) => c.id === "snooze:hour"));
    assert.ok(items.some((i) => i.id === "fork"));
    assert.ok(items.some((i) => i.id === "handoff:grok"));
  });

  it("offers Eject to terminal when showEject is on", () => {
    const items = buildThreadActionMenuItems({
      thread,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: false,
      showFork: false,
      showRename: false,
      showMute: false,
      showEject: true,
      showSettle: false,
    });
    const eject = items.find((i) => i.id === "eject");
    assert.ok(eject, "Eject to terminal");
    assert.equal(eject?.label, "Eject to terminal");
  });

  it("already-ejected threads show Reclaim, not Eject", () => {
    const items = buildThreadActionMenuItems({
      thread: { ...thread, ejected: true } as ThreadInfo,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: false,
      showFork: false,
      showRename: false,
      showMute: false,
      showEject: true,
      showSettle: false,
    });
    assert.ok(items.some((i) => i.id === "reclaim"));
    assert.equal(items.some((i) => i.id === "eject"), false);
  });

  it("already-snoozed threads show Wake, not a Snooze submenu", () => {
    const items = buildThreadActionMenuItems({
      thread: { ...thread, snoozedUntil: Date.now() + 1000 } as ThreadInfo,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: true,
      showFork: false,
      showRename: false,
      showMute: false,
      showSettle: false,
    });
    assert.ok(items.some((i) => i.id === "unsnooze"));
    assert.equal(items.some((i) => i.id === "snooze"), false);
  });

  it("Move to project lists other projects and omits the current one (#737)", () => {
    const items = buildThreadActionMenuItems({
      thread: { ...thread, projectId: "p1" } as ThreadInfo,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: false,
      showFork: false,
      showRename: false,
      showMute: false,
      showSettle: false,
      showMove: true,
      projects: [
        { id: "p1", slug: "acme/ledger", name: "ledger", path: "/tmp/ledger" },
        { id: "p2", slug: "acme/billing", name: "billing", path: "/tmp/billing" },
      ],
    });
    const move = items.find((i) => i.id === "move");
    assert.ok(move, "Move to project…");
    assert.equal(move?.label, "Move to project…");
    assert.deepEqual(
      (move?.children ?? []).map((c) => c.id),
      ["project:p2"],
    );
    assert.equal(items.some((i) => i.id === "project:p2"), false);
  });

  it("hides Move to project when there is no other project", () => {
    const items = buildThreadActionMenuItems({
      thread: { ...thread, projectId: "p1" } as ThreadInfo,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: false,
      showFork: false,
      showRename: false,
      showMute: false,
      showSettle: false,
      showMove: true,
      projects: [
        { id: "p1", slug: "acme/ledger", name: "ledger", path: "/tmp/ledger" },
      ],
    });
    assert.equal(items.some((i) => i.id === "move"), false);
  });

  it("disables Move to project when the thread has a worktree (#737)", () => {
    const items = buildThreadActionMenuItems({
      thread: {
        ...thread,
        projectId: "p1",
        worktreePath: "/tmp/wt",
      } as ThreadInfo,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: false,
      showFork: false,
      showRename: false,
      showMute: false,
      showSettle: false,
      showMove: true,
      projects: [
        { id: "p1", slug: "acme/ledger", name: "ledger", path: "/tmp/ledger" },
        { id: "p2", slug: "acme/billing", name: "billing", path: "/tmp/billing" },
      ],
    });
    const move = items.find((i) => i.id === "move");
    assert.ok(move);
    assert.equal(move?.disabled, true);
    assert.equal(move?.whenLabel, "Has a worktree in this project");
    assert.equal(move?.children, undefined);
  });

  it("disables Move to project while a run is active (#737)", () => {
    const items = buildThreadActionMenuItems({
      thread: {
        ...thread,
        projectId: "p1",
        status: "working",
      } as ThreadInfo,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: false,
      showFork: false,
      showRename: false,
      showMute: false,
      showSettle: false,
      showMove: true,
      projects: [
        { id: "p1", slug: "acme/ledger", name: "ledger", path: "/tmp/ledger" },
        { id: "p2", slug: "acme/billing", name: "billing", path: "/tmp/billing" },
      ],
    });
    const move = items.find((i) => i.id === "move");
    assert.ok(move);
    assert.equal(move?.disabled, true);
    assert.equal(move?.whenLabel, "Run is active");
    assert.equal(move?.children, undefined);
  });

  it("disables Move to project on a pending crew worker (#737)", () => {
    const items = buildThreadActionMenuItems({
      thread: {
        ...thread,
        projectId: "p1",
        orchWorker: true,
        pendingWorktree: true,
        leadSnapshotSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      } as ThreadInfo,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: false,
      showFork: false,
      showRename: false,
      showMute: false,
      showSettle: false,
      showMove: true,
      projects: [
        { id: "p1", slug: "acme/ledger", name: "ledger", path: "/tmp/ledger" },
        { id: "p2", slug: "acme/billing", name: "billing", path: "/tmp/billing" },
      ],
    });
    const move = items.find((i) => i.id === "move");
    assert.ok(move);
    assert.equal(move?.disabled, true);
    assert.equal(move?.whenLabel, "Crew worker");
    assert.equal(move?.children, undefined);
  });
});
