/**
 * MemoryTab, mounted for real: effects run, clicks fire, state advances.
 *
 * This file exists because MemoryTab had ZERO render coverage. All memory
 * testing sat on the pure module src/memoryCard.ts, so the component's wiring
 * was verified by reading only, and a reviewer twice proved that in this
 * codebase you can delete a user-visible feature by passing a wrong value at a
 * call site with the whole suite green.
 *
 * Run: node --import=./test/support/render.mjs --test test/memoryTab.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { MemoryTab } from "../src/components/MemoryTab";
import type {
  AgentConfigDoctorReport,
  AgentConfigPreview,
  MemoryEntryInfo,
  MemoryMaintenanceReport,
  ProjectCodeMap,
} from "../src/shared/ipc";

const LONG_BODY =
  "The deployment runbook for the payments service. " + "x".repeat(900);
/** What a list row actually carries: an excerpt, not the body. */
const EXCERPT = LONG_BODY.slice(0, 240) + "...";

function entry(over: Partial<MemoryEntryInfo> = {}): MemoryEntryInfo {
  return {
    id: "m1",
    type: "convention",
    title: "Never use em dashes",
    body: EXCERPT,
    project: "coder",
    importance: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...over,
  } as MemoryEntryInfo;
}

/** Every argument the component sent, so a wrong id or a dropped scope shows. */
interface Calls {
  recent: unknown[];
  get: unknown[];
  update: unknown[];
  remove: unknown[];
  store: unknown[];
}

function newCalls(): Calls {
  return { recent: [], get: [], update: [], remove: [], store: [] };
}

interface Stubs {
  recent?: () => Promise<MemoryEntryInfo[]>;
  get?: (input: { id: string }) => Promise<MemoryEntryInfo>;
  update?: (input: { id: string; title: string; body: string }) => Promise<{
    id: string;
  }>;
  remove?: (input: { id: string }) => Promise<void>;
}

function tab(
  stubs: Stubs = {},
  calls: Calls = newCalls(),
  rows = [entry()],
  projectSlug = "coder",
) {
  return (
    <MemoryTab
      projectSlug={projectSlug}
      searchMemory={async () => []}
      recentMemory={async (input) => {
        calls.recent.push(input);
        return stubs.recent ? stubs.recent() : rows;
      }}
      getMemory={async (input) => {
        calls.get.push(input);
        if (stubs.get) return stubs.get(input);
        // The fetched entry always carries the FULL body: that is the whole
        // difference between a list row and a get.
        const row = rows.find((r) => r.id === input.id);
        return { ...(row ?? entry({ id: input.id })), body: LONG_BODY };
      }}
      updateMemory={async (input) => {
        calls.update.push(input);
        return stubs.update ? stubs.update(input) : { id: "m2" };
      }}
      removeMemory={async (input) => {
        calls.remove.push(input);
        if (stubs.remove) await stubs.remove(input);
      }}
      storeMemory={async (input) => {
        calls.store.push(input);
        return { id: "m3" };
      }}
    />
  );
}

afterEach(unmountAll);

