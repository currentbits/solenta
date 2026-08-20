import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
import { buildFlatSidebar } from "../sidebarGroups";
import { showContextMenu } from "../contextMenu";
import { buildThreadActionMenuItems } from "../threadActionMenu";
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
import { isUnread } from "../threadUnread";
import {
  buildWaitStates,
  isDelegating,
  subagentNames,
  waitLabel,
  waitTooltip,
  type WaitState,
} from "../waiting";
import { useEscapeClose } from "../useEscapeClose";
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
import styles from "./Sidebar.module.css";

const TICK_MS = 5000;
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;
const SCOPE_KEY = "sidebar:projectScope";
const SNOOZED_OPEN_KEY = "sidebar:snoozedOpen";
const SETTLED_OPEN_KEY = "sidebar:settledOpen";

/**
 * t3 list animation: rows glide on lifecycle transitions instead of the
 * sidebar jumping. Attached per list container via ref callback; no-ops
 * where ResizeObserver is missing (jsdom).
 */
function attachListAnimation(node: HTMLElement | null): void {
  if (node) autoAnimate(node, { duration: 150, easing: "ease-out" });
}

function loadStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveStored(key: string, value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Quota/private mode: UI state just stops persisting.
  }
}

function loadFlag(key: string, fallback: boolean): boolean {
  const raw = loadStored(key);
  if (raw == null) return fallback;
  return raw === "1" || raw === "true";
}

function saveFlag(key: string, value: boolean): void {
  saveStored(key, value ? "1" : "0");
}

