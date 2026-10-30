/**
 * Thread-action item list: Snooze is a parent with children, not a
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

describe("buildThreadActionMenuItems (contract)", () => {
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
    assert.ok(
      snooze.children?.some((c) => c.id === "snooze:custom"),
      "Custom… lives alongside the presets (#1766)",
    );
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

  it("offers Teleport to each saved host, and Teleport back once away (#1702)", () => {
    const base = {
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: false,
      showFork: false,
      showRename: false,
      showMute: false,
      showSettle: false,
    };
    const targets = [
      { host: "box", remotePort: 4620, label: "box" },
      { host: "me@vm", remotePort: 4620, label: "Build VM" },
    ];
    const ready = { ...thread, worktreePath: "/wt" } as ThreadInfo;
    const go = buildThreadActionMenuItems({ ...base, thread: ready, teleportTargets: targets })
      .find((i) => i.id === "teleport");
    assert.deepEqual(go?.children?.map((c) => [c.id, c.label, c.whenLabel]), [
      ["teleport:0", "box", undefined],
      ["teleport:1", "Build VM", "me@vm"],
    ]);
    const noWt = buildThreadActionMenuItems({ ...base, thread, teleportTargets: targets })
      .find((i) => i.id === "teleport");
    assert.equal(noWt?.disabled, true);
    assert.equal(noWt?.whenLabel, "Needs a worktree");
    const codex = { ...ready, provider: "codex" } as ThreadInfo;
    assert.equal(buildThreadActionMenuItems({ ...base, thread: codex, teleportTargets: targets })
      .some((i) => i.id === "teleport"), false);
    assert.equal(buildThreadActionMenuItems({ ...base, thread: ready, teleportTargets: [] })
      .some((i) => i.id === "teleport"), false);
    const away = { ...ready, teleportedTo: { ...targets[1], threadId: "r1" } } as ThreadInfo;
    const back = buildThreadActionMenuItems({ ...base, thread: away, teleportTargets: [] })
      .find((i) => i.id === "teleportBack");
    assert.equal(back?.label, "Teleport back from Build VM");
    assert.equal(back?.disabled, false);
    const sending = { ...away, teleportedTo: { ...targets[1], pending: true } } as ThreadInfo;
    assert.equal(buildThreadActionMenuItems({ ...base, thread: sending, teleportTargets: [] })
      .find((i) => i.id === "teleportBack")?.disabled, true);
    assert.equal(buildThreadActionMenuItems({ ...base, thread: away })
      .some((i) => i.id === "teleportBack"), false, "hidden without an onTeleport");
  });
});