describe("MemoryTab list", () => {
  it("renders file:line citations on the card", async () => {
    const m = await mount(
      tab({}, newCalls(), [
        entry({
          title: "Token check lives in auth",
          citations: [
            { kind: "file", path: "src/auth.ts", line: 12, excerpt: "checkToken" },
            { kind: "commit", sha: "abcdef123456" },
          ],
        }),
      ]),
    );
    const chips = m.queryAll("[data-citations] span");
    assert.equal(chips.length, 2, "each citation must render as its own chip");
    assert.equal(chips[0]?.textContent, "src/auth.ts:12");
    assert.equal(chips[1]?.textContent, "abcdef1");
    m.unmount();
  });

  it("renders the entries the server returned", async () => {
    const m = await mount(tab());
    assert.ok(m.text().includes("Never use em dashes"), "title must render");
    // Scoped to the CARD: m.text() spans the whole tab, and the store form
    // renders <option>convention</option>, so a tab-wide substring check
    // passed with the badge deleted from every card.
    const badge = m.query('[class*="badge"]');
    assert.equal(
      badge?.textContent,
      "convention",
      "the type badge must render on the card itself",
    );
    m.unmount();
  });

  it("renders a strategy entry with its own badge", async () => {
    const m = await mount(
      tab({}, newCalls(), [
        entry({ type: "strategy", title: "When merging, stash by path" }),
      ]),
    );
    const badge = m.query('[class*="badge"]');
    assert.equal(badge?.textContent, "strategy", "the type badge must say strategy");
    assert.ok(
      badge?.className.includes("badgeStrategy"),
      `strategy must use its own badge class, got: ${badge?.className}`,
    );
    assert.ok(
      !badge?.className.includes("badgeRun"),
      "strategy must not fall through to the run badge",
    );
    m.unmount();
  });

  it("asks the server for THIS project only, and shows the tag", async () => {
    // The tag alone proves only that the fixture had a project field. What
    // matters is the argument: dropping it makes every project's memory show
    // up here, which is the invariant round 24 exists to protect.
    const calls = newCalls();
    const m = await mount(tab({}, calls));
    assert.equal(calls.recent.length, 1, "the list must be fetched once");
    assert.deepEqual(
      (calls.recent[0] as { project?: string }).project,
      "coder",
      "recentMemory must be scoped to the selected project",
    );
    assert.ok(
      m.queryAll('[title="coder"]').length > 0,
      "the entry's project must be visible on the card",
    );
    m.unmount();
  });

  it("scopes by the raw project path but labels with its basename", async () => {
    // The caller passes project.path, not the display slug: a slug like
    // "owner/solenta" canonicalizes to a scope no agent writes to, which is
    // exactly how the solenta project's memory tab went permanently empty.
    const calls = newCalls();
    const m = await mount(
      tab({}, calls, [entry()], "/Users/dev/code/coder"),
    );
    assert.equal(
      (calls.recent[0] as { project?: string }).project,
      "/Users/dev/code/coder",
      "the path must reach the server untouched for canonicalization",
    );
    assert.ok(
      m.queryAll('[class*="filterLabel"]').some((el) => el.textContent === "coder"),
      "the filter label must show the basename, not the full path",
    );
    m.unmount();
  });

  it("shows an empty state rather than a blank panel", async () => {
    const m = await mount(tab({ recent: async () => [] }));
    assert.ok(
      m.text().includes("No recent memories"),
      `expected an empty state, got: ${m.text().slice(0, 120)}`,
    );
    m.unmount();
  });

  it("surfaces a load failure instead of looking empty", async () => {
    const m = await mount(
      tab({
        recent: async () => {
          throw new Error("memory server exploded");
        },
      }),
    );
    assert.ok(
      m.text().includes("memory server exploded"),
      `expected the error on screen, got: ${m.text().slice(0, 160)}`,
    );
    m.unmount();
  });
});

