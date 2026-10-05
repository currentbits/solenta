import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import autoAnimate from "@formkit/auto-animate";
import type {
  CliSessionCandidate,
  ConflictForecast,
  ProjectInfo,
  ProviderInfo,
  StayAwakeMode,
  StayAwakeStatus,
  ThreadInfo,
  TrashedThreadInfo,
  UpdateStatus,
} from "../shared/ipc";
import { isWebMode } from "../shared/wire";
import {
  buildFlatSidebar,
  crewAncestorIds,
  nestWorkerFamilies,
  visibleFamilyRows,
  withCrewSearchContext,
  workerIdsByRoot,
} from "../sidebarGroups";
import { ProviderMark } from "./ProviderMark";
import {
  GROUP_BY_KEY,
  GROUP_BY_OPTIONS,
  PROVIDER_FILTER_KEY,
  STATUS_FILTER_KEY,
  STATUS_FILTERS,
  TAG_FILTER_KEY,
  allTags,
  filterThreads,
  groupByLabel,
  groupThreadsByProject,
  groupThreadsByStatus,
  groupThreadsByTag,
  parseGroupBy,
  parseProviderFilter,
  parseStatusFilter,
  providerFilterLabel,
  serializeProviderFilter,
  statusFilterLabel,
  tagFilterLabel,
  threadMatchesFilter,
  type GroupBy,
  type StatusFilter,
} from "../sidebarFilters";
import {
  ACTIVE_SAVED_VIEW_KEY,
  SAVED_VIEWS_KEY,
  addSavedView,
  criteriaEqual,
  deleteSavedView,
  parseActiveSavedViewId,
  parseSavedViews,
  renameSavedView,
  savedViewTriggerLabel,
  savedViewUnavailable,
  serializeSavedViews,
  updateSavedView,
  type SavedView,
  type SavedViewCriteria,
} from "../sidebarViews";
import type { SettingsPane } from "./SettingsModal";
import {
  AUTO_SETTLE_AFTER_DAYS,
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
  effectiveSettled,
} from "../threadSettle";
import { ProjectIcon } from "./ProjectIcon";
import {
  buildWaitStates,
  crewSummaryLabel,
  summarizeCrew,
} from "../waiting";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import {
  flatVisibleThreadIds,
  formatBatchSettleFeedback,
  isShortcutBlocked,
  planBatchSettle,
  rangeSelectIds,
  stepVisibleId,
  toggleIdInSet,
} from "../sidebarSelection";
import { KeyboardSheet } from "./KeyboardSheet";
import { StayAwakeControl } from "./StayAwakeControl";
import {
  ImportCliSessionModal,
  type CliImportProvider,
} from "./ImportCliSessionModal";
import { Icon } from "./sidebar/Icon";
import { ThreadCard, type SelectOpts } from "./sidebar/ThreadCard";
import { SettledRow, SnoozedRow } from "./sidebar/rows";
import {
  MORE_DESTINATIONS,
  moveAppMenuFocus,
  type SidebarNavView,
} from "./sidebar/nav";
import {
  countIdChurn,
  listMotionBlocked,
  releaseAbortedRows,
  type ListAnimCtrl,
  type ListMotionSkip,
} from "./sidebar/motion";
import {
  loadFlag,
  loadOpenSet,
  loadStored,
  saveFlag,
  saveOpenSet,
  saveStored,
} from "./sidebar/storage";
import { useStableThreadTitles } from "./sidebar/useStableThreadTitles";
import styles from "./Sidebar.module.css";

export { displayWorkerTitle, statusPulseFor } from "./sidebar/status";
export { SettledRow, ThreadCard };

const TICK_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatTrashExpiry(expiresAt: number, now: number): string {
  const days = Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
  if (days <= 0) return "Expires today";
  return days === 1 ? "Expires in 1d" : `Expires in ${days}d`;
}
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;
const SCOPE_KEY = "sidebar:projectScope";
const WORKING_OPEN_KEY = "sidebar:workingOpen";
const FILTERS_OPEN_KEY = "sidebar:filtersOpen";
const SNOOZED_OPEN_KEY = "sidebar:snoozedOpen";
const SETTLED_OPEN_KEY = "sidebar:settledOpen";
const WORKER_OPEN_KEY = "sidebar:workerOpen";
const FAMILY_MOTION_MS = 160;
const BULK_ROW_DELTA = 40;
type FilterMenu = "status" | "provider" | "group" | "tag" | "views";
type ViewEditor = { mode: "save" | "rename"; name: string };

