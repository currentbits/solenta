/**
 * Round 46 pure selection helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildVisibleThreadIds,
  flatVisibleThreadIds,
  formatBatchSettleFeedback,
  isShortcutBlocked,
  planBatchSettle,
  rangeSelectIds,
  stepVisibleId,
  toggleIdInSet,
} from "../src/sidebarSelection.ts";
import type { ThreadInfo } from "../src/shared/ipc.ts";
import type { SidebarGroup } from "../src/sidebarGroups.ts";

const NOW = 1_700_000_000_000;

function t(
  id: string,
  over: Partial<ThreadInfo> = {},
): ThreadInfo {
  return {
    id,
    projectId: over.projectId ?? "p1",
    title: id,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: over.status ?? "idle",
    createdAt: NOW,
    updatedAt: NOW,
    runStartedAt: null,
    archived: over.archived ?? false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: over.pinnedAt ?? null,
    snoozedUntil: over.snoozedUntil ?? null,
    snoozedAt: over.snoozedAt ?? null,
    lastVisitedAt: NOW,
    prState: over.prState ?? null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

describe("buildVisibleThreadIds", () => {
  it("matches render order: per-group attention (pinned first in group) then Later shelf", () => {
    // Fixture: pinned mid-list inside its group, two projects, Later shelf
    // with a snoozed and a settled row — interesting case not index 0.
    const pin = t("pin-a", { pinnedAt: NOW - 100, projectId: "p2" });
    const a1 = t("a-noise", { projectId: "p1" });
    const a2 = t("a-mid", { projectId: "p1" });
    const b1 = t("b-mid", { projectId: "p2" });
    const sn = t("snooze-x", {
      projectId: "p1",
      snoozedUntil: NOW + 9999,
      snoozedAt: NOW,
    });
    const st = t("settled-y", {
      projectId: "p2",
      status: "done",
      prState: "MERGED",
      settledAt: NOW,
    });

    const groups: SidebarGroup[] = [
      {
        project: {
          id: "p1",
          slug: "acme/a",
          name: "a",
          path: "/a",
        },
        threads: [a1, a2],
      },
      {
        project: {
          id: "p2",
          slug: "acme/b",
          name: "b",
          path: "/b",
        },
        // buildSidebarGroups sorts pinned rows first within the group.
        threads: [pin, b1],
      },
    ];

    const ids = buildVisibleThreadIds({
      groups,
      collapsedGroupKeys: new Set(),
      later: [sn, st],
      laterOpen: true,
      laterVisibleCount: 10,
      selectedLaterId: null,
    });

    assert.deepEqual(ids, [
      "a-noise",
      "a-mid",
      "pin-a",
      "b-mid",
      "snooze-x",
      "settled-y",
    ]);
  });

  it("skips collapsed groups; carve-out when the Later shelf is closed", () => {
    const ids = buildVisibleThreadIds({
      groups: [
        {
          project: { id: "p1", slug: "a", name: "a", path: "/a" },
          threads: [t("hidden", { projectId: "p1" })],
        },
        {
          project: { id: "p2", slug: "b", name: "b", path: "/b" },
          threads: [t("shown", { projectId: "p2" })],
        },
      ],
      collapsedGroupKeys: new Set(["p1"]),
      later: [t("sn1"), t("sn2"), t("st1"), t("st2")],
      laterOpen: false,
      laterVisibleCount: 10,
      selectedLaterId: "sn2",
    });
    assert.deepEqual(ids, ["shown", "sn2"], "closed shelf shows only the selected row");
  });

  it("paged Later shelf contributes only the visible page", () => {
    // More Later rows than the page size — slice must drop the rest.
    const later = [
      t("lt-page-0", { projectId: "p1", status: "done", settledAt: NOW }),
      t("lt-page-1", { projectId: "p1", status: "done", settledAt: NOW - 1 }),
      t("lt-page-2", { projectId: "p2", status: "done", settledAt: NOW - 2 }),
      t("lt-page-3", { projectId: "p2", status: "done", settledAt: NOW - 3 }),
      t("lt-page-4", { projectId: "p2", status: "done", settledAt: NOW - 4 }),
    ];
    const ids = buildVisibleThreadIds({
      groups: [
        {
          project: { id: "p1", slug: "a", name: "a", path: "/a" },
          threads: [t("attn-noise", { projectId: "p1" })],
        },
      ],
      collapsedGroupKeys: new Set(),
      later,
      laterOpen: true,
      laterVisibleCount: 2,
      selectedLaterId: null,
    });
    assert.deepEqual(ids, ["attn-noise", "lt-page-0", "lt-page-1"]);
    assert.equal(ids.includes("lt-page-2"), false);
    assert.equal(ids.includes("lt-page-4"), false);
  });

  it("group archived rows appear only when searching; shelf skipped in search", () => {
    const groups: SidebarGroup[] = [
      {
        project: { id: "p1", slug: "a", name: "a", path: "/a" },
        threads: [
          t("attn-a", { projectId: "p1" }),
          t("arch-hit", { projectId: "p1", archived: true }),
          t("arch-also", { projectId: "p1", archived: true }),
        ],
      },
      {
        project: { id: "p2", slug: "b", name: "b", path: "/b" },
        threads: [
          t("pin-x", { pinnedAt: NOW, projectId: "p2" }),
          t("attn-b", { projectId: "p2" }),
        ],
      },
    ];
    const later = [t("shelf-row", { projectId: "p1", status: "done", settledAt: NOW })];

    const normal = buildVisibleThreadIds({
      groups,
      collapsedGroupKeys: new Set(),
      later,
      laterOpen: true,
      laterVisibleCount: 10,
      selectedLaterId: null,
    });
    assert.deepEqual(
      normal,
      ["attn-a", "pin-x", "attn-b", "shelf-row"],
      "non-search: archived never render inside groups (they live in Later)",
    );

    const searching = buildVisibleThreadIds({
      groups,
      collapsedGroupKeys: new Set(["p1"]), // collapse ignored while searching
      later,
      laterOpen: true,
      laterVisibleCount: 10,
      selectedLaterId: null,
      searching: true,
    });
    assert.deepEqual(
      searching,
      ["attn-a", "arch-hit", "arch-also", "pin-x", "attn-b"],
      "search: archived hits flatten in after each group's attention; no shelf",
    );
    assert.equal(searching.includes("shelf-row"), false, "shelf skipped in search");
  });
});

describe("rangeSelectIds", () => {
  it("selects inclusive range across section boundary order", () => {
    const ordered = ["pin-a", "a-mid", "b-mid", "settled-y"];
    // Anchor in project attention, shift into the Later shelf.
    assert.deepEqual(rangeSelectIds(ordered, "a-mid", "settled-y"), [
      "a-mid",
      "b-mid",
      "settled-y",
    ]);
    assert.deepEqual(rangeSelectIds(ordered, "settled-y", "a-mid"), [
      "a-mid",
      "b-mid",
      "settled-y",
    ]);
  });
});

describe("planBatchSettle", () => {
  it("skips working threads", () => {
    const map = new Map([
      ["a", t("a", { status: "idle" })],
      ["b", t("b", { status: "working", runStartedAt: NOW })],
      ["c", t("c", { status: "done" })],
    ]);
    const plan = planBatchSettle(["a", "b", "c"], map);
    assert.deepEqual(plan.toSettle, ["a", "c"]);
    assert.equal(plan.skippedWorking, 1);
    assert.equal(
      formatBatchSettleFeedback(2, 1),
      "2 settled · 1 skipped (running)",
    );
  });
});

describe("stepVisibleId wrap", () => {
  it("wraps at ends", () => {
    const ids = ["a", "b", "c"];
    assert.equal(stepVisibleId(ids, "c", 1), "a");
    assert.equal(stepVisibleId(ids, "a", -1), "c");
  });
});

describe("toggleIdInSet", () => {
  it("adds and removes", () => {
    const s = toggleIdInSet(new Set(["a"]), "b");
    assert.ok(s.has("a") && s.has("b"));
    assert.equal(toggleIdInSet(s, "a").has("a"), false);
  });
});

describe("isShortcutBlocked", () => {
  it("blocks when a dialog is open", () => {
    // jsdom may not have document.querySelector dialog — unit without DOM.
    assert.equal(isShortcutBlocked(null, true), true);
  });
});

describe("buildVisibleThreadIds group overflow cap (issue #70)", () => {
  const bigGroup = (n: number): SidebarGroup => ({
    project: { id: "p1", slug: "acme/a", name: "a", path: "/a" },
    // createdAt desc like the real group builder: t0 newest … t(n-1) oldest.
    threads: Array.from({ length: n }, (_, i) =>
      t(`t${i}`, { createdAt: NOW - i, updatedAt: NOW - i }),
    ),
  });

  const baseInput = {
    collapsedGroupKeys: new Set<string>(),
    later: [],
    laterOpen: false,
    laterVisibleCount: 0,
    selectedLaterId: null,
  };

  it("a capped group contributes only the newest 8 attention threads", () => {
    const ids = buildVisibleThreadIds({ ...baseInput, groups: [bigGroup(12)] });
    assert.deepEqual(ids, ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
  });

  it("an expanded group contributes all attention threads", () => {
    const ids = buildVisibleThreadIds({
      ...baseInput,
      groups: [bigGroup(12)],
      expandedGroupKeys: new Set(["p1"]),
    });
    assert.equal(ids.length, 12);
    assert.equal(ids[11], "t11");
  });

  it("keepThreadIds carve-out keeps the open thread visible past the cap", () => {
    const ids = buildVisibleThreadIds({
      ...baseInput,
      groups: [bigGroup(12)],
      keepThreadIds: ["t10"],
    });
    assert.equal(ids.length, 11);
    assert.equal(ids[10], "t10");
    assert.ok(!ids.includes("t11"));
  });

  it("search mode ignores the cap", () => {
    const ids = buildVisibleThreadIds({
      ...baseInput,
      groups: [bigGroup(12)],
      searching: true,
    });
    assert.equal(ids.length, 12);
  });

  it("groups at the cap are untouched", () => {
    const ids = buildVisibleThreadIds({ ...baseInput, groups: [bigGroup(8)] });
    assert.equal(ids.length, 8);
  });
});

describe("flatVisibleThreadIds (T3 flat sidebar)", () => {
  const flat = {
    pinned: [t("pin1")],
    active: [t("a1"), t("a2")],
    snoozed: [t("z1")],
    settled: [t("s1"), t("s2")],
    archived: [t("arc1")],
  };

  it("orders pinned, active, then open shelves with settled paging", () => {
    const ids = flatVisibleThreadIds({
      flat,
      snoozedOpen: true,
      settledOpen: true,
      settledVisibleCount: 2,
    });
    assert.deepEqual(ids, ["pin1", "a1", "a2", "z1", "s1", "s2"]);
  });

  it("archived rows page in at the settled tail", () => {
    const ids = flatVisibleThreadIds({
      flat,
      snoozedOpen: true,
      settledOpen: true,
      settledVisibleCount: 10,
    });
    assert.deepEqual(ids, ["pin1", "a1", "a2", "z1", "s1", "s2", "arc1"]);
  });

  it("collapsed shelves contribute only the selected thread", () => {
    const ids = flatVisibleThreadIds({
      flat,
      snoozedOpen: false,
      settledOpen: false,
      settledVisibleCount: 10,
      selectedThreadId: "s2",
    });
    assert.deepEqual(ids, ["pin1", "a1", "a2", "s2"]);
  });

  it("keepThreadIds carve out a revealed thread on a collapsed shelf", () => {
    const ids = flatVisibleThreadIds({
      flat,
      snoozedOpen: false,
      settledOpen: false,
      settledVisibleCount: 10,
      selectedThreadId: null,
      keepThreadIds: ["z1"],
    });
    assert.deepEqual(ids, ["pin1", "a1", "a2", "z1"]);
  });

  it("selected thread past the page cap is carved out", () => {
    const ids = flatVisibleThreadIds({
      flat,
      snoozedOpen: false,
      settledOpen: true,
      settledVisibleCount: 1,
      selectedThreadId: "arc1",
    });
    assert.deepEqual(ids, ["pin1", "a1", "a2", "s1", "arc1"]);
  });
});
