/**
 * Named sidebar filter views (#939).
 * Run: node --experimental-strip-types --test test/sidebarViews.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterThreads } from "../src/sidebarFilters.ts";
import {
  ACTIVE_SAVED_VIEW_KEY,
  SAVED_VIEWS_KEY,
  addSavedView,
  criteriaEqual,
  criteriaToFilter,
  deleteSavedView,
  normalizeViewName,
  parseActiveSavedViewId,
  parseSavedViews,
  renameSavedView,
  savedViewTriggerLabel,
  savedViewUnavailable,
  serializeSavedViews,
  updateSavedView,
  type SavedView,
  type SavedViewCriteria,
} from "../src/sidebarViews.ts";
import type { ThreadInfo } from "../src/shared/ipc.ts";

function criteria(
  over: Partial<SavedViewCriteria> = {},
): SavedViewCriteria {
  return {
    status: over.status ?? null,
    providers: over.providers ?? [],
    projectId: over.projectId ?? null,
    tag: over.tag ?? null,
    query: over.query ?? "",
    groupBy: over.groupBy ?? "none",
  };
}

function thread(
  partial: Partial<ThreadInfo> & Pick<ThreadInfo, "id">,
): ThreadInfo {
  const createdAt = partial.createdAt ?? 100;
  const updatedAt = partial.updatedAt ?? createdAt;
  return {
    projectId: "p1",
    title: partial.title ?? partial.id,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    lastError: null,
    createdAt,
    updatedAt,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    handoffFrom: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: updatedAt,
    muted: false,
    ejected: false,
    notes: "",
    tags: [],
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...partial,
  };
}

describe("parseSavedViews", () => {
  it("returns empty for missing, blank, or corrupt storage", () => {
    assert.deepEqual(parseSavedViews(null), []);
    assert.deepEqual(parseSavedViews(""), []);
    assert.deepEqual(parseSavedViews("{"), []);
    assert.deepEqual(parseSavedViews("null"), []);
    assert.deepEqual(parseSavedViews("[1, true]"), []);
  });

  it("round-trips two named views without thread ids or message text", () => {
    const views = addSavedView(
      addSavedView([], {
        name: "Failed Codex threads",
        criteria: criteria({ status: "failed", providers: ["codex"] }),
        now: 10,
        id: "v1",
      }),
      {
        name: "Release-tagged threads",
        criteria: criteria({ tag: "release", query: "ship" }),
        now: 20,
        id: "v2",
      },
    );
    const raw = serializeSavedViews(views);
    assert.equal(raw.includes("thread-"), false);
    assert.equal(raw.includes("message"), false);
    const parsed = parseSavedViews(raw);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.name, "Release-tagged threads");
    assert.deepEqual(parsed[0]!.criteria, criteria({ tag: "release", query: "ship" }));
    assert.equal(parsed[1]!.name, "Failed Codex threads");
    assert.deepEqual(parsed[1]!.criteria, criteria({
      status: "failed",
      providers: ["codex"],
    }));
  });

  it("drops rows missing a name or id and de-duplicates ids", () => {
    const raw = JSON.stringify([
      {
        id: "v1",
        name: "Keep",
        criteria: { status: null, providers: [], projectId: null, tag: null, query: "", groupBy: "none" },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "v1",
        name: "Dup",
        criteria: { status: "failed", providers: [], projectId: null, tag: null, query: "", groupBy: "none" },
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "v2",
        name: "   ",
        criteria: { status: null, providers: [], projectId: null, tag: null, query: "", groupBy: "none" },
        createdAt: 3,
        updatedAt: 3,
      },
    ]);
    const parsed = parseSavedViews(raw);
    assert.deepEqual(
      parsed.map((v) => v.id),
      ["v1"],
    );
  });
});

describe("CRUD", () => {
  it("trims names, rejects blank, and leaves existing views in place", () => {
    assert.equal(normalizeViewName("  Failed Codex  "), "Failed Codex");
    assert.equal(normalizeViewName("   "), "");
    const start: SavedView[] = [];
    assert.deepEqual(
      addSavedView(start, { name: "  ", criteria: criteria(), now: 1 }),
      [],
    );
  });

  it("renames, updates criteria, and deletes without touching other views", () => {
    let views = addSavedView([], {
      name: "A",
      criteria: criteria({ status: "failed" }),
      now: 1,
      id: "a",
    });
    views = addSavedView(views, {
      name: "B",
      criteria: criteria({ tag: "release" }),
      now: 2,
      id: "b",
    });
    views = renameSavedView(views, "a", "  Failed Codex threads ");
    views = updateSavedView(views, "a", criteria({
      status: "failed",
      providers: ["codex"],
    }), 5);
    const afterDelete = deleteSavedView(views, "b");
    assert.equal(afterDelete.length, 1);
    assert.equal(afterDelete[0]!.id, "a");
    assert.equal(afterDelete[0]!.name, "Failed Codex threads");
    assert.deepEqual(afterDelete[0]!.criteria.providers, ["codex"]);
    assert.equal(views.find((v) => v.id === "b")?.name, "B");
  });
});

describe("criteriaEqual / trigger label", () => {
  it("treats provider order as irrelevant and trims query", () => {
    assert.equal(
      criteriaEqual(
        criteria({ providers: ["codex", "grok"], query: "  ship " }),
        criteria({ providers: ["grok", "codex"], query: "ship" }),
      ),
      true,
    );
    assert.equal(
      criteriaEqual(criteria({ status: "failed" }), criteria({ status: "idle" })),
      false,
    );
  });

  it("marks the active name modified when filters drift", () => {
    assert.equal(savedViewTriggerLabel(null, false), "Saved views");
    assert.equal(
      savedViewTriggerLabel({ name: "Failed Codex threads" }, false),
      "Failed Codex threads",
    );
    assert.equal(
      savedViewTriggerLabel({ name: "Failed Codex threads" }, true),
      "Failed Codex threads ·",
    );
  });
});

describe("availability", () => {
  const ctx = {
    projectIds: new Set(["p1"]),
    tags: ["release"],
    providerIds: new Set(["claude", "codex"]),
  };

  it("is available when every criterion still exists", () => {
    assert.equal(
      savedViewUnavailable(
        criteria({ projectId: "p1", tag: "release", providers: ["codex"] }),
        ctx,
      ),
      null,
    );
  });

  it("does not silently drop a missing project, tag, or provider", () => {
    assert.equal(
      savedViewUnavailable(criteria({ projectId: "gone" }), ctx)?.kind,
      "project",
    );
    assert.equal(
      savedViewUnavailable(criteria({ tag: "stale" }), ctx)?.kind,
      "tag",
    );
    assert.equal(
      savedViewUnavailable(criteria({ providers: ["muse"] }), ctx)?.kind,
      "provider",
    );
  });
});

describe("live matching (no snapshot)", () => {
  it("new threads that match the saved criteria appear; stored JSON has no ids", () => {
    const saved = addSavedView([], {
      name: "Failed Codex",
      criteria: criteria({ status: "failed", providers: ["codex"] }),
      now: 1,
      id: "v1",
    });
    const raw = serializeSavedViews(saved);
    assert.equal(raw.includes("old-fail"), false);
    const filter = criteriaToFilter(saved[0]!.criteria);
    const first = filterThreads(
      [thread({ id: "old-fail", status: "failed", provider: "codex" })],
      filter,
    );
    const later = filterThreads(
      [
        thread({ id: "old-fail", status: "failed", provider: "codex" }),
        thread({ id: "new-fail", status: "failed", provider: "codex" }),
        thread({ id: "idle-codex", status: "idle", provider: "codex" }),
      ],
      filter,
    );
    assert.deepEqual(
      first.map((t) => t.id),
      ["old-fail"],
    );
    assert.deepEqual(
      later.map((t) => t.id),
      ["old-fail", "new-fail"],
    );
  });
});

describe("active id parser", () => {
  it("keeps a known id and drops a missing one", () => {
    const views = addSavedView([], {
      name: "A",
      criteria: criteria(),
      now: 1,
      id: "v1",
    });
    assert.equal(parseActiveSavedViewId("v1", views), "v1");
    assert.equal(parseActiveSavedViewId("gone", views), null);
    assert.equal(parseActiveSavedViewId(null, views), null);
  });

  it("exports localStorage keys", () => {
    assert.equal(SAVED_VIEWS_KEY, "sidebar:savedViews");
    assert.equal(ACTIVE_SAVED_VIEW_KEY, "sidebar:activeSavedView");
  });
});