interface SidebarProps {
  appName: string;
  /** Wide layouts: fold the sidebar to a rail (⌘B). Absent on narrow. */
  onCollapseSidebar?: () => void;
  /** Running package version; rendered next to the wordmark. */
  appVersion?: string | null;
  /** Update channel of the running build; "nightly" tags the wordmark. */
  channel?: "prod" | "nightly" | null;
  /** Update check result; a button next to Settings when an update is waiting. */
  updateState?: UpdateStatus["state"] | null;
  /** Download + stage the waiting release (updateState "available"). */
  onDownloadUpdate?: () => void | Promise<void>;
  /** Relaunch into the staged bundle (updateState "staged"). */
  onApplyUpdate?: () => void | Promise<void>;
  searchPlaceholder: string;
  projectsHeader: string;
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  /** Provider registry for display names on thread cards. */
  providers: ProviderInfo[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  /** Global + uses selected project; per-group New thread passes that projectId. */
  onCreateThread: (
    projectId?: string,
    opts?: { worktree?: boolean; orchestrate?: boolean; teach?: boolean; ask?: boolean; issueNumber?: number | null; baseBranch?: string | null },
  ) => void;
  /** Local branches for the stacked-thread base picker (#187). */
  listBaseBranches?: (
    projectId: string,
  ) => Promise<{ defaultBranch: string; branches: string[] }>;
  /**
   * Mirrors SettingsInfo.defaultWorktree. The caret lists worktree,
   * orchestrator, plain, teach, and ask; this only documents the setting the
   * plain "New thread" button follows (issue #72). Unused in the menu itself.
   */
  defaultWorktree?: boolean;
  onAddProject: () => void;
  /**
   * t3-style remove project entry (after the sidebar confirm). Caller owns
   * the IPC call, selection handoff, and failure toast. Resolves on success;
   * rejects on failure so the confirm can close either way.
   */
  onRemoveProject?: (projectId: string) => void | Promise<void>;
  /** Opens the edit-project modal (name + SSH remote fields). */
  onEditProject?: (projectId: string) => void;
  projectError?: string | null;
  onDismissProjectError?: () => void;
  /** Opens Settings. Pass a pane to land on it (worktree usage → Git). */
  onOpenSettings?: (pane?: SettingsPane) => void;
  /**
   * Stay-awake state from main (issue #364). When present, the footer shows
   * the three-state control (agent/on/off); click cycles the mode.
   */
  stayAwake?: StayAwakeStatus | null;
  /** Persist a stay-awake mode (settings.stayAwake). */
  onSetStayAwakeMode?: (mode: StayAwakeMode) => void;
  /** Aggregated spend today (USD); null while loading. */
  spendTodayUsd?: number | null;
  /** Shared-memory entry count (AppStatus.memory.entries); null hides it. */
  memoryEntries?: number | null;
  /** Daily budget cap; null = no cap. */
  dailyBudgetUsd?: number | null;
  /**
   * Auto-settle window (days). undefined = settings still loading → use
   * AUTO_SETTLE_AFTER_DAYS constant. null = loaded and user disabled.
   * positive integer = override.
   */
  autoSettleAfterDays?: number | null;
  /**
   * When false, a MERGED PR does not auto-settle. undefined while settings
   * load → treat as true (the store default).
   */
  autoSettleOnMerge?: boolean;
  /**
   * Full-content thread search (titles + message text). Called only for
   * queries of 2+ chars after debounce; empty / 1-char stays local.
   */
  searchThreads: (input: { query: string }) => Promise<ThreadInfo[]>;
  /**
   * Pin or unpin settle override for a thread card (hover action).
   * override "settled" folds it; "active" keeps it out of the fold.
   */
  onSetSettled?: (
    threadId: string,
    override: "settled" | "active",
  ) => void | Promise<void>;
  onSetPinned?: (threadId: string, pinned: boolean) => void | Promise<void>;
  onSetSnoozed?: (threadId: string, until: number | null) => void | Promise<void>;
  /** Replace a thread's user-defined tags (chip editor on the card). */
  onSetTags?: (threadId: string, tags: string[]) => void | Promise<void>;
  /** Recategorize a thread onto another project (issue #737). */
  onSetThreadProject?: (
    threadId: string,
    projectId: string,
  ) => void | Promise<void>;
  /** Mute/unmute desktop notifications for one thread. */
  onSetMuted?: (threadId: string, muted: boolean) => void | Promise<void>;
  /** Eject/reclaim the provider session so the raw CLI can own it (#554). */
  onSetEjected?: (threadId: string, ejected: boolean) => void | Promise<void>;
  /** Rename a thread from the row menu. */
  onRenameThread?: (threadId: string, title: string) => void | Promise<void>;
  /** Archive a thread (batch toolbar). */
  onSetArchived?: (threadId: string, archived: boolean) => void | Promise<void>;
  /** Clear the settled tail: archive all settled threads (Synara-style, undo via toast). */
  onClearSettled?: (threadIds: string[]) => void | Promise<void>;
  /** Recently deleted rows (#940). Hidden from the live list. */
  trashedThreads?: TrashedThreadInfo[];
  onRestoreThread?: (threadId: string) => void | Promise<void>;
  onPurgeThread?: (threadId: string) => void | Promise<void>;
  /**
   * Fork / hand off (round 49). Plain call = same harness; provider override
   * is hand-off. Does not require the thread to be selected.
   */
  onFork?: (
    threadId: string,
    opts?: { provider?: string },
  ) => void | Promise<void>;
  /**
   * Which main view is showing. Pass the real view: collapsing other
   * destinations to "thread" marks Threads active while the user is elsewhere.
   */
  activeView?: SidebarNavView;
  /** Return to the selected thread. Does not create a thread. */
  onOpenThreads?: () => void;
  onOpenKanban?: (scopedProjectId?: string | null) => void;
  onOpenPlanboard?: (scopedProjectId?: string | null) => void;
  /** Existing pull-request list. Not a separate review dashboard. */
  onOpenReview?: () => void;
  onOpenAutomations?: () => void;
  onOpenUsage?: () => void;
  onOpenFleet?: () => void;
  onOpenInsights?: () => void;
  onOpenDigest?: () => void;
  /**
   * Paste a GitHub issue into this project. Omitted by existing tests so
   * the icon button stays hidden.
   */
  onCreateThreadFromIssue?: (input: {
    projectId: string;
    projectPath: string;
    ref: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Codex / Grok / Claude / Cursor / OpenCode / Kimi / Muse CLI sessions on disk. Desktop import picker. */
  listCliSessions?: (input?: {
    provider?: CliImportProvider;
  }) => Promise<CliSessionCandidate[]>;
  /**
   * Import one listed CLI session as a Solenta thread in projectId.
   * Caller selects/reveals the returned thread.
   */
  importCliSession?: (input: {
    sessionId: string;
    projectId: string;
    provider?: CliImportProvider;
  }) => Promise<ThreadInfo>;
  onOpenActivity?: (scopedProjectId?: string | null) => void;
  /**
   * Freshly created thread to reveal (t3: new work must be visible): the
   * sidebar expands its project group, scrolls the card into view and flashes
   * a highlight, then calls onRevealHandled.
   */
  revealThreadId?: string | null;
  /** Clears revealThreadId once the reveal ran (or the thread is gone). */
  onRevealHandled?: () => void;
  /** Overlapping-edit forecast for the selected project (issue #249). */
  conflictForecast?: ConflictForecast | null;
}

/**
 * memo'd: a streaming thread pushes an update every 700ms, and the sidebar
 * must only re-render when the LIST moved — not when the open transcript did
 * (issue #91). App keeps every prop stable for that to bite.
 */
export const Sidebar = memo(function Sidebar({
  appName,
  onCollapseSidebar,
  appVersion,
  channel,
  updateState,
  onDownloadUpdate,
  onApplyUpdate,
  searchPlaceholder,
  projects,
  threads,
  providers,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  listBaseBranches,
  onAddProject,
  onRemoveProject,
  onEditProject,
  projectError = null,
  onDismissProjectError,
  onOpenSettings,
  stayAwake = null,
  onSetStayAwakeMode,
  memoryEntries = null,
  autoSettleAfterDays,
  autoSettleOnMerge,
  searchThreads,
  onSetSettled,
  onSetPinned,
  onSetSnoozed,
  onSetTags,
  onSetThreadProject,
  onSetMuted,
  onSetEjected,
  onRenameThread,
  onSetArchived,
  onClearSettled,
  trashedThreads = [],
  onRestoreThread,
  onPurgeThread,
  onFork,
  activeView = "thread",
  onOpenThreads,
  onOpenKanban,
  onOpenPlanboard,
  onOpenReview,
  onOpenAutomations,
  onOpenUsage,
  onOpenFleet,
  onOpenInsights,
  onOpenDigest,
  onCreateThreadFromIssue,
  listCliSessions,
  importCliSession,
  onOpenActivity,
  revealThreadId = null,
  onRevealHandled,
  conflictForecast = null,
}: SidebarProps) {
  const [savedViews, setSavedViews] = useState<SavedView[]>(() =>
    parseSavedViews(loadStored(SAVED_VIEWS_KEY)),
  );
  const [activeViewId, setActiveViewId] = useState<string | null>(() =>
    parseActiveSavedViewId(
      loadStored(ACTIVE_SAVED_VIEW_KEY),
      parseSavedViews(loadStored(SAVED_VIEWS_KEY)),
    ),
  );
  const [viewEditor, setViewEditor] = useState<ViewEditor | null>(null);
  const [query, setQuery] = useState(() => {
    const views = parseSavedViews(loadStored(SAVED_VIEWS_KEY));
    const id = parseActiveSavedViewId(
      loadStored(ACTIVE_SAVED_VIEW_KEY),
      views,
    );
    const view = views.find((v) => v.id === id);
    return view?.criteria.query ?? "";
  });
  const [now, setNow] = useState(() => Date.now());
  const [updating, setUpdating] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [basePicker, setBasePicker] = useState<{
    defaultBranch: string;
    branches: string[];
  } | null>(null);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [filterMenu, setFilterMenu] = useState<FilterMenu | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreHostRef = useRef<HTMLSpanElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter | null>(() =>
    parseStatusFilter(loadStored(STATUS_FILTER_KEY)),
  );
  const [providerFilter, setProviderFilter] = useState<string[]>(() =>
    parseProviderFilter(loadStored(PROVIDER_FILTER_KEY)),
  );
  const [tagFilter, setTagFilter] = useState<string | null>(() =>
    loadStored(TAG_FILTER_KEY),
  );
  const [groupBy, setGroupBy] = useState<GroupBy>(() =>
    parseGroupBy(loadStored(GROUP_BY_KEY)),
  );
  useEscapeClose(
    (createMenuOpen || scopeMenuOpen || filterMenu != null) &&
      removeConfirmId == null &&
      !moreOpen,
    () => {
      setCreateMenuOpen(false);
      setBasePicker(null);
      setScopeMenuOpen(false);
      setFilterMenu(null);
      setViewEditor(null);
    },
  );
  useLayoutEffect(() => {
    if (!moreOpen) return;
    const menu = moreHostRef.current?.querySelector<HTMLElement>(
      "[data-app-more-menu]",
    );
    if (!menu) return;
    const current = menu.querySelector<HTMLElement>('[aria-current="page"]');
    const first = menu.querySelector<HTMLElement>('[role="menuitem"]');
    (current ?? first)?.focus();
  }, [moreOpen]);
  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (moreHostRef.current?.contains(e.target as Node)) return;
      const menu = moreHostRef.current?.querySelector("[data-app-more-menu]");
      const restore = Boolean(menu?.contains(document.activeElement));
      setMoreOpen(false);
      if (restore) moreTriggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointer, true);
    return () => document.removeEventListener("mousedown", onPointer, true);
  }, [moreOpen]);
  const [importCliProvider, setImportCliProvider] =
    useState<CliImportProvider | null>(null);
  const [issueFormFor, setIssueFormFor] = useState<string | null>(null);
  const [issueRef, setIssueRef] = useState("");
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issuePending, setIssuePending] = useState(false);
  const closeIssueForm = useCallback(() => {
    if (issuePending) return;
    setIssueFormFor(null);
    setIssueRef("");
    setIssueError(null);
  }, [issuePending]);
  useEscapeClose(issueFormFor != null && !issuePending, closeIssueForm);
  const [removePending, setRemovePending] = useState(false);
  const closeRemoveConfirm = useCallback(() => {
    if (removePending) return;
    setRemoveConfirmId(null);
  }, [removePending]);
  useEscapeClose(removeConfirmId != null && !removePending, closeRemoveConfirm);
  const removeConfirmRef = useRef<HTMLDivElement>(null);
  useModalFocus(removeConfirmId != null, removeConfirmRef);
  const [projectScope, setProjectScope] = useState<string | null>(() =>
    loadStored(SCOPE_KEY),
  );
  const [workingOpen, setWorkingOpen] = useState(() =>
    loadFlag(WORKING_OPEN_KEY, false),
  );
  const [filtersOpen, setFiltersOpen] = useState(() =>
    loadFlag(FILTERS_OPEN_KEY, false),
  );
  const [snoozedOpen, setSnoozedOpen] = useState(() =>
    loadFlag(SNOOZED_OPEN_KEY, false),
  );
  const [settledOpen, setSettledOpen] = useState(() =>
    loadFlag(SETTLED_OPEN_KEY, false),
  );
  const [workerOpen, setWorkerOpen] = useState<Set<string>>(
    () => loadOpenSet(WORKER_OPEN_KEY),
  );
  const listAnimCtrls = useRef(new Map<HTMLElement, ListAnimCtrl>());
  const listAnimSkip = useRef<ListMotionSkip>({
    hydrate: true,
    bulk: false,
    keyboard: false,
  });
  const prevRowIds = useRef<string[]>([]);
  const applyListMotion = useCallback(() => {
    const enable = !listMotionBlocked(listAnimSkip.current);
    for (const [node, ctrl] of listAnimCtrls.current) {
      if (enable) ctrl.enable();
      else {
        ctrl.disable();
        releaseAbortedRows(node);
      }
    }
  }, []);
  const bindListAnimation = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    if (typeof ResizeObserver === "undefined") return;
    // The library samples prefers-reduced-motion only while binding and, when
    // it matches, never installs an observer. enable() cannot bring that
    // observer back, so a session that starts reduced stays frozen after the
    // user turns motion on. Own the gate instead.
    const ctrl = autoAnimate(node, {
      duration: FAMILY_MOTION_MS,
      easing: "ease-out",
      disrespectUserMotionPreference: true,
    });
    listAnimCtrls.current.set(node, ctrl);
    if (listMotionBlocked(listAnimSkip.current)) {
      ctrl.disable();
      releaseAbortedRows(node);
    }
    return () => {
      ctrl.destroy?.();
      listAnimCtrls.current.delete(node);
    };
  }, []);
  const [trashedOpen, setTrashedOpen] = useState(false);
  const [purgeConfirmId, setPurgeConfirmId] = useState<string | null>(null);
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    SETTLED_TAIL_INITIAL_COUNT,
  );
  const [multiSelected, setMultiSelected] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectAnchor, setSelectAnchor] = useState<string | null>(null);
  const [batchFeedback, setBatchFeedback] = useState<string | null>(null);
  const [cmdHeld, setCmdHeld] = useState(false);
  const [keyboardSheetOpen, setKeyboardSheetOpen] = useState(false);
  const settleOpts = useMemo(
    () => ({
      now,
      autoSettleAfterDays:
        autoSettleAfterDays === undefined
          ? AUTO_SETTLE_AFTER_DAYS
          : autoSettleAfterDays,
      autoSettleOnMerge: autoSettleOnMerge !== false,
    }),
    [now, autoSettleAfterDays, autoSettleOnMerge],
  );
  const threadTitles = useStableThreadTitles(threads);
  const [searchResults, setSearchResults] = useState<ThreadInfo[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  const searchGen = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => window.clearInterval(handle);
  }, []);

  const projectById = useMemo(() => {
    const m = new Map<string, ProjectInfo>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const liveById = useMemo(() => {
    const m = new Map<string, ThreadInfo>();
    for (const t of threads) m.set(t.id, t);
    return m;
  }, [threads]);

  const waitStates = useMemo(() => buildWaitStates(threads), [threads]);

  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length >= MIN_SEARCH_LEN;

  const runSearch = useCallback(
    async (q: string) => {
      const gen = ++searchGen.current;
      setSearchLoading(true);
      try {
        const list = await searchThreads({ query: q });
        if (!mountedRef.current || searchGen.current !== gen) return;
        setSearchResults(list);
      } catch {
        if (!mountedRef.current || searchGen.current !== gen) return;
        setSearchResults([]);
      } finally {
        if (mountedRef.current && searchGen.current === gen) {
          setSearchLoading(false);
        }
      }
    },
    [searchThreads],
  );

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_SEARCH_LEN) {
      searchGen.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }

    const handle = window.setTimeout(() => {
      void runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, runSearch]);

  const keepThreadIds = useMemo(() => {
    const ids: (string | null | undefined)[] = [activeThreadId, revealThreadId];
    for (const id of [activeThreadId, revealThreadId]) {
      if (!id) continue;
      const row = liveById.get(id);
      if (!row) continue;
      const ancestors = crewAncestorIds(row, liveById);
      const rootId = ancestors[ancestors.length - 1];
      if (rootId) ids.push(rootId);
    }
    return ids;
  }, [activeThreadId, revealThreadId, liveById]);

  const displayThreads = useMemo(() => {
    const source =
      searching
        ? searchResults == null
          ? []
          : searchResults.map((t) => liveById.get(t.id) ?? t)
        : threads;
    const filtered = filterThreads(
      source,
      {
        status: statusFilter,
        providers: providerFilter,
        projectId: projectScope,
        tag: tagFilter,
      },
      {
        waits: waitStates,
        keepIds: keepThreadIds,
      },
    );
    return searching ? withCrewSearchContext(filtered, threads) : filtered;
  }, [
    searching,
    searchResults,
    threads,
    liveById,
    statusFilter,
    providerFilter,
    tagFilter,
    projectScope,
    waitStates,
    keepThreadIds,
  ]);

  // Drop a stale scope if the project was removed. An active saved view
  // keeps the criterion so a missing project stays empty, not "all projects".
  useEffect(() => {
    if (activeViewId != null) return;
    if (projectScope != null && !projectById.has(projectScope)) {
      setProjectScope(null);
      saveStored(SCOPE_KEY, null);
    }
  }, [projectScope, projectById, activeViewId]);

  const knownTags = useMemo(() => allTags(threads), [threads]);

  // Drop a stale tag filter when no thread carries the tag anymore.
  useEffect(() => {
    if (activeViewId != null) return;
    if (tagFilter != null && !knownTags.includes(tagFilter)) {
      setTagFilter(null);
      saveStored(TAG_FILTER_KEY, null);
    }
  }, [tagFilter, knownTags, activeViewId]);

  useEffect(() => {
    setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
  }, [projectScope, statusFilter, providerFilter]);

  const flat = useMemo(
    () => buildFlatSidebar(displayThreads, settleOpts),
    [displayThreads, settleOpts],
  );

  // Grouped views have no Working shelf: busy rows stay in their groups.
  const attentionThreads = useMemo(
    () => [...flat.pinned, ...flat.active, ...flat.working],
    [flat.pinned, flat.active, flat.working],
  );
  const projectGroups = useMemo(
    () =>
      groupBy === "project"
        ? groupThreadsByProject(projects, attentionThreads)
        : [],
    [groupBy, projects, attentionThreads],
  );
  const statusGroups = useMemo(
    () =>
      groupBy === "status"
        ? groupThreadsByStatus(attentionThreads, waitStates).map((g) => ({
            ...g,
            threads: nestWorkerFamilies(g.threads, liveById),
          }))
        : [],
    [groupBy, attentionThreads, waitStates, liveById],
  );
  const tagGroups = useMemo(
    () =>
      groupBy === "tag"
        ? groupThreadsByTag(attentionThreads).map((g) => ({
            ...g,
            threads: nestWorkerFamilies(g.threads, liveById),
          }))
        : [],
    [groupBy, attentionThreads, liveById],
  );
  const searchHitIds = useMemo(() => {
    if (!searching || searchResults == null) return undefined;
    return new Set(searchResults.map((t) => t.id));
  }, [searching, searchResults]);

  const familyOpts = useMemo(
    () => ({
      expandedRootIds: workerOpen,
      keepIds: keepThreadIds,
      keepWorkerIds: searchHitIds,
      byIdFull: liveById,
    }),
    [workerOpen, keepThreadIds, searchHitIds, liveById],
  );

  const visiblePinned = useMemo(
    () => visibleFamilyRows(flat.pinned, familyOpts),
    [flat.pinned, familyOpts],
  );
  const visibleActive = useMemo(
    () => visibleFamilyRows(flat.active, familyOpts),
    [flat.active, familyOpts],
  );
  const pinnedFamilies = useMemo(
    () => workerIdsByRoot(flat.pinned, liveById),
    [flat.pinned, liveById],
  );
  const activeFamilies = useMemo(
    () => workerIdsByRoot(flat.active, liveById),
    [flat.active, liveById],
  );
  const visibleWorking = useMemo(
    () => visibleFamilyRows(flat.working, familyOpts),
    [flat.working, familyOpts],
  );
  const workingFamilies = useMemo(
    () => workerIdsByRoot(flat.working, liveById),
    [flat.working, liveById],
  );
  const searchFamilies = useMemo(
    () => workerIdsByRoot(displayThreads, liveById),
    [displayThreads, liveById],
  );

  const toggleFamily = useCallback(
    (threadId: string, snap = false) => {
      if (snap) {
        listAnimSkip.current.keyboard = true;
        applyListMotion();
      }
      setWorkerOpen((prev) => {
        const next = new Set(prev);
        if (next.has(threadId)) next.delete(threadId);
        else next.add(threadId);
        saveOpenSet(WORKER_OPEN_KEY, next);
        return next;
      });
      if (snap) {
        window.requestAnimationFrame(() => {
          listAnimSkip.current.keyboard = false;
          applyListMotion();
        });
      }
    },
    [applyListMotion],
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => applyListMotion();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [applyListMotion]);

  useEffect(() => {
    if (!revealThreadId) return;
    const target = threads.find((t) => t.id === revealThreadId);
    if (target) {
      window.requestAnimationFrame(() => {
        const el = document.querySelector(
          `[data-thread-card="${revealThreadId}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
        el?.classList.add(styles.reveal);
      });
    }
    onRevealHandled?.();
  }, [revealThreadId, threads, onRevealHandled]);

  const canCreate = projects.length > 0;
  /**
   * Create target: scoped project when a scope is set, else the open
   * thread's project, else the first project.
   */
  const createTargetProject = (() => {
    if (projectScope) {
      const scoped = projectById.get(projectScope);
      if (scoped) return scoped;
    }
    if (activeThreadId) {
      const t = liveById.get(activeThreadId);
      if (t) return projectById.get(t.projectId) ?? null;
    }
    return projects[0] ?? null;
  })();
  const createTargetLabel = createTargetProject
    ? `New thread in ${createTargetProject.slug || createTargetProject.name}`
    : "New thread";
  const queryLower = trimmedQuery.toLowerCase();
  const searchInFlight = searching && (searchLoading || searchResults == null);
  const searchEmpty =
    searching &&
    !searchInFlight &&
    displayThreads.length === 0;

  const slugFor = (t: ThreadInfo) =>
    projectById.get(t.projectId)?.slug ?? "unknown";
  const iconUrlFor = (t: ThreadInfo) =>
    projectById.get(t.projectId)?.iconUrl ?? null;

  const settledTail = useMemo(
    () => [...flat.settled, ...flat.archived],
    [flat.settled, flat.archived],
  );

  const filtersOn =
    statusFilter != null || providerFilter.length > 0 || tagFilter != null;
  // Any narrowing keeps its controls on screen, so a filtered list explains
  // itself; otherwise the filter bar folds behind the search-row funnel.
  const filtersEngaged = filtersOn || groupBy !== "none" || activeViewId != null;
  const filterBarShown = filtersOpen || filtersEngaged;
  const toggleFilterBar = () => {
    setFiltersOpen((open) => {
      saveFlag(FILTERS_OPEN_KEY, !open);
      return !open;
    });
  };
  const workingExpanded = workingOpen || filtersOn;
  const snoozedExpanded = snoozedOpen || filtersOn;
  const settledExpanded = settledOpen || filtersOn;

  const visibleProjectGroups = useMemo(
    () =>
      projectGroups.map((g) => ({
        ...g,
        threads: visibleFamilyRows(g.threads, familyOpts),
      })),
    [projectGroups, familyOpts],
  );
  const visibleStatusGroups = useMemo(
    () =>
      statusGroups.map((g) => ({
        ...g,
        threads: visibleFamilyRows(g.threads, familyOpts),
      })),
    [statusGroups, familyOpts],
  );
  const visibleTagGroups = useMemo(
    () =>
      tagGroups.map((g) => ({
        ...g,
        threads: visibleFamilyRows(g.threads, familyOpts),
      })),
    [tagGroups, familyOpts],
  );

  const visibleIds = useMemo(() => {
    if (searching) {
      return visibleFamilyRows(displayThreads, familyOpts).map((t) => t.id);
    }
    const groupedRows =
      groupBy === "project"
        ? visibleProjectGroups.flatMap((g) => g.threads)
        : groupBy === "status"
          ? visibleStatusGroups.flatMap((g) => g.threads)
          : groupBy === "tag"
            ? (() => {
                const seen = new Set<string>();
                const out: ThreadInfo[] = [];
                for (const g of visibleTagGroups) {
                  for (const t of g.threads) {
                    if (seen.has(t.id)) continue;
                    seen.add(t.id);
                    out.push(t);
                  }
                }
                return out;
              })()
            : null;
    const navFlat =
      groupedRows != null
        ? { ...flat, pinned: [], active: groupedRows, working: [] }
        : {
            ...flat,
            pinned: visiblePinned,
            active: visibleActive,
            working: visibleWorking,
          };
    return flatVisibleThreadIds({
      flat: navFlat,
      workingOpen: workingExpanded,
      snoozedOpen: snoozedExpanded,
      settledOpen: settledExpanded,
      settledVisibleCount,
      selectedThreadId: activeThreadId,
      keepThreadIds: [revealThreadId ?? null],
    });
  }, [
    searching,
    displayThreads,
    familyOpts,
    groupBy,
    visibleProjectGroups,
    visibleStatusGroups,
    visibleTagGroups,
    flat,
    visiblePinned,
    visibleActive,
    visibleWorking,
    workingExpanded,
    snoozedExpanded,
    settledExpanded,
    settledVisibleCount,
    activeThreadId,
    revealThreadId,
  ]);

  useLayoutEffect(() => {
    const next = visibleIds;
    const prev = prevRowIds.current;
    const firstFill = prev.length === 0 && next.length > 0;
    const churn = countIdChurn(prev, next);
    const bulk =
      searching ||
      firstFill ||
      listAnimSkip.current.hydrate ||
      churn > BULK_ROW_DELTA;
    listAnimSkip.current.bulk = bulk;
    if (bulk || listAnimSkip.current.keyboard) applyListMotion();
    prevRowIds.current = next;
  }, [visibleIds, searching, applyListMotion]);

  useEffect(() => {
    listAnimSkip.current.hydrate = false;
    listAnimSkip.current.bulk = searching;
    applyListMotion();
  }, [visibleIds, searching, applyListMotion]);

  const visibleIndex = useMemo(() => {
    const m = new Map<string, number>();
    visibleIds.forEach((id, i) => m.set(id, i));
    return m;
  }, [visibleIds]);

  const visibleIdsRef = useRef(visibleIds);
  const selectAnchorRef = useRef(selectAnchor);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const listMoveProjects = useCallback(() => projectsRef.current, []);
  useEffect(() => {
    visibleIdsRef.current = visibleIds;
    selectAnchorRef.current = selectAnchor;
  });

  const handleSelect = useCallback(
    (id: string, opts?: SelectOpts) => {
      if (opts?.shift) {
        const range = rangeSelectIds(
          visibleIdsRef.current,
          selectAnchorRef.current,
          id,
        );
        setMultiSelected(new Set(range));
        setBatchFeedback(null);
        return;
      }
      if (opts?.meta) {
        setMultiSelected((prev) => toggleIdInSet(prev, id));
        setSelectAnchor(id);
        setBatchFeedback(null);
        return;
      }
      setMultiSelected(new Set());
      setSelectAnchor(id);
      setBatchFeedback(null);
      onSelectThread(id);
    },
    [onSelectThread],
  );

  const clearMulti = useCallback(() => {
    setMultiSelected(new Set());
    setBatchFeedback(null);
  }, []);

  const runBatchArchive = useCallback(async () => {
    if (!onSetArchived || multiSelected.size === 0) return;
    const ids = [...multiSelected];
    for (const id of ids) {
      await onSetArchived(id, true);
    }
    setBatchFeedback(ids.length === 1 ? "1 archived" : `${ids.length} archived`);
    setMultiSelected(new Set());
  }, [multiSelected, onSetArchived]);

  const runBatchSettle = useCallback(async () => {
    if (!onSetSettled || multiSelected.size === 0) return;
    const byId = new Map(threads.map((t) => [t.id, t]));
    const { toSettle, skippedWorking } = planBatchSettle(
      [...multiSelected],
      byId,
    );
    for (const id of toSettle) {
      await onSetSettled(id, "settled");
    }
    setBatchFeedback(formatBatchSettleFeedback(toSettle.length, skippedWorking));
    setMultiSelected(new Set());
  }, [multiSelected, onSetSettled, threads]);

  const createInTargetProject = useCallback(() => {
    if (!createTargetProject) return;
    onCreateThread(createTargetProject.id);
  }, [createTargetProject, onCreateThread]);

  const handleBrandCreate = useCallback(() => {
    createInTargetProject();
  }, [createInTargetProject]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") {
        setCmdHeld(true);
        return;
      }
      if (isShortcutBlocked(e.target)) return;
      if (keyboardSheetOpen && e.key !== "Escape") return;

      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "?" && !mod) {
        e.preventDefault();
        setKeyboardSheetOpen(true);
        return;
      }

      if (!mod) return;

      if (e.key >= "1" && e.key <= "9") {
        const n = Number(e.key);
        const id = visibleIds[n - 1];
        if (id) {
          e.preventDefault();
          setMultiSelected(new Set());
          setSelectAnchor(id);
          onSelectThread(id);
        }
        return;
      }

      const key = e.key.toLowerCase();
      if (key === "j") {
        e.preventDefault();
        const delta = e.shiftKey ? -1 : 1;
        const next = stepVisibleId(visibleIds, activeThreadId, delta as 1 | -1);
        if (next) {
          setMultiSelected(new Set());
          setSelectAnchor(next);
          onSelectThread(next);
        }
        return;
      }

      if (key === "n") {
        e.preventDefault();
        if (e.shiftKey) createInTargetProject();
        else handleBrandCreate();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") {
        setCmdHeld(false);
      }
    };
    const onBlur = () => setCmdHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    visibleIds,
    activeThreadId,
    onSelectThread,
    keyboardSheetOpen,
    createInTargetProject,
    handleBrandCreate,
  ]);

  const indexHintFor = (id: string): number | null => {
    if (!cmdHeld) return null;
    const i = visibleIndex.get(id);
    if (i == null || i >= 9) return null;
    return i + 1;
  };

  const openIssueForm = (projectId: string) => {
    setIssueFormFor(projectId);
    setIssueRef("");
    setIssueError(null);
    setCreateMenuOpen(false);
  };

  const submitIssueForm = (project: ProjectInfo) => {
    if (!onCreateThreadFromIssue || issuePending) return;
    const ref = issueRef.trim();
    if (!ref) return;
    setIssuePending(true);
    setIssueError(null);
    void onCreateThreadFromIssue({
      projectId: project.id,
      projectPath: project.path,
      ref,
    })
      .then((result) => {
        if (result.ok) {
          setIssueFormFor(null);
          setIssueRef("");
          setIssueError(null);
          return;
        }
        setIssueError(result.reason);
      })
      .catch((err: unknown) => {
        setIssueError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setIssuePending(false);
      });
  };

  const persistViews = (next: SavedView[]) => {
    setSavedViews(next);
    saveStored(SAVED_VIEWS_KEY, next.length ? serializeSavedViews(next) : null);
  };

  const persistActiveViewId = (id: string | null) => {
    setActiveViewId(id);
    saveStored(ACTIVE_SAVED_VIEW_KEY, id);
  };

  const applyCriteria = (c: SavedViewCriteria) => {
    setStatusFilter(c.status);
    saveStored(STATUS_FILTER_KEY, c.status);
    setProviderFilter([...c.providers]);
    saveStored(PROVIDER_FILTER_KEY, serializeProviderFilter(c.providers));
    setTagFilter(c.tag);
    saveStored(TAG_FILTER_KEY, c.tag);
    setProjectScope(c.projectId);
    saveStored(SCOPE_KEY, c.projectId);
    setGroupBy(c.groupBy);
    saveStored(GROUP_BY_KEY, c.groupBy === "none" ? null : c.groupBy);
    setQuery(c.query);
    if (c.status === "archived") {
      setSettledOpen(true);
      saveFlag(SETTLED_OPEN_KEY, true);
    }
  };

  const currentCriteria = useMemo<SavedViewCriteria>(
    () => ({
      status: statusFilter,
      providers: providerFilter,
      projectId: projectScope,
      tag: tagFilter,
      query: query.trim(),
      groupBy,
    }),
    [statusFilter, providerFilter, projectScope, tagFilter, query, groupBy],
  );

  const activeSavedView =
    savedViews.find((v) => v.id === activeViewId) ?? null;
  const viewModified =
    activeSavedView != null &&
    !criteriaEqual(activeSavedView.criteria, currentCriteria);

  const setScope = (id: string | null) => {
    setProjectScope(id);
    saveStored(SCOPE_KEY, id);
    setScopeMenuOpen(false);
    setFilterMenu(null);
  };

  const applyStatusFilter = (id: StatusFilter | null) => {
    setStatusFilter(id);
    saveStored(STATUS_FILTER_KEY, id);
    setFilterMenu(null);
    if (id === "archived") {
      setSettledOpen(true);
      saveFlag(SETTLED_OPEN_KEY, true);
    }
  };

  const applyGroupBy = (id: GroupBy) => {
    setGroupBy(id);
    saveStored(GROUP_BY_KEY, id === "none" ? null : id);
    setFilterMenu(null);
  };

  const applyTagFilter = (tag: string | null) => {
    setTagFilter(tag);
    saveStored(TAG_FILTER_KEY, tag);
    setFilterMenu(null);
  };

  const toggleProviderFilter = (id: string) => {
    setProviderFilter((prev) => {
      const next = prev.includes(id)
        ? prev.filter((p) => p !== id)
        : [...prev, id];
      saveStored(PROVIDER_FILTER_KEY, serializeProviderFilter(next));
      return next;
    });
  };

  const toggleFilterMenu = (menu: FilterMenu) => {
    setCreateMenuOpen(false);
    setScopeMenuOpen(false);
    setViewEditor(null);
    setMoreOpen(false);
    setFilterMenu((open) => (open === menu ? null : menu));
  };

  const toggleMore = () => {
    setCreateMenuOpen(false);
    setScopeMenuOpen(false);
    setViewEditor(null);
    setBasePicker(null);
    setFilterMenu(null);
    setMoreOpen((open) => !open);
  };

  const closeMore = (returnFocus: boolean) => {
    setMoreOpen(false);
    if (returnFocus) moreTriggerRef.current?.focus();
  };

  const onMoreBlur = (e: React.FocusEvent<HTMLElement>) => {
    if (!moreOpen) return;
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    setMoreOpen(false);
  };

  const onMoreKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!moreOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMore(true);
      return;
    }
    // Tab leaves the menu. Focus returns to More first so the browser's
    // default tab move continues from that button. Hidden Electron does not
    // fire the blur that would otherwise close it.
    if (e.key === "Tab") {
      closeMore(true);
      return;
    }
    const menu = moreHostRef.current?.querySelector<HTMLElement>(
      "[data-app-more-menu]",
    );
    if (!menu) return;
    if (moveAppMenuFocus(menu, e.key)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const recallSavedView = (view: SavedView) => {
    persistActiveViewId(view.id);
    applyCriteria(view.criteria);
    setViewEditor(null);
    setFilterMenu(null);
  };

  const submitViewEditor = () => {
    if (!viewEditor) return;
    if (viewEditor.mode === "save") {
      const next = addSavedView(savedViews, {
        name: viewEditor.name,
        criteria: currentCriteria,
      });
      if (next.length === savedViews.length) return;
      persistViews(next);
      persistActiveViewId(next[0]!.id);
      setViewEditor(null);
      return;
    }
    if (!activeSavedView) return;
    const next = renameSavedView(savedViews, activeSavedView.id, viewEditor.name);
    persistViews(next);
    setViewEditor(null);
  };

  const updateActiveView = () => {
    if (!activeSavedView || !viewModified) return;
    persistViews(
      updateSavedView(savedViews, activeSavedView.id, currentCriteria),
    );
    setFilterMenu(null);
    setViewEditor(null);
  };

  const deleteActiveView = () => {
    if (!activeSavedView) return;
    persistViews(deleteSavedView(savedViews, activeSavedView.id));
    persistActiveViewId(null);
    setFilterMenu(null);
    setViewEditor(null);
  };

  const toggleWorking = () => {
    setWorkingOpen((open) => {
      saveFlag(WORKING_OPEN_KEY, !open);
      return !open;
    });
  };

  const toggleSnoozed = () => {
    setSnoozedOpen((open) => {
      saveFlag(SNOOZED_OPEN_KEY, !open);
      return !open;
    });
  };

  const toggleSettled = () => {
    setSettledOpen((open) => {
      saveFlag(SETTLED_OPEN_KEY, !open);
      if (open) setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
      return !open;
    });
  };

  const createProjectId = createTargetProject?.id;
  const remoteTarget = Boolean(createTargetProject?.remoteHost);
  const issueProject =
    issueFormFor != null ? projectById.get(issueFormFor) ?? null : null;

  const renderCard = (
    thread: ThreadInfo,
    families: ReadonlyMap<string, string[]>,
  ) => {
    let compact = false;
    for (const kids of families.values()) {
      if (kids.includes(thread.id)) {
        compact = true;
        break;
      }
    }
    const kids = families.get(thread.id) ?? [];
    const familyWorkers = kids
      .map((id) => liveById.get(id))
      .filter((t): t is ThreadInfo => t != null);
    const summary =
      familyWorkers.length > 0
        ? summarizeCrew(familyWorkers)
        : null;
    const wait = waitStates.get(thread.id) ?? null;
    return (
    <Fragment key={`${thread.id}:card`}>
      <ThreadCard
        thread={thread}
        slug={slugFor(thread)}
        iconUrl={iconUrlFor(thread)}
        providers={providers}
        active={thread.id === activeThreadId}
        multiSelected={multiSelected.has(thread.id)}
        indexHint={indexHintFor(thread.id)}
        now={now}
        onSelect={handleSelect}
        isSettled={effectiveSettled(thread, settleOpts)}
        onSetSettled={onSetSettled}
        onSetPinned={onSetPinned}
        onSetSnoozed={onSetSnoozed}
        onSetTags={onSetTags}
        onSetThreadProject={onSetThreadProject}
        onSetMuted={onSetMuted}
        onSetEjected={onSetEjected}
        onRenameThread={onRenameThread}
        onFork={onFork}
        listMoveProjects={listMoveProjects}
        nested={compact}
        compact={compact}
        familySummary={summary ? crewSummaryLabel(summary) : null}
        familyExpanded={workerOpen.has(thread.id)}
        familyAttention={Boolean(summary && summary.blocked > 0)}
        onToggleFamily={summary ? toggleFamily : undefined}
        wait={wait}
        contentMatch={
          searching && !thread.title.toLowerCase().includes(queryLower)
        }
        conflictForecast={conflictForecast}
        threadTitles={threadTitles}
      />
    </Fragment>
    );
  };

  // The open thread never vanishes — and neither does a freshly revealed
  // one (new-thread reveal can land on a collapsed shelf).
  const keepIds = [activeThreadId, revealThreadId ?? null];
  const workingCarve = workingExpanded
    ? null
    : flat.working.find((t) => keepIds.includes(t.id)) ?? null;
  const visibleSnoozed = snoozedExpanded ? flat.snoozed : [];
  const snoozedCarve = snoozedExpanded
    ? null
    : flat.snoozed.find((t) => keepIds.includes(t.id)) ?? null;

  const visibleSettled = settledExpanded
    ? settledTail.slice(0, settledVisibleCount)
    : [];
  const settledCarve =
    settledTail.find(
      (t) =>
        keepIds.includes(t.id) &&
        !visibleSettled.some((v) => v.id === t.id),
    ) ?? null;
  const settledHidden = Math.max(0, settledTail.length - settledVisibleCount);

  const renderSnoozed = (thread: ThreadInfo, activeOverride = false) => (
    <SnoozedRow
      key={`${thread.id}:slim`}
      thread={thread}
      slug={slugFor(thread)}
      iconUrl={iconUrlFor(thread)}
      active={activeOverride || thread.id === activeThreadId}
      multiSelected={multiSelected.has(thread.id)}
      indexHint={indexHintFor(thread.id)}
      now={now}
      onSelect={handleSelect}
      onSetSnoozed={onSetSnoozed}
    />
  );

  const renderSettled = (thread: ThreadInfo, activeOverride = false) => (
    <SettledRow
      key={`${thread.id}:slim`}
      thread={thread}
      slug={slugFor(thread)}
      iconUrl={iconUrlFor(thread)}
      active={activeOverride || thread.id === activeThreadId}
      multiSelected={multiSelected.has(thread.id)}
      indexHint={indexHintFor(thread.id)}
      now={now}
      onSelect={handleSelect}
      onSetSettled={thread.archived ? undefined : onSetSettled}
      archived={thread.archived === true}
      onSetArchived={onSetArchived}
    />
  );

  const scopedProject =
    projectScope != null ? projectById.get(projectScope) ?? null : null;
  const scopedSlug = scopedProject
    ? scopedProject.slug || scopedProject.name
    : "All projects";

  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; name: string }[] = [];
    const rank = ["claude", "codex", "grok", "kimi", "opencode", "cursor", "muse"];
    for (const p of providers) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, name: p.name });
    }
    for (const t of threads) {
      const id = t.provider;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: id });
    }
    out.sort((a, b) => {
      const ia = rank.indexOf(a.id);
      const ib = rank.indexOf(b.id);
      return (
        (ia === -1 ? rank.length : ia) - (ib === -1 ? rank.length : ib) ||
        a.id.localeCompare(b.id)
      );
    });
    return out;
  }, [providers, threads]);
  const providerNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of providerOptions) m.set(p.id, p.name);
    return m;
  }, [providerOptions]);

  const listEmpty =
    !searching &&
    flat.pinned.length +
      flat.active.length +
      flat.working.length +
      flat.snoozed.length +
      settledTail.length ===
      0;

  const viewUnavailable =
    activeViewId != null
      ? savedViewUnavailable(currentCriteria, {
          projectIds: new Set(projectById.keys()),
          tags: knownTags,
          providerIds: new Set(providerOptions.map((p) => p.id)),
        })
      : null;

  const keptOutsideFilter = (() => {
    if (!activeThreadId) return false;
    if (
      statusFilter == null &&
      providerFilter.length === 0 &&
      tagFilter == null &&
      projectScope == null
    ) {
      return false;
    }
    const open = liveById.get(activeThreadId);
    if (!open) return false;
    if (!displayThreads.some((t) => t.id === open.id)) return false;
    return !threadMatchesFilter(
      open,
      {
        status: statusFilter,
        providers: providerFilter,
        projectId: projectScope,
        tag: tagFilter,
      },
      waitStates.get(open.id),
    );
  })();

  const moreRunners: Partial<
    Record<(typeof MORE_DESTINATIONS)[number]["id"], () => void>
  > = {};
  if (onOpenActivity) moreRunners.activity = () => onOpenActivity(projectScope);
  if (onOpenKanban) moreRunners.kanban = () => onOpenKanban(projectScope);
  if (onOpenAutomations) moreRunners.automations = onOpenAutomations;
  if (onOpenUsage) moreRunners.usage = onOpenUsage;
  if (onOpenFleet) moreRunners.fleet = onOpenFleet;
  if (onOpenInsights) moreRunners.insights = onOpenInsights;
  if (onOpenDigest) moreRunners.digest = onOpenDigest;
  const moreDestinations = MORE_DESTINATIONS.flatMap((dest) => {
    const run = moreRunners[dest.id];
    return run ? [{ ...dest, run }] : [];
  });
  const moreCurrentLabel =
    moreDestinations.find((dest) => dest.view === activeView)?.label ?? null;

  return (
    <aside className={styles.sidebar}>
      {!isWebMode() && <div className={styles.dragRegion} />}
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden>
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 1.75 14.25 8 8 14.25 1.75 8Z" />
              <path d="M8 5.25 10.75 8 8 10.75 5.25 8Z" />
            </svg>
          </span>
          <span className={styles.brandName}>{appName}</span>
          {appVersion ? (
            <span className={styles.brandVersion} data-app-version="">
              {appVersion}
            </span>
          ) : null}
          {channel === "nightly" && (
            <span className={styles.brandChannel}>nightly</span>
          )}
        </div>
        {onCollapseSidebar ? (
          <button
            type="button"
            className={styles.iconBtn}
            data-sidebar-collapse=""
            aria-label="Hide sidebar"
            title="Hide sidebar (⌘B)"
            onClick={onCollapseSidebar}
          >
            <Icon size={15}>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </Icon>
          </button>
        ) : null}
      </header>

      <div className={styles.searchRow}>
        <span className={styles.searchField}>
          <span className={styles.searchIcon} aria-hidden>
            <Icon size={14}>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </Icon>
          </span>
          <input
            className={styles.searchInput}
            type="search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search threads"
          />
          {query === "" ? (
            <kbd
              className={styles.searchKbd}
              title="Search threads, projects and actions anywhere (⌘K)"
            >
              ⌘K
            </kbd>
          ) : null}
        </span>
        <button
          type="button"
          className={styles.iconBtn}
          data-filter-bar-toggle=""
          data-active={filterBarShown ? "true" : undefined}
          aria-expanded={filterBarShown}
          aria-label="Filters, grouping and saved views"
          title={
            filtersEngaged
              ? "Filters are on"
              : "Filters, grouping and saved views"
          }
          disabled={filtersEngaged}
          onClick={toggleFilterBar}
        >
          <Icon size={14}>
            <path d="M4 5h16l-6 8v5l-4 2v-7Z" />
          </Icon>
        </button>
        <span className={styles.scopeMenuHost}>
          <button
            type="button"
            className={styles.iconBtn}
            data-scope-trigger=""
            data-active={projectScope != null ? "true" : undefined}
            title={`Project: ${scopedSlug}`}
            aria-haspopup="menu"
            aria-expanded={scopeMenuOpen}
            aria-label="Filter threads by project"
            onClick={() => {
              setCreateMenuOpen(false);
              setFilterMenu(null);
              setViewEditor(null);
              setMoreOpen(false);
              setScopeMenuOpen((open) => !open);
            }}
          >
            {scopedProject ? (
              <ProjectIcon
                url={scopedProject.iconUrl}
                name={scopedProject.slug || scopedProject.name}
                seed={scopedProject.id}
                size={16}
              />
            ) : (
              <Icon size={15}>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </Icon>
            )}
            <span className={styles.srOnly}>{scopedSlug}</span>
          </button>
          {scopeMenuOpen && (
            <div className={styles.menu} role="menu" data-scope-menu="">
              <button
                type="button"
                className={styles.scopeItem}
                role="menuitem"
                data-scope-item="all"
                onClick={() => setScope(null)}
              >
                All projects
              </button>
              {projects.map((p) => (
                <div key={p.id} className={styles.scopeItemRow}>
                  <button
                    type="button"
                    className={styles.scopeItem}
                    role="menuitem"
                    data-scope-item={p.id}
                    onClick={() => setScope(p.id)}
                  >
                    <ProjectIcon
                      url={p.iconUrl}
                      name={p.slug || p.name}
                      seed={p.id}
                      size={16}
                    />
                    {p.slug || p.name}
                    {p.scm?.kind === "jj" ? (
                      <span
                        className={styles.scmChip}
                        data-scm-badge={p.scm.support}
                        title={p.scm.detail || "Jujutsu"}
                      >
                        jj
                      </span>
                    ) : null}
                  </button>
                  {onEditProject && (
                    <button
                      type="button"
                      className={styles.iconBtn}
                      data-scope-edit={p.id}
                      aria-label={`Edit project ${p.slug || p.name}`}
                      title="Edit project"
                      onClick={(e) => {
                        e.stopPropagation();
                        setScopeMenuOpen(false);
                        onEditProject(p.id);
                      }}
                    >
                      <Icon size={12}>
                        <path d="M12.3 6.7a1.4 1.4 0 0 1 2 2L8 15H6v-2l6.3-6.3Z" />
                      </Icon>
                    </button>
                  )}
                  {onRemoveProject && (
                    <button
                      type="button"
                      className={styles.iconBtn}
                      data-project-remove={p.id}
                      aria-label={`Remove project ${p.slug || p.name}`}
                      title="Remove project"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRemoveConfirmId(p.id);
                      }}
                    >
                      <Icon size={12}>
                        <path d="M18 6 6 18M6 6l12 12" />
                      </Icon>
                    </button>
                  )}
                </div>
              ))}
              <div className={styles.menuSep} />
              <button
                type="button"
                className={styles.scopeItem}
                role="menuitem"
                data-new-project=""
                onClick={() => {
                  setScopeMenuOpen(false);
                  onAddProject();
                }}
              >
                <Icon size={14}>
                  <path d="M12 10v8" />
                  <path d="M8 14h8" />
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </Icon>
                New project…
              </button>
            </div>
          )}
        </span>
        <span className={styles.searchCreate}>
          <button
            type="button"
            className={styles.iconBtn}
            data-new-thread=""
            onClick={handleBrandCreate}
            disabled={!canCreate}
            title={
              canCreate
                ? createTargetLabel
                : "Add a project before creating a thread"
            }
            aria-label={createTargetLabel}
          >
            <Icon size={15}>
              <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
            </Icon>
          </button>
          {canCreate && createTargetProject && (
            <span className={styles.menuWrap}>
              <button
                type="button"
                className={styles.caretBtn}
                data-new-thread-caret=""
                title="Thread options"
                aria-label="Thread options"
                aria-haspopup="menu"
                aria-expanded={createMenuOpen}
                onClick={() => {
                  setScopeMenuOpen(false);
                  setFilterMenu(null);
                  setViewEditor(null);
                  setBasePicker(null);
                  setMoreOpen(false);
                  setCreateMenuOpen((open) => !open);
                }}
              >
                <Icon size={10}>
                  <path d="m6 9 6 6 6-6" />
                </Icon>
              </button>
              {createMenuOpen && (
                <div
                  className={styles.menu}
                  role="menu"
                  data-new-thread-menu=""
                >
                  {!remoteTarget && (
                    <>
                      <button
                        type="button"
                        className={styles.menuItem}
                        role="menuitem"
                        data-create-worktree-thread={createProjectId}
                        title="New thread in an isolated git worktree + branch"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          setBasePicker(null);
                          onCreateThread(createProjectId, { worktree: true });
                        }}
                      >
                        New worktree thread
                      </button>
                      {listBaseBranches && createProjectId && (
                        <>
                          <button
                            type="button"
                            className={styles.menuItem}
                            role="menuitem"
                            data-create-base-branch=""
                            title="New worktree thread stacked on a branch other than the repo default"
                            onClick={() => {
                              const pid = createProjectId;
                              void listBaseBranches(pid).then((listed) => {
                                setBasePicker(listed);
                              });
                            }}
                          >
                            On another base…
                          </button>
                          {basePicker &&
                            basePicker.branches
                              .filter((name) => name !== basePicker.defaultBranch)
                              .map((name) => (
                                <button
                                  key={name}
                                  type="button"
                                  className={`${styles.menuItem} ${styles.menuItemNested}`}
                                  role="menuitem"
                                  data-base-branch={name}
                                  title={`Stack this thread on ${name}`}
                                  onClick={() => {
                                    setCreateMenuOpen(false);
                                    setBasePicker(null);
                                    onCreateThread(createProjectId, {
                                      worktree: true,
                                      baseBranch: name,
                                    });
                                  }}
                                >
                                  {name}
                                </button>
                              ))}
                        </>
                      )}
                      <button
                        type="button"
                        className={styles.menuItem}
                        role="menuitem"
                        data-create-orchestrator-thread={createProjectId}
                        title="New thread that hands its first prompt to a worker in its own worktree"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          onCreateThread(createProjectId, { orchestrate: true });
                        }}
                      >
                        New orchestrator thread
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-create-plain-thread={createProjectId}
                    title="New thread directly in the project checkout (no worktree)"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      onCreateThread(createProjectId, { worktree: false });
                    }}
                  >
                    New plain thread
                  </button>
                  {!remoteTarget && (
                    <button
                      type="button"
                      className={styles.menuItem}
                      role="menuitem"
                      data-create-teach-thread={createProjectId}
                      title="New thread that teaches: hints, TODO(human) markers, reviews your code"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        onCreateThread(createProjectId, {
                          worktree: true,
                          teach: true,
                        });
                      }}
                    >
                      New teach thread
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-create-ask-thread={createProjectId}
                    title="New read-only Ask thread: repo Q&A from the index and memory, no worktree"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      onCreateThread(createProjectId, { ask: true });
                    }}
                  >
                    New ask thread
                  </button>
                  {onCreateThreadFromIssue && createProjectId && (
                    <button
                      type="button"
                      className={styles.menuItem}
                      role="menuitem"
                      data-create-from-issue={createProjectId}
                      title="New thread from a GitHub or Linear issue"
                      onClick={() => openIssueForm(createProjectId)}
                    >
                      From issue
                    </button>
                  )}
                  {listCliSessions && importCliSession && createProjectId && (
                    <>
                      <button
                        type="button"
                        className={styles.menuItem}
                        role="menuitem"
                        data-import-cli-session={createProjectId}
                        title="Import a Codex CLI session from disk"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          setImportCliProvider("codex");
                        }}
                      >
                        Import Codex session…
                      </button>
                      <button
                        type="button"
                        className={styles.menuItem}
                        role="menuitem"
                        data-import-grok-session={createProjectId}
                        title="Import a Grok CLI session from disk"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          setImportCliProvider("grok");
                        }}
                      >
                        Import Grok session…
                      </button>
                      <button
                        type="button"
                        className={styles.menuItem}
                        role="menuitem"
                        data-import-claude-session={createProjectId}
                        title="Import a Claude Code session from disk"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          setImportCliProvider("claude");
                        }}
                      >
                        Import Claude session…
                      </button>
                      <button
                        type="button"
                        className={styles.menuItem}
                        role="menuitem"
                        data-import-cursor-session={createProjectId}
                        title="Import a Cursor CLI session from disk"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          setImportCliProvider("cursor");
                        }}
                      >
                        Import Cursor session…
                      </button>
                      <button
                        type="button"
                        className={styles.menuItem}
                        role="menuitem"
                        data-import-opencode-session={createProjectId}
                        title="Import an OpenCode CLI session from disk"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          setImportCliProvider("opencode");
                        }}
                      >
                        Import OpenCode session…
                      </button>
                      <button
                        type="button"
                        className={styles.menuItem}
                        role="menuitem"
                        data-import-kimi-session={createProjectId}
                        title="Import a Kimi CLI session from disk"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          setImportCliProvider("kimi");
                        }}
                      >
                        Import Kimi session…
                      </button>
                      <button
                        type="button"
                        className={styles.menuItem}
                        role="menuitem"
                        data-import-muse-session={createProjectId}
                        title="Import a Muse CLI session from disk"
                        onClick={() => {
                          setCreateMenuOpen(false);
                          setImportCliProvider("muse");
                        }}
                      >
                        Import Muse session…
                      </button>
                    </>
                  )}
                </div>
              )}
            </span>
          )}
        </span>
      </div>

      {filterBarShown && (
      <div className={styles.filterBar} data-filter-bar="">
      <div className={styles.viewRow}>
        <span className={styles.filterMenuHost}>
          <button
            type="button"
            className={styles.viewTrigger}
            data-saved-views-trigger=""
            data-active={activeSavedView ? "true" : undefined}
            data-modified={viewModified ? "true" : undefined}
            aria-haspopup="menu"
            aria-expanded={filterMenu === "views"}
            aria-label={
              activeSavedView
                ? viewModified
                  ? `Saved views, ${activeSavedView.name}, modified`
                  : `Saved views, ${activeSavedView.name}`
                : "Saved views"
            }
            onClick={() => toggleFilterMenu("views")}
          >
            <span className={styles.filterTriggerLabel}>
              {savedViewTriggerLabel(
                activeSavedView ? { name: activeSavedView.name } : null,
                viewModified,
              )}
            </span>
            <Icon size={12}>
              <path d="m6 9 6 6 6-6" />
            </Icon>
          </button>
          {filterMenu === "views" && (
            <div
              className={`${styles.menu} ${styles.menuLeft} ${styles.viewMenu}`}
              role="menu"
              data-saved-views-menu=""
            >
              {savedViews.length === 0 && !viewEditor && (
                <p className={styles.viewEmpty}>No saved views</p>
              )}
              {savedViews.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  data-saved-view={view.id}
                  data-saved-view-label={view.name}
                  data-selected={
                    view.id === activeViewId ? "true" : undefined
                  }
                  onClick={() => recallSavedView(view)}
                >
                  {view.name}
                  {view.id === activeViewId && !viewModified && (
                    <span className={styles.filterCheck}>
                      <Icon size={12}>
                        <path d="M5 12.5 9 16.5 19 7.5" />
                      </Icon>
                    </span>
                  )}
                </button>
              ))}
              {viewEditor ? (
                <form
                  className={styles.viewNameForm}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitViewEditor();
                  }}
                >
                  <input
                    className={styles.viewNameInput}
                    data-saved-view-name=""
                    value={viewEditor.name}
                    onChange={(e) =>
                      setViewEditor({ ...viewEditor, name: e.target.value })
                    }
                    placeholder="View name"
                    aria-label="View name"
                    autoFocus
                  />
                  <button
                    type="submit"
                    className={styles.viewNameSave}
                    data-saved-view-save-confirm=""
                    disabled={viewEditor.name.trim() === ""}
                  >
                    Save
                  </button>
                </form>
              ) : (
                <>
                  {savedViews.length > 0 && (
                    <div className={styles.menuSep} />
                  )}
                  <button
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-saved-view-save=""
                    onClick={() =>
                      setViewEditor({ mode: "save", name: "" })
                    }
                  >
                    Save current as…
                  </button>
                  {activeSavedView && viewModified && (
                    <button
                      type="button"
                      className={styles.menuItem}
                      role="menuitem"
                      data-saved-view-update=""
                      onClick={updateActiveView}
                    >
                      Update view
                    </button>
                  )}
                  {activeSavedView && (
                    <button
                      type="button"
                      className={styles.menuItem}
                      role="menuitem"
                      data-saved-view-rename=""
                      onClick={() =>
                        setViewEditor({
                          mode: "rename",
                          name: activeSavedView.name,
                        })
                      }
                    >
                      Rename…
                    </button>
                  )}
                  {activeSavedView && (
                    <button
                      type="button"
                      className={styles.menuItem}
                      role="menuitem"
                      data-saved-view-delete=""
                      onClick={deleteActiveView}
                    >
                      Delete view
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </span>
      </div>

      <div className={styles.filterRow} data-filter-row="">
        <span className={styles.filterMenuHost}>
          <button
            type="button"
            className={styles.filterTrigger}
            data-status-filter-trigger=""
            data-active={statusFilter != null ? "true" : undefined}
            aria-haspopup="menu"
            aria-expanded={filterMenu === "status"}
            aria-label="Filter threads by status"
            onClick={() => toggleFilterMenu("status")}
          >
            <span className={styles.filterTriggerLabel}>
              {statusFilterLabel(statusFilter)}
            </span>
            <Icon size={12}>
              <path d="m6 9 6 6 6-6" />
            </Icon>
          </button>
          {filterMenu === "status" && (
            <div
              className={`${styles.menu} ${styles.menuLeft} ${styles.filterMenu}`}
              role="menu"
              data-status-filter-menu=""
            >
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                data-status-filter="all"
                data-selected={statusFilter == null ? "true" : undefined}
                onClick={() => applyStatusFilter(null)}
              >
                All statuses
                {statusFilter == null && (
                  <span className={styles.filterCheck}>
                    <Icon size={12}>
                      <path d="M5 12.5 9 16.5 19 7.5" />
                    </Icon>
                  </span>
                )}
              </button>
              {STATUS_FILTERS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  data-status-filter={opt.id}
                  data-selected={statusFilter === opt.id ? "true" : undefined}
                  onClick={() => applyStatusFilter(opt.id)}
                >
                  {opt.label}
                  {statusFilter === opt.id && (
                    <span className={styles.filterCheck}>
                      <Icon size={12}>
                        <path d="M5 12.5 9 16.5 19 7.5" />
                      </Icon>
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </span>
        <span className={styles.filterMenuHost}>
          <button
            type="button"
            className={styles.filterTrigger}
            data-provider-filter-trigger=""
            data-active={providerFilter.length > 0 ? "true" : undefined}
            aria-haspopup="menu"
            aria-expanded={filterMenu === "provider"}
            aria-label="Filter threads by provider"
            onClick={() => toggleFilterMenu("provider")}
          >
            <span className={styles.filterTriggerLabel}>
              {providerFilterLabel(providerFilter, providerNames)}
            </span>
            <Icon size={12}>
              <path d="m6 9 6 6 6-6" />
            </Icon>
          </button>
          {filterMenu === "provider" && (
            <div
              className={`${styles.menu} ${styles.menuLeft} ${styles.filterMenu}`}
              role="menu"
              data-provider-filter-menu=""
            >
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                data-provider-filter="all"
                data-selected={providerFilter.length === 0 ? "true" : undefined}
                onClick={() => {
                  setProviderFilter([]);
                  saveStored(PROVIDER_FILTER_KEY, null);
                }}
              >
                All providers
                {providerFilter.length === 0 && (
                  <span className={styles.filterCheck}>
                    <Icon size={12}>
                      <path d="M5 12.5 9 16.5 19 7.5" />
                    </Icon>
                  </span>
                )}
              </button>
              <div className={styles.filterChipRow} data-provider-chips="">
                {providerOptions.map((p) => {
                  const on = providerFilter.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={styles.filterChip}
                      data-provider-filter={p.id}
                      data-on={on ? "true" : undefined}
                      aria-pressed={on}
                      onClick={() => toggleProviderFilter(p.id)}
                    >
                      <ProviderMark
                        providerId={p.id}
                        providers={providers}
                        size={12}
                        decorative
                      />
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </span>
        {(knownTags.length > 0 || tagFilter != null) && (
          <span className={styles.filterMenuHost}>
            <button
              type="button"
              className={styles.filterTrigger}
              data-tag-filter-trigger=""
              data-active={tagFilter != null ? "true" : undefined}
              aria-haspopup="menu"
              aria-expanded={filterMenu === "tag"}
              aria-label="Filter threads by tag"
              onClick={() => toggleFilterMenu("tag")}
            >
              <span className={styles.filterTriggerLabel}>
                {tagFilterLabel(tagFilter)}
              </span>
              <Icon size={12}>
                <path d="m6 9 6 6 6-6" />
              </Icon>
            </button>
            {filterMenu === "tag" && (
              <div
                className={`${styles.menu} ${styles.menuLeft} ${styles.filterMenu}`}
                role="menu"
                data-tag-filter-menu=""
              >
                <button
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  data-tag-filter="all"
                  data-selected={tagFilter == null ? "true" : undefined}
                  onClick={() => applyTagFilter(null)}
                >
                  All tags
                  {tagFilter == null && (
                    <span className={styles.filterCheck}>
                      <Icon size={12}>
                        <path d="M5 12.5 9 16.5 19 7.5" />
                      </Icon>
                    </span>
                  )}
                </button>
                {knownTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-tag-filter={tag}
                    data-selected={tagFilter === tag ? "true" : undefined}
                    onClick={() => applyTagFilter(tag)}
                  >
                    {tag}
                    {tagFilter === tag && (
                      <span className={styles.filterCheck}>
                        <Icon size={12}>
                          <path d="M5 12.5 9 16.5 19 7.5" />
                        </Icon>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        <span className={styles.filterMenuHost}>
          <button
            type="button"
            className={styles.filterTrigger}
            data-group-by-trigger=""
            data-active={groupBy !== "none" ? "true" : undefined}
            aria-haspopup="menu"
            aria-expanded={filterMenu === "group"}
            aria-label="Group threads"
            onClick={() => toggleFilterMenu("group")}
          >
            <span className={styles.filterTriggerLabel}>
              {groupByLabel(groupBy)}
            </span>
            <Icon size={12}>
              <path d="m6 9 6 6 6-6" />
            </Icon>
          </button>
          {filterMenu === "group" && (
            <div
              className={`${styles.menu} ${styles.menuLeft} ${styles.filterMenu}`}
              role="menu"
              data-group-by-menu=""
            >
              {GROUP_BY_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  data-group-by={opt.id}
                  data-selected={groupBy === opt.id ? "true" : undefined}
                  onClick={() => applyGroupBy(opt.id)}
                >
                  {opt.label}
                  {groupBy === opt.id && (
                    <span className={styles.filterCheck}>
                      <Icon size={12}>
                        <path d="M5 12.5 9 16.5 19 7.5" />
                      </Icon>
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </span>
      </div>
      </div>
      )}


      {importCliProvider &&
        listCliSessions &&
        importCliSession &&
        createProjectId && (
          <ImportCliSessionModal
            projectId={createProjectId}
            provider={importCliProvider}
            threads={threads}
            listCliSessions={listCliSessions}
            importCliSession={importCliSession}
            onClose={() => setImportCliProvider(null)}
            onImported={(imported) => {
              setImportCliProvider(null);
              onSelectThread(imported.id);
            }}
          />
        )}

      {issueProject && onCreateThreadFromIssue && (
        <form
          className={styles.issueForm}
          data-issue-form={issueProject.id}
          onSubmit={(e) => {
            e.preventDefault();
            submitIssueForm(issueProject);
          }}
        >
          <input
            className={styles.issueInput}
            type="text"
            value={issueRef}
            onChange={(e) => setIssueRef(e.target.value)}
            placeholder="GitHub URL, Linear URL, or ENG-123"
            aria-label="GitHub or Linear issue URL or reference"
            data-issue-input={issueProject.id}
            disabled={issuePending}
            autoComplete="off"
            spellCheck={false}
          />
          {issueError && (
            <p
              className={styles.issueError}
              role="alert"
              data-issue-error={issueProject.id}
            >
              {issueError}
            </p>
          )}
          <div className={styles.issueActions}>
            <button
              type="submit"
              className={styles.issueCreate}
              data-issue-create={issueProject.id}
              disabled={issuePending || issueRef.trim() === ""}
              aria-busy={issuePending || undefined}
            >
              {issuePending ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              className={styles.issueCancel}
              data-issue-cancel={issueProject.id}
              disabled={issuePending}
              onClick={closeIssueForm}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div
        className={styles.list}
        data-sidebar-list=""
        ref={bindListAnimation}
      >
        {projects.length === 0 && (
          <button
            type="button"
            className={styles.addProjectRow}
            onClick={onAddProject}
          >
            Add project
          </button>
        )}

        {viewUnavailable && (
          <p className={styles.emptySearch} data-view-unavailable="">
            {viewUnavailable.message}
          </p>
        )}

        {keptOutsideFilter && (
          <p className={styles.filterCarveOut} data-filter-carve-out="">
            The open thread stays visible even when it doesn't match these
            filters
          </p>
        )}

        {searchInFlight && (
          <p className={styles.searchHint} aria-live="polite">
            Searching…
          </p>
        )}

        {projects.length > 0 && searchEmpty && (
          <p className={styles.emptySearch}>No threads match</p>
        )}

        {searching
          ? visibleFamilyRows(displayThreads, familyOpts).map((thread) =>
              renderCard(thread, searchFamilies),
            )
          : (
            <>
              {groupBy === "project"
                ? visibleProjectGroups.map((g) => {
                    const key = g.project?.id ?? "orphan";
                    const title =
                      g.project?.slug || g.project?.name || "Unknown project";
                    const source =
                      projectGroups.find(
                        (s) => (s.project?.id ?? "orphan") === key,
                      )?.threads ?? g.threads;
                    const families = workerIdsByRoot(source, liveById);
                    return (
                      <div
                        key={key}
                        className={styles.filterGroup}
                        data-filter-group={key}
                        ref={bindListAnimation}
                      >
                        <div className={styles.filterGroupHeader}>
                          {g.project ? (
                            <ProjectIcon
                              url={g.project.iconUrl}
                              name={g.project.slug || g.project.name}
                              seed={g.project.id}
                              size={16}
                            />
                          ) : null}
                          <span className={styles.filterGroupTitle}>{title}</span>
                          <span className={styles.filterGroupCount}>
                            {g.threads.length}
                          </span>
                        </div>
                        {g.threads.map((thread) => renderCard(thread, families))}
                      </div>
                    );
                  })
                : groupBy === "status"
                  ? visibleStatusGroups.map((g) => {
                      const source =
                        statusGroups.find((s) => s.id === g.id)?.threads ??
                        g.threads;
                      const families = workerIdsByRoot(source, liveById);
                      return (
                      <div
                        key={g.id}
                        className={styles.filterGroup}
                        data-filter-group={g.id}
                        ref={bindListAnimation}
                      >
                        <div className={styles.filterGroupHeader}>
                          <span className={styles.filterGroupTitle}>{g.label}</span>
                          <span className={styles.filterGroupCount}>
                            {g.threads.length}
                          </span>
                        </div>
                        {g.threads.map((thread) => renderCard(thread, families))}
                      </div>
                      );
                    })
                  : groupBy === "tag"
                    ? visibleTagGroups.map((g) => {
                        const source =
                          tagGroups.find((s) => s.id === g.id)?.threads ??
                          g.threads;
                        const families = workerIdsByRoot(source, liveById);
                        return (
                        <div
                          key={g.id || "untagged"}
                          className={styles.filterGroup}
                          data-filter-group={g.id || "untagged"}
                          ref={bindListAnimation}
                        >
                          <div className={styles.filterGroupHeader}>
                            <span className={styles.filterGroupTitle}>{g.label}</span>
                            <span className={styles.filterGroupCount}>
                              {g.threads.length}
                            </span>
                          </div>
                          {g.threads.map((thread) => renderCard(thread, families))}
                        </div>
                        );
                      })
                    : (
                    <>
                      {visiblePinned.map((thread) =>
                        renderCard(thread, pinnedFamilies),
                      )}
                      {visiblePinned.length > 0 && (
                        <div
                          className={styles.pinnedDivider}
                          data-pinned-divider=""
                          aria-hidden
                        />
                      )}
                      {visibleActive.map((thread) =>
                        renderCard(thread, activeFamilies),
                      )}
                    </>
                  )}

              {listEmpty && projects.length > 0 && !viewUnavailable && (
                <p className={styles.emptySearch}>
                  {filtersOn
                    ? "No threads match these filters"
                    : projectScope
                      ? `No threads in ${scopedSlug} yet`
                      : "No threads yet"}
                </p>
              )}

              {/* T3 inbox: the shelves sit at the foot of the list. */}
              <div className={styles.shelves}>
              {groupBy === "none" && flat.working.length > 0 && (
                <div className={styles.shelf} ref={bindListAnimation}>
                  <button
                    type="button"
                    className={styles.shelfToggle}
                    data-working-shelf-toggle=""
                    aria-expanded={workingExpanded}
                    onClick={toggleWorking}
                  >
                    <span className={styles.shelfLabelSettled}>
                      {`Working · ${flat.working.length}`}
                    </span>
                    <span className={styles.shelfRuleSettled} />
                    <span
                      className={styles.shelfChevron}
                      data-open={workingExpanded}
                      aria-hidden
                    >
                      <Icon size={12}>
                        <path d="m6 9 6 6 6-6" />
                      </Icon>
                    </span>
                  </button>
                  {workingCarve && renderCard(workingCarve, workingFamilies)}
                  {workingExpanded &&
                    visibleWorking.map((thread) =>
                      renderCard(thread, workingFamilies),
                    )}
                </div>
              )}

              {flat.snoozed.length > 0 && (
                <div className={styles.shelf}>
                  <button
                    type="button"
                    className={styles.shelfToggle}
                    data-snoozed-shelf-toggle=""
                    aria-expanded={snoozedExpanded}
                    onClick={toggleSnoozed}
                  >
                    <span className={styles.shelfLabelSnoozed}>
                      {`Snoozed · ${flat.snoozed.length}`}
                    </span>
                    <span className={styles.shelfRuleSnoozed} />
                    <span
                      className={styles.shelfChevron}
                      data-open={snoozedExpanded}
                      aria-hidden
                    >
                      <Icon size={12}>
                        <path d="m6 9 6 6 6-6" />
                      </Icon>
                    </span>
                  </button>
                  {snoozedCarve && renderSnoozed(snoozedCarve, true)}
                  {visibleSnoozed.map((thread) => renderSnoozed(thread))}
                </div>
              )}

              {settledTail.length > 0 && (
                <div className={styles.shelf}>
                  <div className={styles.shelfHeaderRow}>
                    <button
                      type="button"
                      className={styles.shelfToggle}
                      data-settled-shelf-toggle=""
                      aria-expanded={settledExpanded}
                      onClick={toggleSettled}
                    >
                      <span className={styles.shelfLabelSettled}>
                        {`Settled · ${settledTail.length}`}
                      </span>
                      <span className={styles.shelfRuleSettled} />
                      <span
                        className={styles.shelfChevron}
                        data-open={settledExpanded}
                        aria-hidden
                      >
                        <Icon size={12}>
                          <path d="m6 9 6 6 6-6" />
                        </Icon>
                      </span>
                    </button>
                    {settledExpanded && onClearSettled && flat.settled.length > 0 && (
                      <button
                        type="button"
                        className={styles.shelfClear}
                        data-settled-clear-all=""
                        title="Archive every settled thread"
                        onClick={() =>
                          onClearSettled(flat.settled.map((t) => t.id))
                        }
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {settledCarve && renderSettled(settledCarve, true)}
                  {visibleSettled.map((thread) => renderSettled(thread))}
                  {settledExpanded && settledHidden > 0 && (
                    <button
                      type="button"
                      className={styles.showMore}
                      data-settled-more=""
                      onClick={() =>
                        setSettledVisibleCount(
                          (n) => n + SETTLED_TAIL_PAGE_COUNT,
                        )
                      }
                    >
                      Show {Math.min(settledHidden, SETTLED_TAIL_PAGE_COUNT)} more
                    </button>
                  )}
                </div>
              )}

              {trashedThreads.length > 0 && (
                <div className={styles.shelf} data-trashed-shelf="">
                  <div className={styles.shelfHeaderRow}>
                    <button
                      type="button"
                      className={styles.shelfToggle}
                      data-trashed-shelf-toggle=""
                      aria-expanded={trashedOpen}
                      onClick={() => setTrashedOpen((open) => !open)}
                    >
                      <span className={styles.shelfLabelSettled}>
                        {`Recently deleted · ${trashedThreads.length}`}
                      </span>
                      <span className={styles.shelfRuleSettled} />
                      <span
                        className={styles.shelfChevron}
                        data-open={trashedOpen}
                        aria-hidden
                      >
                        <Icon size={12}>
                          <path d="m6 9 6 6 6-6" />
                        </Icon>
                      </span>
                    </button>
                  </div>
                  {trashedOpen &&
                    trashedThreads.map((row) => (
                      <div
                        key={row.id}
                        className={styles.slimRow}
                        data-trashed-row={row.id}
                      >
                        <div className={styles.slimBody}>
                          <span className={styles.slimTitle}>{row.title}</span>
                          <span className={styles.slimSlug}>
                            {row.projectMissing
                              ? "Project unavailable"
                              : (row.projectSlug ?? "unknown")}
                          </span>
                          <span className={styles.slimSlot}>
                            <span className={styles.slimAge}>
                              {formatTrashExpiry(row.expiresAt, now)}
                            </span>
                            {onRestoreThread && (
                              <button
                                type="button"
                                className={styles.slimAction}
                                data-restore-btn={row.id}
                                disabled={row.projectMissing}
                                title={
                                  row.projectMissing
                                    ? "Cannot restore: project is no longer available"
                                    : "Restore thread"
                                }
                                onClick={() => void onRestoreThread(row.id)}
                              >
                                Restore
                              </button>
                            )}
                            {onPurgeThread &&
                              (purgeConfirmId === row.id ? (
                                <button
                                  type="button"
                                  className={`${styles.slimAction} ${styles.trashPurge}`}
                                  data-purge-confirm={row.id}
                                  onClick={() => {
                                    setPurgeConfirmId(null);
                                    void onPurgeThread(row.id);
                                  }}
                                >
                                  Confirm
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className={`${styles.slimAction} ${styles.trashPurge}`}
                                  data-purge-btn={row.id}
                                  title="Delete permanently"
                                  onClick={() => setPurgeConfirmId(row.id)}
                                >
                                  Delete
                                </button>
                              ))}
                          </span>
                        </div>
                      </div>
                    ))}
                </div>
              )}
              </div>
            </>
          )}
      </div>

      {removeConfirmId &&
        (() => {
          const confirmProject = projectById.get(removeConfirmId);
          if (!confirmProject) return null;
          const projectThreads = threads.filter(
            (t) => t.projectId === confirmProject.id,
          );
          const count = projectThreads.length;
          const worktreeCount = projectThreads.filter(
            (t) => t.worktreePath,
          ).length;
          const threadWord = count === 1 ? "thread" : "threads";
          const title = `Remove project ${confirmProject.slug} and delete its ${count} ${threadWord}?`;
          return (
            <div
              className={styles.removeConfirmOverlay}
              role="presentation"
              onClick={closeRemoveConfirm}
            >
              <div
                ref={removeConfirmRef}
                className={styles.removeConfirm}
                role="dialog"
                aria-modal="true"
                aria-labelledby="remove-project-title"
                tabIndex={-1}
                data-remove-confirm={confirmProject.id}
                onClick={(e) => e.stopPropagation()}
              >
                <h2
                  id="remove-project-title"
                  className={styles.removeConfirmTitle}
                >
                  {title}
                </h2>
                <p className={styles.removeConfirmMeta}>{confirmProject.path}</p>
                <p className={styles.removeConfirmBody}>
                  This permanently clears conversation history for those
                  threads.
                </p>
                <p className={styles.removeConfirmBody}>
                  This removes only this project entry.
                </p>
                {worktreeCount > 0 && (
                  <p
                    className={styles.removeConfirmBody}
                    data-remove-worktree-note
                  >
                    {worktreeCount === 1
                      ? "Its 1 worktree folder is deleted too."
                      : `Its ${worktreeCount} worktree folders are deleted too.`}{" "}
                    Branches and the repository are kept; a worktree with
                    uncommitted changes is left alone.
                  </p>
                )}
                <div className={styles.removeConfirmActions}>
                  <button
                    type="button"
                    className={styles.removeConfirmDanger}
                    data-remove-confirm-submit={confirmProject.id}
                    disabled={removePending}
                    aria-busy={removePending || undefined}
                    onClick={() => {
                      if (removePending || !onRemoveProject) return;
                      const id = confirmProject.id;
                      setRemovePending(true);
                      void Promise.resolve(onRemoveProject(id))
                        .catch(() => {
                          // Failure toast is the caller's job; always close.
                        })
                        .finally(() => {
                          setRemovePending(false);
                          setRemoveConfirmId(null);
                        });
                    }}
                  >
                    {removePending ? "Removing…" : "Remove project"}
                  </button>
                  <button
                    type="button"
                    className={styles.removeConfirmCancel}
                    disabled={removePending}
                    onClick={closeRemoveConfirm}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {multiSelected.size >= 2 && (
        <div className={styles.batchBar} data-batch-bar="">
          <span className={styles.batchCount} data-batch-count="">
            {multiSelected.size} selected
          </span>
          {batchFeedback && (
            <span className={styles.batchFeedback} data-batch-feedback="">
              {batchFeedback}
            </span>
          )}
          <button
            type="button"
            className={styles.batchBtn}
            data-batch-archive=""
            onClick={() => void runBatchArchive()}
          >
            Archive
          </button>
          <button
            type="button"
            className={styles.batchBtn}
            data-batch-settle=""
            onClick={() => void runBatchSettle()}
          >
            Settle
          </button>
          <button
            type="button"
            className={styles.batchBtn}
            data-batch-clear=""
            onClick={clearMulti}
          >
            Clear
          </button>
        </div>
      )}
      {batchFeedback && multiSelected.size < 2 && (
        <div
          className={styles.batchBar}
          data-batch-bar=""
          data-batch-feedback-only=""
        >
          <span className={styles.batchFeedback} data-batch-feedback="">
            {batchFeedback}
          </span>
          <button
            type="button"
            className={styles.batchBtn}
            data-batch-clear=""
            onClick={() => setBatchFeedback(null)}
          >
            Clear
          </button>
        </div>
      )}

      <footer className={styles.footer}>
        {projectError && (
          <div className={styles.errorBanner} role="alert">
            <span className={styles.errorText}>{projectError}</span>
            <button
              type="button"
              className={styles.errorDismiss}
              onClick={onDismissProjectError}
              aria-label="Dismiss error"
              title="Dismiss error"
            >
              <Icon size={12}>
                <path d="M18 6 6 18M6 6l12 12" />
              </Icon>
            </button>
          </div>
        )}
        <div className={styles.footerRow}>
          <button
            type="button"
            className={styles.settings}
            title="Settings"
            onClick={() => onOpenSettings?.()}
          >
            <span className={styles.settingsIcon} aria-hidden>
              <Icon size={15}>
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </Icon>
            </span>
            <span className={styles.srOnly}>Settings</span>
          </button>
          <nav className={styles.viewNav} aria-label="App">
        <button
          type="button"
          className={styles.viewNavBtn}
          data-view-nav="planboard"
          title={activeView === "planboard" ? "Back to threads" : "Planboard"}
          data-active={activeView === "planboard" ? "true" : undefined}
          aria-current={activeView === "planboard" ? "page" : undefined}
          onClick={() =>
            // The active destination toggles back to the thread view (#1411).
            activeView === "planboard"
              ? onOpenThreads?.()
              : onOpenPlanboard?.(projectScope)
          }
        >
          <Icon size={15}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16M15 4v16" />
          </Icon>
          <span className={styles.srOnly}>Planboard</span>
        </button>
        <button
          type="button"
          className={styles.viewNavBtn}
          data-view-nav="review"
          title={activeView === "prs" ? "Back to threads" : "Review"}
          data-active={activeView === "prs" ? "true" : undefined}
          aria-current={activeView === "prs" ? "page" : undefined}
          onClick={() =>
            activeView === "prs" ? onOpenThreads?.() : onOpenReview?.()
          }
        >
          <Icon size={15}>
            <circle cx="6" cy="6" r="2" />
            <circle cx="18" cy="18" r="2" />
            <path d="M6 8v8a2 2 0 0 0 2 2h8M13 6h3a2 2 0 0 1 2 2v8" />
          </Icon>
          <span className={styles.srOnly}>Review</span>
        </button>
        {moreDestinations.length > 0 && (
          <span
            className={styles.filterMenuHost}
            ref={moreHostRef}
            onBlur={onMoreBlur}
          >
            <button
              type="button"
              ref={moreTriggerRef}
              className={`${styles.viewNavBtn} ${styles.viewNavMore}`}
              data-app-more=""
              title="Insights: activity, usage, automations and more"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-controls="app-more-menu"
              aria-current={moreCurrentLabel ? "page" : undefined}
              data-active={moreCurrentLabel ? "true" : undefined}
              aria-label={
                moreCurrentLabel ? `Insights, ${moreCurrentLabel}` : undefined
              }
              onClick={toggleMore}
              onKeyDown={onMoreKeyDown}
            >
              <Icon size={15}>
                <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
              </Icon>
              <span className={styles.srOnly}>Insights</span>
            </button>
            {moreOpen && (
              <div
                id="app-more-menu"
                className={`${styles.menu} ${styles.appMoreMenu} ${styles.appMoreMenuUp}`}
                role="menu"
                aria-label="Insights"
                data-app-more-menu=""
                onKeyDown={onMoreKeyDown}
              >
                {moreCurrentLabel ? (
                  <button
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-view-nav="threads"
                    onClick={() => {
                      closeMore(true);
                      onOpenThreads?.();
                    }}
                  >
                    Back to threads
                  </button>
                ) : null}
                {moreDestinations.map((dest) => {
                  const current = activeView === dest.view;
                  return (
                    <button
                      key={dest.id}
                      type="button"
                      className={styles.menuItem}
                      role="menuitem"
                      data-view-nav={dest.id}
                      data-active={current ? "true" : undefined}
                      aria-current={current ? "page" : undefined}
                      onClick={() => {
                        closeMore(true);
                        dest.run();
                      }}
                    >
                      {dest.label}
                      {current && (
                        <span className={styles.filterCheck}>
                          <Icon size={12}>
                            <path d="M5 12.5 9 16.5 19 7.5" />
                          </Icon>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </span>
        )}
          </nav>
          {memoryEntries != null && (
            <span
              className={styles.memoryPulse}
              data-memory-pulse={memoryEntries}
              title="Shared memories every agent in Solenta can recall"
            >
              <span className={styles.memoryDiamond} aria-hidden />
              {memoryEntries.toLocaleString()}{" "}
              {memoryEntries === 1 ? "memory" : "memories"}
            </span>
          )}
          {stayAwake && onSetStayAwakeMode && (
            <StayAwakeControl
              state={stayAwake}
              onSetMode={onSetStayAwakeMode}
              compact={memoryEntries != null}
            />
          )}
          {(updateState === "available" || updateState === "staged") && (
            <button
              type="button"
              className={styles.settingsUpdate}
              data-settings-update=""
              disabled={updating}
              title={
                updateState === "staged"
                  ? "Restart to update"
                  : "Download and install the update"
              }
              onClick={async () => {
                if (updateState === "staged") {
                  void onApplyUpdate?.();
                  return;
                }
                setUpdating(true);
                try {
                  await onDownloadUpdate?.();
                } finally {
                  // On success updateState flips to "staged" and this button
                  // becomes Restart; on failure it stays clickable.
                  setUpdating(false);
                }
              }}
            >
              {updating
                ? "Updating…"
                : updateState === "staged"
                  ? "Restart"
                  : "Update"}
            </button>
          )}
        </div>
      </footer>
      <KeyboardSheet
        open={keyboardSheetOpen}
        onClose={() => setKeyboardSheetOpen(false)}
      />
    </aside>
  );
});