describe("MemoryTab card interaction", () => {
  /** Expand the one card and return the mounted tab. */
  async function expanded(stubs: Stubs = {}) {
    const m = await mount(tab(stubs));
    const toggle = m.query("button");
    await m.click(toggle);
    return m;
  }

  it("fetches and shows the FULL body on expand, not the excerpt", async () => {
    const m = await expanded();
    const pre = m.query("pre");
    assert.ok(pre, "expanded card must show the body in a pre");
    assert.ok(
      (pre.textContent || "").includes("x".repeat(500)),
      "the full body must be fetched, not the truncated list excerpt",
    );
    m.unmount();
  });

  it("offers Edit and Delete once expanded", async () => {
    const m = await expanded();
    assert.ok(m.byText("Edit"), "Edit must be reachable");
    assert.ok(m.byText("Delete"), "Delete must be reachable");
    m.unmount();
  });

  it("keeps Delete reachable on a card whose body failed to load", async () => {
    // Regression: the action row used to vanish on an errored card, leaving no
    // way to remove a broken entry.
    const m = await expanded({
      get: async () => {
        throw new Error("body fetch failed");
      },
    });
    assert.ok(
      m.text().includes("body fetch failed"),
      "the fetch error must be visible",
    );
    assert.ok(m.byText("Delete"), "Delete must survive a failed body fetch");
    m.unmount();
  });

  it("refuses to edit before the real body has arrived", async () => {
    // Load-bearing: a list row carries a 240-char excerpt. Editing from it once
    // saved the truncation over a 980-char entry.
    let release: (v: MemoryEntryInfo) => void = () => {};
    const pending = new Promise<MemoryEntryInfo>((r) => {
      release = r;
    });
    const m = await expanded({ get: () => pending });
    const edit = m.byText("Edit") as HTMLButtonElement | null;
    assert.ok(edit, "Edit control must exist while loading");
    assert.equal(
      edit.disabled,
      true,
      "Edit must be disabled until the full body is present",
    );
    release(entry({ body: LONG_BODY }));
    await m.flush();
    assert.equal(
      (m.byText("Edit") as HTMLButtonElement).disabled,
      false,
      "Edit must become available once the body arrives",
    );
    m.unmount();
  });

  it("saves an edit as a correction, carrying the real body", async () => {
    const calls: { id: string; title: string; body: string }[] = [];
    const m = await expanded({
      update: async (input) => {
        calls.push(input);
        return { id: "m2" };
      },
    });
    await m.click(m.byText("Edit"));
    const title = m.query('input[aria-label="Edit title"]');
    assert.ok(title, "the edit form must render a title field");
    await m.type(title, "Corrected title");
    await m.click(m.byText("Save correction"));

    assert.equal(calls.length, 1, "save must call updateMemory exactly once");
    assert.equal(
      calls[0].id,
      "m1",
      "the correction must be written to the entry being edited",
    );
    assert.equal(calls[0].title, "Corrected title");
    assert.ok(
      calls[0].body.includes("x".repeat(500)),
      "the saved body must be the full body, never the list excerpt",
    );
    m.unmount();
  });

  it("asks before deleting, and only then deletes", async () => {
    const removed: string[] = [];
    const m = await expanded({
      remove: async (input) => {
        removed.push(input.id);
      },
    });
    await m.click(m.byText("Delete"));
    assert.equal(removed.length, 0, "the first click must not delete");
    assert.ok(
      m.text().includes("Delete permanently?"),
      "a confirmation must be shown first",
    );
    await m.click(m.byText("Delete"));
    assert.deepEqual(removed, ["m1"], "confirming must delete that entry");
    m.unmount();
  });

  it("surfaces a failed delete instead of pretending it worked", async () => {
    const m = await expanded({
      remove: async () => {
        throw new Error("1 entry references it via superseded_by");
      },
    });
    await m.click(m.byText("Delete"));
    await m.click(m.byText("Delete"));
    assert.ok(
      m.text().includes("superseded_by"),
      `the failure must reach the user, got: ${m.text().slice(-160)}`,
    );
    m.unmount();
  });

  it("never nests interactive elements inside a card", async () => {
    // A button inside a button is invalid HTML and drops clicks. This shipped
    // once already in this component.
    const m = await expanded();
    const interactives = m.queryAll("button, a");
    // Without this the loop body never runs when nothing rendered, and the
    // test passes hardest exactly when the card is missing.
    assert.ok(
      interactives.length >= 3,
      `expected at least toggle + Edit + Delete, got ${interactives.length}`,
    );
    for (const el of interactives) {
      assert.equal(
        el.querySelector("button, a, input, textarea"),
        null,
        `interactive element nested inside <${el.tagName.toLowerCase()}>`,
      );
    }
    m.unmount();
  });
});

