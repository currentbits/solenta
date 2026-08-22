/**
 * Sidebar status / provider / project filters (#553).
 * Run: node --experimental-strip-types --test test/sidebarFilters.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterThreads,
  groupByLabel,
  groupThreadsByProject,
  groupThreadsByStatus,
  parseGroupBy,
  parseProviderFilter,
  parseStatusFilter,
  providerFilterLabel,
  serializeProviderFilter,
  statusFilterLabel,
  threadMatchesFilter,
  threadStatusBucket,
} from "../src/sidebarFilters.ts";
import type { ProjectInfo, ThreadInfo } from "../src/shared/ipc.ts";
import type { WaitState } from "../src/waiting.ts";

function project(
  partial: Partial<ProjectInfo> & Pick<ProjectInfo, "id" | "slug">,
): ProjectInfo {
  return {
    name: partial.name ?? partial.slug,
    path: partial.path ?? `/demo/${partial.slug}`,
    ...partial,
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
    notes: "",
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

function wait(over: Partial<WaitState> = {}): WaitState {
  return {
    children: over.children ?? [
      { id: "w1", title: "worker", state: over.blocked ? "blocked" : "working" },
    ],
    blocked: over.blocked ?? 0,
    since: over.since ?? 1,
  };
}

describe("threadStatusBucket", () => {
  it("maps badge states onto the five filter buckets", () => {
    assert.equal(
      threadStatusBucket(thread({ id: "r", status: "working" }), null),
      "running",
    );
    assert.equal(
      threadStatusBucket(
        thread({ id: "w", status: "working", awaitingInput: true }),
        null,
      ),
      "waiting",
    );
    assert.equal(
      threadStatusBucket(thread({ id: "f", status: "failed" }), null),
      "failed",
    );
    assert.equal(
      threadStatusBucket(thread({ id: "i", status: "idle" }), null),
      "idle",
    );
    assert.equal(
      threadStatusBucket(thread({ id: "d", status: "done" }), null),
      "idle",
    );
    assert.equal(
      threadStatusBucket(thread({ id: "q", status: "quota-wait" }), null),
      "idle",
    );
    assert.equal(
      threadStatusBucket(
        thread({ id: "a", status: "failed", archived: true }),
        null,
      ),
      "archived",
    );
  });

  it("treats blocked workers as waiting-on-you and delegating as running", () => {
    assert.equal(
      threadStatusBucket(thread({ id: "p", status: "idle" }), wait({ blocked: 1 })),
      "waiting",
    );
    assert.equal(
      threadStatusBucket(thread({ id: "d", status: "done" }), wait({ blocked: 0 })),
      "running",
    );
  });
});

describe("threadMatchesFilter", () => {
  const busy = thread({ id: "busy", status: "working", provider: "codex" });
  const idle = thread({ id: "idle", status: "idle", projectId: "p2" });

  it("ANDs status, provider, and project; empty providers match all", () => {
    assert.equal(
      threadMatchesFilter(busy, { status: "running", providers: [], projectId: null }, null),
      true,
    );
    assert.equal(
      threadMatchesFilter(busy, { status: "failed", providers: [], projectId: null }, null),
      false,
    );
    assert.equal(
      threadMatchesFilter(
        busy,
        { status: "running", providers: ["claude"], projectId: null },
        null,
      ),
      false,
    );
    assert.equal(
      threadMatchesFilter(
        busy,
        { status: "running", providers: ["codex", "grok"], projectId: null },
        null,
      ),
      true,
    );
    assert.equal(
      threadMatchesFilter(idle, { status: null, providers: [], projectId: "p1" }, null),
      false,
    );
    assert.equal(
      threadMatchesFilter(idle, { status: null, providers: [], projectId: "p2" }, null),
      true,
    );
  });

  it("does not inspect title or message text", () => {
    const named = thread({
      id: "t",
      title: "failed parser",
      status: "idle",
    });
    assert.equal(
      threadMatchesFilter(
        named,
        { status: "failed", providers: [], projectId: null },
        null,
      ),
      false,
      "title text is not a status filter",
    );
  });
});

describe("filterThreads", () => {
  const rows = [
    thread({ id: "busy", status: "working" }),
    thread({ id: "broken", status: "failed" }),
    thread({ id: "idle", status: "idle" }),
    thread({ id: "old", status: "idle", archived: true }),
  ];

  it("keeps the open thread even when it misses the filter", () => {
    const out = filterThreads(
      rows,
      { status: "failed", providers: [], projectId: null },
      { keepIds: ["idle", "missing"] },
    );
    assert.deepEqual(
      out.map((t) => t.id),
      ["broken", "idle"],
    );
  });

  it("returns only archived rows for the archived filter", () => {
    const out = filterThreads(rows, {
      status: "archived",
      providers: [],
      projectId: null,
    });
    assert.deepEqual(
      out.map((t) => t.id),
      ["old"],
    );
  });
});

describe("groupThreadsByStatus", () => {
  it("omits empty buckets and orders running / waiting / failed / idle", () => {
    const groups = groupThreadsByStatus([
      thread({ id: "idle", status: "idle" }),
      thread({ id: "run", status: "working" }),
      thread({ id: "fail", status: "failed" }),
      thread({ id: "arch", status: "idle", archived: true }),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.id, g.threads.map((t) => t.id)]),
      [
        ["running", ["run"]],
        ["failed", ["fail"]],
        ["idle", ["idle"]],
      ],
    );
  });

  it("sorts pinned first inside a bucket", () => {
    const groups = groupThreadsByStatus([
      thread({ id: "new", status: "idle", createdAt: 200 }),
      thread({ id: "pin", status: "idle", createdAt: 100, pinnedAt: 50 }),
    ]);
    assert.deepEqual(
      groups[0]!.threads.map((t) => t.id),
      ["pin", "new"],
    );
  });
});

describe("groupThreadsByProject", () => {
  it("hides empty projects", () => {
    const groups = groupThreadsByProject(
      [
        project({ id: "p1", slug: "acme/ledger" }),
        project({ id: "p2", slug: "acme/billing" }),
      ],
      [thread({ id: "t1", projectId: "p1" })],
    );
    assert.deepEqual(
      groups.map((g) => g.project?.id),
      ["p1"],
    );
  });
});

describe("persist parsers", () => {
  it("drops unknown status / group-by values", () => {
    assert.equal(parseStatusFilter("waiting"), "waiting");
    assert.equal(parseStatusFilter("nope"), null);
    assert.equal(parseStatusFilter(null), null);
    assert.equal(parseGroupBy("project"), "project");
    assert.equal(parseGroupBy("flat"), "none");
    assert.equal(parseGroupBy(null), "none");
  });

  it("round-trips a provider multi-select", () => {
    assert.deepEqual(parseProviderFilter(null), []);
    assert.deepEqual(parseProviderFilter(""), []);
    assert.deepEqual(parseProviderFilter("codex,grok,codex, grok"), [
      "codex",
      "grok",
    ]);
    assert.equal(serializeProviderFilter([]), null);
    assert.equal(serializeProviderFilter(["codex", "grok"]), "codex,grok");
  });
});

describe("trigger labels", () => {
  it("uses compact copy until a filter is on", () => {
    assert.equal(statusFilterLabel(null), "Status");
    assert.equal(statusFilterLabel("waiting"), "Waiting");
    assert.equal(groupByLabel("none"), "Group");
    assert.equal(groupByLabel("project"), "Project");
    const names = new Map([["claude", "Claude Code"]]);
    assert.equal(providerFilterLabel([], names), "Provider");
    assert.equal(providerFilterLabel(["claude"], names), "Claude Code");
    assert.equal(providerFilterLabel(["claude", "codex"], names), "2 providers");
  });
});
