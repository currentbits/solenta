/**
 * Shared Sidebar fixtures for sidebar.test.tsx and sidebar.filters.test.tsx.
 *
 * The suite is split across files because node:test gives each FILE one
 * --test-timeout budget (20 s); as one file it sat at the edge on slow
 * Windows runners. Importing this module also installs the localStorage
 * hooks below for the importing file.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach } from "node:test";
import { dismissContextMenu } from "../../src/contextMenuFallback";
import { mount } from "./dom";
import { Sidebar } from "../../src/components/Sidebar";
import type {
  ProjectInfo,
  ProviderInfo,
  ThreadInfo,
  UpdateStatus,
} from "../../src/shared/ipc";

export const p1: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};
export const p2: ProjectInfo = {
  id: "p2",
  slug: "acme/billing",
  name: "billing",
  path: "/tmp/billing",
};

export const providers: ProviderInfo[] = [
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

export const FRESH = Date.now();
export const DAY_MS = 24 * 60 * 60 * 1000;

// Card-anatomy tests render working threads; the Working shelf folds them
// by default, so open it here and test the fold on its own.
beforeEach(async () => {
  const shell = await mount(<div />);
  window.localStorage.setItem("sidebar:workingOpen", "1");
  window.localStorage.setItem("sidebar:filtersOpen", "1");
  shell.unmount();
});

afterEach(() => {
  dismissContextMenu();
  try {
    const ls = globalThis.window?.localStorage;
    if (!ls) return;
    for (const k of [
      "sidebar:projectScope",
      "sidebar:workingOpen",
      "sidebar:filtersOpen",
      "sidebar:snoozedOpen",
      "sidebar:settledOpen",
      "sidebar:statusFilter",
      "sidebar:providerFilter",
      "sidebar:tagFilter",
      "sidebar:groupBy",
      "sidebar:savedViews",
      "sidebar:activeSavedView",
      "coder.sidebar.collapsedGroups",
      "coder.sidebar.settledCollapsed",
    ]) {
      ls.removeItem(k);
    }
  } catch {
    // jsdom not installed yet
  }
});

export function thread(over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">): ThreadInfo {
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
    tags: [],
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

export function sidebar(
  threads: ThreadInfo[],
  over: {
    projects?: ProjectInfo[];
    activeThreadId?: string | null;
    onSetSettled?: (id: string, o: "settled" | "active") => void;
    onSetArchived?: (id: string, archived: boolean) => void;
    onSelectThread?: (id: string) => void;
    onRemoveProject?: (projectId: string) => void;
    onEditProject?: (projectId: string) => void;
    onAddProject?: () => void;
    onCreateThread?: (
      projectId?: string,
      opts?: {
        worktree?: boolean;
        orchestrate?: boolean;
        teach?: boolean;
        ask?: boolean;
        issueNumber?: number | null;
      },
    ) => void;
    onCreateThreadFromIssue?: (input: {
      projectId: string;
      projectPath: string;
      ref: string;
    }) => Promise<{ ok: boolean; reason?: string }>;
    onSetPinned?: (threadId: string, pinned: boolean) => void;
    onSetSnoozed?: (threadId: string, until: number | null) => void;
    onSetTags?: (threadId: string, tags: string[]) => void;
    onSetThreadProject?: (threadId: string, projectId: string) => void;
    projectError?: string | null;
    providers?: ProviderInfo[];
    onSetMuted?: (threadId: string, muted: boolean) => void;
    onRenameThread?: (threadId: string, title: string) => void;
    onFork?: (threadId: string, opts?: { provider?: string }) => void;
    activeView?:
      | "thread"
      | "kanban"
      | "planboard"
      | "prs"
      | "automations"
      | "activity"
      | "usage"
      | "fleet"
      | "insights"
      | "digest";
    onOpenThreads?: () => void;
    onOpenPlanboard?: (scopedProjectId?: string | null) => void;
    onOpenKanban?: (scopedProjectId?: string | null) => void;
    onOpenActivity?: (scopedProjectId?: string | null) => void;
    onOpenReview?: () => void;
    onOpenAutomations?: () => void;
    onOpenUsage?: () => void;
    onOpenFleet?: () => void;
    onOpenInsights?: () => void;
    onOpenDigest?: () => void;
    revealThreadId?: string | null;
    onRevealHandled?: () => void;
    updateState?: UpdateStatus["state"] | null;
    onDownloadUpdate?: () => void | Promise<void>;
    onApplyUpdate?: () => void | Promise<void>;
    onOpenSettings?: () => void;
    appVersion?: string | null;
    channel?: "prod" | "nightly" | null;
    searchThreads?: (input: { query: string }) => Promise<ThreadInfo[]>;
    trashedThreads?: import("../../src/shared/ipc").TrashedThreadInfo[];
    onRestoreThread?: (threadId: string) => void;
    onPurgeThread?: (threadId: string) => void;
    memoryEntries?: number | null;
    stayAwake?: import("../../src/shared/ipc").StayAwakeStatus | null;
  } = {},
) {
  const projects = over.projects ?? [p1];
  return (
    <Sidebar
      appName="Solenta"
      appVersion={over.appVersion}
      channel={over.channel}
      memoryEntries={over.memoryEntries}
      stayAwake={over.stayAwake}
      onSetStayAwakeMode={() => {}}
      searchPlaceholder="Search threads..."
      projectsHeader="All projects"
      projects={projects}
      threads={threads}
      providers={over.providers ?? providers}
      activeThreadId={over.activeThreadId ?? null}
      onSelectThread={over.onSelectThread ?? (() => {})}
      onCreateThread={over.onCreateThread ?? (() => {})}
      onAddProject={over.onAddProject ?? (() => {})}
      onRemoveProject={over.onRemoveProject}
      onEditProject={over.onEditProject}
      projectError={over.projectError ?? null}
      onSetSettled={over.onSetSettled}
      onSetArchived={over.onSetArchived}
      onSetPinned={over.onSetPinned}
      onSetSnoozed={over.onSetSnoozed}
      onSetTags={over.onSetTags}
      onSetThreadProject={over.onSetThreadProject}
      onSetMuted={over.onSetMuted}
      onRenameThread={over.onRenameThread}
      onFork={over.onFork}
      activeView={over.activeView}
      onOpenThreads={over.onOpenThreads}
      onOpenPlanboard={over.onOpenPlanboard}
      onOpenKanban={over.onOpenKanban}
      onOpenActivity={over.onOpenActivity}
      onOpenReview={over.onOpenReview}
      onOpenAutomations={over.onOpenAutomations}
      onOpenUsage={over.onOpenUsage}
      onOpenFleet={over.onOpenFleet}
      onOpenInsights={over.onOpenInsights}
      onOpenDigest={over.onOpenDigest}
      onCreateThreadFromIssue={over.onCreateThreadFromIssue}
      revealThreadId={over.revealThreadId ?? null}
      onRevealHandled={over.onRevealHandled}
      updateState={over.updateState}
      onDownloadUpdate={over.onDownloadUpdate}
      onApplyUpdate={over.onApplyUpdate}
      onOpenSettings={over.onOpenSettings}
      searchThreads={
        over.searchThreads ??
        (async ({ query }) =>
          threads.filter((t) => t.title.includes(query)))
      }
      trashedThreads={over.trashedThreads}
      onRestoreThread={over.onRestoreThread}
      onPurgeThread={over.onPurgeThread}
    />
  );
}

export async function openMoreMenu(m: Awaited<ReturnType<typeof mount>>): Promise<void> {
  if (m.query("[data-app-more-menu]")) return;
  const more = m.query("[data-app-more]");
  assert.ok(more, "More menu");
  await m.click(more);
  await m.flush();
}

/** Two projects; settled cases not all in one; selected not index 0. */
export const THREADS = [
  thread({
    id: "busy",
    title: "busy work",
    status: "working",
    runStartedAt: FRESH,
    createdAt: FRESH + 50,
    updatedAt: FRESH + 50,
    projectId: "p1",
  }),
  thread({
    id: "finished",
    title: "finished work",
    status: "done",
    createdAt: FRESH + 40,
    updatedAt: FRESH + 40,
    projectId: "p1",
  }),
  thread({
    id: "merged-p1",
    title: "merged ledger",
    status: "done",
    prState: "MERGED",
    settledAt: FRESH + 30,
    createdAt: FRESH + 30,
    updatedAt: FRESH + 30,
    projectId: "p1",
  }),
  thread({
    id: "broken",
    title: "broken work",
    status: "failed",
    createdAt: FRESH + 20,
    updatedAt: FRESH + 20,
    projectId: "p1",
  }),
  thread({
    id: "merged-p2",
    title: "merged billing",
    status: "done",
    prState: "MERGED",
    settledAt: FRESH + 35,
    createdAt: FRESH + 35,
    updatedAt: FRESH + 35,
    projectId: "p2",
  }),
  thread({
    id: "billing-idle",
    title: "billing idle",
    status: "idle",
    createdAt: FRESH + 10,
    updatedAt: FRESH + 10,
    projectId: "p2",
  }),
];