describe("MemoryTab wiring the reviewer's mutations exposed", () => {
  it("fetches the body of the entry that was expanded", async () => {
    // The get stub used to ignore its argument, so asking for the wrong id
    // showed another entry's body with the suite green.
    const calls = newCalls();
    const rows = [entry({ id: "a" }), entry({ id: "b", title: "Second" })];
    const m = await mount(tab({}, calls, rows));
    const toggles = m.queryAll("button").filter((b) =>
      (b.textContent || "").includes("Second"),
    );
    await m.click(toggles[0]);
    assert.deepEqual(calls.get, [{ id: "b" }], "must fetch the expanded entry");
    m.unmount();
  });

  it("carries edits to the BODY, not just the title", async () => {
    const calls = newCalls();
    const m = await mount(tab({}, calls));
    await m.click(m.query("button"));
    await m.click(m.byText("Edit"));
    await m.type(m.query('textarea[aria-label="Edit body"]'), "rewritten body");
    await m.click(m.byText("Save correction"));
    assert.equal(
      (calls.update[0] as { body: string }).body,
      "rewritten body",
      "a body edit must reach the server, not be silently discarded",
    );
    m.unmount();
  });

  it("offers a way out of an edit", async () => {
    const m = await mount(tab());
    await m.click(m.query("button"));
    await m.click(m.byText("Edit"));
    assert.ok(m.byText("Cancel"), "an edit form with no Cancel is a trap");
    m.unmount();
  });

  it("keeps a mid-edit draft across collapse and re-expand", async () => {
    // docs/ISSUES.md records this as a decision, and MemoryTab carries a
    // comment saying it is what silently destroyed mid-edit text.
    const m = await mount(tab());
    const toggle = () => m.query("button");
    await m.click(toggle());
    await m.click(m.byText("Edit"));
    await m.type(m.query('input[aria-label="Edit title"]'), "half-typed");
    await m.click(toggle());
    await m.click(toggle());
    const title = m.query('input[aria-label="Edit title"]') as HTMLInputElement;
    assert.ok(title, "the edit form must come back");
    assert.equal(title.value, "half-typed", "the draft must survive collapse");
    m.unmount();
  });

  it("keeps two cards' state independent", async () => {
    // cardActions is keyed by entry id precisely so card A cannot paint on B.
    // Nothing exercised that through the component.
    const rows = [entry({ id: "a" }), entry({ id: "b", title: "Second" })];
    const m = await mount(tab({}, newCalls(), rows));
    const cardToggles = m
      .queryAll("button")
      .filter((b) => (b.textContent || "").match(/Never use em dashes|Second/));
    await m.click(cardToggles[0]);
    await m.click(m.byText("Edit"));
    await m.type(m.query('input[aria-label="Edit title"]'), "draft for A");
    await m.click(cardToggles[1]);
    const inputs = m.queryAll('input[aria-label="Edit title"]');
    assert.equal(
      inputs.length,
      0,
      "expanding another card must not put it into edit mode with A's draft",
    );
    m.unmount();
  });

  it("can store a strategy entry from the form", async () => {
    const calls = newCalls();
    const m = await mount(tab({}, calls));
    await m.change(m.query('select[aria-label="Memory type"]'), "strategy");
    await m.type(m.query('input[placeholder="Title"]'), "When merging, stash by path");
    await m.type(
      m.query('textarea[placeholder="What should future sessions know?"]'),
      "When a worktree merge is dirty, stash by path then retry.",
    );
    await m.click(m.byText("Save"));
    assert.equal(calls.store.length, 1, "Save must store once");
    assert.equal(
      (calls.store[0] as { type: string }).type,
      "strategy",
      "the store form must send type strategy",
    );
    m.unmount();
  });

  it("scopes a newly stored memory to the current project", async () => {
    const calls = newCalls();
    const m = await mount(tab({}, calls));
    await m.type(m.query('input[placeholder="Title"]'), "New convention");
    await m.type(
      m.query('textarea[placeholder="What should future sessions know?"]'),
      "the body of the new convention",
    );
    await m.click(m.byText("Save"));
    assert.equal(calls.store.length, 1, "Save must store once");
    assert.equal(
      (calls.store[0] as { project?: string }).project,
      "coder",
      "a new memory must be scoped, or it lands where no agent will find it",
    );
    m.unmount();
  });

  it("says the server is down and offers a retry", async () => {
    const m = await mount(
      tab({
        recent: async () => {
          throw new Error("Memory server is not running.");
        },
      }),
    );
    assert.ok(
      m.text().includes("Memory server is not running"),
      `expected the not-running message, got: ${m.text().slice(0, 140)}`,
    );
    assert.ok(m.byText("Retry"), "a dead server needs a way back");
    m.unmount();
  });

  it("shows a relative age on each card", async () => {
    const m = await mount(tab());
    const age = m.query('[class*="age"]');
    assert.ok(
      age && (age.textContent || "").trim().length > 0,
      "an entry with no age reads as undated",
    );
    m.unmount();
  });

  it("keeps the search box and the store form available", async () => {
    const m = await mount(tab());
    assert.ok(
      m.query('input[placeholder="Search shared memory..."]'),
      "search is the primary way to reach memory",
    );
    assert.ok(
      m.query('input[placeholder="Title"]'),
      "the store form must be usable",
    );
    m.unmount();
  });
});

