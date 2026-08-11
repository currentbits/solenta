/**
 * Round 46 pure selection helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildVisibleThreadIds,
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
  it("matches render order across pinned, two projects, snoozed, settled", () => {
    // Fixture: pinned mid, two projects, snoozed, settled — interesting not index 0.
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
        threads: [b1],
      },
    ];

    const ids = buildVisibleThreadIds({
      pinned: [pin],
      groups,
      collapsedGroupKeys: new Set(),
      showArchivedKeys: new Set(),
      snoozed: [sn],
      snoozedOpen: true,
      selectedSnoozedId: null,
      settled: [st],
      settledOpen: true,
      settledVisibleCount: 10,
      selectedSettledId: null,
    });

    assert.deepEqual(ids, [
      "pin-a",
      "a-noise",
      "a-mid",
      "b-mid",
      "snooze-x",
      "settled-y",
    ]);
  });

  it("skips collapsed groups; carve-outs when shelves collapsed", () => {
    const ids = buildVisibleThreadIds({
      pinned: [],
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
      showArchivedKeys: new Set(),
      snoozed: [t("sn1"), t("sn2")],
      snoozedOpen: false,
      selectedSnoozedId: "sn2",
      settled: [t("st1"), t("st2")],
      settledOpen: false,
      settledVisibleCount: 10,
      selectedSettledId: "st1",
    });
    assert.deepEqual(ids, ["shown", "sn2", "st1"]);
  });

  it("paged settled tail contributes only the visible page (M3)", () => {
    // More settled rows than the page size — slice must drop the rest.
    const settled = [
      t("st-page-0", { projectId: "p1", status: "done", settledAt: NOW }),
      t("st-page-1", { projectId: "p1", status: "done", settledAt: NOW - 1 }),
      t("st-page-2", { projectId: "p2", status: "done", settledAt: NOW - 2 }),
      t("st-page-3", { projectId: "p2", status: "done", settledAt: NOW - 3 }),
      t("st-page-4", { projectId: "p2", status: "done", settledAt: NOW - 4 }),
    ];
    const ids = buildVisibleThreadIds({
      pinned: [],
      groups: [
        {
          project: { id: "p1", slug: "a", name: "a", path: "/a" },
          threads: [t("attn-noise", { projectId: "p1" })],
        },
      ],
      collapsedGroupKeys: new Set(),
      showArchivedKeys: new Set(),
      snoozed: [],
      snoozedOpen: false,
      selectedSnoozedId: null,
      settled,
      settledOpen: true,
      settledVisibleCount: 2,
      selectedSettledId: null,
    });
    assert.deepEqual(ids, ["attn-noise", "st-page-0", "st-page-1"]);
    assert.equal(ids.includes("st-page-2"), false);
    assert.equal(ids.includes("st-page-4"), false);
  });

  it("collapsed archived contribute nothing until expanded (M11)", () => {
    const groups: SidebarGroup[] = [
      {
        project: { id: "p1", slug: "a", name: "a", path: "/a" },
        threads: [
          t("attn-a", { projectId: "p1" }),
          t("arch-hidden", { projectId: "p1", archived: true }),
          t("arch-also", { projectId: "p1", archived: true }),
        ],
      },
      {
        project: { id: "p2", slug: "b", name: "b", path: "/b" },
        threads: [
          t("attn-b", { projectId: "p2" }),
          t("arch-b", { projectId: "p2", archived: true }),
        ],
      },
    ];

    const collapsed = buildVisibleThreadIds({
      pinned: [t("pin-x", { pinnedAt: NOW, projectId: "p2" })],
      groups,
      collapsedGroupKeys: new Set(),
      showArchivedKeys: new Set(),
      snoozed: [],
      snoozedOpen: false,
      selectedSnoozedId: null,
      settled: [],
      settledOpen: false,
      settledVisibleCount: 10,
      selectedSettledId: null,
    });
    assert.deepEqual(collapsed, ["pin-x", "attn-a", "attn-b"]);
    assert.equal(collapsed.includes("arch-hidden"), false);
    assert.equal(collapsed.includes("arch-b"), false);

    const expanded = buildVisibleThreadIds({
      pinned: [t("pin-x", { pinnedAt: NOW, projectId: "p2" })],
      groups,
      collapsedGroupKeys: new Set(),
      showArchivedKeys: new Set(["p1"]),
      snoozed: [],
      snoozedOpen: false,
      selectedSnoozedId: null,
      settled: [],
      settledOpen: false,
      settledVisibleCount: 10,
      selectedSettledId: null,
    });
    assert.deepEqual(expanded, [
      "pin-x",
      "attn-a",
      "arch-hidden",
      "arch-also",
      "attn-b",
    ]);
    assert.equal(expanded.includes("arch-b"), false, "p2 still collapsed");
  });
});

describe("rangeSelectIds", () => {
  it("selects inclusive range across section boundary order", () => {
    const ordered = ["pin-a", "a-mid", "b-mid", "settled-y"];
    // Anchor in project attention, shift into settled tail.
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