export function cardTitles(m: Awaited<ReturnType<typeof mount>>): string[] {
  return m
    .queryAll("[data-thread-card]")
    .map((el) => el.getAttribute("data-thread-card") || "");
}

export function searchInput(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLInputElement {
  const el = m.query(
    'input[placeholder="Search threads..."]',
  ) as HTMLInputElement | null;
  assert.ok(el, "search input must render");
  return el;
}

export function scopeTrigger(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLButtonElement {
  const el = m.query("[data-scope-trigger]") as HTMLButtonElement | null;
  assert.ok(el, "scope trigger must render");
  return el;
}

export function snoozedToggle(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLButtonElement {
  const el = m.query(
    "[data-snoozed-shelf-toggle]",
  ) as HTMLButtonElement | null;
  assert.ok(el, "snoozed shelf toggle must render");
  return el;
}

export function settledToggle(
  m: Awaited<ReturnType<typeof mount>>,
): HTMLButtonElement {
  const el = m.query(
    "[data-settled-shelf-toggle]",
  ) as HTMLButtonElement | null;
  assert.ok(el, "settled shelf toggle must render");
  return el;
}

export async function openSettledShelf(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  const btn = settledToggle(m);
  if (btn.getAttribute("aria-expanded") !== "true") {
    await m.click(btn);
    await m.flush();
  }
}

export async function openSnoozedShelf(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  const btn = snoozedToggle(m);
  if (btn.getAttribute("aria-expanded") !== "true") {
    await m.click(btn);
    await m.flush();
  }
}

export async function openScopeMenu(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  if (!m.query("[data-scope-menu]")) {
    await m.click(scopeTrigger(m));
    await m.flush();
  }
}

export async function openCreateMenu(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  if (!m.query("[data-new-thread-menu]")) {
    const caret = m.query("[data-new-thread-caret]");
    assert.ok(caret, "create caret must render");
    await m.click(caret);
    await m.flush();
  }
}

/** Install jsdom via a throwaway mount, then clear localStorage for a clean slate. */
export async function clearSidebarStorage(): Promise<void> {
  const shell = await mount(<div />);
  window.localStorage.clear();
  window.localStorage.setItem("sidebar:workingOpen", "1");
  window.localStorage.setItem("sidebar:filtersOpen", "1");
  shell.unmount();
}

export function portalMenu(): HTMLElement | null {
  return document.querySelector("[data-context-menu]");
}