const SAMPLE_REPORT: AgentConfigDoctorReport = {
  projectId: "p1",
  files: [
    {
      path: "AGENTS.md",
      bytes: 120,
      score: 42,
      grade: "D",
      axes: [],
      issues: [],
      recommendations: [],
    },
  ],
  score: 42,
  grade: "D",
  memory: {
    considered: 3,
    covered: 1,
    missing: [
      { id: "c1", type: "convention", title: "Fail closed on worktrees" },
    ],
  },
  issues: [],
  recommendations: [],
};

describe("MemoryTab config doctor", () => {
  it("is absent when no lint callback is wired", async () => {
    const m = await mount(tab());
    assert.equal(m.query("[data-config-doctor]"), null);
    m.unmount();
  });

  it("lints the selected project and shows grade + memory gap", async () => {
    const linted: string[] = [];
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        projectId="p1"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        lintAgentConfig={async (input) => {
          linted.push(input.projectId);
          return SAMPLE_REPORT;
        }}
      />,
    );
    assert.deepEqual(linted, ["p1"]);
    const card = m.query("[data-config-doctor]");
    assert.ok(card, "doctor card must render");
    assert.ok(card.textContent?.includes("D 42"));
    assert.ok(card.textContent?.includes("AGENTS.md"));
    assert.ok(card.textContent?.includes("1/3 memory"));
    assert.ok(card.textContent?.includes("1 memory not in the files"));
    m.unmount();
  });

  it("previews then confirms before writing", async () => {
    const written: string[] = [];
    const preview: AgentConfigPreview = {
      projectId: "p1",
      files: [{ path: "AGENTS.md", content: "# generated\n", exists: true }],
    };
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        projectId="p1"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        lintAgentConfig={async () => SAMPLE_REPORT}
        previewAgentConfig={async () => preview}
        writeAgentConfig={async (input) => {
          written.push(input.projectId);
          return { projectId: input.projectId, written: ["AGENTS.md"] };
        }}
      />,
    );
    await m.click(m.byText("Preview"));
    assert.ok(m.query("[data-config-preview]"));
    assert.ok(m.text().includes("# generated"));
    await m.click(m.byText("Write AGENTS.md"));
    assert.equal(written.length, 0, "first click is confirm");
    await m.click(m.byText("Confirm write"));
    assert.deepEqual(written, ["p1"]);
    assert.ok(m.query("[data-config-wrote]"));
    m.unmount();
  });
});

function emptyAutoResolved(): MemoryMaintenanceReport["autoResolved"] {
  return { last7Days: 0, invalidated: 0, kept: 0, byRule: {} };
}

function maintenanceReport(
  over: Partial<MemoryMaintenanceReport> = {},
): MemoryMaintenanceReport {
  return {
    queue: { open: 0, oldestAgeDays: 0, items: [] },
    autoResolved: emptyAutoResolved(),
    nearDupes: [],
    agingRuns: [],
    fatConventions: [],
    trust: { agents: [], suspect: [] },
    ...over,
  };
}

const QUEUE_ITEM = {
  id: 7,
  kind: "near_dup" as const,
  detail: "overlap 0.5",
  createdAt: "2026-08-01T00:00:00.000Z",
  a: { id: "a1", title: "Swift tests need DEVELOPER_DIR" },
  b: { id: "b1", title: "Swift tests need DEVELOPER_DIR set" },
};

