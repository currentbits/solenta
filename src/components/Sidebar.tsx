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
  ConflictForecast,
  ProjectInfo,
  ProviderInfo,
  ThreadInfo,
  UpdateStatus,
} from "../shared/ipc";
import {
  forecastHoverLines,
  formatForecastHoverLine,
  pairsForThread,
} from "../conflictForecast";
import { isWebMode } from "../shared/wire";
import {
  formatElapsed,
  formatRelativeAge,
  formatWorkingLabel,
} from "../format";
import { formatQuotaWaitLabel } from "../quotaWait";
import {
  GROUP_ATTENTION_CAP,
  buildSidebarGroups,
  flattenLater,
  partitionSidebar,
  visibleAttentionCount,
} from "../sidebarGroups";
import {
  AUTO_SETTLE_AFTER_DAYS,
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
  effectiveSettled,
  resolveSettledTimestamp,
} from "../threadSettle";
import {
  formatSnoozeWakeLabel,
  isPinned,
  resolveSnoozePresets,
  showWokePill,
} from "../threadSnooze";
import { countUnread, isUnread } from "../threadUnread";
import {
  buildWaitStates,
  isDelegating,
  waitLabel,
  waitTooltip,
  type WaitState,
} from "../waiting";
import { useEscapeClose } from "../useEscapeClose";
import {
  buildVisibleThreadIds,
  formatBatchSettleFeedback,
  isShortcutBlocked,
  planBatchSettle,
  rangeSelectIds,
  stepVisibleId,
  toggleIdInSet,
} from "../sidebarSelection";
import { KeyboardSheet } from "./KeyboardSheet";
import styles from "./Sidebar.module.css";

const TICK_MS = 5000;
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;
const COLLAPSED_KEY = "coder.sidebar.collapsedGroups";
/** Settled tail collapse flag: stored "tail" = collapsed, absent = expanded. */
const SETTLED_COLLAPSED_KEY = "coder.sidebar.settledCollapsed";

/**
 * t3 list animation (Sidebar.logic.ts): rows glide on lifecycle transitions
 * instead of the sidebar jumping. Attached per list container via ref
 * callback; no-ops where ResizeObserver is missing (jsdom).
 */
function attachListAnimation(node: HTMLElement | null): void {
  if (node) autoAnimate(node, { duration: 150, easing: "ease-out" });
}

/** localStorage set, defensive: private mode / quota / bad JSON all mean "empty". */
function loadKeySet(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveKeySet(key: string, set: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // Quota/private mode: collapse state just stops persisting.
  }
}

/**
 * Whether the ALL PROJECTS control should treat the tree as having any
 * expanded group. Used for BOTH aria/title render and the collapse-all click
 * — duplicating this with a searching term only on one side inverted
 * collapse-all during search into expand-all (B1).
 *
 * Search overrides per-group collapse for display, so searching counts as
 * expanded-any (click re-collapses; it must not clear the set).
 *
 * A project added after collapse-all is absent from the collapsed set, so it
 * renders expanded: new work must be visible.
 */
export function anyGroupExpandedState(
  groupKeys: readonly string[],
  collapsed: ReadonlySet<string>,
  searching: boolean,
): boolean {
  if (groupKeys.length === 0) return false;
  if (searching) return true;
  return groupKeys.some((k) => !collapsed.has(k));
}

