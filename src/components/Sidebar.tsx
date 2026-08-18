import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import autoAnimate from "@formkit/auto-animate";
import type {
  ConflictForecast,
  ProjectInfo,
  ProviderInfo,
  SpaceInfo,
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
  providerDisplayName,
} from "../format";
import { formatQuotaWaitLabel } from "../quotaWait";
import { sidebarPrBadge } from "../prUi";
import {
  GROUP_ATTENTION_CAP,
  buildSidebarSections,
  groupHeaderSummary,
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
const SPACES_COLLAPSED_KEY = "coder.sidebar.collapsedSpaces";
/** Distinct from file drops on the composer. */
const PROJECT_DRAG_TYPE = "application/x-solenta-project";
const UNASSIGNED_SPACE_KEY = "unassigned";

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
  /** Named sidebar groups. Empty = today's flat list (no section headers). */
  spaces?: SpaceInfo[];
  threads: ThreadInfo[];
  /** Provider registry for display names on thread cards. */
  providers: ProviderInfo[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  /** Global + uses selected project; per-group New thread passes that projectId. */
  onCreateThread: (
    projectId?: string,
    opts?: { worktree?: boolean; orchestrate?: boolean; teach?: boolean; issueNumber?: number | null },
  ) => void;
  /**
   * Mirrors SettingsInfo.defaultWorktree. The caret lists worktree,
   * orchestrator, plain, and teach; this only documents the setting the
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
  onAddSpace?: (name: string) => void | Promise<unknown>;
  onRenameSpace?: (id: string, name: string) => void | Promise<unknown>;
  onRemoveSpace?: (id: string) => void | Promise<void>;
  /** Empty string unassigns. */
  onAssignProjectToSpace?: (
    projectId: string,
    spaceId: string,
  ) => void | Promise<unknown>;
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

function StatusBadge({
  thread,
  now,
  wait = null,
  active = false,
}: {
  thread: ThreadInfo;
  now: number;
  /** Live delegated work; turns a done/idle turn into "Delegating". */
  wait?: WaitState | null;
  /** Selected thread never renders Woke (you are looking at it). */
  active?: boolean;
}) {
  if (thread.status === "quota-wait") {
    const until = thread.quotaWaitUntil;
    const clock =
      until != null && Number.isFinite(until)
        ? formatQuotaWaitLabel(until, now)
        : "—";
    return (
      <span
        className={`${styles.badge} ${styles.badgeQuotaWait}`}
        data-quota-wait=""
        title={thread.lastError ?? `Usage limit reached. Resuming at ${clock}.`}
      >
        <span className={styles.waitingDot} aria-hidden />
        Quota wait · {clock}
      </span>
    );
  }

  if (thread.status === "working" && thread.awaitingInput) {
    return (
      <span className={`${styles.badge} ${styles.badgeWaiting}`}>
        <span className={styles.waitingDot} aria-hidden />
        Waiting
      </span>
    );
  }

  if (thread.status === "working" && thread.stalledAt != null) {
    return (
      <span className={`${styles.badge} ${styles.badgeWaiting}`} data-stalled="">
        Stalled {formatElapsed(thread.stalledAt, now)}
      </span>
    );
  }

  if (thread.status === "working") {
    const label =
      thread.runStartedAt != null
        ? formatWorkingLabel(thread.runStartedAt, now)
        : "Working";
    return (
      <span className={`${styles.badge} ${styles.badgeWorking}`}>
        <span className={styles.spinner} aria-hidden />
        {label}
      </span>
    );
  }

  if (!active && showWokePill(thread, now)) {
    return (
      <span className={`${styles.badge} ${styles.badgeWoke}`} data-woke="">
        Woke
      </span>
    );
  }

  if (isDelegating(thread.status, wait)) {
    return (
      <span
        className={`${styles.badge} ${styles.badgeDelegating}`}
        data-delegating={thread.id}
      >
        <span className={styles.waitingDot} aria-hidden />
        Delegating
      </span>
    );
  }

  if (thread.status === "done") {
    return (
      <span className={`${styles.badge} ${styles.badgeDone}`}>
        <span className={styles.check} aria-hidden>
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m3 8.75 3.25 3.25L13 5.25" />
          </svg>
        </span>
        Done
      </span>
    );
  }

  if (thread.status === "failed") {
    return (
      <span
        className={`${styles.badge} ${styles.badgeFailed}`}
        title={thread.lastError ?? undefined}
      >
        Failed
      </span>
    );
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

/** Exported for render tests that need a card without the archived-collapse gate. */
export function ThreadCard({
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
  forkMenuOpen = false,
  onToggleForkMenu,
  remote = false,
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
  snoozeMenuOpen?: boolean;
  onToggleSnoozeMenu?: (threadId: string | null) => void;
  forkMenuOpen?: boolean;
  onToggleForkMenu?: (threadId: string | null) => void;
  /** True when the thread's project lives on an SSH remote. */
  remote?: boolean;
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
  const branch = thread.branch ?? "";
  const prBadge = sidebarPrBadge({
    prNumber: thread.prNumber,
    prUrl: thread.prUrl,
  });
  const providerLabel = providerDisplayName(thread.provider, providers);
  const working = thread.status === "working";
  // Settled cards offer "keep active"; attention cards offer "settle".
  const settleOverride = isSettled ? ("active" as const) : ("settled" as const);
  const settleLabel = isSettled ? "Keep thread active" : "Settle thread";
  // Selected never paints unread (you are looking at it) — render rule only.
  const showUnread = !active && isUnread(thread);
  const selectLabel = showUnread
    ? `Select thread: ${thread.title}, unread`
    : `Select thread: ${thread.title}`;
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renamingRef = useRef(false);

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
      data-nested={nested ? "true" : undefined}
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
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          {showSlug && <span className={styles.repo}>{slug}</span>}
          <span className={styles.cardTags}>
            <span className={styles.providerTag}>{providerLabel}</span>
            {remote && (
              <span className={styles.sshTag} data-ssh-tag="" title="SSH remote">
                ssh
              </span>
            )}
            {(thread.worktreePath || thread.pendingWorktree) && (
              <span className={styles.worktreeTag}>wt</span>
            )}
            {thread.archived && (
              <span className={styles.archivedTag}>archived</span>
            )}
            {contentMatch && (
              <span className={styles.inMessagesTag}>in messages</span>
            )}
          </span>
          <span className={styles.age}>
            {formatRelativeAge(thread.updatedAt, now)}
          </span>
        </div>
        <div className={styles.cardTitleRow}>
          {showUnread && (
            <span
              className={styles.unreadDot}
              data-unread-dot={thread.id}
              aria-hidden="true"
            />
          )}
          {showUnread && <span className={styles.srOnly}>unread</span>}
          {thread.queued && (
            <span
              className={styles.queuedDot}
              data-queued-dot={thread.id}
              title={thread.queued.prompt}
            />
          )}
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
            <div className={styles.cardTitle}>{thread.title}</div>
          )}
        </div>
        <div className={styles.cardMeta}>
          <div className={styles.branchRow}>
            {/* Truncation applies only to the branch name; PR chip is a sibling. */}
            <span className={styles.branch}>{branch}</span>
            {branch && prBadge ? (
              <span className={styles.branchSep} aria-hidden>
                {" · "}
              </span>
            ) : null}
            {prBadge?.href ? (
              <a
                className={styles.prLink}
                href={prBadge.href}
                target="_blank"
                rel="noreferrer"
                title={prBadge.href}
              >
                {prBadge.label}
              </a>
            ) : prBadge ? (
              <span className={styles.prLabel}>{prBadge.label}</span>
            ) : null}
          </div>
          <div className={styles.cardBadges}>
            <ConflictForecastBadge
              threadId={thread.id}
              forecast={conflictForecast}
              titles={threadTitles}
            />
            <StatusBadge
              thread={thread}
              now={now}
              wait={wait}
              active={active}
            />
          </div>
        </div>
        {/* Own row, not a chip beside the status badge: on a narrow card the
            branch + PR chip squeeze a chip down to "Waiting on…", which loses
            the count that is the whole point (issue #42). */}
        {wait && (
          <div
            className={styles.waitRow}
            data-wait-badge={thread.id}
            data-attention={wait.blocked > 0 ? "true" : undefined}
            title={waitTooltip(wait)}
          >
            <span className={styles.waitingDot} aria-hidden />
            {waitLabel(wait, now)}
          </div>
        )}
        {thread.notes ? (
          <div
            className={styles.notesPreview}
            data-notes-preview={thread.id}
            title={thread.notes}
          >
            {thread.notes.split("\n")[0]}
          </div>
        ) : null}
      </div>
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
          {onSetSnoozed && (
            <div className={styles.snoozeWrap}>
              <button
                type="button"
                className={styles.settleBtn}
                aria-label="Snooze thread"
                title="Snooze thread"
                aria-haspopup="menu"
                aria-expanded={snoozeMenuOpen}
                data-snooze-btn={thread.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSnoozeMenu?.(snoozeMenuOpen ? null : thread.id);
                  onToggleForkMenu?.(null);
                }}
              >
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
                  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                </svg>
              </button>
              {snoozeMenuOpen && (
                <div
                  className={styles.snoozeMenu}
                  role="menu"
                  data-snooze-menu={thread.id}
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
                  {onSetSettled && thread.snoozedUntil != null && !working && (
                    <button
                      type="button"
                      className={styles.snoozeMenuItem}
                      role="menuitem"
                      data-snooze-settle=""
                      onClick={(e) => {
                        e.stopPropagation();
                        void onSetSettled(thread.id, "settled");
                        onToggleSnoozeMenu?.(null);
                      }}
                    >
                      Settle now
                    </button>
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
                </div>
              )}
            </div>
          )}
          {onFork && (
            <div className={styles.snoozeWrap}>
              <button
                type="button"
                className={styles.settleBtn}
                aria-label="Fork thread"
                title="Fork thread"
                data-fork-btn={thread.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleForkMenu?.(null);
                  onToggleSnoozeMenu?.(null);
                  void onFork(thread.id);
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <circle cx="4" cy="3.5" r="1.8" />
                  <circle cx="4" cy="12.5" r="1.8" />
                  <circle cx="12" cy="8" r="1.8" />
                  <path d="M4 5.3v5.4M4 8c0 2.2 3.2 2.6 6.2 2.7" />
                </svg>
              </button>
              <button
                type="button"
                className={styles.settleBtn}
                aria-label="Hand off to…"
                title="Hand off to…"
                aria-haspopup="menu"
                aria-expanded={forkMenuOpen}
                data-handoff-btn={thread.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSnoozeMenu?.(null);
                  onToggleForkMenu?.(forkMenuOpen ? null : thread.id);
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
                  <path d="M2.5 8h10M9 4.5 12.5 8 9 11.5" />
                </svg>
              </button>
              {forkMenuOpen && (
                <div
                  className={styles.snoozeMenu}
                  role="menu"
                  data-handoff-menu={thread.id}
                >
                  {providers
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
                            onToggleForkMenu?.(null);
                          }}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                </div>
              )}
            </div>
          )}
          {onSetSettled && (
            <button
              type="button"
              className={styles.settleBtn}
              aria-label={settleLabel}
              title={
                working
                  ? "Cannot settle while a run is active"
                  : settleLabel
              }
              disabled={working}
              onClick={(e) => {
                e.stopPropagation();
                void onSetSettled(thread.id, settleOverride);
              }}
            >
              {isSettled ? (
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
              ) : (
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
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Slim settled tail row (t3-style): title + project slug + wrap-up age.
 * Dimmed at rest, restored on hover. Selectable; Keep-active hover pin only
 * (opening a settled thread does NOT un-settle).
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
  multiSelected?: boolean;
  indexHint?: number | null;
}) {
  const wrapUpAt = pinMode
    ? (thread.pinnedAt ?? thread.updatedAt)
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
      data-settled={pinMode ? undefined : "true"}
      data-pinned={pinMode ? "true" : undefined}
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
      {pinMode && onSetPinned ? (
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
  spaces = [],
  threads,
  providers,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onAddProject,
  onRemoveProject,
  onEditProject,
  onAddSpace,
  onRenameSpace,
  onRemoveSpace,
  onAssignProjectToSpace,
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
  /** Which thread's hand-off provider menu is open (one at a time). */
  const [forkMenuFor, setForkMenuFor] = useState<string | null>(null);
  useEscapeClose(snoozeMenuFor != null, () => setSnoozeMenuFor(null));
  useEscapeClose(forkMenuFor != null, () => setForkMenuFor(null));
  /** Project id whose thread-create menu (plain vs worktree) is open. */
  const [createMenuFor, setCreateMenuFor] = useState<string | null>(null);
  useEscapeClose(createMenuFor != null, () => setCreateMenuFor(null));
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
  /** Project ids whose archived threads are shown inline (normal view only). */
  const [showArchived, setShowArchived] = useState<Set<string>>(() => new Set());
  /**
   * Group keys fully expanded past GROUP_ATTENTION_CAP (session-only, like
   * showArchived). Absent = capped at the newest 8 attention threads.
   */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  /** Group keys the user collapsed. Survives restarts: collapsing a noisy
   *  project is a lasting choice, not a per-session whim. */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    loadKeySet(COLLAPSED_KEY),
  );
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(() =>
    loadKeySet(SPACES_COLLAPSED_KEY),
  );
  const [addingSpace, setAddingSpace] = useState(false);
  const [spaceDraft, setSpaceDraft] = useState("");
  const [renamingSpaceId, setRenamingSpaceId] = useState<string | null>(null);
  const [renameSpaceDraft, setRenameSpaceDraft] = useState("");
  const [removeSpaceConfirmId, setRemoveSpaceConfirmId] = useState<
    string | null
  >(null);
  const [removeSpacePending, setRemoveSpacePending] = useState(false);
  const [spaceDropOver, setSpaceDropOver] = useState<string | null>(null);
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
  /** Snoozed shelf open state (session-only, collapsed by default). */
  const [snoozedOpen, setSnoozedOpen] = useState(false);
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
  const threadTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const t of threads) titles.set(t.id, t.title);
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

  const {
    pinned: globalPinned,
    attentionThreads,
    snoozed: globalSnoozed,
    settled: globalSettled,
  } = useMemo(
    () => partitionSidebar(displayThreads, settleOpts),
    [displayThreads, settleOpts],
  );

  /**
   * Project groups for the main list.
   * Normal view: attention + archived only (pin/snooze/settled pulled out).
   * Search: full hit list including shelves, so hits surface inline.
   * Spaces wrap the same groups; zero spaces is one Unassigned section.
   */
  const sections = useMemo(() => {
    if (searching) {
      const projectsWithHits = projects.filter((p) =>
        displayThreads.some((t) => t.projectId === p.id),
      );
      return buildSidebarSections(spaces, projectsWithHits, displayThreads);
    }
    const attentionIds = new Set(attentionThreads.map((t) => t.id));
    const forGroups = displayThreads.filter(
      (t) => t.archived || attentionIds.has(t.id),
    );
    return buildSidebarSections(spaces, projects, forGroups);
  }, [spaces, projects, displayThreads, searching, attentionThreads]);

  const groups = useMemo(
    () => sections.flatMap((s) => s.groups),
    [sections],
  );

  const toggleCollapsed = (groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      saveKeySet(COLLAPSED_KEY, next);
      return next;
    });
  };

  const toggleCollapsedSpace = (spaceKey: string) => {
    setCollapsedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(spaceKey)) next.delete(spaceKey);
      else next.add(spaceKey);
      saveKeySet(SPACES_COLLAPSED_KEY, next);
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
      const home =
        projects.find((p) => p.id === target.projectId)?.spaceId ??
        UNASSIGNED_SPACE_KEY;
      setCollapsedSpaces((prev) => {
        if (!prev.has(home)) return prev;
        const next = new Set(prev);
        next.delete(home);
        saveKeySet(SPACES_COLLAPSED_KEY, next);
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

  const toggleArchived = (groupKey: string) => {
    setShowArchived((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
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
  const selectedSettled =
    !searching &&
    !settledTailOpen &&
    activeThreadId != null
      ? globalSettled.find((t) => t.id === activeThreadId) ?? null
      : null;
  const selectedSnoozed =
    !searching &&
    !snoozedOpen &&
    activeThreadId != null
      ? globalSnoozed.find((t) => t.id === activeThreadId) ?? null
      : null;

  const visibleSettled = settledTailOpen
    ? globalSettled.slice(0, settledVisibleCount)
    : [];
  const settledHasMore =
    settledTailOpen && globalSettled.length > settledVisibleCount;

  const slugFor = (t: ThreadInfo) =>
    projectById.get(t.projectId)?.slug ?? "unknown";

  /**
   * Groups that actually render. A collapsed space drops its project
   * groups so ⌘1-9 / ⌘J/K stay in lockstep with the list.
   */
  const visibleSectionGroups = useMemo(() => {
    if (searching || spaces.length === 0) return groups;
    return sections.flatMap((s) => {
      const key = s.space?.id ?? UNASSIGNED_SPACE_KEY;
      return collapsedSpaces.has(key) ? [] : s.groups;
    });
  }, [searching, spaces.length, groups, sections, collapsedSpaces]);

  /** Ordered visible ids — matches render order (round 46). */
  const visibleIds = useMemo(
    () =>
      buildVisibleThreadIds({
        pinned: searching ? [] : globalPinned,
        groups: visibleSectionGroups,
        collapsedGroupKeys: searching ? new Set() : collapsedGroups,
        expandedGroupKeys: searching ? new Set() : expandedGroups,
        keepThreadIds: [activeThreadId, revealThreadId ?? null],
        showArchivedKeys: searching
          ? new Set(groups.map((g) => g.project?.id ?? g.threads[0]?.projectId ?? "orphan"))
          : showArchived,
        snoozed: globalSnoozed,
        snoozedOpen,
        selectedSnoozedId: selectedSnoozed?.id ?? null,
        settled: globalSettled,
        settledOpen: settledTailOpen,
        settledVisibleCount,
        selectedSettledId: selectedSettled?.id ?? null,
        searching,
      }),
    [
      searching,
      globalPinned,
      visibleSectionGroups,
      collapsedGroups,
      expandedGroups,
      activeThreadId,
      revealThreadId,
      showArchived,
      globalSnoozed,
      snoozedOpen,
      selectedSnoozed,
      globalSettled,
      settledTailOpen,
      settledVisibleCount,
      selectedSettled,
    ],
  );

  const visibleIndex = useMemo(() => {
    const m = new Map<string, number>();
    visibleIds.forEach((id, i) => m.set(id, i));
    return m;
  }, [visibleIds]);

  const handleSelect = useCallback(
    (id: string, opts?: SelectOpts) => {
      if (opts?.shift) {
        const range = rangeSelectIds(visibleIds, selectAnchor, id);
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
    [visibleIds, selectAnchor, onSelectThread],
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
    const { toSettle, skippedWorking } = planBatchSettle(
      attentionThreads.map((t) => t.id),
      new Map(attentionThreads.map((t) => [t.id, t])),
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
        {onAddSpace && (
          <button
            type="button"
            className={styles.spaceAddBtn}
            aria-label="Add space"
            title="Add space"
            data-space-add=""
            onClick={() => {
              setAddingSpace(true);
              setSpaceDraft("");
            }}
          >
            +
          </button>
        )}
      </div>
      {addingSpace && (
        <input
          className={styles.spaceInput}
          data-space-add-input=""
          value={spaceDraft}
          placeholder="Space name"
          aria-label="New space name"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setSpaceDraft(e.target.value)}
          onBlur={() => {
            if (!spaceDraft.trim()) {
              setAddingSpace(false);
              setSpaceDraft("");
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const name = spaceDraft.trim();
              if (!name) return;
              void onAddSpace?.(name);
              setAddingSpace(false);
              setSpaceDraft("");
            } else if (e.key === "Escape") {
              e.preventDefault();
              setAddingSpace(false);
              setSpaceDraft("");
            }
          }}
        />
      )}

      <div className={styles.list}>
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

        {/* Global PINNED shelf (t3): always expanded, above project groups. */}
        {!searching && globalPinned.length > 0 && (
          <div
            className={styles.pinnedSection}
            data-pinned-section=""
            ref={attachListAnimation}
          >
            <div className={styles.pinnedHeader}>
              <span>Pinned · {globalPinned.length}</span>
            </div>
            {globalPinned.map((thread) => (
              <SettledRow
                key={`${thread.id}:slim`}
                thread={thread}
                slug={slugFor(thread)}
                active={thread.id === activeThreadId}
                multiSelected={multiSelected.has(thread.id)}
                indexHint={indexHintFor(thread.id)}
                now={now}
                onSelect={handleSelect}
                onSetSettled={onSetSettled}
                pinMode
                onSetPinned={onSetPinned}
              />
            ))}
          </div>
        )}

        {sections.map((section) => {
          const spaceKey = section.space?.id ?? UNASSIGNED_SPACE_KEY;
          const showSpaceHeader = section.space != null || spaces.length > 0;
          const spaceCollapsed =
            !searching && showSpaceHeader && collapsedSpaces.has(spaceKey);
          const spaceName = section.space?.name ?? "Unassigned";
          const projectCount = section.groups.filter((g) => g.project).length;
          const acceptSpaceDrop = (e: DragEvent) => {
            if (!onAssignProjectToSpace) return;
            if (!Array.from(e.dataTransfer.types).includes(PROJECT_DRAG_TYPE)) {
              return;
            }
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setSpaceDropOver(spaceKey);
          };
          return (
            <div
              key={spaceKey}
              className={styles.spaceSection}
              data-space-section={spaceKey}
            >
              {showSpaceHeader && (
                <div
                  className={
                    spaceDropOver === spaceKey
                      ? `${styles.spaceHeaderRow} ${styles.spaceDropOver}`
                      : styles.spaceHeaderRow
                  }
                  data-space-drop={spaceKey}
                  data-space-over={
                    spaceDropOver === spaceKey ? "true" : undefined
                  }
                  onDragOver={acceptSpaceDrop}
                  onDragEnter={acceptSpaceDrop}
                  onDragLeave={(e) => {
                    if (
                      e.relatedTarget instanceof Node &&
                      e.currentTarget.contains(e.relatedTarget)
                    ) {
                      return;
                    }
                    setSpaceDropOver((cur) =>
                      cur === spaceKey ? null : cur,
                    );
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setSpaceDropOver(null);
                    const projectId =
                      e.dataTransfer.getData(PROJECT_DRAG_TYPE);
                    if (!projectId || !onAssignProjectToSpace) return;
                    void onAssignProjectToSpace(
                      projectId,
                      section.space?.id ?? "",
                    );
                  }}
                >
                  {renamingSpaceId === section.space?.id ? (
                    <input
                      className={styles.spaceInput}
                      data-space-rename-input={section.space.id}
                      value={renameSpaceDraft}
                      aria-label={`Rename space ${spaceName}`}
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setRenameSpaceDraft(e.target.value)}
                      onBlur={() => {
                        const next = renameSpaceDraft.trim();
                        const id = section.space?.id;
                        setRenamingSpaceId(null);
                        if (id && next && next !== section.space?.name) {
                          void onRenameSpace?.(id, next);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          (e.currentTarget as HTMLInputElement).blur();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setRenamingSpaceId(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={styles.spaceHeader}
                      data-space-header={spaceKey}
                      onClick={() => toggleCollapsedSpace(spaceKey)}
                      aria-expanded={!spaceCollapsed}
                      aria-label={
                        spaceCollapsed
                          ? `Expand space ${spaceName}`
                          : `Collapse space ${spaceName}`
                      }
                      title={
                        spaceCollapsed ? "Expand space" : "Collapse space"
                      }
                    >
                      <span
                        className={styles.chevron}
                        data-open={!spaceCollapsed}
                        data-space-chevron={spaceKey}
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
                      <span className={styles.spaceName}>{spaceName}</span>
                      <span className={styles.count}>{projectCount}</span>
                    </button>
                  )}
                  {section.space &&
                    onRenameSpace &&
                    !searching &&
                    renamingSpaceId !== section.space.id && (
                      <button
                        type="button"
                        className={styles.groupRemove}
                        aria-label={`Rename space ${spaceName}`}
                        title="Rename space"
                        data-space-edit={section.space.id}
                        onClick={() => {
                          setRenamingSpaceId(section.space!.id);
                          setRenameSpaceDraft(section.space!.name);
                        }}
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
                  {section.space && onRemoveSpace && !searching && (
                    <button
                      type="button"
                      className={styles.groupRemove}
                      aria-label={`Delete space ${spaceName}`}
                      title="Delete space"
                      data-space-remove={section.space.id}
                      onClick={() =>
                        setRemoveSpaceConfirmId(section.space!.id)
                      }
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
              )}
              {spaceCollapsed
                ? null
                : section.groups.map(({ project, threads: groupThreads }) => {
                  const groupKey =
                    project?.id ?? groupThreads[0]?.projectId ?? "orphan";
                  const slug =
                    project?.slug ??
                    (groupThreads[0]
                      ? projectById.get(groupThreads[0].projectId)?.slug
                      : undefined) ??
                    "unknown";
                  // Attention only in normal view (settled are global); search shows all.
                  const attentionThreads = groupThreads.filter((t) => !t.archived);
                  const archivedThreads = groupThreads.filter((t) => t.archived);
                  // A fork indents only when its source row renders in the same
                  // sublist (buildSidebarGroups already placed it right below).
                  const attentionIdSet = new Set(attentionThreads.map((t) => t.id));
                  const archivedIdSet = new Set(archivedThreads.map((t) => t.id));
                  const archivedExpanded = searching
                    ? true
                    : showArchived.has(groupKey);
                  const hasAnyThreads = groupThreads.length > 0;
                  // Fully-settled projects have zero attention/archived rows here but
                  // their threads still live in the global tail — "No threads yet"
                  // would be a lie.
                  const settledInProject = project
                    ? globalSettled.filter((t) => t.projectId === project.id).length
                    : globalSettled.filter(
                        (t) => t.projectId === (groupThreads[0]?.projectId ?? ""),
                      ).length;
                  // A collapsed project shows only its header. Search overrides the
                  // collapse: hiding hits inside a collapsed group makes results lie.
                  const collapsed = !searching && collapsedGroups.has(groupKey);
                  const summary = groupHeaderSummary(attentionThreads);
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
                      <div
                        className={styles.groupHeaderRow}
                        draggable={Boolean(
                          project && onAssignProjectToSpace && !searching,
                        )}
                        data-project-drag={project?.id}
                        onDragStart={(e) => {
                          if (!project) {
                            e.preventDefault();
                            return;
                          }
                          e.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                      >
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
                          {summary && (
                            <span className={styles.groupSummary}>{summary}</span>
                          )}
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
                              {settledInProject > 0 ? "All settled" : "No threads yet"}
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
                            <ThreadCard
                              key={`${thread.id}:card`}
                              thread={thread}
                              slug={slug}
                              showSlug={project == null}
                              remote={Boolean(project?.remoteHost)}
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
                              forkMenuOpen={forkMenuFor === thread.id}
                              onToggleForkMenu={setForkMenuFor}
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
                          {archivedExpanded &&
                            archivedThreads.map((thread) => (
                              <ThreadCard
                                key={`${thread.id}:card`}
                                thread={thread}
                                slug={slug}
                                showSlug={project == null}
                                remote={Boolean(project?.remoteHost)}
                                providers={providers}
                                active={thread.id === activeThreadId}
                                multiSelected={multiSelected.has(thread.id)}
                                indexHint={indexHintFor(thread.id)}
                                now={now}
                                onSelect={handleSelect}
                                isSettled={effectiveSettled(thread, settleOpts)}
                                onSetSettled={onSetSettled}
                                onFork={onFork}
                                forkMenuOpen={forkMenuFor === thread.id}
                                onToggleForkMenu={setForkMenuFor}
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
                            ))}
                          {!searching && archivedThreads.length > 0 && (
                            <button
                              type="button"
                              className={styles.archivedToggle}
                              onClick={() => toggleArchived(groupKey)}
                              aria-expanded={archivedExpanded}
                            >
                              {archivedExpanded
                                ? "Hide archived"
                                : `${archivedThreads.length} archived`}
                            </button>
                          )}
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
            </div>
          );
        })}

        {/* Global SNOOZED shelf (t3): between groups and settled, collapsed by default. */}
        {!searching && globalSnoozed.length > 0 && (
          <div
            className={styles.snoozedShelf}
            data-snoozed-shelf=""
            ref={attachListAnimation}
          >
            {selectedSnoozed && (
              <SnoozedRow
                thread={selectedSnoozed}
                slug={slugFor(selectedSnoozed)}
                active
                multiSelected={multiSelected.has(selectedSnoozed.id)}
                indexHint={indexHintFor(selectedSnoozed.id)}
                now={now}
                onSelect={handleSelect}
                onSetSnoozed={onSetSnoozed}
                onSetSettled={onSetSettled}
              />
            )}
            <button
              type="button"
              className={styles.settledTailHeader}
              onClick={() => setSnoozedOpen((o) => !o)}
              aria-expanded={snoozedOpen}
              data-snoozed-header=""
            >
              <span className={styles.chevron} data-open={snoozedOpen}>
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
                Snoozed · {globalSnoozed.length}
              </span>
            </button>
            {snoozedOpen &&
              globalSnoozed.map((thread) => (
                <SnoozedRow
                  key={`${thread.id}:slim`}
                  thread={thread}
                  slug={slugFor(thread)}
                  active={thread.id === activeThreadId}
                  multiSelected={multiSelected.has(thread.id)}
                  indexHint={indexHintFor(thread.id)}
                  now={now}
                  onSelect={handleSelect}
                  onSetSnoozed={onSetSnoozed}
                  onSetSettled={onSetSettled}
                />
              ))}
          </div>
        )}

        {/* Global settled tail (t3-style): one section at the bottom, all projects.
            Independent of per-project / collapse-all — has its own toggle. */}
        {!searching && globalSettled.length > 0 && (
          <div
            className={styles.settledTail}
            data-settled-tail=""
            ref={attachListAnimation}
          >
            {selectedSettled && (
              <SettledRow
                thread={selectedSettled}
                slug={slugFor(selectedSettled)}
                active
                multiSelected={multiSelected.has(selectedSettled.id)}
                indexHint={indexHintFor(selectedSettled.id)}
                now={now}
                onSelect={handleSelect}
                onSetSettled={onSetSettled}
              />
            )}
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
                  Settled · {globalSettled.length}
                  {(() => {
                    const n = countUnread(globalSettled);
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
                  title="Settle every attention thread (running threads skipped)"
                  onClick={() => void runSettleAll()}
                >
                  Settle all
                </button>
              )}
              {onClearSettled && (
                <button
                  type="button"
                  className={styles.settledClear}
                  data-settled-clear-all=""
                  aria-label="Clear settled threads"
                  title="Archive all settled threads (undoable)"
                  onClick={() =>
                    void onClearSettled(globalSettled.map((t) => t.id))
                  }
                >
                  Clear
                </button>
              )}
            </div>
            {settledTailOpen &&
              visibleSettled.map((thread) => (
                <SettledRow
                  key={`${thread.id}:slim`}
                  thread={thread}
                  slug={slugFor(thread)}
                  active={thread.id === activeThreadId}
                  multiSelected={multiSelected.has(thread.id)}
                  indexHint={indexHintFor(thread.id)}
                  now={now}
                  onSelect={handleSelect}
                  onSetSettled={onSetSettled}
                />
              ))}
            {settledHasMore && (
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

      {removeSpaceConfirmId &&
        (() => {
          const confirmSpace = spaces.find(
            (s) => s.id === removeSpaceConfirmId,
          );
          if (!confirmSpace) return null;
          const closeConfirm = () => {
            if (removeSpacePending) return;
            setRemoveSpaceConfirmId(null);
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
                aria-labelledby="remove-space-title"
                data-space-remove-confirm={confirmSpace.id}
                onClick={(e) => e.stopPropagation()}
              >
                <h2
                  id="remove-space-title"
                  className={styles.removeConfirmTitle}
                >
                  Delete space {confirmSpace.name}?
                </h2>
                <p className={styles.removeConfirmBody}>
                  Projects in this space will be unassigned, not deleted.
                </p>
                <div className={styles.removeConfirmActions}>
                  <button
                    type="button"
                    className={styles.removeConfirmDanger}
                    data-space-remove-confirm-submit={confirmSpace.id}
                    disabled={removeSpacePending}
                    aria-busy={removeSpacePending || undefined}
                    onClick={() => {
                      if (removeSpacePending || !onRemoveSpace) return;
                      const id = confirmSpace.id;
                      setRemoveSpacePending(true);
                      void Promise.resolve(onRemoveSpace(id))
                        .catch(() => {
                          // Failure toast is the caller's job; always close.
                        })
                        .finally(() => {
                          setRemoveSpacePending(false);
                          setRemoveSpaceConfirmId(null);
                        });
                    }}
                  >
                    {removeSpacePending ? "Deleting…" : "Delete space"}
                  </button>
                  <button
                    type="button"
                    className={styles.removeConfirmCancel}
                    disabled={removeSpacePending}
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
