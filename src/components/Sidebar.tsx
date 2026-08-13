import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../shared/ipc";
import { isWebMode } from "../shared/wire";
import {
  formatRelativeAge,
  formatWorkingLabel,
  providerDisplayName,
} from "../format";
import { sidebarPrBadge } from "../prUi";
import {
  buildSidebarGroups,
  groupHeaderSummary,
  partitionSidebar,
} from "../sidebarGroups";
import {
  AUTO_SETTLE_AFTER_DAYS,
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
  effectiveSettled,
  resolveSettledTimestamp,
} from "../threadSettle";
import {
  SNOOZE_PRESETS,
  formatSnoozeWakeLabel,
  isPinned,
  snoozePresetUntil,
} from "../threadSnooze";
import { countUnread, isUnread } from "../threadUnread";
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
  searchPlaceholder: string;
  projectsHeader: string;
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  /** Provider registry for display names on thread cards. */
  providers: ProviderInfo[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  /** Global + uses selected project; per-group New thread passes that projectId. */
  onCreateThread: (projectId?: string) => void;
  onAddProject: () => void;
  /**
   * t3-style remove project entry (after the sidebar confirm). Caller owns
   * the IPC call, selection handoff, and failure toast. Resolves on success;
   * rejects on failure so the confirm can close either way.
   */
  onRemoveProject?: (projectId: string) => void | Promise<void>;
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
  /** Archive a thread (batch toolbar). */
  onSetArchived?: (threadId: string, archived: boolean) => void | Promise<void>;
  /**
   * Fork / hand off (round 49). Plain call = same harness; provider override
   * is hand-off. Does not require the thread to be selected.
   */
  onFork?: (
    threadId: string,
    opts?: { provider?: string },
  ) => void | Promise<void>;
  /** Which main view is showing. Defaults to thread so existing callers stay idle. */
  activeView?: "thread" | "kanban" | "prs" | "automations";
  onOpenKanban?: () => void;
  onOpenPrs?: () => void;
  /**
   * Paste a GitHub issue into this project. Omitted by existing tests so
   * the icon button stays hidden.
   */
  onCreateThreadFromIssue?: (input: {
    projectId: string;
    projectPath: string;
    ref: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onOpenAutomations?: () => void;
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
}: {
  thread: ThreadInfo;
  now: number;
}) {
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

  if (thread.status === "done") {
    return (
      <span className={`${styles.badge} ${styles.badgeDone}`}>
        <span className={styles.check} aria-hidden>
          ✓
        </span>
        Done
      </span>
    );
  }

  if (thread.status === "failed") {
    return (
      <span className={`${styles.badge} ${styles.badgeFailed}`}>
        Failed
      </span>
    );
  }

  return null;
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
  onFork,
  snoozeMenuOpen = false,
  onToggleSnoozeMenu,
  forkMenuOpen = false,
  onToggleForkMenu,
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
  onFork?: (
    threadId: string,
    opts?: { provider?: string },
  ) => void | Promise<void>;
  snoozeMenuOpen?: boolean;
  onToggleSnoozeMenu?: (threadId: string | null) => void;
  forkMenuOpen?: boolean;
  onToggleForkMenu?: (threadId: string | null) => void;
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
          <span className={styles.repo}>{slug}</span>
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
          <div className={styles.cardTitle}>{thread.title}</div>
        </div>
        <div className={styles.cardTags}>
          <span className={styles.providerTag}>{providerLabel}</span>
          {thread.worktreePath && (
            <span className={styles.worktreeTag}>wt</span>
          )}
          {thread.archived && (
            <span className={styles.archivedTag}>archived</span>
          )}
          {contentMatch && (
            <span className={styles.inMessagesTag}>in messages</span>
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
          <StatusBadge thread={thread} now={now} />
        </div>
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
              {isPinned(thread) ? "★" : "☆"}
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
                zzz
              </button>
              {snoozeMenuOpen && (
                <div
                  className={styles.snoozeMenu}
                  role="menu"
                  data-snooze-menu={thread.id}
                >
                  {SNOOZE_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={styles.snoozeMenuItem}
                      role="menuitem"
                      data-snooze-preset={p.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onSetSnoozed(
                          thread.id,
                          snoozePresetUntil(p.id, now),
                        );
                        onToggleSnoozeMenu?.(null);
                      }}
                    >
                      {p.label}
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
                →
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
              {isSettled ? "↑" : "↓"}
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
            ★
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
            ↑
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
  multiSelected = false,
  indexHint = null,
}: {
  thread: ThreadInfo;
  slug: string;
  active: boolean;
  now: number;
  onSelect: (id: string, opts?: SelectOpts) => void;
  onSetSnoozed?: (threadId: string, until: number | null) => void | Promise<void>;
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
      {onSetSnoozed && (
        <div className={styles.cardActions}>
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
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  appName,
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
  projectError = null,
  onDismissProjectError,
  onOpenSettings,
  spendTodayUsd = null,
  dailyBudgetUsd = null,
  autoSettleAfterDays,
  searchThreads,
  onSetSettled,
  onSetPinned,
  onSetSnoozed,
  onSetArchived,
  onFork,
  activeView = "thread",
  onOpenKanban,
  onOpenPrs,
  onCreateThreadFromIssue,
  onOpenAutomations,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /** Which thread's snooze preset menu is open (one at a time). */
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<string | null>(null);
  /** Which thread's hand-off provider menu is open (one at a time). */
  const [forkMenuFor, setForkMenuFor] = useState<string | null>(null);
  useEscapeClose(snoozeMenuFor != null, () => setSnoozeMenuFor(null));
  useEscapeClose(forkMenuFor != null, () => setForkMenuFor(null));
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
  /** Group keys the user collapsed. Survives restarts: collapsing a noisy
   *  project is a lasting choice, not a per-session whim. */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    loadKeySet(COLLAPSED_KEY),
  );
  /**
   * Global settled tail open state. Session-only (t3: out of the way, never
   * gone). Collapsed by default so attention work stays scannable.
   */
  const [settledTailOpen, setSettledTailOpen] = useState(false);
  /** How many settled rows to show when the tail is expanded. */
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    SETTLED_TAIL_INITIAL_COUNT,
  );
  /** Snoozed shelf open state (session-only, collapsed by default like settled). */
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
    }),
    [now, autoSettleAfterDays],
  );
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
   */
  const groups = useMemo(() => {
    if (searching) {
      const projectsWithHits = projects.filter((p) =>
        displayThreads.some((t) => t.projectId === p.id),
      );
      return buildSidebarGroups(projectsWithHits, displayThreads);
    }
    const attentionIds = new Set(attentionThreads.map((t) => t.id));
    const forGroups = displayThreads.filter(
      (t) => t.archived || attentionIds.has(t.id),
    );
    return buildSidebarGroups(projects, forGroups);
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

  const canCreate = projects.length > 0;
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

  /** Ordered visible ids — matches render order (round 46). */
  const visibleIds = useMemo(
    () =>
      buildVisibleThreadIds({
        pinned: searching ? [] : globalPinned,
        groups,
        collapsedGroupKeys: searching ? new Set() : collapsedGroups,
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
      groups,
      collapsedGroups,
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

  // Jump shortcuts + cmd index hints + keyboard sheet.
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
  }, [visibleIds, activeThreadId, onSelectThread, keyboardSheetOpen]);

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
    return (
      <div className={styles.groupThreadActions}>
        <button
          type="button"
          className={styles.groupNewThread}
          onClick={() => onCreateThread(project.id)}
        >
          New thread
        </button>
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
            #
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
          <span className={styles.brandMark}>◇</span>
          <span className={styles.brandName}>{appName}</span>
        </div>
        <button
          type="button"
          className={styles.headerAdd}
          onClick={() => onCreateThread()}
          disabled={!canCreate}
          title={
            canCreate
              ? "New thread"
              : "Add a project before creating a thread"
          }
          aria-label="New thread"
        >
          +
        </button>
      </header>

      <div className={styles.searchRow}>
        <span className={styles.searchIcon} aria-hidden>
          ⌕
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
          data-view-nav="kanban"
          data-active={activeView === "kanban" ? "true" : undefined}
          title="Kanban"
          onClick={() => onOpenKanban?.()}
        >
          <span className={styles.viewNavIcon} aria-hidden>
            ▦
          </span>
          Kanban
        </button>
        <button
          type="button"
          className={styles.viewNavRow}
          data-view-nav="prs"
          data-active={activeView === "prs" ? "true" : undefined}
          title="Pull requests"
          onClick={() => onOpenPrs?.()}
        >
          <span className={styles.viewNavIcon} aria-hidden>
            ⇄
          </span>
          Pull requests
        </button>
        <button
          type="button"
          className={styles.viewNavRow}
          data-view-nav="automations"
          data-active={activeView === "automations" ? "true" : undefined}
          title="Automations"
          onClick={() => onOpenAutomations?.()}
        >
          <span className={styles.viewNavIcon} aria-hidden>
            ⟳
          </span>
          Automations
        </button>
      </nav>

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
          ▸
        </span>
        <span>{projectsHeader}</span>
        <span className={styles.count}>{sectionCount}</span>
      </button>

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
          <div className={styles.pinnedSection} data-pinned-section="">
            <div className={styles.pinnedHeader}>
              <span>Pinned · {globalPinned.length}</span>
            </div>
            {globalPinned.map((thread) => (
              <SettledRow
                key={thread.id}
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

        {groups.map(({ project, threads: groupThreads }) => {
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

            return (
              <div key={groupKey} className={styles.group}>
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
                      ▸
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
                  {project && onRemoveProject && !searching && (
                    <button
                      type="button"
                      className={styles.groupRemove}
                      aria-label={`Remove project ${slug}`}
                      title="Remove project"
                      data-project-remove={project.id}
                      onClick={() => setRemoveConfirmId(project.id)}
                    >
                      ×
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
                    {attentionThreads.map((thread) => (
                      <ThreadCard
                        key={thread.id}
                        thread={thread}
                        slug={slug}
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
                        onFork={onFork}
                        snoozeMenuOpen={snoozeMenuFor === thread.id}
                        onToggleSnoozeMenu={setSnoozeMenuFor}
                        forkMenuOpen={forkMenuFor === thread.id}
                        onToggleForkMenu={setForkMenuFor}
                        contentMatch={
                          searching &&
                          !thread.title.toLowerCase().includes(queryLower)
                        }
                      />
                    ))}
                    {archivedExpanded &&
                      archivedThreads.map((thread) => (
                        <ThreadCard
                          key={thread.id}
                          thread={thread}
                          slug={slug}
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
                          contentMatch={
                            searching &&
                            !thread.title.toLowerCase().includes(queryLower)
                          }
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

        {/* Global SNOOZED shelf (t3): between groups and settled, collapsed by default. */}
        {!searching && globalSnoozed.length > 0 && (
          <div className={styles.snoozedShelf} data-snoozed-shelf="">
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
                ▸
              </span>
              <span>
                Snoozed · {globalSnoozed.length}
              </span>
            </button>
            {snoozedOpen &&
              globalSnoozed.map((thread) => (
                <SnoozedRow
                  key={thread.id}
                  thread={thread}
                  slug={slugFor(thread)}
                  active={thread.id === activeThreadId}
                  multiSelected={multiSelected.has(thread.id)}
                  indexHint={indexHintFor(thread.id)}
                  now={now}
                  onSelect={handleSelect}
                  onSetSnoozed={onSetSnoozed}
                />
              ))}
          </div>
        )}

        {/* Global settled tail (t3-style): one section at the bottom, all projects.
            Independent of per-project / collapse-all — has its own toggle. */}
        {!searching && globalSettled.length > 0 && (
          <div className={styles.settledTail} data-settled-tail="">
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
            <button
              type="button"
              className={styles.settledTailHeader}
              onClick={toggleSettledTail}
              aria-expanded={settledTailOpen}
            >
              <span className={styles.chevron} data-open={settledTailOpen}>
                ▸
              </span>
              <span>
                Settled · {globalSettled.length}
                {(() => {
                  const n = countUnread(globalSettled);
                  return n > 0 ? ` · ${n} unread` : "";
                })()}
              </span>
            </button>
            {settledTailOpen &&
              visibleSettled.map((thread) => (
                <SettledRow
                  key={thread.id}
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
              ×
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
            onClick={() => onOpenSettings?.()}
          >
            <span className={styles.settingsIcon} aria-hidden>
              ⚙
            </span>
            Settings
          </button>
          {projects.length > 0 && (
            <button
              type="button"
              className={styles.footerAdd}
              onClick={onAddProject}
              title="Add project"
              aria-label="Add project"
            >
              +
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
}