describe("MemoryTab review queue", () => {
  it("is absent when no maintenance callback is wired", async () => {
    const m = await mount(tab());
    assert.equal(m.query("[data-review-queue]"), null);
    m.unmount();
  });

  it("hides the card when the queue is empty and nothing auto-resolved", async () => {
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        maintenanceMemory={async () => maintenanceReport()}
      />,
    );
    assert.equal(m.query("[data-review-queue]"), null);
    m.unmount();
  });

  it("lists an open pair as needing a call and resolves keep-both", async () => {
    const resolved: Array<{ id: number; resolution: string }> = [];
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        maintenanceMemory={async () =>
          maintenanceReport({
            queue: {
              open: 1,
              oldestAgeDays: 2,
              items: [QUEUE_ITEM],
            },
          })
        }
        resolveMemory={async (input) => {
          resolved.push(input);
          return { ok: true, id: input.id, resolution: input.resolution };
        }}
      />,
    );
    const card = m.query("[data-review-queue]");
    assert.ok(card, "queue card must render");
    assert.ok(
      card.textContent?.includes("1 needs your call"),
      `expected needs-your-call badge, got: ${card.textContent}`,
    );
    assert.equal(card.textContent?.includes("1 open"), false);
    assert.ok(m.query("[data-needs-your-call]"), "remaining pairs sit in the call list");
    assert.ok(card.textContent?.includes("Swift tests need DEVELOPER_DIR"));
    assert.ok(m.byText("Keep both"));
    assert.ok(m.byText("Mark reviewed"));
    assert.ok(m.byText("Invalidate older"));
    await m.click(m.byText("Keep both"));
    assert.deepEqual(resolved, [{ id: 7, resolution: "noop" }]);
    m.unmount();
  });

  it("renders the auto-resolution activity line and keeps the queue buttons", async () => {
    const resolved: Array<{ id: number; resolution: string }> = [];
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        maintenanceMemory={async () =>
          maintenanceReport({
            queue: {
              open: 1,
              oldestAgeDays: 2,
              items: [QUEUE_ITEM],
            },
            autoResolved: {
              last7Days: 3,
              invalidated: 2,
              kept: 1,
              byRule: { semantic_dup: 2, dead_pair: 1 },
            },
          })
        }
        resolveMemory={async (input) => {
          resolved.push(input);
          return { ok: true, id: input.id, resolution: input.resolution };
        }}
      />,
    );
    const line = m.query("[data-review-activity]");
    assert.ok(line, "activity line must render");
    assert.equal(
      line.textContent,
      "3 pairs auto-resolved this week: 2 invalidated, 1 kept · semantic dup 2, dead pair 1",
    );
    const card = m.query("[data-review-queue]");
    assert.ok(card?.textContent?.includes("1 needs your call"));
    assert.ok(m.query("[data-needs-your-call]"));
    await m.click(m.byText("Invalidate older"));
    assert.deepEqual(resolved, [{ id: 7, resolution: "invalidate" }]);
    m.unmount();
  });

  it("shows the activity line when the queue is empty", async () => {
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        maintenanceMemory={async () =>
          maintenanceReport({
            autoResolved: {
              last7Days: 1,
              invalidated: 1,
              kept: 0,
              byRule: { semantic_dup: 1 },
            },
          })
        }
      />,
    );
    const card = m.query("[data-review-queue]");
    assert.ok(card, "activity-only card must still render");
    assert.equal(m.query("[data-needs-your-call]"), null);
    assert.equal(
      m.query("[data-review-activity]")?.textContent,
      "1 pair auto-resolved this week: 1 invalidated, 0 kept · semantic dup 1",
    );
    assert.equal(card.textContent?.includes("needs your call"), false);
    m.unmount();
  });

  it("does not render report-only nearDupes, agingRuns, or fatConventions", async () => {
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        maintenanceMemory={async () =>
          maintenanceReport({
            queue: {
              open: 1,
              oldestAgeDays: 0,
              items: [QUEUE_ITEM],
            },
            nearDupes: [
              {
                a: { id: "x", title: "Near dupe secret title" },
                b: { id: "y", title: "y" },
              },
            ],
            agingRuns: [{ id: "run-secret", title: "Aging run secret title" }],
            fatConventions: [
              { id: "fat-secret", title: "Fat convention secret title" },
            ],
          })
        }
      />,
    );
    const text = m.text();
    assert.equal(text.includes("Near dupe secret title"), false);
    assert.equal(text.includes("Aging run secret title"), false);
    assert.equal(text.includes("Fat convention secret title"), false);
    assert.ok(m.query("[data-needs-your-call]"));
    m.unmount();
  });
});