interface SidebarProps {
  appName: string;
  /** Update channel of the running build; "nightly" tags the wordmark. */
  channel?: "prod" | "nightly" | null;
  /** Update check result; a dot on Settings when an update is waiting. */
  updateState?: UpdateStatus["state"] | null;
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
    opts?: { worktree?: boolean; orchestrate?: boolean; teach?: boolean; ask?: boolean; issueNumber?: number | null },
  ) => void;
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
  /** Opens the Settings modal. */
  onOpenSettings?: () => void;
  /** Aggregated spend today (USD); null while loading. */
  spendTodayUsd?: number | null;
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
  /** Mute/unmute desktop notifications for one thread. */
  onSetMuted?: (threadId: string, muted: boolean) => void | Promise<void>;
  /** Rename a thread from the row menu. */
  onRenameThread?: (threadId: string, title: string) => void | Promise<void>;
  /** Archive a thread (batch toolbar). */
  onSetArchived?: (threadId: string, archived: boolean) => void | Promise<void>;
  /** Clear the settled tail: archive all settled threads (Synara-style, undo via toast). */
  onClearSettled?: (threadIds: string[]) => void | Promise<void>;
  /**
   * Fork / hand off (round 49). Plain call = same harness; provider override
   * is hand-off. Does not require the thread to be selected.
   */
  onFork?: (
    threadId: string,
    opts?: { provider?: string },
  ) => void | Promise<void>;
  /** Which main view is showing. Defaults to thread so existing callers stay idle. */
  activeView?: "thread" | "kanban" | "planboard" | "activity";
  onOpenKanban?: () => void;
  onOpenPlanboard?: () => void;
  /**
   * Paste a GitHub issue into this project. Omitted by existing tests so
   * the icon button stays hidden.
   */
  onCreateThreadFromIssue?: (input: {
    projectId: string;
    projectPath: string;
    ref: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onOpenActivity?: () => void;
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

export type SelectOpts = { meta?: boolean; shift?: boolean };

/**
 * Live subagents (Agent tool, issue #21) nested under their thread card with
 * the same indent + elbow as fork/worker cards (issue #542). Running rows
 * only: the sidebar is the live overview (mirrors buildWaitStates), finished
 * rows stay on the Agents panel roster. Subagents are not threads, so a row
 * click just selects the parent thread.
 */
function SubagentRows({
  thread,
  onSelect,
}: {
  thread: ThreadInfo;
  onSelect: (id: string, opts?: SelectOpts) => void;
}) {
  const running = (thread.subagents ?? []).filter(
    (s) => s.status === "running",
  );
  if (running.length === 0) return null;
  return (
    <ul className={styles.subagentList} data-subagent-list={thread.id}>
      {running.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            className={styles.subagentRow}
            data-subagent-row=""
            title={s.description}
            aria-label={`Subagent: ${s.description}`}
            onClick={(e) =>
              onSelect(thread.id, {
                meta: e.metaKey || e.ctrlKey,
                shift: e.shiftKey,
              })
            }
          >
            <span className={styles.waitingDot} aria-hidden />
            <span className={styles.subagentTitle}>{s.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function formatUsd(n: number): string {
  return n.toFixed(2);
}

function spendMeterLabel(
  spend: number,
  budget: number | null | undefined,
): string {
  if (budget != null && budget > 0) {
    return `Today: $${formatUsd(spend)} / $${formatUsd(budget)}`;
  }
  return `Today: $${formatUsd(spend)}`;
}

function spendMeterTone(
  spend: number,
  budget: number | null | undefined,
): "ok" | "warn" | "over" {
  if (budget == null || budget <= 0) return "ok";
  const ratio = spend / budget;
  if (ratio >= 1) return "over";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

/**
 * t3 flatten (#566): the row's whole status vocabulary is one dot.
 * blue = running (working/delegating), amber = needs you (waiting/stalled/
 * quota/woke/blocked workers), red = failed, grey = queued follow-up,
 * absent = idle/done. Words live in the title tooltip and the select
 * button's accessible name; detail lives in the thread header and Activity.
 */
export type StatusDotInfo = {
  tone: "working" | "attention" | "failed" | "queued";
  /** Tooltip: full phrase, e.g. "Stalled 4m" or "Waiting on 2 workers · 3m". */
  label: string;
  /** Spoken triage word appended to the row's aria-label. */
  spoken: string;
  /** Legacy data hooks (tests, e2e selectors). */
  flags: Record<string, string>;
};

export function statusDotFor(
  thread: ThreadInfo,
  now: number,
  wait: WaitState | null,
  active: boolean,
): StatusDotInfo | null {
  const base = baseStatusDot(thread, now, wait, active);
  // Queued follow-up (#92) rides along on whatever dot is showing; it only
  // owns the dot when the thread is otherwise idle.
  if (!thread.queued) return base;
  if (base == null) {
    return {
      tone: "queued",
      label: `Queued: ${thread.queued.prompt}`,
      spoken: "queued follow-up",
      flags: { "data-queued-dot": thread.id },
    };
  }
  return {
    ...base,
    label: `${base.label} — Queued: ${thread.queued.prompt}`,
    flags: { ...base.flags, "data-queued-dot": thread.id },
  };
}

function baseStatusDot(
  thread: ThreadInfo,
  now: number,
  wait: WaitState | null,
  active: boolean,
): StatusDotInfo | null {
  const waitSuffix = wait ? ` — ${waitTooltip(wait)}` : "";
  const waitFlags: Record<string, string> = wait
    ? {
        "data-wait-badge": thread.id,
        ...(wait.blocked > 0 ? { "data-attention": "true" } : {}),
      }
    : {};
  if (thread.status === "failed") {
    return {
      tone: "failed",
      label: thread.lastError ?? "Failed",
      spoken: "failed",
      flags: { "data-failed": thread.id },
    };
  }
  if (thread.status === "quota-wait") {
    const until = thread.quotaWaitUntil;
    const clock =
      until != null && Number.isFinite(until)
        ? formatQuotaWaitLabel(until, now)
        : "—";
    return {
      tone: "attention",
      label: thread.lastError ?? `Usage limit reached. Resuming at ${clock}.`,
      spoken: "needs attention",
      flags: { "data-quota-wait": "" },
    };
  }
  if (thread.status === "working" && thread.awaitingInput) {
    return {
      tone: "attention",
      label: `Waiting for input${waitSuffix}`,
      spoken: "needs attention",
      flags: { "data-waiting": "", ...waitFlags },
    };
  }
  if (thread.status === "working" && thread.stalledAt != null) {
    return {
      tone: "attention",
      label: `Stalled ${formatElapsed(thread.stalledAt, now)}${waitSuffix}`,
      spoken: "needs attention",
      flags: { "data-stalled": "", ...waitFlags },
    };
  }
  if (wait && wait.blocked > 0) {
    return {
      tone: "attention",
      label: waitTooltip(wait),
      spoken: "needs attention",
      flags: waitFlags,
    };
  }
  if (thread.status === "working") {
    const label =
      thread.runStartedAt != null
        ? formatWorkingLabel(thread.runStartedAt, now)
        : "Working";
    return {
      tone: "working",
      label: `${label}${waitSuffix}`,
      spoken: "working",
      flags: waitFlags,
    };
  }
  if (isDelegating(thread.status, wait)) {
    return {
      tone: "working",
      label: wait ? waitTooltip(wait) : "Delegating",
      spoken: "delegating",
      flags: { "data-delegating": thread.id, ...waitFlags },
    };
  }
  if (!active && showWokePill(thread, now)) {
    return {
      tone: "attention",
      label: "Woke from snooze",
      spoken: "needs attention",
      flags: { "data-woke": "" },
    };
  }
  return null;
}

function StatusDot({ dot }: { dot: StatusDotInfo }) {
  return (
    <span
      className={styles.statusDot}
      data-status-dot={dot.tone}
      title={dot.label}
      {...dot.flags}
    />
  );
}

function ConflictForecastBadge({
  threadId,
  forecast,
  titles,
}: {
  threadId: string;
  forecast?: ConflictForecast | null;
  titles?: ReadonlyMap<string, string>;
}) {
  const pairs = pairsForThread(forecast, threadId);
  if (pairs.length === 0) return null;
  const lines = forecastHoverLines(pairs, threadId, titles);
  const loud = lines.some((l) => l.kind === "conflict");
  const kind = loud ? "conflict" : "overlap";
  const label = pairs.length > 1 ? `${kind} · ${pairs.length}` : kind;
  const spoken = lines.map(formatForecastHoverLine).join(". ");
  const tipId = `conflict-tip-${threadId}`;
  return (
    <span className={styles.conflictWrap}>
      <span
        className={`${styles.badge} ${loud ? styles.badgeConflict : styles.badgeOverlap}`}
        data-conflict-forecast={kind}
        tabIndex={0}
        aria-describedby={tipId}
        aria-label={`${label}. ${spoken}`}
      >
        {label}
      </span>
      <span
        id={tipId}
        role="tooltip"
        className={styles.conflictTip}
        data-conflict-tip=""
      >
        {lines.map((line) => (
          <span
            key={line.otherId}
            className={styles.conflictTipLine}
            data-conflict-kind={line.kind}
          >
            {formatForecastHoverLine(line)}
          </span>
        ))}
      </span>
    </span>
  );
}

/** Visible label for typeahead: strip the ‹/› carets, keep the words. */
function menuItemLabel(el: HTMLElement): string {
  return (el.textContent || "")
    .replace(/[‹›]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function enabledMenuItems(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
}

function focusMenuItem(menu: HTMLElement, delta: number): void {
  const items = enabledMenuItems(menu);
  if (items.length === 0) return;
  const from = items.findIndex((el) => el === document.activeElement);
  const next =
    from < 0
      ? delta > 0
        ? 0
        : items.length - 1
      : (from + delta + items.length) % items.length;
  items[next]!.focus();
}

function focusMenuEdge(menu: HTMLElement, edge: "first" | "last"): void {
  const items = enabledMenuItems(menu);
  if (items.length === 0) return;
  (edge === "first" ? items[0] : items[items.length - 1])!.focus();
}

const TYPEAHEAD_MS = 500;

function focusTypeaheadItem(
  menu: HTMLElement,
  state: { prefix: string; at: number },
  key: string,
): void {
  const now = Date.now();
  if (now - state.at > TYPEAHEAD_MS) state.prefix = "";
  state.at = now;
  state.prefix += key.toLowerCase();
  const items = enabledMenuItems(menu);
  if (items.length === 0) return;
  const from = items.findIndex((el) => el === document.activeElement);
  const start = from >= 0 ? from + 1 : 0;
  const repeated =
    state.prefix.length > 1 && [...state.prefix].every((c) => c === state.prefix[0]);
  const needle = repeated ? state.prefix[0]! : state.prefix;
  for (let i = 0; i < items.length; i++) {
    const el = items[(start + i) % items.length]!;
    if (menuItemLabel(el).startsWith(needle)) {
      el.focus();
      return;
    }
  }
}

/**
 * Memo'd: during a run main pushes thread updates every 700ms and the parent
 * list re-renders each tick — without memo every visible card re-renders too.
 * Unchanged threads keep row identity (patchThreadList), so a shallow compare
 * skips them. Exported for render tests that need a card without the
 * archived-collapse gate.
 */
export const ThreadCard = memo(function ThreadCard({
  thread,
  slug,
  providers,
  active,
  now,
  onSelect,
  contentMatch,
  isSettled = false,
  multiSelected = false,
  indexHint = null,
  onSetSettled,
  onSetPinned,
  onSetSnoozed,
  onSetMuted,
  onRenameThread,
  onFork,
  snoozeMenuOpen = false,
  onToggleSnoozeMenu,
  nested = false,
  wait = null,
  showSlug = true,
  conflictForecast = null,
  threadTitles,
}: {
  thread: ThreadInfo;
  slug: string;
  providers: ProviderInfo[];
  active: boolean;
  now: number;
  onSelect: (id: string, opts?: SelectOpts) => void;
  contentMatch?: boolean;
  isSettled?: boolean;
  multiSelected?: boolean;
  /** 1-9 while cmd held; null otherwise. */
  indexHint?: number | null;
  onSetSettled?: (
    threadId: string,
    override: "settled" | "active",
  ) => void | Promise<void>;
  onSetPinned?: (threadId: string, pinned: boolean) => void | Promise<void>;
  onSetSnoozed?: (threadId: string, until: number | null) => void | Promise<void>;
  /** Mute/unmute desktop notifications for this thread (snooze menu item). */
  onSetMuted?: (threadId: string, muted: boolean) => void | Promise<void>;
  /** Rename this thread (snooze menu item). */
  onRenameThread?: (threadId: string, title: string) => void | Promise<void>;
  onFork?: (
    threadId: string,
    opts?: { provider?: string },
  ) => void | Promise<void>;
  /** Single row menu (snooze/fork/hand-off/rename/mute/settle). */
  snoozeMenuOpen?: boolean;
  onToggleSnoozeMenu?: (threadId: string | null) => void;
  /** Fork/worker rendered attached under its source thread (indent + elbow). */
  nested?: boolean;
  /** Live delegated work this thread is blocked on (issue #42); null when none. */
  wait?: WaitState | null;
  /**
   * Render the project slug on the top row. False inside named project
   * groups — the group header already carries the slug, repeating it per
   * card is pure noise. True for orphan groups (no header) and standalone
   * renders (tests).
   */
  showSlug?: boolean;
  /** Project forecast; omitted in tests that do not care about #249. */
  conflictForecast?: ConflictForecast | null;
  /** Titles for the other side of each pair, used in the tooltip. */
  threadTitles?: ReadonlyMap<string, string>;
}) {
  const working = thread.status === "working";
  // Settled cards offer "keep active"; attention cards offer "settle".
  const settleOverride = isSettled ? ("active" as const) : ("settled" as const);
  const settleLabel = isSettled ? "Keep thread active" : "Settle thread";
  // Selected never paints unread (you are looking at it) — render rule only.
  const showUnread = !active && isUnread(thread);
  const dot = statusDotFor(thread, now, wait, active);
  const pinned = isPinned(thread);
  // The dot is color-only, so the select button speaks the triage state.
  const selectLabel = [
    `Select thread: ${thread.title}`,
    showUnread ? "unread" : null,
    pinned ? "pinned" : null,
    dot ? dot.spoken : null,
  ]
    .filter(Boolean)
    .join(", ");
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renamingRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const menuWasOpen = useRef(false);
  const [menuPlaceUp, setMenuPlaceUp] = useState(false);
  // Drill-in (#583): a flyout would clip on .list { overflow-y: auto }.
  const [snoozePanelOpen, setSnoozePanelOpen] = useState(false);
  const pendingMenuFocus = useRef<"snooze" | "preset" | null>(null);
  const typeaheadRef = useRef({ prefix: "", at: 0 });

  const openSnoozePanel = () => {
    pendingMenuFocus.current = "preset";
    setSnoozePanelOpen(true);
  };
  const closeSnoozePanel = () => {
    pendingMenuFocus.current = "snooze";
    setSnoozePanelOpen(false);
  };

  const startRename = () => {
    setRenameDraft(thread.title);
    renamingRef.current = true;
    setRenaming(true);
    onToggleSnoozeMenu?.(null);
  };

  const finishRename = (cancel: boolean) => {
    if (!renamingRef.current) return;
    renamingRef.current = false;
    const next = renameDraft.trim();
    setRenaming(false);
    if (cancel || !next || next === thread.title) return;
    void onRenameThread?.(thread.id, next);
  };

  useLayoutEffect(() => {
    if (!snoozeMenuOpen) {
      setMenuPlaceUp(false);
      setSnoozePanelOpen(false);
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const clip = menu.closest("[data-sidebar-list]");
    const menuRect = menu.getBoundingClientRect();
    const clipRect = clip?.getBoundingClientRect();
    if (menuRect.height === 0) return;
    const bottom = clipRect?.bottom ?? window.innerHeight;
    const top = clipRect?.top ?? 0;
    const overflows = menuRect.bottom > bottom - 8;
    const fitsAbove = menuRect.height < menuRect.top - top - 8;
    setMenuPlaceUp(overflows && fitsAbove);
  }, [snoozeMenuOpen, snoozePanelOpen]);

  useLayoutEffect(() => {
    if (!snoozeMenuOpen) {
      pendingMenuFocus.current = null;
      if (menuWasOpen.current && !renamingRef.current) {
        const active = document.activeElement as HTMLElement | null;
        const more = moreBtnRef.current;
        // Skip if another card already took focus (opening B closes A).
        if (
          more &&
          (!active ||
            active === document.body ||
            active === more ||
            !document.body.contains(active))
        ) {
          more.focus();
        }
      }
      menuWasOpen.current = false;
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const justOpened = !menuWasOpen.current;
    menuWasOpen.current = true;
    const want = pendingMenuFocus.current;
    if (want) {
      pendingMenuFocus.current = null;
      const el =
        want === "snooze"
          ? menu.querySelector<HTMLElement>("[data-snooze-item]")
          : (menu.querySelector<HTMLElement>("[data-snooze-preset]") ??
            menu.querySelector<HTMLElement>("[data-snooze-back]"));
      el?.focus();
      return;
    }
    if (justOpened) focusMenuEdge(menu, "first");
  }, [snoozeMenuOpen, snoozePanelOpen]);

  // Card is a non-interactive shell. Stretch select + optional settle action
  // are separate focusables. Content sits in a sibling with pointer-events:none
  // so clicks fall through to select; PR <a> and settle re-enable pointer-events.
  // Never nest interactive controls inside the select button.
  return (
    <div
      className={styles.card}
      data-thread-card={thread.id}
      data-active={active}
      data-multi={multiSelected ? "true" : undefined}
      data-archived={thread.archived ? "true" : undefined}
      data-settled={isSettled ? "true" : undefined}
      data-unread={showUnread ? "true" : undefined}
      data-pinned={pinned ? "true" : undefined}
      data-nested={nested ? "true" : undefined}
      data-menu-open={snoozeMenuOpen ? "true" : undefined}
    >
      {indexHint != null && (
        <span className={styles.indexHint} data-index-hint={indexHint} aria-hidden>
          {indexHint}
        </span>
      )}
      <button
        type="button"
        className={styles.cardSelect}
        onClick={(e) =>
          onSelect(thread.id, {
            meta: e.metaKey || e.ctrlKey,
            shift: e.shiftKey,
          })
        }
        aria-label={selectLabel}
      />
      {/* One line (#566): dot + title + age. Branch/PR/provider/worktree live
          in the thread header; run detail lives in the dot tooltip. */}
      <div className={styles.cardBody}>
        {dot && <StatusDot dot={dot} />}
        {showUnread && <span className={styles.srOnly}>unread</span>}
        {renaming ? (
          <input
            className={styles.titleInput}
            data-thread-title-input={thread.id}
            value={renameDraft}
            maxLength={60}
            aria-label="Thread title"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenameDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={() => finishRename(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                finishRename(true);
              }
            }}
          />
        ) : (
          <div className={styles.cardTitle} title={thread.title}>
            {thread.title}
          </div>
        )}
        {pinned && (
          <span className={styles.pinFlag} data-pin-flag="" title="Pinned" aria-hidden>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 11 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1" />
            </svg>
          </span>
        )}
        {showSlug && <span className={styles.repo}>{slug}</span>}
        {contentMatch && (
          <span className={styles.inMessagesTag}>in messages</span>
        )}
        <ConflictForecastBadge
          threadId={thread.id}
          forecast={conflictForecast}
          titles={threadTitles}
        />
        <span className={styles.age}>
          {formatRelativeAge(thread.updatedAt, now)}
        </span>
      </div>
      {/* Live delegated work stays visible (issue #42, kept through the #566
          flatten by request): the count is the point, and the line vanishes
          on its own when the workers finish. */}
      {wait && (
        <div
          className={styles.waitRow}
          data-wait-row={thread.id}
          data-attention={wait.blocked > 0 ? "true" : undefined}
          title={waitTooltip(wait)}
        >
          {waitLabel(wait, now)}
        </div>
      )}
      {(onSetSettled || onSetPinned || onSetSnoozed || onFork) && (
        <div className={styles.cardActions} data-card-actions="">
          {onSetPinned && (
            <button
              type="button"
              className={styles.settleBtn}
              aria-label={isPinned(thread) ? "Unpin thread" : "Pin thread"}
              title={isPinned(thread) ? "Unpin thread" : "Pin thread"}
              data-pin-btn={thread.id}
              onClick={(e) => {
                e.stopPropagation();
                void onSetPinned(thread.id, !isPinned(thread));
              }}
            >
              {isPinned(thread) ? (
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 17v5" />
                  <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 11 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1" />
                </svg>
              ) : (
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 17v5" />
                  <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 11 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1" />
                </svg>
              )}
            </button>
          )}
          {(onSetSnoozed || onFork || onRenameThread || onSetMuted || onSetSettled) && (
            <div className={styles.snoozeWrap}>
              <button
                ref={moreBtnRef}
                type="button"
                className={styles.settleBtn}
                aria-label={`Thread actions: ${thread.title}`}
                title="Thread actions"
                aria-haspopup="menu"
                aria-expanded={snoozeMenuOpen}
                data-more-btn={thread.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSnoozeMenu?.(snoozeMenuOpen ? null : thread.id);
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="3.25" cy="8" r="1.25" />
                  <circle cx="8" cy="8" r="1.25" />
                  <circle cx="12.75" cy="8" r="1.25" />
                </svg>
              </button>
              {snoozeMenuOpen && (
                <div
                  ref={menuRef}
                  className={styles.snoozeMenu}
                  role="menu"
                  data-snooze-menu={thread.id}
                  data-placement={menuPlaceUp ? "up" : "down"}
                  onKeyDown={(e) => {
                    const menu = menuRef.current;
                    if (!menu) return;
                    if (
                      snoozePanelOpen &&
                      (e.key === "ArrowLeft" || e.key === "Backspace")
                    ) {
                      e.preventDefault();
                      closeSnoozePanel();
                      return;
                    }
                    if (
                      !snoozePanelOpen &&
                      e.key === "ArrowRight" &&
                      (e.target as HTMLElement).closest("[data-snooze-item]")
                    ) {
                      e.preventDefault();
                      openSnoozePanel();
                      return;
                    }
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      focusMenuItem(menu, 1);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      focusMenuItem(menu, -1);
                      return;
                    }
                    if (e.key === "Home") {
                      e.preventDefault();
                      focusMenuEdge(menu, "first");
                      return;
                    }
                    if (e.key === "End") {
                      e.preventDefault();
                      focusMenuEdge(menu, "last");
                      return;
                    }
                    if (
                      e.key.length === 1 &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      !e.altKey &&
                      e.key !== " "
                    ) {
                      e.preventDefault();
                      focusTypeaheadItem(menu, typeaheadRef.current, e.key);
                    }
                  }}
                >
                  {onSetSnoozed && snoozePanelOpen ? (
                    <>
                      <button
                        type="button"
                        className={styles.snoozeMenuItem}
                        role="menuitem"
                        data-snooze-item=""
                        data-snooze-back=""
                        aria-haspopup="menu"
                        aria-expanded="true"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeSnoozePanel();
                        }}
                      >
                        <span className={styles.snoozeBack}>
                          <span className={styles.snoozeCaret} aria-hidden>
                            ‹
                          </span>
                          <span>Snooze</span>
                        </span>
                      </button>
                      <div
                        className={styles.snoozeSubmenu}
                        data-snooze-submenu=""
                        role="group"
                        aria-label="Snooze until"
                      >
                        {resolveSnoozePresets(now).map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            className={styles.snoozeMenuItem}
                            role="menuitem"
                            data-snooze-preset={p.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              void onSetSnoozed(thread.id, p.until);
                              onToggleSnoozeMenu?.(null);
                            }}
                          >
                            <span>{p.label}</span>
                            <span className={styles.snoozeWhen}>{p.whenLabel}</span>
                          </button>
                        ))}
                        {thread.snoozedUntil != null && (
                          <button
                            type="button"
                            className={styles.snoozeMenuItem}
                            role="menuitem"
                            data-snooze-clear=""
                            onClick={(e) => {
                              e.stopPropagation();
                              void onSetSnoozed(thread.id, null);
                              onToggleSnoozeMenu?.(null);
                            }}
                          >
                            Clear snooze
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                  {onSetSnoozed && (
                    <button
                      type="button"
                      className={styles.snoozeMenuItem}
                      role="menuitem"
                      data-snooze-item=""
                      aria-haspopup="menu"
                      aria-expanded="false"
                      onClick={(e) => {
                        e.stopPropagation();
                        openSnoozePanel();
                      }}
                    >
                      <span>Snooze</span>
                      <span className={styles.snoozeCaret} aria-hidden>
                        ›
                      </span>
                    </button>
                  )}
                  {onSetSnoozed &&
                    (onFork || onRenameThread || onSetMuted || onSetSettled) && (
                      <div
                        className={styles.snoozeMenuSep}
                        role="separator"
                        data-menu-sep="snooze"
                      />
                    )}
                  {onFork && (
                    <button
                      type="button"
                      className={styles.snoozeMenuItem}
                      role="menuitem"
                      data-fork-btn={thread.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleSnoozeMenu?.(null);
                        void onFork(thread.id);
                      }}
                    >
                      Fork
                    </button>
                  )}
                  {onFork &&
                    providers
                      .filter((p) => p.id !== thread.provider)
                      .map((p) => {
                        const disabled = !p.available;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            className={styles.snoozeMenuItem}
                            role="menuitem"
                            data-handoff-provider={p.id}
                            disabled={disabled}
                            aria-disabled={disabled ? "true" : undefined}
                            title={
                              disabled
                                ? `${p.name} is not installed`
                                : `Hand off to ${p.name}`
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              if (disabled) return;
                              void onFork(thread.id, { provider: p.id });
                              onToggleSnoozeMenu?.(null);
                            }}
                          >
                            Hand off · {p.name}
                          </button>
                        );
                      })}
                  {onFork && (onRenameThread || onSetMuted || onSetSettled) && (
                    <div
                      className={styles.snoozeMenuSep}
                      role="separator"
                      data-menu-sep="fork"
                    />
                  )}
                  {onRenameThread && (
                    <button
                      type="button"
                      className={styles.snoozeMenuItem}
                      role="menuitem"
                      data-rename-thread={thread.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename();
                      }}
                    >
                      Rename
                    </button>
                  )}
                  {onSetMuted && (
                    <button
                      type="button"
                      className={styles.snoozeMenuItem}
                      role="menuitem"
                      data-mute-toggle={thread.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onSetMuted(thread.id, !thread.muted);
                        onToggleSnoozeMenu?.(null);
                      }}
                    >
                      {thread.muted ? "Unmute notifications" : "Mute notifications"}
                    </button>
                  )}
                  {onSetSettled && (
                    <button
                      type="button"
                      className={styles.snoozeMenuItem}
                      role="menuitem"
                      data-settle-item={thread.id}
                      disabled={working && !isSettled}
                      title={
                        working && !isSettled
                          ? "Cannot settle while a run is active"
                          : undefined
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        void onSetSettled(thread.id, settleOverride);
                        onToggleSnoozeMenu?.(null);
                      }}
                    >
                      {settleLabel}
                    </button>
                  )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Slim Later-shelf row (t3-style): title + project slug + wrap-up age.
 * Dimmed at rest, restored on hover. Selectable; Keep-active hover pin only
 * (opening a settled thread does NOT un-settle). Archived rows dim further
 * and swap the hover action for "unarchive" (#567).
 */
export function SettledRow({
  thread,
  slug,
  active,
  now,
  onSelect,
  onSetSettled,
  pinMode = false,
  onSetPinned,
  archived = false,
  onSetArchived,
  multiSelected = false,
  indexHint = null,
}: {
  thread: ThreadInfo;
  slug: string;
  active: boolean;
  now: number;
  onSelect: (id: string, opts?: SelectOpts) => void;
  onSetSettled?: (
    threadId: string,
    override: "settled" | "active",
  ) => void | Promise<void>;
  pinMode?: boolean;
  onSetPinned?: (threadId: string, pinned: boolean) => void | Promise<void>;
  /** Archived Later row: dimmer, hover action = unarchive. */
  archived?: boolean;
  onSetArchived?: (threadId: string, archived: boolean) => void | Promise<void>;
  multiSelected?: boolean;
  indexHint?: number | null;
}) {
  const wrapUpAt = pinMode
    ? (thread.pinnedAt ?? thread.updatedAt)
    : archived
      ? thread.updatedAt
      : resolveSettledTimestamp(thread);
  // Settled can still be unread (activity after last visit, then auto-settled).
  const showUnread = !active && isUnread(thread);
  const selectLabel = showUnread
    ? `Select thread: ${thread.title}, unread`
    : `Select thread: ${thread.title}`;
  return (
    <div
      className={styles.settledRow}
      data-thread-card={thread.id}
      data-settled={pinMode || archived ? undefined : "true"}
      data-pinned={pinMode ? "true" : undefined}
      data-archived={archived ? "true" : undefined}
      data-active={active}
      data-multi={multiSelected ? "true" : undefined}
      data-unread={showUnread ? "true" : undefined}
    >
      {indexHint != null && (
        <span className={styles.indexHint} data-index-hint={indexHint} aria-hidden>
          {indexHint}
        </span>
      )}
      <button
        type="button"
        className={styles.cardSelect}
        onClick={(e) =>
          onSelect(thread.id, {
            meta: e.metaKey || e.ctrlKey,
            shift: e.shiftKey,
          })
        }
        aria-label={selectLabel}
      />
      <div className={styles.settledBody}>
        {showUnread && (
          <span
            className={styles.unreadDot}
            data-unread-dot={thread.id}
            aria-hidden="true"
          />
        )}
        {showUnread && <span className={styles.srOnly}>unread</span>}
        <span className={styles.settledTitle}>{thread.title}</span>
        <span className={styles.settledSlug}>{slug}</span>
        <span className={styles.settledAge}>
          {formatRelativeAge(wrapUpAt, now)}
        </span>
      </div>
      {archived && onSetArchived ? (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.settleBtn}
            aria-label="Unarchive thread"
            title="Unarchive thread"
            data-unarchive-btn={thread.id}
            onClick={(e) => {
              e.stopPropagation();
              void onSetArchived(thread.id, false);
            }}
          >
            unarchive
          </button>
        </div>
      ) : pinMode && onSetPinned ? (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.settleBtn}
            aria-label="Unpin thread"
            title="Unpin thread"
            data-unpin-btn={thread.id}
            onClick={(e) => {
              e.stopPropagation();
              void onSetPinned(thread.id, false);
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 11 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1" />
            </svg>
          </button>
        </div>
      ) : onSetSettled ? (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.settleBtn}
            aria-label="Keep thread active"
            title="Keep thread active"
            onClick={(e) => {
              e.stopPropagation();
              void onSetSettled(thread.id, "active");
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 13.5v-10M4.5 6.5 8 3l3.5 3.5" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Slim snoozed shelf row: title + slug + wake label (shared formatter). */
export function SnoozedRow({
  thread,
  slug,
  active,
  now,
  onSelect,
  onSetSnoozed,
  onSetSettled,
  multiSelected = false,
  indexHint = null,
}: {
  thread: ThreadInfo;
  slug: string;
  active: boolean;
  now: number;
  onSelect: (id: string, opts?: SelectOpts) => void;
  onSetSnoozed?: (threadId: string, until: number | null) => void | Promise<void>;
  onSetSettled?: (
    threadId: string,
    override: "settled" | "active",
  ) => void | Promise<void>;
  multiSelected?: boolean;
  indexHint?: number | null;
}) {
  const showUnread = !active && isUnread(thread);
  const wake = formatSnoozeWakeLabel(thread, now);
  const selectLabel = showUnread
    ? `Select thread: ${thread.title}, unread`
    : `Select thread: ${thread.title}`;
  return (
    <div
      className={styles.settledRow}
      data-thread-card={thread.id}
      data-snoozed="true"
      data-active={active}
      data-multi={multiSelected ? "true" : undefined}
      data-unread={showUnread ? "true" : undefined}
    >
      {indexHint != null && (
        <span className={styles.indexHint} data-index-hint={indexHint} aria-hidden>
          {indexHint}
        </span>
      )}
      <button
        type="button"
        className={styles.cardSelect}
        onClick={(e) =>
          onSelect(thread.id, {
            meta: e.metaKey || e.ctrlKey,
            shift: e.shiftKey,
          })
        }
        aria-label={selectLabel}
      />
      <div className={styles.settledBody}>
        {showUnread && (
          <span
            className={styles.unreadDot}
            data-unread-dot={thread.id}
            aria-hidden="true"
          />
        )}
        {showUnread && <span className={styles.srOnly}>unread</span>}
        <span className={styles.settledTitle}>{thread.title}</span>
        <span className={styles.settledSlug}>{slug}</span>
        <span className={styles.settledAge} data-wake-label={thread.id}>
          {wake}
        </span>
      </div>
      {(onSetSnoozed || onSetSettled) && (
        <div className={styles.cardActions}>
          {onSetSettled && thread.status !== "working" && (
            <button
              type="button"
              className={styles.settleBtn}
              aria-label="Settle thread"
              title="Settle thread"
              data-snooze-settle-btn={thread.id}
              onClick={(e) => {
                e.stopPropagation();
                void onSetSettled(thread.id, "settled");
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 2.5v10M4.5 9.5 8 13l3.5-3.5" />
              </svg>
            </button>
          )}
          {onSetSnoozed && (
            <button
              type="button"
              className={styles.settleBtn}
              aria-label="Clear snooze"
              title="Clear snooze"
              data-snooze-clear-btn={thread.id}
              data-snooze-clear=""
              onClick={(e) => {
                e.stopPropagation();
                void onSetSnoozed(thread.id, null);
              }}
            >
              wake
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * memo'd: a streaming thread pushes an update every 700ms, and the sidebar
 * must only re-render when the LIST moved — not when the open transcript did
 * (issue #91). App keeps every prop stable for that to bite.
 */
export const Sidebar = memo(function Sidebar({
  appName,
  channel,
  updateState,
  searchPlaceholder,
  projectsHeader,
  projects,
  threads,
  providers,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onAddProject,
  onRemoveProject,
  onEditProject,
  projectError = null,
  onDismissProjectError,
  onOpenSettings,
  spendTodayUsd = null,
  dailyBudgetUsd = null,
  autoSettleAfterDays,
  autoSettleOnMerge,
  searchThreads,
  onSetSettled,
  onSetPinned,
  onSetSnoozed,
  onSetMuted,
  onRenameThread,
  onSetArchived,
  onClearSettled,
  onFork,
  activeView = "thread",
  onOpenKanban,
  onOpenPlanboard,
  onCreateThreadFromIssue,
  onOpenActivity,
  revealThreadId = null,
  onRevealHandled,
  conflictForecast = null,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /** Which thread's snooze preset menu is open (one at a time). */
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<string | null>(null);
  useEscapeClose(snoozeMenuFor != null, () => setSnoozeMenuFor(null));
  /** Project id whose thread-create menu (plain vs worktree) is open. */
  const [createMenuFor, setCreateMenuFor] = useState<string | null>(null);
  useEscapeClose(createMenuFor != null, () => setCreateMenuFor(null));
  useEffect(() => {
    if (snoozeMenuFor == null && createMenuFor == null) return;
    const onDoc = (e: MouseEvent) => {
      const el = e.target;
      if (!(el instanceof Element)) {
        setSnoozeMenuFor(null);
        setCreateMenuFor(null);
        return;
      }
      if (
        el.closest(
          "[data-snooze-menu], [data-snooze-submenu], [data-more-btn], [data-create-menu], [data-create-menu-btn]",
        )
      ) {
        return;
      }
      setSnoozeMenuFor(null);
      setCreateMenuFor(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("click", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("click", onDoc);
    };
  }, [snoozeMenuFor, createMenuFor]);
  /** Project id whose "from GitHub issue" form is open. */
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
  /**
   * Project pending the destructive remove confirm. Confirm is a dialog, not
   * an archive-style undo toast: history deletion is irreversible.
   */
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  /** True while projects.remove is in flight; disables the confirm button. */
  const [removePending, setRemovePending] = useState(false);
  /**
   * Group keys fully expanded past GROUP_ATTENTION_CAP (session-only, like
   * session-only). Absent = capped at the newest 8 attention threads.
   */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  /** Group keys the user collapsed. Survives restarts: collapsing a noisy
   *  project is a lasting choice, not a per-session whim. */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    loadKeySet(COLLAPSED_KEY),
  );
  /**
   * Global settled tail open state. t3 default: EXPANDED — settled work stays
   * visible and the settle transition is seen. A user collapse persists like
   * group collapse (SETTLED_COLLAPSED_KEY holds "tail"; absent = expanded).
   */
  const [settledTailOpen, setSettledTailOpen] = useState(
    () => !loadKeySet(SETTLED_COLLAPSED_KEY).has("tail"),
  );
  /** How many settled rows to show when the tail is expanded. */
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    SETTLED_TAIL_INITIAL_COUNT,
  );
  /** Multi-select set (round 46). Distinct from activeThreadId. */
  const [multiSelected, setMultiSelected] = useState<Set<string>>(() => new Set());
  /** Anchor for shift-range (last plain select or meta toggle). */
  const [selectAnchor, setSelectAnchor] = useState<string | null>(null);
  const [batchFeedback, setBatchFeedback] = useState<string | null>(null);
  const [cmdHeld, setCmdHeld] = useState(false);
  const [keyboardSheetOpen, setKeyboardSheetOpen] = useState(false);
  /**
   * Contract: null disables inactivity settle; while settings are still
   * loading (prop undefined) fall back to AUTO_SETTLE_AFTER_DAYS (3).
   */
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
  // Reuse the previous Map when the id→title mapping is unchanged: `threads`
  // gets a new identity every 700ms stream tick, and a fresh Map here would
  // bust ThreadCard's memo for every card on every tick.
  const threadTitlesRef = useRef<Map<string, string>>(new Map());
  const threadTitles = useMemo(() => {
    const prev = threadTitlesRef.current;
    let same = prev.size === threads.length;
    if (same) {
      for (const t of threads) {
        if (prev.get(t.id) !== t.title) {
          same = false;
          break;
        }
      }
    }
    if (same) return prev;
    const titles = new Map<string, string>();
    for (const t of threads) titles.set(t.id, t.title);
    threadTitlesRef.current = titles;
    return titles;
  }, [threads]);
  /** Full-content search results; null means not in active search mode. */
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

  // One shared interval for the whole list (age + working elapsed).
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

  /**
   * Live delegated work per parent thread (issue #42). Built from the FULL
   * threads prop, never the filtered view: a worker hidden by search or by a
   * collapsed group still has its orchestrator waiting on it.
   */
  const waitStates = useMemo(() => buildWaitStates(threads), [threads]);

  const trimmedQuery = query.trim();
  /** Active full-content search mode (2+ chars). */
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

  // Debounced full-content search for 2+ chars; 0–1 char restores local view.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_SEARCH_LEN) {
      // Instant restore: bump gen so in-flight results are ignored.
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

  /**
   * Threads shown in the list: normal view uses full list; search mode uses
   * server results with live status overlaid from the threads prop. While
   * waiting for the first response, show nothing (loading hint covers it).
   */
  const displayThreads = useMemo(() => {
    if (!searching) return threads;
    if (searchResults == null) return [];
    return searchResults.map((t) => liveById.get(t.id) ?? t);
  }, [searching, searchResults, threads, liveById]);

  const { attentionThreads, later } = useMemo(
    () => partitionSidebar(displayThreads, settleOpts),
    [displayThreads, settleOpts],
  );
  /** Later shelf render order: snoozed, settled, archived (#567). */
  const laterThreads = useMemo(() => flattenLater(later), [later]);
  const snoozedIds = useMemo(
    () => new Set(later.snoozed.map((t) => t.id)),
    [later],
  );

  /**
   * Project groups for the main list.
   * Normal view: attention only (pinned sort first; snooze/settle/archive
   * live on the Later shelf). Search: full hit list, so hits surface inline.
   */
  const groups = useMemo(() => {
    if (searching) {
      const projectsWithHits = projects.filter((p) =>
        displayThreads.some((t) => t.projectId === p.id),
      );
      return buildSidebarGroups(projectsWithHits, displayThreads);
    }
    return buildSidebarGroups(projects, attentionThreads);
  }, [projects, displayThreads, searching, attentionThreads]);

  const toggleCollapsed = (groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      saveKeySet(COLLAPSED_KEY, next);
      return next;
    });
  };

  /**
   * Reveal a freshly created thread (t3: new work must be visible). Expand
   * its project group when collapsed, then next frame — once the expanded
   * group has rendered the card — scroll it into view and flash a highlight.
   * Runs on create only; it never touches selection or the carve-out logic.
   */
  useEffect(() => {
    if (!revealThreadId) return;
    const target = threads.find((t) => t.id === revealThreadId);
    if (target) {
      setCollapsedGroups((prev) => {
        if (!prev.has(target.projectId)) return prev;
        const next = new Set(prev);
        next.delete(target.projectId);
        saveKeySet(COLLAPSED_KEY, next);
        return next;
      });
      // No cleanup: the lookup is null-safe if the row left before the frame.
      window.requestAnimationFrame(() => {
        const el = document.querySelector(
          `[data-thread-card="${revealThreadId}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
        el?.classList.add(styles.reveal);
      });
    }
    onRevealHandled?.();
  }, [revealThreadId, threads, projects, onRevealHandled]);

  /**
   * Keys for every project group currently rendered. Collapse-all / expand-all
   * and the ALL PROJECTS aria-expanded state are derived from this list.
   */
  const allGroupKeys = useMemo(
    () =>
      groups.map(
        ({ project, threads: groupThreads }) =>
          project?.id ?? groupThreads[0]?.projectId ?? "orphan",
      ),
    [groups],
  );

  /** Shared render + click predicate (see anyGroupExpandedState). */
  const anyGroupExpanded = anyGroupExpandedState(
    allGroupKeys,
    collapsedGroups,
    searching,
  );

  /**
   * ALL PROJECTS header: if any group is expanded → collapse every group
   * (persist all keys); if all are collapsed → expand all (clear the set).
   * Replaces the old projectsOpen section-hide toggle.
   */
  const toggleCollapseAll = () => {
    setCollapsedGroups((prev) => {
      // Same predicate as aria-expanded / title — never branch on a second
      // copy that omits `searching` (that cleared the set mid-search).
      const anyExpanded = anyGroupExpandedState(
        allGroupKeys,
        prev,
        searching,
      );
      const next = anyExpanded
        ? (() => {
            const s = new Set(prev);
            for (const k of allGroupKeys) s.add(k);
            return s;
          })()
        : new Set<string>();
      saveKeySet(COLLAPSED_KEY, next);
      return next;
    });
  };

  const toggleSettledTail = () => {
    setSettledTailOpen((open) => {
      saveKeySet(SETTLED_COLLAPSED_KEY, open ? new Set(["tail"]) : new Set());
      if (open) {
        // Collapse: reset paging so the next open starts at the initial page.
        setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
      }
      return !open;
    });
  };

  const toggleGroupExpanded = (groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const canCreate = projects.length > 0;
  /**
   * Project the global + targets (mirrors useCoder's selectedProjectId):
   * the selected thread's project, else the first project. Names the button.
   */
  const createTargetProject = (() => {
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
  const sectionCount = searching ? displayThreads.length : projects.length;
  /** Debounce window or in-flight request: show subtle "Searching…" hint. */
  const searchInFlight = searching && (searchLoading || searchResults == null);
  /** Search finished with zero hits (not still loading the first response). */
  const searchEmpty =
    searching &&
    !searchInFlight &&
    searchResults != null &&
    searchResults.length === 0;

  // Carve-out: the open thread must never vanish behind a collapsed shelf.
  const selectedLater =
    !searching &&
    !settledTailOpen &&
    activeThreadId != null
      ? laterThreads.find((t) => t.id === activeThreadId) ?? null
      : null;

  const visibleLater = settledTailOpen
    ? laterThreads.slice(0, settledVisibleCount)
    : [];
  const laterHasMore =
    settledTailOpen && laterThreads.length > settledVisibleCount;

  const slugFor = (t: ThreadInfo) =>
    projectById.get(t.projectId)?.slug ?? "unknown";

  /** One Later row: snoozed → wake row, archived → dim unarchive row,
   *  settled → keep-active row. Shared by the list and the carve-out. */
  const renderLaterRow = (thread: ThreadInfo, activeOverride = false) =>
    snoozedIds.has(thread.id) ? (
      <SnoozedRow
        key={`${thread.id}:slim`}
        thread={thread}
        slug={slugFor(thread)}
        active={activeOverride || thread.id === activeThreadId}
        multiSelected={multiSelected.has(thread.id)}
        indexHint={indexHintFor(thread.id)}
        now={now}
        onSelect={handleSelect}
        onSetSnoozed={onSetSnoozed}
        onSetSettled={onSetSettled}
      />
    ) : (
      <SettledRow
        key={`${thread.id}:slim`}
        thread={thread}
        slug={slugFor(thread)}
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

  /** Ordered visible ids — matches render order (round 46). */
  const visibleIds = useMemo(
    () =>
      buildVisibleThreadIds({
        groups,
        collapsedGroupKeys: searching ? new Set() : collapsedGroups,
        expandedGroupKeys: searching ? new Set() : expandedGroups,
        keepThreadIds: [activeThreadId, revealThreadId ?? null],
        later: laterThreads,
        laterOpen: settledTailOpen,
        laterVisibleCount: settledVisibleCount,
        selectedLaterId: selectedLater?.id ?? null,
        searching,
      }),
    [
      searching,
      groups,
      collapsedGroups,
      expandedGroups,
      activeThreadId,
      revealThreadId,
      laterThreads,
      settledTailOpen,
      settledVisibleCount,
      selectedLater,
    ],
  );

  const visibleIndex = useMemo(() => {
    const m = new Map<string, number>();
    visibleIds.forEach((id, i) => m.set(id, i));
    return m;
  }, [visibleIds]);

  // Refs so handleSelect stays identity-stable across stream ticks: visibleIds
  // is rebuilt whenever `threads` changes (every 700ms during a run), and a
  // fresh handleSelect would bust ThreadCard's memo for every card.
  const visibleIdsRef = useRef(visibleIds);
  const selectAnchorRef = useRef(selectAnchor);
  useEffect(() => {
    visibleIdsRef.current = visibleIds;
    selectAnchorRef.current = selectAnchor;
  });

  const handleSelect = useCallback(
    (id: string, opts?: SelectOpts) => {
      if (opts?.shift) {
        const range = rangeSelectIds(visibleIdsRef.current, selectAnchorRef.current, id);
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
    setBatchFeedback(
      ids.length === 1 ? "1 archived" : `${ids.length} archived`,
    );
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
    setBatchFeedback(
      formatBatchSettleFeedback(toSettle.length, skippedWorking),
    );
    setMultiSelected(new Set());
  }, [multiSelected, onSetSettled, threads]);

  /** Settle every attention thread (working ones skipped, same as batch settle). */
  const runSettleAll = useCallback(async () => {
    if (!onSetSettled || attentionThreads.length === 0) return;
    // Pinned rows stay Active even with a settled override — skip them.
    const settleable = attentionThreads.filter((t) => !isPinned(t));
    const { toSettle, skippedWorking } = planBatchSettle(
      settleable.map((t) => t.id),
      new Map(settleable.map((t) => [t.id, t])),
    );
    for (const id of toSettle) {
      await onSetSettled(id, "settled");
    }
    setBatchFeedback(
      formatBatchSettleFeedback(toSettle.length, skippedWorking),
    );
  }, [attentionThreads, onSetSettled]);

  /** Always the open thread's project, else the first project. */
  const createInTargetProject = useCallback(() => {
    if (!createTargetProject) return;
    onCreateThread(createTargetProject.id);
  }, [createTargetProject, onCreateThread]);

  /**
   * Brand-row + and ⌘N. Until #443's picker lands this is the same as
   * createInTargetProject; after that, several projects open the picker.
   */
  const handleBrandCreate = useCallback(() => {
    createInTargetProject();
  }, [createInTargetProject]);

  // Jump shortcuts + new-thread chords + cmd index hints + keyboard sheet.
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

      // cmd+1..9
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

      // cmd+j / cmd+k — next / previous (wrap)
      const key = e.key.toLowerCase();
      if (key === "j" || key === "k") {
        e.preventDefault();
        const delta = key === "j" ? 1 : -1;
        const next = stepVisibleId(visibleIds, activeThreadId, delta as 1 | -1);
        if (next) {
          setMultiSelected(new Set());
          setSelectAnchor(next);
          onSelectThread(next);
        }
        return;
      }

      // cmd+n: same as brand-row +. cmd+shift+n: always createTargetProject.
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

  const renderGroupCreateActions = (project: ProjectInfo) => {
    const open = issueFormFor === project.id;
    const createOpen = createMenuFor === project.id;
    // Worktree threads are local-only (electron/worktrees.js); remote
    // projects get the plain button without the caret.
    const remote = Boolean(project.remoteHost);
    return (
      <div className={styles.groupThreadActions}>
        <div className={styles.snoozeWrap}>
          <button
            type="button"
            className={styles.groupNewThread}
            onClick={() => onCreateThread(project.id)}
          >
            New thread
          </button>
          {!remote && (
            <button
              type="button"
              className={styles.groupIssueBtn}
              title="Thread options"
              aria-label="Thread options"
              aria-haspopup="menu"
              aria-expanded={createOpen}
              data-create-menu-btn={project.id}
              onClick={() => setCreateMenuFor(createOpen ? null : project.id)}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M4 6.5 8 10.5 12 6.5" />
              </svg>
            </button>
          )}
          {createOpen && !remote && (
            <div
              className={`${styles.snoozeMenu} ${styles.snoozeMenuLeft}`}
              role="menu"
              data-create-menu={project.id}
            >
              <button
                type="button"
                className={styles.snoozeMenuItem}
                role="menuitem"
                data-create-worktree-thread={project.id}
                title="New thread in an isolated git worktree + branch"
                onClick={() => {
                  setCreateMenuFor(null);
                  onCreateThread(project.id, { worktree: true });
                }}
              >
                New worktree thread
              </button>
              <button
                type="button"
                className={styles.snoozeMenuItem}
                role="menuitem"
                data-create-orchestrator-thread={project.id}
                title="New thread that hands its first prompt to a worker in its own worktree"
                onClick={() => {
                  setCreateMenuFor(null);
                  onCreateThread(project.id, { orchestrate: true });
                }}
              >
                New orchestrator thread
              </button>
              <button
                type="button"
                className={styles.snoozeMenuItem}
                role="menuitem"
                data-create-plain-thread={project.id}
                title="New thread directly in the project checkout (no worktree)"
                onClick={() => {
                  setCreateMenuFor(null);
                  onCreateThread(project.id, { worktree: false });
                }}
              >
                New plain thread
              </button>
              <button
                type="button"
                className={styles.snoozeMenuItem}
                role="menuitem"
                data-create-teach-thread={project.id}
                title="New thread that teaches: hints, TODO(human) markers, reviews your code"
                onClick={() => {
                  setCreateMenuFor(null);
                  onCreateThread(project.id, { worktree: true, teach: true });
                }}
              >
                New teach thread
              </button>
              <button
                type="button"
                className={styles.snoozeMenuItem}
                role="menuitem"
                data-create-ask-thread={project.id}
                title="New read-only Ask thread: repo Q&A from the index and memory, no worktree"
                onClick={() => {
                  setCreateMenuFor(null);
                  onCreateThread(project.id, { ask: true });
                }}
              >
                New ask thread
              </button>
            </div>
          )}
        </div>
        {onCreateThreadFromIssue && (
          <button
            type="button"
            className={styles.groupIssueBtn}
            title="New thread from GitHub issue"
            aria-label="New thread from GitHub issue"
            data-issue-thread-btn={project.id}
            onClick={() => {
              if (open) closeIssueForm();
              else openIssueForm(project.id);
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="8" cy="8" r="6.25" />
              <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
            </svg>
          </button>
        )}
      </div>
    );
  };

  const renderGroupIssueForm = (project: ProjectInfo) => {
    if (issueFormFor !== project.id || !onCreateThreadFromIssue) return null;
    return (
      <form
        className={styles.groupIssueForm}
        data-issue-form={project.id}
        onSubmit={(e) => {
          e.preventDefault();
          submitIssueForm(project);
        }}
      >
        <input
          className={styles.groupIssueInput}
          type="text"
          value={issueRef}
          onChange={(e) => setIssueRef(e.target.value)}
          placeholder="https://github.com/owner/repo/issues/123"
          aria-label="GitHub issue URL or reference"
          data-issue-input={project.id}
          disabled={issuePending}
          autoComplete="off"
          spellCheck={false}
        />
        {issueError && (
          <p
            className={styles.groupIssueError}
            role="alert"
            data-issue-error={project.id}
          >
            {issueError}
          </p>
        )}
        <div className={styles.groupIssueActions}>
          <button
            type="submit"
            className={styles.groupIssueCreate}
            data-issue-create={project.id}
            disabled={issuePending || issueRef.trim() === ""}
            aria-busy={issuePending || undefined}
          >
            {issuePending ? (
              <>
                <span className={styles.spinner} aria-hidden />
                Creating…
              </>
            ) : (
              "Create"
            )}
          </button>
          <button
            type="button"
            className={styles.groupIssueCancel}
            data-issue-cancel={project.id}
            disabled={issuePending}
            onClick={closeIssueForm}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  };

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
          {channel === "nightly" && (
            <span className={styles.brandChannel}>nightly</span>
          )}
        </div>
        <button
          type="button"
          className={styles.headerAdd}
          onClick={handleBrandCreate}
          disabled={!canCreate}
          title={
            canCreate
              ? createTargetLabel
              : "Add a project before creating a thread"
          }
          aria-label={createTargetLabel}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M8 3.25v9.5M3.25 8h9.5" />
          </svg>
        </button>
      </header>

      <div className={styles.searchRow}>
        <span className={styles.searchIcon} aria-hidden>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="7" cy="7" r="4.25" />
            <path d="m10.25 10.25 3 3" />
          </svg>
        </span>
        <input
          className={styles.searchInput}
          type="search"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search threads"
        />
      </div>

      <nav className={styles.viewNav} aria-label="Views">
        <button
          type="button"
          className={styles.viewNavRow}
          data-view-nav="activity"
          data-active={activeView === "activity" ? "true" : undefined}
          title="Activity"
          onClick={() => onOpenActivity?.()}
        >
          <span className={styles.viewNavIcon} aria-hidden>
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M1.75 8h2.5l1.75-3.5 2.5 7 1.75-3.5h2.5" />
            </svg>
          </span>
          Activity
        </button>
        <button
          type="button"
          className={styles.viewNavRow}
          data-view-nav="kanban"
          data-active={activeView === "kanban" ? "true" : undefined}
          title="Kanban"
          onClick={() => onOpenKanban?.()}
        >
          <span className={styles.viewNavIcon} aria-hidden>
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="1.75" y="2.75" width="3.5" height="10.5" rx="1" />
              <rect x="6.25" y="2.75" width="3.5" height="7" rx="1" />
              <rect x="10.75" y="2.75" width="3.5" height="4.5" rx="1" />
            </svg>
          </span>
          Kanban
        </button>
        <button
          type="button"
          className={styles.viewNavRow}
          data-view-nav="planboard"
          data-active={activeView === "planboard" ? "true" : undefined}
          title="Planboard"
          onClick={() => onOpenPlanboard?.()}
        >
          <span className={styles.viewNavIcon} aria-hidden>
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="1.5" />
              <path d="M4.75 5.25h6.5" />
              <path d="M4.75 8h4.5" />
              <path d="M4.75 10.75h2.5" />
            </svg>
          </span>
          Planboard
        </button>
      </nav>

      <div className={styles.sectionHeaderRow}>
        <button
          type="button"
          className={styles.sectionHeader}
          onClick={toggleCollapseAll}
          aria-expanded={anyGroupExpanded}
          title={
            anyGroupExpanded ? "Collapse all projects" : "Expand all projects"
          }
          data-projects-section=""
        >
          <span
            className={styles.chevron}
            data-open={anyGroupExpanded}
            aria-hidden="true"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 3.5 4.5 4.5L6 12.5" />
            </svg>
          </span>
          <span>{projectsHeader}</span>
          <span className={styles.count}>{sectionCount}</span>
        </button>
      </div>

      <div className={styles.list} data-sidebar-list="">
        {projects.length === 0 && (
          <button
            type="button"
            className={styles.addProjectRow}
            onClick={onAddProject}
          >
            Add project
          </button>
        )}

        {searchInFlight && (
          <p className={styles.searchHint} aria-live="polite">
            Searching…
          </p>
        )}

        {projects.length > 0 && searchEmpty && (
          <p className={styles.emptySearch}>No threads match</p>
        )}

        {groups.map(({ project, threads: groupThreads }) => {
                  const groupKey =
                    project?.id ?? groupThreads[0]?.projectId ?? "orphan";
                  const slug =
                    project?.slug ??
                    (groupThreads[0]
                      ? projectById.get(groupThreads[0].projectId)?.slug
                      : undefined) ??
                    "unknown";
                  // Attention only in normal view (Later is global); search shows all.
                  const attentionThreads = groupThreads.filter((t) => !t.archived);
                  // Search surfaces archived hits inline; normal view keeps
                  // them on the Later shelf (#567).
                  const archivedThreads = searching
                    ? groupThreads.filter((t) => t.archived)
                    : [];
                  // A fork indents only when its source row renders in the same
                  // sublist (buildSidebarGroups already placed it right below).
                  const attentionIdSet = new Set(attentionThreads.map((t) => t.id));
                  const archivedIdSet = new Set(archivedThreads.map((t) => t.id));
                  const hasAnyThreads = groupThreads.length > 0;
                  // A project whose every thread sits on the Later shelf has zero
                  // rows here — "No threads yet" would be a lie.
                  const projectIdHere =
                    project?.id ?? groupThreads[0]?.projectId ?? "";
                  const laterInProject = laterThreads.filter(
                    (t) => t.projectId === projectIdHere,
                  ).length;
                  // A collapsed project shows only its header. Search overrides the
                  // collapse: hiding hits inside a collapsed group makes results lie.
                  const collapsed = !searching && collapsedGroups.has(groupKey);
                  // Overflow cap (issue #70): a group renders its newest
                  // GROUP_ATTENTION_CAP attention threads; the rest hide behind a
                  // session-only "Show more". Search bypasses the cap like every
                  // other collapse. The active/revealed thread never vanishes.
                  const groupCapped = !searching && !expandedGroups.has(groupKey);
                  const visibleCount = visibleAttentionCount(attentionThreads, {
                    capped: groupCapped,
                    keepIds: [activeThreadId, revealThreadId ?? null],
                  });
                  const visibleAttention = attentionThreads.slice(0, visibleCount);
                  const showOverflowToggle =
                    !searching && attentionThreads.length > GROUP_ATTENTION_CAP;

                  return (
                    <div key={groupKey} className={styles.group} ref={attachListAnimation}>
                      <div className={styles.groupHeaderRow}>
                        <button
                          type="button"
                          className={styles.groupHeader}
                          onClick={() => toggleCollapsed(groupKey)}
                          aria-expanded={!collapsed}
                          title={collapsed ? "Expand project" : "Collapse project"}
                        >
                          <span
                            className={styles.chevron}
                            data-open={!collapsed}
                            data-group-chevron={groupKey}
                            aria-hidden="true"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="m6 3.5 4.5 4.5L6 12.5" />
                            </svg>
                          </span>
                          <span className={styles.groupSlug}>{slug}</span>
                          <span className={styles.groupCount}>
                            {searching
                              ? groupThreads.length
                              : attentionThreads.length}
                          </span>
                        </button>
                        {/*
                          Remove is a sibling of the collapse control — separately
                          focusable, not nested inside it — so keyboard users can
                          reach it without toggling the group.
                        */}
                        {project && onEditProject && !searching && (
                          <button
                            type="button"
                            className={styles.groupRemove}
                            aria-label={`Edit project ${slug}`}
                            title="Edit project"
                            data-project-edit={project.id}
                            onClick={() => onEditProject(project.id)}
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M11.3 2.7a1.4 1.4 0 0 1 2 2L5 13H3v-2l8.3-8.3Z" />
                            </svg>
                          </button>
                        )}
                        {project && onRemoveProject && !searching && (
                          <button
                            type="button"
                            className={styles.groupRemove}
                            aria-label={`Remove project ${slug}`}
                            title="Remove project"
                            data-project-remove={project.id}
                            onClick={() => setRemoveConfirmId(project.id)}
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              aria-hidden="true"
                            >
                              <path d="m4 4 8 8M12 4l-8 8" />
                            </svg>
                          </button>
                        )}
                      </div>

                      {collapsed ? null : !hasAnyThreads ? (
                        <>
                          <div className={styles.emptyGroup}>
                            <span className={styles.emptyThreads}>
                              {laterInProject > 0 ? "Nothing active" : "No threads yet"}
                            </span>
                            {project && !searching && renderGroupCreateActions(project)}
                          </div>
                          {project && !searching && renderGroupIssueForm(project)}
                        </>
                      ) : (
                        <>
                          {/*
                            t3 key rule: rows key by id + variant (:card in groups,
                            :slim on shelves) so a settle/unsettle move unmounts and
                            remounts — auto-animate cross-fades instead of sliding
                            one element across lists.
                          */}
                          {visibleAttention.map((thread) => (
                            <Fragment key={`${thread.id}:card`}>
                              <ThreadCard
                                thread={thread}
                                slug={slug}
                                showSlug={project == null}
                                providers={providers}
                                active={thread.id === activeThreadId}
                                multiSelected={multiSelected.has(thread.id)}
                                indexHint={indexHintFor(thread.id)}
                                now={now}
                                onSelect={handleSelect}
                                isSettled={
                                  searching
                                    ? effectiveSettled(thread, settleOpts)
                                    : false
                                }
                                onSetSettled={onSetSettled}
                                onSetPinned={onSetPinned}
                                onSetSnoozed={onSetSnoozed}
                                onSetMuted={onSetMuted}
                                onRenameThread={onRenameThread}
                                onFork={onFork}
                                snoozeMenuOpen={snoozeMenuFor === thread.id}
                                onToggleSnoozeMenu={setSnoozeMenuFor}
                                nested={
                                  thread.handoffFrom != null &&
                                  attentionIdSet.has(thread.handoffFrom)
                                }
                                wait={waitStates.get(thread.id) ?? null}
                                contentMatch={
                                  searching &&
                                  !thread.title.toLowerCase().includes(queryLower)
                                }
                                conflictForecast={conflictForecast}
                                threadTitles={threadTitles}
                              />
                              <SubagentRows
                                thread={thread}
                                onSelect={handleSelect}
                              />
                            </Fragment>
                          ))}
                          {showOverflowToggle && (
                            <button
                              type="button"
                              className={styles.settledShowMore}
                              data-group-overflow={groupKey}
                              onClick={() => toggleGroupExpanded(groupKey)}
                              aria-expanded={!groupCapped}
                            >
                              {groupCapped
                                ? `Show ${attentionThreads.length - visibleCount} more`
                                : "Show fewer"}
                            </button>
                          )}
                          {searching &&
                            archivedThreads.map((thread) => (
                              <Fragment key={`${thread.id}:card`}>
                                <ThreadCard
                                  thread={thread}
                                  slug={slug}
                                  showSlug={project == null}
                                  providers={providers}
                                  active={thread.id === activeThreadId}
                                  multiSelected={multiSelected.has(thread.id)}
                                  indexHint={indexHintFor(thread.id)}
                                  now={now}
                                  onSelect={handleSelect}
                                  isSettled={effectiveSettled(thread, settleOpts)}
                                  onSetSettled={onSetSettled}
                                  onFork={onFork}
                                  snoozeMenuOpen={snoozeMenuFor === thread.id}
                                  onToggleSnoozeMenu={setSnoozeMenuFor}
                                  nested={
                                    thread.handoffFrom != null &&
                                    archivedIdSet.has(thread.handoffFrom)
                                  }
                                  wait={waitStates.get(thread.id) ?? null}
                                  contentMatch={
                                    searching &&
                                    !thread.title.toLowerCase().includes(queryLower)
                                  }
                                  conflictForecast={conflictForecast}
                                  threadTitles={threadTitles}
                                />
                                <SubagentRows
                                  thread={thread}
                                  onSelect={handleSelect}
                                />
                              </Fragment>
                            ))}
                          {project && !searching && (
                            <>
                              {renderGroupCreateActions(project)}
                              {renderGroupIssueForm(project)}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  );
        })}

        {/* Global LATER shelf (#567): the one "not now" zone — snoozed
            (wake soonest), then settled, then archived. Independent of
            per-project collapse — has its own toggle. */}
        {!searching && laterThreads.length > 0 && (
          <div
            className={styles.settledTail}
            data-later-shelf=""
            ref={attachListAnimation}
          >
            {selectedLater && renderLaterRow(selectedLater, true)}
            <div className={styles.settledTailBar}>
              <button
                type="button"
                className={styles.settledTailHeader}
                onClick={toggleSettledTail}
                aria-expanded={settledTailOpen}
              >
                <span className={styles.chevron} data-open={settledTailOpen}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m6 3.5 4.5 4.5L6 12.5" />
                  </svg>
                </span>
                <span>
                  Later · {laterThreads.length}
                  {(() => {
                    const n = countUnread(laterThreads);
                    return n > 0 ? ` · ${n} unread` : "";
                  })()}
                </span>
              </button>
              {onSetSettled && attentionThreads.length > 0 && (
                <button
                  type="button"
                  className={styles.settledClear}
                  data-settle-all=""
                  aria-label="Settle all threads"
                  title="Settle every attention thread (running and pinned skipped)"
                  onClick={() => void runSettleAll()}
                >
                  Settle all
                </button>
              )}
              {onClearSettled && later.settled.length > 0 && (
                <button
                  type="button"
                  className={styles.settledClear}
                  data-settled-clear-all=""
                  aria-label="Clear settled threads"
                  title="Archive all settled threads (undoable)"
                  onClick={() =>
                    void onClearSettled(later.settled.map((t) => t.id))
                  }
                >
                  Clear
                </button>
              )}
            </div>
            {settledTailOpen &&
              visibleLater.map((thread) => renderLaterRow(thread))}
            {laterHasMore && (
              <button
                type="button"
                className={styles.settledShowMore}
                onClick={() =>
                  setSettledVisibleCount(
                    (n) => n + SETTLED_TAIL_PAGE_COUNT,
                  )
                }
              >
                Show more
              </button>
            )}
          </div>
        )}
      </div>

      {removeConfirmId &&
        (() => {
          const confirmProject = projectById.get(removeConfirmId);
          if (!confirmProject) return null;
          // Real count: every thread the project owns (attention + archived +
          // settled), not the attention-only header badge.
          const count = threads.filter(
            (t) => t.projectId === confirmProject.id,
          ).length;
          const threadWord = count === 1 ? "thread" : "threads";
          // t3 LegacySidebar copy: title names project + count; body has path
          // and the two load-bearing sentences about history vs entry-only.
          const title = `Remove project ${confirmProject.slug} and delete its ${count} ${threadWord}?`;
          const closeConfirm = () => {
            if (removePending) return;
            setRemoveConfirmId(null);
          };
          return (
            <div
              className={styles.removeConfirmOverlay}
              role="presentation"
              onClick={closeConfirm}
            >
              <div
                className={styles.removeConfirm}
                role="dialog"
                aria-modal="true"
                aria-labelledby="remove-project-title"
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
                    onClick={closeConfirm}
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
        <div className={styles.batchBar} data-batch-bar="" data-batch-feedback-only="">
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
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        )}
        {spendTodayUsd != null && (
          <div
            className={styles.spendMeter}
            data-tone={spendMeterTone(spendTodayUsd, dailyBudgetUsd)}
            title="Spend today across all providers"
          >
            {spendMeterLabel(spendTodayUsd, dailyBudgetUsd)}
          </div>
        )}
        <div className={styles.footerRow}>
          <button
            type="button"
            className={styles.settings}
            title={
              updateState === "available"
                ? "Update available"
                : updateState === "staged"
                  ? "Update ready — restart to apply"
                  : undefined
            }
            aria-label={
              updateState === "available"
                ? "Settings. Update available"
                : updateState === "staged"
                  ? "Settings. Update ready — restart to apply"
                  : undefined
            }
            onClick={() => onOpenSettings?.()}
          >
            <span className={styles.settingsIcon} aria-hidden>
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </span>
            Settings
            {(updateState === "available" || updateState === "staged") && (
              <span className={styles.settingsDot} aria-hidden />
            )}
          </button>
          {projects.length > 0 && (
            <button
              type="button"
              className={styles.footerAdd}
              onClick={onAddProject}
              title="Add project"
              aria-label="Add project"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M8 3.25v9.5M3.25 8h9.5" />
              </svg>
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