function Icon({
  children,
  size = 14,
}: {
  children: ReactNode;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
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
  onOpenKanban?: (scopedProjectId?: string | null) => void;
  onOpenPlanboard?: (scopedProjectId?: string | null) => void;
  /**
   * Paste a GitHub issue into this project. Omitted by existing tests so
   * the icon button stays hidden.
   */
  onCreateThreadFromIssue?: (input: {
    projectId: string;
    projectPath: string;
    ref: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
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

export type SelectOpts = { meta?: boolean; shift?: boolean };

/**
 * t3 flatten (#566): the row's whole status vocabulary is one label.
 * Precedence lives in statusDotFor; the card maps that onto colored text.
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

export type StatusLabelInfo = {
  text: string;
  tone: "working" | "attention" | "failed" | "done" | "queued";
  title: string;
  spoken: string;
  flags: Record<string, string>;
};

export function statusDotFor(
  thread: ThreadInfo,
  now: number,
  wait: WaitState | null,
  active: boolean,
): StatusDotInfo | null {
  const base = baseStatusDot(thread, now, wait, active);
  // Queued follow-up (#92) rides along on whatever status is showing; it only
  // owns the row when the thread is otherwise idle.
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

/**
 * Card status slot: colored TEXT (no dot, no pill). Precedence matches
 * statusDotFor; unread done is the extra idle case the spec adds.
 */
export function statusLabelFor(
  thread: ThreadInfo,
  now: number,
  wait: WaitState | null,
  active: boolean,
): StatusLabelInfo | null {
  const dot = statusDotFor(thread, now, wait, active);
  if (thread.status === "failed") {
    return {
      text: "Failed",
      tone: "failed",
      title: dot?.label ?? "Failed",
      spoken: "failed",
      flags: dot?.flags ?? { "data-failed": thread.id },
    };
  }
  if (thread.status === "quota-wait") {
    return {
      text: "Quota",
      tone: "attention",
      title: dot?.label ?? "Quota",
      spoken: "needs attention",
      flags: dot?.flags ?? { "data-quota-wait": "" },
    };
  }
  if (thread.status === "working" && thread.awaitingInput) {
    return {
      text: "Waiting",
      tone: "attention",
      title: dot?.label ?? "Waiting for input",
      spoken: "needs attention",
      flags: dot?.flags ?? { "data-waiting": "" },
    };
  }
  if (thread.status === "working" && thread.stalledAt != null) {
    return {
      text: "Stalled",
      tone: "attention",
      title: dot?.label ?? "Stalled",
      spoken: "needs attention",
      flags: dot?.flags ?? { "data-stalled": "" },
    };
  }
  if (wait && wait.blocked > 0) {
    return {
      text: "Waiting",
      tone: "attention",
      title: dot?.label ?? waitTooltip(wait),
      spoken: "needs attention",
      flags: dot?.flags ?? {},
    };
  }
  if (thread.status === "working") {
    const elapsed =
      thread.runStartedAt != null
        ? formatElapsed(thread.runStartedAt, now)
        : "";
    return {
      text: elapsed ? `Working ${elapsed}` : "Working",
      tone: "working",
      title: dot?.label ?? "Working",
      spoken: "working",
      flags: dot?.flags ?? {},
    };
  }
  if (isDelegating(thread.status, wait)) {
    return {
      text: "Delegating",
      tone: "working",
      title: dot?.label ?? "Delegating",
      spoken: "delegating",
      flags: dot?.flags ?? { "data-delegating": thread.id },
    };
  }
  if (!active && showWokePill(thread, now)) {
    return {
      text: "Woke",
      tone: "attention",
      title: dot?.label ?? "Woke from snooze",
      spoken: "needs attention",
      flags: dot?.flags ?? { "data-woke": "" },
    };
  }
  // Queued follow-up (#92) owns the slot only when nothing louder does;
  // on a busy card it rides along in the tooltip via statusDotFor.
  if (thread.queued) {
    return {
      text: "Queued",
      tone: "queued",
      title: dot?.label ?? `Queued: ${thread.queued.prompt}`,
      spoken: "queued follow-up",
      flags: dot?.flags ?? { "data-queued-dot": thread.id },
    };
  }
  if (
    !active &&
    isUnread(thread) &&
    (thread.status === "done" || thread.status === "idle")
  ) {
    return {
      text: "Done",
      tone: "done",
      title: "Done",
      spoken: "unread",
      flags: {},
    };
  }
  return null;
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
        className={styles.forecast}
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

/**
 * Memo'd: during a run main pushes thread updates every 700ms and the parent
 * list re-renders each tick — without memo every visible card re-renders too.
 * Unchanged threads keep row identity (patchThreadList), so a shallow compare
 * skips them. Exported for Kanban and render tests.
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
  onSetMuted?: (threadId: string, muted: boolean) => void | Promise<void>;
  onRenameThread?: (threadId: string, title: string) => void | Promise<void>;
  onFork?: (
    threadId: string,
    opts?: { provider?: string },
  ) => void | Promise<void>;
  /** Parent bookkeeping: which card has its (native/portal) menu open. */
  onToggleSnoozeMenu?: (threadId: string | null) => void;
  nested?: boolean;
  wait?: WaitState | null;
  showSlug?: boolean;
  conflictForecast?: ConflictForecast | null;
  threadTitles?: ReadonlyMap<string, string>;
}) {
  const working = thread.status === "working";
  const settleOverride = isSettled ? ("active" as const) : ("settled" as const);
  const settleLabel = isSettled ? "Keep thread active" : "Settle thread";
  const showUnread = !active && isUnread(thread);
  const label = statusLabelFor(thread, now, wait, active);
  const pinned = isPinned(thread);
  const recede = working && !active && !multiSelected;
  const subagentLines = wait ? subagentNames(wait) : [];
  // Menus are native Menu.popup / a body portal (#592) — the card only
  // tracks openness so the hover actions stay pinned underneath.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBusy = useRef(false);
  const actionsOpen = menuOpen;
  const selectLabel = [
    `Select thread: ${thread.title}`,
    showUnread ? "unread" : null,
    pinned ? "pinned" : null,
    label ? label.spoken : null,
  ]
    .filter(Boolean)
    .join(", ");
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renamingRef = useRef(false);
  const forecastPairs = pairsForThread(conflictForecast, thread.id);
  const providerId = thread.provider || "";
  const hasLine3 =
    Boolean(thread.branch) ||
    (thread.prNumber != null && Boolean(thread.prUrl)) ||
    forecastPairs.length > 0 ||
    Boolean(providerId);

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

  const applyMenuId = (
    id: string,
    presets: ReturnType<typeof resolveSnoozePresets>,
  ) => {
    if (id === "settle") void onSetSettled?.(thread.id, "settled");
    else if (id === "unsettle") void onSetSettled?.(thread.id, "active");
    else if (id === "unsnooze") void onSetSnoozed?.(thread.id, null);
    else if (id.startsWith("snooze:")) {
      const preset = presets.find((p) => `snooze:${p.id}` === id);
      if (preset) void onSetSnoozed?.(thread.id, preset.until);
    } else if (id === "pin") void onSetPinned?.(thread.id, true);
    else if (id === "unpin") void onSetPinned?.(thread.id, false);
    else if (id === "fork") void onFork?.(thread.id);
    else if (id.startsWith("handoff:")) {
      void onFork?.(thread.id, { provider: id.slice("handoff:".length) });
    } else if (id === "rename") startRename();
    else if (id === "mute") void onSetMuted?.(thread.id, true);
    else if (id === "unmute") void onSetMuted?.(thread.id, false);
  };

  const openThreadMenu = async (position: { x: number; y: number }) => {
    if (menuBusy.current || renaming) return;
    const presets = resolveSnoozePresets(Date.now());
    const items = buildThreadActionMenuItems({
      thread,
      providers,
      snoozePresets: presets,
      isSettled,
      canSettle: !(working && !isSettled),
      showSnooze: Boolean(onSetSnoozed),
      showPin: Boolean(onSetPinned),
      showFork: Boolean(onFork),
      showRename: Boolean(onRenameThread),
      showMute: Boolean(onSetMuted),
      showSettle: Boolean(onSetSettled),
    });
    if (items.length === 0) return;
    menuBusy.current = true;
    setMenuOpen(true);
    onToggleSnoozeMenu?.(thread.id);
    try {
      const id = await showContextMenu(items, position);
      if (id) applyMenuId(id, presets);
    } finally {
      menuBusy.current = false;
      setMenuOpen(false);
      onToggleSnoozeMenu?.(null);
    }
  };

  const hasActions = Boolean(
    onSetSettled || onSetPinned || onSetSnoozed || onFork || onRenameThread || onSetMuted,
  );

  // Card is a non-interactive shell. Stretch select + hover actions are
  // separate focusables. Content sits in a sibling with pointer-events:none
  // so clicks fall through to select; PR <a> and actions re-enable.
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
      data-recede={recede ? "true" : undefined}
      data-actions-open={actionsOpen ? "true" : undefined}
      onContextMenu={(e) => {
        if (renaming) return;
        if ((e.target as HTMLElement).closest("input, a, textarea")) return;
        e.preventDefault();
        e.stopPropagation();
        void openThreadMenu({ x: e.clientX, y: e.clientY });
      }}
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
        onDoubleClick={(e) => {
          if (!onRenameThread) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          startRename();
        }}
        aria-label={selectLabel}
      />
      <div className={styles.cardBody}>
        <div className={styles.cardLine1}>
          {showSlug && (
            <span className={styles.cardSlug} data-card-slug="">
              {slug}
            </span>
          )}
          {pinned && (
            <span className={styles.pinFlag} data-pin-flag="" title="Pinned" aria-hidden>
              <Icon size={10}>
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1" />
              </Icon>
            </span>
          )}
          <span className={styles.cardSlot}>
            <span className={styles.cardStatus}>
              {label ? (
                <span
                  className={styles.statusLabel}
                  data-status-label={label.text}
                  data-tone={label.tone}
                  data-dim={
                    label.tone === "working" && !active ? "true" : undefined
                  }
                  title={label.title}
                  {...label.flags}
                >
                  {label.text}
                </span>
              ) : (
                <span className={styles.age}>
                  {formatRelativeAge(thread.updatedAt, now)}
                </span>
              )}
            </span>
            {hasActions && (
              <span className={styles.cardActions} data-card-actions="">
                {onSetSnoozed && (
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label={
                      thread.snoozedUntil != null
                        ? "Wake thread now"
                        : "Snooze thread"
                    }
                    title={thread.snoozedUntil != null ? "Wake" : "Snooze"}
                    aria-haspopup={
                      thread.snoozedUntil != null ? undefined : "menu"
                    }
                    data-snooze-btn={thread.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (thread.snoozedUntil != null) {
                        void onSetSnoozed(thread.id, null);
                        return;
                      }
                      if (menuBusy.current) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const presets = resolveSnoozePresets(Date.now());
                      menuBusy.current = true;
                      setMenuOpen(true);
                      onToggleSnoozeMenu?.(thread.id);
                      void showContextMenu(
                        presets.map((p) => ({
                          id: `snooze:${p.id}`,
                          label: p.label,
                          whenLabel: p.whenLabel,
                          attrs: { "data-snooze-preset": p.id },
                        })),
                        { x: rect.right, y: rect.bottom },
                      )
                        .then((id) => {
                          if (id) applyMenuId(id, presets);
                        })
                        .finally(() => {
                          menuBusy.current = false;
                          setMenuOpen(false);
                          onToggleSnoozeMenu?.(null);
                        });
                    }}
                  >
                    <Icon size={13}>
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 6v6l4 2" />
                    </Icon>
                  </button>
                )}
                {onSetSettled && (
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label={settleLabel}
                    title={
                      working && !isSettled
                        ? "Cannot settle while a run is active"
                        : settleLabel
                    }
                    data-settle-btn={thread.id}
                    disabled={working && !isSettled}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onSetSettled(thread.id, settleOverride);
                    }}
                  >
                    <Icon size={13}>
                      <path d="M20 6 9 17l-5-5" />
                    </Icon>
                  </button>
                )}
                {(onSetSnoozed || onFork || onRenameThread || onSetMuted || onSetSettled || onSetPinned) && (
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label={`Thread actions: ${thread.title}`}
                    title="Thread actions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    data-more-btn={thread.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      void openThreadMenu({ x: rect.right, y: rect.bottom });
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
                )}
              </span>
            )}
          </span>
        </div>
        <div className={styles.cardLine2}>
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
              onDoubleClick={(e) => e.stopPropagation()}
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
          {contentMatch && (
            <span className={styles.inMessagesTag}>in messages</span>
          )}
        </div>
        {hasLine3 && (
          <div className={styles.cardLine3}>
            {thread.branch ? (
              <span className={styles.cardBranch} data-card-branch="">
                {thread.branch}
              </span>
            ) : (
              <span className={styles.cardBranchSpacer} />
            )}
            {thread.prNumber != null && thread.prUrl && (
              <a
                className={styles.prLink}
                data-pr-badge=""
                href={thread.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                #{thread.prNumber}
              </a>
            )}
            <ConflictForecastBadge
              threadId={thread.id}
              forecast={conflictForecast}
              titles={threadTitles}
            />
            {providerId ? (
              <span className={styles.cardProvider} data-card-provider="">
                {providerId}
              </span>
            ) : null}
          </div>
        )}
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
        {/*
          Issue #542: name the running in-agent subagents under the wait row.
          Plain 11px lines inside cardBody — no elbow, no dot, no interactive
          child; cardBody is pointer-events:none, so a click falls through to
          the stretch-select button and picks the parent thread, same as the
          old nested rows did explicitly.
          ponytail: 3 lines then a "+N more" tail; if fan-outs routinely run
          wider, cap by card height instead of a count.
        */}
        {subagentLines.slice(0, 3).map((name, i) => (
          <div
            key={i}
            className={styles.subagentRow}
            data-subagent-row={thread.id}
            title={name}
          >
            {name}
          </div>
        ))}
        {subagentLines.length > 3 && (
          <div className={styles.subagentRow} data-subagent-row={thread.id}>
            +{subagentLines.length - 3} more
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * Slim shelf row: title + slug + time. Dimmed at rest, restored on hover.
 * Selectable; hover swaps time for the row's one action.
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
  const showUnread = !active && isUnread(thread);
  const selectLabel = showUnread
    ? `Select thread: ${thread.title}, unread`
    : `Select thread: ${thread.title}`;
  return (
    <div
      className={styles.slimRow}
      data-slim-row={thread.id}
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
      <div className={styles.slimBody}>
        {showUnread && <span className={styles.srOnly}>unread</span>}
        <span className={styles.slimTitle}>{thread.title}</span>
        <span className={styles.slimSlug}>{slug}</span>
        <span className={styles.slimSlot}>
          <span className={styles.slimAge}>
            {formatRelativeAge(wrapUpAt, now)}
          </span>
          {archived && onSetArchived ? (
            <button
              type="button"
              className={styles.slimAction}
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
          ) : pinMode && onSetPinned ? (
            <button
              type="button"
              className={styles.slimAction}
              aria-label="Unpin thread"
              title="Unpin thread"
              data-unpin-btn={thread.id}
              onClick={(e) => {
                e.stopPropagation();
                void onSetPinned(thread.id, false);
              }}
            >
              unpin
            </button>
          ) : onSetSettled ? (
            <button
              type="button"
              className={styles.slimAction}
              aria-label="Keep thread active"
              title="Keep thread active"
              data-unsettle-btn={thread.id}
              onClick={(e) => {
                e.stopPropagation();
                void onSetSettled(thread.id, "active");
              }}
            >
              keep
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** Slim snoozed shelf row: title + slug + wake countdown. */
export function SnoozedRow({
  thread,
  slug,
  active,
  now,
  onSelect,
  onSetSnoozed,
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
      className={styles.slimRow}
      data-slim-row={thread.id}
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
      <div className={styles.slimBody}>
        {showUnread && <span className={styles.srOnly}>unread</span>}
        <span className={styles.slimTitle}>{thread.title}</span>
        <span className={styles.slimSlug}>{slug}</span>
        <span className={styles.slimSlot}>
          <span className={styles.slimAge} data-wake-label={thread.id}>
            {wake}
          </span>
          {onSetSnoozed && (
            <button
              type="button"
              className={styles.slimAction}
              aria-label="Wake thread now"
              title="Wake thread now"
              data-wake-btn={thread.id}
              onClick={(e) => {
                e.stopPropagation();
                void onSetSnoozed(thread.id, null);
              }}
            >
              wake
            </button>
          )}
        </span>
      </div>
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
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  useEscapeClose(createMenuOpen || scopeMenuOpen, () => {
    setCreateMenuOpen(false);
    setScopeMenuOpen(false);
  });
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
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [projectScope, setProjectScope] = useState<string | null>(() =>
    loadStored(SCOPE_KEY),
  );
  const [snoozedOpen, setSnoozedOpen] = useState(() =>
    loadFlag(SNOOZED_OPEN_KEY, false),
  );
  const [settledOpen, setSettledOpen] = useState(() =>
    loadFlag(SETTLED_OPEN_KEY, false),
  );
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

  const displayThreads = useMemo(() => {
    if (!searching) return threads;
    if (searchResults == null) return [];
    return searchResults.map((t) => liveById.get(t.id) ?? t);
  }, [searching, searchResults, threads, liveById]);

  // Drop a stale scope if the project was removed.
  useEffect(() => {
    if (projectScope != null && !projectById.has(projectScope)) {
      setProjectScope(null);
      saveStored(SCOPE_KEY, null);
    }
  }, [projectScope, projectById]);

  useEffect(() => {
    setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
  }, [projectScope]);

  const scopeFilter = searching ? null : projectScope;
  const flat = useMemo(
    () => buildFlatSidebar(displayThreads, settleOpts, scopeFilter),
    [displayThreads, settleOpts, scopeFilter],
  );

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
    searchResults != null &&
    searchResults.length === 0;

  const slugFor = (t: ThreadInfo) =>
    projectById.get(t.projectId)?.slug ?? "unknown";

  const settledTail = useMemo(
    () => [...flat.settled, ...flat.archived],
    [flat.settled, flat.archived],
  );

  const visibleIds = useMemo(() => {
    if (searching) return displayThreads.map((t) => t.id);
    return flatVisibleThreadIds({
      flat,
      snoozedOpen,
      settledOpen,
      settledVisibleCount,
      selectedThreadId: activeThreadId,
      keepThreadIds: [revealThreadId ?? null],
    });
  }, [
    searching,
    displayThreads,
    flat,
    snoozedOpen,
    settledOpen,
    settledVisibleCount,
    activeThreadId,
    revealThreadId,
  ]);

  const visibleIndex = useMemo(() => {
    const m = new Map<string, number>();
    visibleIds.forEach((id, i) => m.set(id, i));
    return m;
  }, [visibleIds]);

  const visibleIdsRef = useRef(visibleIds);
  const selectAnchorRef = useRef(selectAnchor);
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

  const setScope = (id: string | null) => {
    setProjectScope(id);
    saveStored(SCOPE_KEY, id);
    setScopeMenuOpen(false);
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

  const cardIds = searching
    ? new Set(displayThreads.map((t) => t.id))
    : new Set([...flat.pinned, ...flat.active].map((t) => t.id));

  const renderCard = (thread: ThreadInfo) => (
    <Fragment key={`${thread.id}:card`}>
      <ThreadCard
        thread={thread}
        slug={slugFor(thread)}
        providers={providers}
        active={thread.id === activeThreadId}
        multiSelected={multiSelected.has(thread.id)}
        indexHint={indexHintFor(thread.id)}
        now={now}
        onSelect={handleSelect}
        isSettled={searching ? effectiveSettled(thread, settleOpts) : false}
        onSetSettled={onSetSettled}
        onSetPinned={onSetPinned}
        onSetSnoozed={onSetSnoozed}
        onSetMuted={onSetMuted}
        onRenameThread={onRenameThread}
        onFork={onFork}
        nested={
          thread.handoffFrom != null && cardIds.has(thread.handoffFrom)
        }
        wait={waitStates.get(thread.id) ?? null}
        contentMatch={
          searching && !thread.title.toLowerCase().includes(queryLower)
        }
        conflictForecast={conflictForecast}
        threadTitles={threadTitles}
      />
    </Fragment>
  );

  // The open thread never vanishes — and neither does a freshly revealed
  // one (new-thread reveal can land on a collapsed shelf).
  const keepIds = [activeThreadId, revealThreadId ?? null];
  const visibleSnoozed = snoozedOpen ? flat.snoozed : [];
  const snoozedCarve = snoozedOpen
    ? null
    : flat.snoozed.find((t) => keepIds.includes(t.id)) ?? null;

  const visibleSettled = settledOpen
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

  const scopedSlug =
    projectScope != null
      ? projectById.get(projectScope)?.slug ?? "All projects"
      : "All projects";

  const listEmpty =
    !searching &&
    flat.pinned.length +
      flat.active.length +
      flat.snoozed.length +
      settledTail.length ===
      0;

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
                onClick={() => setCreateMenuOpen((open) => !open)}
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
                          onCreateThread(createProjectId, { worktree: true });
                        }}
                      >
                        New worktree thread
                      </button>
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
                      title="New thread from a GitHub issue"
                      onClick={() => openIssueForm(createProjectId)}
                    >
                      From GitHub issue
                    </button>
                  )}
                </div>
              )}
            </span>
          )}
        </span>
      </div>

      <div className={styles.scopeRow}>
        <span className={styles.scopeMenuHost}>
          <button
            type="button"
            className={styles.scopeTrigger}
            data-scope-trigger=""
            aria-haspopup="menu"
            aria-expanded={scopeMenuOpen}
            aria-label="Filter threads by project"
            onClick={() => setScopeMenuOpen((open) => !open)}
          >
            <Icon size={14}>
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </Icon>
            <span className={styles.scopeLabel}>{scopedSlug}</span>
            <Icon size={12}>
              <path d="m6 9 6 6 6-6" />
            </Icon>
          </button>
          {scopeMenuOpen && (
            <div className={`${styles.menu} ${styles.menuLeft}`} role="menu" data-scope-menu="">
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
                    {p.slug || p.name}
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
                        setScopeMenuOpen(false);
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
            </div>
          )}
        </span>
        <button
          type="button"
          className={styles.iconBtn}
          data-new-project=""
          title="New project"
          aria-label="New project"
          onClick={onAddProject}
        >
          <Icon size={15}>
            <path d="M12 10v8" />
            <path d="M8 14h8" />
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </Icon>
        </button>
      </div>

      <nav className={styles.viewNav} aria-label="Views">
        <button
          type="button"
          className={styles.viewNavBtn}
          data-view-nav="activity"
          data-active={activeView === "activity" ? "true" : undefined}
          title="Activity"
          aria-label="Activity"
          onClick={() => onOpenActivity?.(projectScope)}
        >
          <Icon size={15}>
            <path d="M3 12h3l2-6 4 12 2-6h4" />
          </Icon>
        </button>
        <button
          type="button"
          className={styles.viewNavBtn}
          data-view-nav="kanban"
          data-active={activeView === "kanban" ? "true" : undefined}
          title="Kanban"
          aria-label="Kanban"
          onClick={() => onOpenKanban?.(projectScope)}
        >
          <Icon size={15}>
            <rect x="3" y="4" width="5" height="16" rx="1" />
            <rect x="10" y="4" width="5" height="10" rx="1" />
            <rect x="17" y="4" width="4" height="7" rx="1" />
          </Icon>
        </button>
        <button
          type="button"
          className={styles.viewNavBtn}
          data-view-nav="planboard"
          data-active={activeView === "planboard" ? "true" : undefined}
          title="Planboard"
          aria-label="Planboard"
          onClick={() => onOpenPlanboard?.(projectScope)}
        >
          <Icon size={15}>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M8 9h8" />
            <path d="M8 13h6" />
            <path d="M8 17h4" />
          </Icon>
        </button>
      </nav>

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
            placeholder="https://github.com/owner/repo/issues/123"
            aria-label="GitHub issue URL or reference"
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

      <div className={styles.list} data-sidebar-list="" ref={attachListAnimation}>
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

        {searching
          ? displayThreads.map((thread) => renderCard(thread))
          : (
            <>
              {flat.pinned.map((thread) => renderCard(thread))}
              {flat.pinned.length > 0 && (
                <div className={styles.pinnedDivider} data-pinned-divider="" aria-hidden />
              )}
              {flat.active.map((thread) => renderCard(thread))}

              {flat.snoozed.length > 0 && (
                <div className={styles.shelf}>
                  <button
                    type="button"
                    className={styles.shelfToggle}
                    data-snoozed-shelf-toggle=""
                    aria-expanded={snoozedOpen}
                    onClick={toggleSnoozed}
                  >
                    <span className={styles.shelfLabelSnoozed}>
                      {snoozedOpen
                        ? "Snoozed"
                        : `Snoozed (${flat.snoozed.length})`}
                    </span>
                    <span className={styles.shelfRuleSnoozed} />
                    <span
                      className={styles.shelfChevron}
                      data-open={snoozedOpen}
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
                      aria-expanded={settledOpen}
                      onClick={toggleSettled}
                    >
                      <span className={styles.shelfLabelSettled}>
                        {settledOpen
                          ? "Settled"
                          : `Settled (${settledTail.length})`}
                      </span>
                      <span className={styles.shelfRuleSettled} />
                      <span
                        className={styles.shelfChevron}
                        data-open={settledOpen}
                        aria-hidden
                      >
                        <Icon size={12}>
                          <path d="m6 9 6 6 6-6" />
                        </Icon>
                      </span>
                    </button>
                    {settledOpen && onClearSettled && flat.settled.length > 0 && (
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
                  {settledOpen && settledHidden > 0 && (
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

              {listEmpty && projects.length > 0 && (
                <p className={styles.emptySearch}>
                  {projectScope
                    ? `No threads in ${scopedSlug} yet`
                    : "No threads yet"}
                </p>
              )}
            </>
          )}
      </div>

      {removeConfirmId &&
        (() => {
          const confirmProject = projectById.get(removeConfirmId);
          if (!confirmProject) return null;
          const count = threads.filter(
            (t) => t.projectId === confirmProject.id,
          ).length;
          const threadWord = count === 1 ? "thread" : "threads";
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
              <Icon size={15}>
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </Icon>
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
              <Icon size={15}>
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </Icon>
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