describe("MemoryTab code map", () => {
  const wiki: ProjectCodeMap = {
    projectId: "p1",
    updatedAt: Date.now() - 5 * 60_000,
    fileCount: 2,
    symbolCount: 3,
    headSha: "abc1234ffff",
    defaultBranch: "main",
    modules: [
      {
        name: "src",
        fileCount: 2,
        symbolCount: 3,
        hot: [{ path: "src/App.tsx", symbols: ["App", "useNarrow"], rank: 4 }],
      },
    ],
    dependencies: ["react"],
  };

  it("renders the wiki and expands a module", async () => {
    const calls: unknown[] = [];
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        projectId="p1"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        loadCodeMap={async (input) => {
          calls.push(input);
          return wiki;
        }}
      />,
    );
    await m.flush();
    assert.deepEqual(calls, [{ projectId: "p1" }]);
    assert.ok(m.query("[data-code-map]"));
    assert.match(m.text(), /Code map/);
    assert.match(m.text(), /not agent memory/);
    assert.match(m.text(), /2 files/);
    assert.match(m.text(), /react/);
    assert.equal(m.text().includes("src/App.tsx"), false);
    await m.click(m.byText("src/"));
    assert.match(m.text(), /src\/App\.tsx/);
    assert.match(m.text(), /App, useNarrow/);
    m.unmount();
  });

  it("still shows the map when the memory server is down", async () => {
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        projectId="p1"
        searchMemory={async () => []}
        recentMemory={async () => {
          throw new Error("Memory server is not running.");
        }}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        loadCodeMap={async () => wiki}
      />,
    );
    await m.flush();
    assert.ok(m.query("[data-code-map]"));
    assert.match(m.text(), /Memory server is not running/);
    assert.match(m.text(), /src\//);
    m.unmount();
  });
});

describe("MemoryTab inspector layout", () => {
  it("keeps map, doctor, and review in the scrolling pane, not the search toolbar", async () => {
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        projectId="p1"
        searchMemory={async () => []}
        recentMemory={async () => [entry()]}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        loadCodeMap={async () => ({
          projectId: "p1",
          updatedAt: Date.now(),
          fileCount: 1,
          symbolCount: 1,
          headSha: "abc1234",
          defaultBranch: "main",
          modules: [],
          dependencies: [],
        })}
        lintAgentConfig={async () => SAMPLE_REPORT}
        maintenanceMemory={async () =>
          maintenanceReport({
            queue: {
              open: 1,
              oldestAgeDays: 1,
              items: [QUEUE_ITEM],
            },
          })
        }
      />,
    );
    await m.flush();
    const toolbar = m.query('[class*="searchRow"]');
    assert.ok(toolbar, "search toolbar must render");
    assert.equal(
      toolbar.querySelector("[data-code-map]"),
      null,
      "code map must not live in the non-scrolling toolbar",
    );
    assert.equal(
      toolbar.querySelector("[data-config-doctor]"),
      null,
      "config doctor must not live in the non-scrolling toolbar",
    );
    assert.equal(
      toolbar.querySelector("[data-review-queue]"),
      null,
      "review queue must not live in the non-scrolling toolbar",
    );
    const scroll = m.query("[data-memory-scroll]");
    assert.ok(scroll, "one scrolling pane must exist");
    assert.ok(scroll.querySelector("[data-code-map]"), "map scrolls with the list");
    assert.ok(
      scroll.querySelector("[data-config-doctor]"),
      "doctor scrolls with the list",
    );
    assert.ok(
      scroll.querySelector("[data-review-queue]"),
      "review queue scrolls with the list",
    );
    assert.ok(
      scroll.querySelector('input[placeholder="Title"]'),
      "the remember form must stay reachable inside the scroll",
    );
    m.unmount();
  });
});
