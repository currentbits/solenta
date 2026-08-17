/**
 * Spaces: named sidebar groups (#159).
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { inAct, mount } from "./support/dom.ts";
import { Sidebar } from "../src/components/Sidebar";
import App from "../src/App";
import type {
  ProjectInfo,
  ProviderInfo,
  SpaceInfo,
  ThreadInfo,
} from "../src/shared/ipc";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  space,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";

const PROJECT_DRAG_TYPE = "application/x-solenta-project";

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
];

const FRESH = Date.now();

function t(
  over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">,
): ThreadInfo {
  const createdAt = over.createdAt ?? FRESH;
  const updatedAt = over.updatedAt ?? createdAt;
  return {
    projectId: "p1",
    title: over.id,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt,
    updatedAt,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt:
      over.lastVisitedAt !== undefined ? over.lastVisitedAt : updatedAt,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

function sidebar(
  threads: ThreadInfo[],
  over: {
    projects?: ProjectInfo[];
    spaces?: SpaceInfo[];
    activeThreadId?: string | null;
    onSelectThread?: (id: string) => void;
    onAddSpace?: (name: string) => void;
    onRenameSpace?: (id: string, name: string) => void;
    onRemoveSpace?: (id: string) => void;
    onAssignProjectToSpace?: (projectId: string, spaceId: string) => void;
  } = {},
) {
  return (
    <Sidebar
      appName="Solenta"
      searchPlaceholder="Search threads..."
      projectsHeader="All projects"
      projects={over.projects ?? [project()]}
      spaces={over.spaces ?? []}
      threads={threads}
      providers={providers}
      activeThreadId={over.activeThreadId ?? null}
      onSelectThread={over.onSelectThread ?? (() => {})}
      onCreateThread={() => {}}
      onAddProject={() => {}}
      onAddSpace={over.onAddSpace}
      onRenameSpace={over.onRenameSpace}
      onRemoveSpace={over.onRemoveSpace}
      onAssignProjectToSpace={over.onAssignProjectToSpace}
      searchThreads={async ({ query }) =>
        threads.filter((th) => th.title.includes(query))
      }
    />
  );
}

async function clearSidebarStorage(): Promise<void> {
  const shell = await mount(<div />);
  window.localStorage.clear();
  shell.unmount();
}

function collapsedSpacesFromStorage(): string[] {
  try {
    const raw = window.localStorage.getItem("coder.sidebar.collapsedSpaces");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String).sort() : [];
  } catch {
    return [];
  }
}

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function stubTransfer(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    dropEffect: "none",
    effectAllowed: "all",
    get types() {
      return Object.keys(store);
    },
    setData(type: string, value: string) {
      store[type] = value;
    },
    getData(type: string) {
      return store[type] ?? "";
    },
  };
}

async function fireDrag(
  el: Element,
  type: string,
  transfer: ReturnType<typeof stubTransfer>,
) {
  await inAct(async () => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: transfer });
    el.dispatchEvent(ev);
  });
}

function dispatchKey(
  key: string,
  mods: { metaKey?: boolean } = {},
) {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      metaKey: mods.metaKey ?? false,
    }),
  );
}

describe("Sidebar spaces CRUD", () => {
  it("creating a space via the inline input records spaces.add", async () => {
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "t1", projectId: "p1" })],
      details: { t1: detail({ thread: thread({ id: "t1", projectId: "p1" }) }) },
    });
    const m = await boot(fake);

    const add = m.query("[data-space-add]");
    assert.ok(add, "projects header must expose an add-space control");
    await m.click(add);
    const input = m.query("[data-space-add-input]");
    assert.ok(input, "add click reveals the inline input");
    await m.type(input, "Client work");
    await m.press(input, "Enter");
    await m.flush();

    const calls = fake.of("spaces.add");
    assert.equal(calls.length, 1, "Enter records exactly one spaces.add");
    assert.deepEqual(calls[0]!.args[0], { name: "Client work" });
    assert.ok(
      m.query('[data-space-header="s-new-1"]'),
      "new space section appears after add",
    );
    m.unmount();
  });

  it("empty create is rejected and records nothing", async () => {
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [thread({ id: "t1", projectId: "p1" })],
      details: { t1: detail({ thread: thread({ id: "t1", projectId: "p1" }) }) },
    });
    const m = await boot(fake);
    await m.click(m.query("[data-space-add]"));
    await m.press(m.query("[data-space-add-input]"), "Enter");
    await m.flush();
    assert.equal(fake.of("spaces.add").length, 0, "empty name must not add");
    assert.ok(
      m.query("[data-space-add-input]"),
      "input stays open when rejected",
    );
    m.unmount();
  });

  it("renaming a space records spaces.update", async () => {
    const s1 = space({ id: "s1", name: "Client work" });
    const fake = createFakeCoder({
      spaces: [s1],
      projects: [project({ id: "p1", spaceId: "s1" })],
      threads: [thread({ id: "t1", projectId: "p1" })],
      details: { t1: detail({ thread: thread({ id: "t1", projectId: "p1" }) }) },
    });
    const m = await boot(fake);

    const edit = m.query('[data-space-edit="s1"]');
    assert.ok(edit, "space header must expose a rename control");
    await m.click(edit);
    const input = m.query('[data-space-rename-input="s1"]');
    assert.ok(input, "pencil reveals the inline rename input");
    await m.type(input, "Agency");
    await m.press(input, "Enter");
    await m.flush();

    const calls = fake.of("spaces.update");
    assert.equal(calls.length, 1, "rename records exactly one spaces.update");
    assert.deepEqual(calls[0]!.args[0], { id: "s1", name: "Agency" });
    m.unmount();
  });

  it("deleting a space confirms then records spaces.remove", async () => {
    const s1 = space({ id: "s1", name: "Client work" });
    const fake = createFakeCoder({
      spaces: [s1],
      projects: [project({ id: "p1", spaceId: "s1" })],
      threads: [thread({ id: "t1", projectId: "p1" })],
      details: { t1: detail({ thread: thread({ id: "t1", projectId: "p1" }) }) },
    });
    const m = await boot(fake);

    await m.click(m.query('[data-space-remove="s1"]'));
    const dialog = m.query('[data-space-remove-confirm="s1"]');
    assert.ok(dialog, "delete must confirm first");
    assert.ok(
      (dialog!.textContent || "").includes("unassigned, not deleted"),
      "confirm must say projects are unassigned, not deleted",
    );
    await m.click(m.byText("Cancel"));
    assert.equal(fake.of("spaces.remove").length, 0, "cancel records nothing");

    await m.click(m.query('[data-space-remove="s1"]'));
    await m.click(m.query('[data-space-remove-confirm-submit="s1"]'));
    await m.flush();
    const calls = fake.of("spaces.remove");
    assert.equal(calls.length, 1, "confirm records exactly one spaces.remove");
    assert.deepEqual(calls[0]!.args[0], { id: "s1" });
    m.unmount();
  });
});

describe("Sidebar spaces drag-and-drop", () => {
  it("dropping a project header on a space header records projects.update", async () => {
    const s1 = space({ id: "s1", name: "Client work" });
    const p1 = project({ id: "p1", slug: "acme/ledger", name: "ledger" });
    const assigned: string[] = [];
    const m = await mount(
      sidebar([t({ id: "t1", projectId: "p1" })], {
        projects: [p1],
        spaces: [s1],
        onAssignProjectToSpace: (projectId, spaceId) => {
          assigned.push(`${projectId}:${spaceId}`);
        },
      }),
    );

    const drag = m.query('[data-project-drag="p1"]');
    const drop = m.query('[data-space-drop="s1"]');
    assert.ok(drag, "project group header is the drag source");
    assert.ok(drop, "space header is the drop target");

    const transfer = stubTransfer();
    await fireDrag(drag, "dragstart", transfer);
    assert.equal(
      transfer.getData(PROJECT_DRAG_TYPE),
      "p1",
      "dragstart writes the project id on the dedicated type",
    );
    await fireDrag(drop, "dragover", transfer);
    await fireDrag(drop, "drop", transfer);
    await m.flush();

    assert.deepEqual(
      assigned,
      ["p1:s1"],
      "drop records exactly one assign with the right ids",
    );
    m.unmount();
  });

  it("dropping on Unassigned unassigns", async () => {
    const s1 = space({ id: "s1", name: "Client work" });
    const p1 = project({
      id: "p1",
      slug: "acme/ledger",
      name: "ledger",
      spaceId: "s1",
    });
    const assigned: string[] = [];
    const m = await mount(
      sidebar([t({ id: "t1", projectId: "p1" })], {
        projects: [p1],
        spaces: [s1],
        onAssignProjectToSpace: (projectId, spaceId) => {
          assigned.push(`${projectId}:${spaceId}`);
        },
      }),
    );
    const transfer = stubTransfer();
    await fireDrag(m.query('[data-project-drag="p1"]')!, "dragstart", transfer);
    await fireDrag(
      m.query('[data-space-drop="unassigned"]')!,
      "drop",
      transfer,
    );
    await m.flush();
    assert.deepEqual(assigned, ["p1:"], "Unassigned drop sends empty spaceId");
    m.unmount();
  });
});

describe("Edit project space select", () => {
  it("prefills from the project and submit records the chosen spaceId", async () => {
    const s1 = space({ id: "s1", name: "Client work" });
    const s2 = space({ id: "s2", name: "Experiments" });
    const p1 = project({ id: "p1", name: "ledger", spaceId: "s1" });
    const t1 = thread({ id: "t1", projectId: "p1" });
    const fake = createFakeCoder({
      spaces: [s1, s2],
      projects: [p1],
      threads: [t1],
      details: { t1: detail({ thread: t1 }) },
    });
    const m = await boot(fake);

    await m.click(m.query('[data-project-edit="p1"]'));
    const select = m.query(
      "[data-edit-project-space]",
    ) as HTMLSelectElement | null;
    assert.ok(select, "space select must exist when spaces do");
    assert.equal(select.value, "s1", "select prefills from the project");

    await m.change(select, "s2");
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();

    const calls = fake.of("projects.update");
    assert.equal(calls.length, 1, "submit records exactly one update");
    assert.equal(
      (calls[0]!.args[0] as { spaceId?: string }).spaceId,
      "s2",
      "chosen spaceId is sent",
    );
    m.unmount();
  });

  it("picking No space sends an empty string", async () => {
    const s1 = space({ id: "s1", name: "Client work" });
    const p1 = project({ id: "p1", name: "ledger", spaceId: "s1" });
    const t1 = thread({ id: "t1", projectId: "p1" });
    const fake = createFakeCoder({
      spaces: [s1],
      projects: [p1],
      threads: [t1],
      details: { t1: detail({ thread: t1 }) },
    });
    const m = await boot(fake);
    await m.click(m.query('[data-project-edit="p1"]'));
    await m.change(m.query("[data-edit-project-space]"), "");
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();
    const payload = fake.of("projects.update")[0]!.args[0] as {
      spaceId?: string;
    };
    assert.equal(payload.spaceId, "", "No space sends empty string");
    m.unmount();
  });
});

describe("Sidebar space collapse", () => {
  const s1 = space({ id: "s1", name: "Client work" });
  const s2 = space({ id: "s2", name: "Experiments" });
  const p1 = project({
    id: "p1",
    slug: "acme/ledger",
    name: "ledger",
    spaceId: "s1",
  });
  const p2 = project({
    id: "p2",
    slug: "acme/lab",
    name: "lab",
    spaceId: "s2",
  });
  const threads = [
    t({ id: "t-ledger", title: "ledger work", projectId: "p1" }),
    t({ id: "t-lab", title: "lab work", projectId: "p2" }),
  ];

  it("collapsing a space hides its project groups and drops them from ⌘1-9", async () => {
    await clearSidebarStorage();
    const selected: string[] = [];
    const m = await mount(
      sidebar(threads, {
        projects: [p1, p2],
        spaces: [s1, s2],
        onSelectThread: (id) => {
          selected.push(id);
        },
      }),
    );
    assert.ok(m.query('[data-thread-card="t-ledger"]'), "s1 project visible");
    assert.ok(m.query('[data-thread-card="t-lab"]'), "s2 project visible");

    await m.click(m.query('[data-space-header="s1"]'));
    assert.equal(
      m.query('[data-thread-card="t-ledger"]'),
      null,
      "collapsed space hides its project groups",
    );
    assert.ok(
      m.query('[data-thread-card="t-lab"]'),
      "other space stays visible",
    );

    await inAct(async () => {
      dispatchKey("1", { metaKey: true });
    });
    await m.flush();
    assert.deepEqual(
      selected,
      ["t-lab"],
      "⌘1 must pick the first still-visible thread, not the hidden one",
    );
    m.unmount();
    await clearSidebarStorage();
  });

  it("collapse state survives a remount (localStorage)", async () => {
    await clearSidebarStorage();
    const props = {
      projects: [p1, p2],
      spaces: [s1, s2],
    };
    const m1 = await mount(sidebar(threads, props));
    await m1.click(m1.query('[data-space-header="s1"]'));
    assert.deepEqual(
      collapsedSpacesFromStorage(),
      ["s1"],
      "collapse persists via coder.sidebar.collapsedSpaces",
    );
    m1.unmount();

    const m2 = await mount(sidebar(threads, props));
    assert.equal(
      m2.query('[data-thread-card="t-ledger"]'),
      null,
      "collapsed space stays collapsed after remount",
    );
    assert.ok(
      m2.query('[data-thread-card="t-lab"]'),
      "uncollapsed space still shows",
    );
    assert.equal(
      m2.query('[data-space-header="s1"]')?.getAttribute("aria-expanded"),
      "false",
    );
    m2.unmount();
    await clearSidebarStorage();
  });

  it("zero spaces renders no Unassigned header (today's sidebar)", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar([t({ id: "t1", projectId: "p1" })], {
        projects: [project({ id: "p1", slug: "acme/ledger" })],
        spaces: [],
      }),
    );
    assert.equal(
      m.query("[data-space-header]"),
      null,
      "no space headers when there are no spaces",
    );
    assert.ok(
      m.query('[data-thread-card="t1"]'),
      "project group still renders",
    );
    m.unmount();
  });
});
