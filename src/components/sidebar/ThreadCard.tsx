import { memo, useRef, useState, useSyncExternalStore } from "react";
import type {
  ConflictForecast,
  ProjectInfo,
  ProviderInfo,
  TeleportTarget,
  ThreadInfo,
} from "../../shared/ipc";
import {
  forecastHoverLines,
  formatForecastHoverLine,
  pairsForThread,
} from "../../conflictForecast";
import { formatRelativeAge, middleTruncate } from "../../format";
import { isCrewWorker } from "../../sidebarGroups";
import { hasNonEmptyDraft, subscribeDrafts } from "../../composerSession";
import { ProviderMark } from "../ProviderMark";
import { showContextMenu } from "../../contextMenu";
import {
  canDetachThread,
  detachThread,
  droppedOutsideWindow,
} from "../../detachedWindow";
import { buildThreadActionMenuItems } from "../../threadActionMenu";
import { CustomSnoozeDialog } from "../CustomSnoozeDialog";
import { loadHosts } from "../../remoteHosts";
import { isPinned, resolveSnoozePresets } from "../../threadSnooze";
import { isUnread } from "../../threadUnread";
import { ProjectIcon } from "../ProjectIcon";
import { PrHoverTarget, repoFromGithubUrl } from "../PrHoverCard";
import {
  subagentNames,
  waitLabel,
  waitTooltip,
  type WaitState,
} from "../../waiting";
import {
  displayWorkerTitle,
  statusLabelFor,
  statusPulseFor,
  type StatusLabelInfo,
  type StatusPulseTone,
} from "./status";
import { Icon } from "./Icon";
import styles from "../Sidebar.module.css";

export type SelectOpts = { meta?: boolean; shift?: boolean };

/**
 * F4 diamond (#1429): the logo glyph as the status marker. Hollow when
 * queued; only a live "Working" run pulses (statusPulseFor).
 */
function StatusMarker({
  tone,
  pulse,
}: {
  tone: StatusLabelInfo["tone"];
  pulse: StatusPulseTone | null;
}) {
  return (
    <span
      className={styles.statusMarker}
      data-marker={tone}
      data-status-dot={pulse ?? undefined}
      aria-hidden
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
  iconUrl = null,
  providers,
  active,
  now,
  onSelect,
  projectPath = null,
  contentMatch,
  isSettled = false,
  multiSelected = false,
  indexHint = null,
  onSetSettled,
  onSetPinned,
  onSetSnoozed,
  onSetTags,
  onSetThreadProject,
  onSetMuted,
  onSetEjected,
  onTeleport,
  onRenameThread,
  onRegenerateTitle,
  regeneratingTitle = false,
  onFork,
  onToggleSnoozeMenu,
  nested = false,
  compact = false,
  familySummary = null,
  familyExpanded = false,
  familyAttention = false,
  onToggleFamily,
  wait = null,
  showSlug = true,
  conflictForecast = null,
  threadTitles,
  listMoveProjects,
  onDragStartRow,
  onDragOverRow,
  onDropRow,
  onDragEndRow,
  dropIndicator = null,
  dragging = false,
}: {
  thread: ThreadInfo;
  slug: string;
  /** The thread's project checkout path, for the PR hover card's gh call (#1771). */
  projectPath?: string | null;
  iconUrl?: string | null;
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
  onSetTags?: (threadId: string, tags: string[]) => void | Promise<void>;
  onSetThreadProject?: (
    threadId: string,
    projectId: string,
  ) => void | Promise<void>;
  onSetMuted?: (threadId: string, muted: boolean) => void | Promise<void>;
  /** Live project list at menu-open time. Stable identity (ref getter). */
  listMoveProjects?: () => readonly ProjectInfo[];
  onSetEjected?: (threadId: string, ejected: boolean) => void | Promise<void>;
  /** Teleport to a saved host, or back with null (#1702). */
  onTeleport?: (threadId: string, target: TeleportTarget | null) => void | Promise<void>;
  onRenameThread?: (threadId: string, title: string) => void | Promise<void>;
  /** Regenerate the title from current activity (issue #1774). */
  onRegenerateTitle?: (threadId: string) => void | Promise<void>;
  /** This row's title is being regenerated (#1774); cheap inline state. */
  regeneratingTitle?: boolean;
  onFork?: (
    threadId: string,
    opts?: { provider?: string },
  ) => void | Promise<void>;
  /** Parent bookkeeping: which card has its (native/portal) menu open. */
  onToggleSnoozeMenu?: (threadId: string | null) => void;
  nested?: boolean;
  compact?: boolean;
  familySummary?: string | null;
  familyExpanded?: boolean;
  familyAttention?: boolean;
  onToggleFamily?: (threadId: string, snap?: boolean) => void;
  wait?: WaitState | null;
  showSlug?: boolean;
  conflictForecast?: ConflictForecast | null;
  threadTitles?: ReadonlyMap<string, string>;
  /**
   * Manual drag reorder (#1769). The card only reports the native drag
   * events on its outer row, passing its own id — same shape as
   * onSetPinned etc. — so Sidebar can pass one stable function to every
   * card without defeating this component's memo (#617). Sidebar owns the
   * section order, the pure midpoint math (src/threadOrder.ts) and the
   * persisted patch.
   */
  onDragStartRow?: (threadId: string) => void;
  onDragOverRow?: (threadId: string, e: React.DragEvent<HTMLDivElement>) => void;
  onDropRow?: (threadId: string, e: React.DragEvent<HTMLDivElement>) => void;
  onDragEndRow?: (threadId: string) => void;
  /** Drop indicator line rendered above/below this row while dragging. */
  dropIndicator?: "before" | "after" | null;
  /** This row is the one currently being dragged (reorder, not detach). */
  dragging?: boolean;
}) {
  const working = thread.status === "working";
  const settleOverride = isSettled ? ("active" as const) : ("settled" as const);
  const settleLabel = isSettled ? "Keep thread active" : "Settle thread";
  const showUnread = !active && isUnread(thread);
  const label = statusLabelFor(thread, now, wait, active);
  const pulse = statusPulseFor(thread, now, wait ?? null, active);
  const pinned = isPinned(thread);
  const showProject = showSlug && !compact;
  // A plain fork is usually "Fork: <lead title>"; stripping that under the
  // lead would make it read as a second copy of its lead.
  const shownTitle =
    compact && isCrewWorker(thread)
      ? displayWorkerTitle(thread.title)
      : thread.title;
  const subagentLines = wait ? subagentNames(wait) : [];
  // Menus are native Menu.popup / a body portal (#592) — the card only
  // tracks openness so the hover actions stay pinned underneath.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBusy = useRef(false);
  const actionsOpen = menuOpen;
  const selectLabel = [
    `Select thread: ${shownTitle}`,
    showUnread ? "unread" : null,
    pinned ? "pinned" : null,
    label ? label.spoken : null,
  ]
    .filter(Boolean)
    .join(", ");
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renamingRef = useRef(false);
  const [editingTags, setEditingTags] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  /** "Custom…" snooze: native menus cannot host a date/time input (#1766). */
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const forecastPairs = pairsForThread(conflictForecast, thread.id);
  const providerId = thread.provider || "";
  // Reactive (#1770): subscribes to composer writes rather than reading
  // localStorage/keptDrafts on every row's render.
  // Server snapshot: renderToString (prRender tests) has no drafts.
  const hasDraft = useSyncExternalStore(
    subscribeDrafts,
    () => hasNonEmptyDraft(thread.id),
    () => false,
  );
  const hasLine3 =
    Boolean(thread.branch) ||
    (thread.prNumber != null && Boolean(thread.prUrl)) ||
    forecastPairs.length > 0 ||
    Boolean(providerId) ||
    hasDraft;

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

  const startTagEdit = () => {
    setTagDraft("");
    setEditingTags(true);
    onToggleSnoozeMenu?.(null);
  };

  // Server/fakes normalize (trim, lowercase, dedupe, caps) — pass raw.
  const addTag = (raw: string) => {
    const next = raw.trim();
    if (!next) return;
    void onSetTags?.(thread.id, [...(thread.tags ?? []), next]);
  };

  const removeTag = (tag: string) => {
    void onSetTags?.(
      thread.id,
      (thread.tags ?? []).filter((t) => t !== tag),
    );
  };

  const finishTagEdit = (cancel: boolean) => {
    setEditingTags(false);
    if (cancel) return;
    addTag(tagDraft);
  };

  const applyMenuId = (
    id: string,
    presets: ReturnType<typeof resolveSnoozePresets>,
    teleportTargets: ReadonlyArray<TeleportTarget>,
  ) => {
    if (id === "settle") void onSetSettled?.(thread.id, "settled");
    else if (id === "unsettle") void onSetSettled?.(thread.id, "active");
    else if (id === "unsnooze") void onSetSnoozed?.(thread.id, null);
    else if (id === "snooze:custom") setCustomSnoozeOpen(true);
    else if (id.startsWith("snooze:")) {
      const preset = presets.find((p) => `snooze:${p.id}` === id);
      if (preset) void onSetSnoozed?.(thread.id, preset.until);
    } else if (id === "pin") void onSetPinned?.(thread.id, true);
    else if (id === "unpin") void onSetPinned?.(thread.id, false);
    else if (id === "fork") void onFork?.(thread.id);
    else if (id.startsWith("handoff:")) {
      void onFork?.(thread.id, { provider: id.slice("handoff:".length) });
    } else if (id === "rename") startRename();
    else if (id === "regenerateTitle") void onRegenerateTitle?.(thread.id);
    else if (id === "tags") startTagEdit();
    else if (id === "copyLink") {
      void navigator.clipboard?.writeText(`solenta://thread/${thread.id}`).catch(() => {});
    }
    else if (id.startsWith("project:")) {
      void onSetThreadProject?.(thread.id, id.slice("project:".length));
    } else if (id === "mute") void onSetMuted?.(thread.id, true);
    else if (id === "unmute") void onSetMuted?.(thread.id, false);
    else if (id === "eject") void onSetEjected?.(thread.id, true);
    else if (id === "reclaim") void onSetEjected?.(thread.id, false);
    else if (id === "teleportBack") void onTeleport?.(thread.id, null);
    else if (id.startsWith("teleport:")) {
      const target = teleportTargets[Number(id.slice("teleport:".length))];
      if (target) void onTeleport?.(thread.id, target);
    }
    else if (id === "detach") detachThread(thread.id);
  };

  const openThreadMenu = async (position: { x: number; y: number }) => {
    if (menuBusy.current || renaming || editingTags) return;
    const presets = resolveSnoozePresets(Date.now());
    const teleportTargets = onTeleport
      ? loadHosts().map((h) => ({ host: h.host, remotePort: h.remotePort, label: h.label }))
      : undefined;
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
      showRegenerateTitle: Boolean(onRegenerateTitle),
      showTags: Boolean(onSetTags),
      showCopyLink: true,
      showMove: Boolean(onSetThreadProject),
      projects: listMoveProjects?.() ?? [],
      showMute: Boolean(onSetMuted),
      showEject: Boolean(onSetEjected),
      teleportTargets,
      showSettle: Boolean(onSetSettled),
      showDetach: canDetachThread(),
    });
    if (items.length === 0) return;
    menuBusy.current = true;
    setMenuOpen(true);
    onToggleSnoozeMenu?.(thread.id);
    try {
      const id = await showContextMenu(items, position);
      if (id) applyMenuId(id, presets, teleportTargets ?? []);
    } finally {
      menuBusy.current = false;
      setMenuOpen(false);
      onToggleSnoozeMenu?.(null);
    }
  };

  const hasActions = Boolean(
    onSetSettled || onSetPinned || onSetSnoozed || onSetTags || onSetThreadProject || onFork || onRenameThread || onRegenerateTitle || onSetMuted || onSetEjected || onTeleport,
  );

  // Card is a non-interactive shell. Stretch select + hover actions are
  // separate focusables. Content sits in a sibling with pointer-events:none
  // so clicks fall through to select; PR <a> and actions re-enable.
  return (
    <>
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
      data-compact={compact ? "true" : undefined}
      data-actions-open={actionsOpen ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-drop-indicator={dropIndicator ?? undefined}
      onContextMenu={(e) => {
        if (renaming || editingTags) return;
        if ((e.target as HTMLElement).closest("input, a, textarea")) return;
        e.preventDefault();
        e.stopPropagation();
        void openThreadMenu({ x: e.clientX, y: e.clientY });
      }}
      onDragOver={onDragOverRow && ((e) => onDragOverRow(thread.id, e))}
      onDrop={onDropRow && ((e) => onDropRow(thread.id, e))}
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
        // Drag a card out of the window to detach it (#519), or drop it
        // elsewhere in the pinned/active section to reorder it (#1769).
        // canDetachThread() used to gate this attribute, so reordering
        // never worked in web mode; dragging now always starts, and
        // detach stays desktop-only at the onDragEnd check below.
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-solenta-thread", thread.id);
          e.dataTransfer.effectAllowed = "move";
          onDragStartRow?.(thread.id);
        }}
        onDragEnd={(e) => {
          onDragEndRow?.(thread.id);
          if (canDetachThread() && droppedOutsideWindow(e)) detachThread(thread.id);
        }}
        aria-label={selectLabel}
      />
      <div className={styles.cardBody}>
        {!compact && (
        <div className={styles.cardLine1}>
          <ProjectIcon url={iconUrl} name={slug} seed={thread.projectId} size={16} />
          {showProject && (
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
                    (label.tone === "working" || label.tone === "delegating") &&
                    !active
                      ? "true"
                      : undefined
                  }
                  title={label.title}
                  {...label.flags}
                >
                  <StatusMarker tone={label.tone} pulse={pulse} />
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
                        [
                          ...presets.map((p) => ({
                            id: `snooze:${p.id}`,
                            label: p.label,
                            whenLabel: p.whenLabel,
                            attrs: { "data-snooze-preset": p.id },
                          })),
                          {
                            id: "snooze:custom",
                            label: "Custom…",
                            separatorBefore: true,
                            attrs: { "data-snooze-custom": "" },
                          },
                        ],
                        { x: rect.right, y: rect.bottom },
                      )
                        .then((id) => {
                          if (id) applyMenuId(id, presets, []);
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
                {(onSetSnoozed || onFork || onRenameThread || onSetMuted || onSetEjected || onSetSettled || onSetPinned || onSetTags || onSetThreadProject) && (
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
        )}
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
            <div
              className={styles.cardTitle}
              title={thread.title}
              data-regenerating-title={regeneratingTitle ? "" : undefined}
            >
              {regeneratingTitle ? "Regenerating…" : shownTitle}
            </div>
          )}
          {contentMatch && (
            <span className={styles.inMessagesTag}>in messages</span>
          )}
          {compact && (
            <span className={styles.cardSlot}>
              <span className={styles.cardStatus}>
                {label ? (
                  <span
                    className={styles.statusLabel}
                    data-status-label={label.text}
                    data-tone={label.tone}
                    title={label.title}
                    {...label.flags}
                  >
                    <StatusMarker tone={label.tone} pulse={pulse} />
                    {label.text}
                  </span>
                ) : (
                  <span className={styles.age}>
                    {formatRelativeAge(thread.updatedAt, now)}
                  </span>
                )}
              </span>
            </span>
          )}
        </div>
        {editingTags ? (
          <div className={styles.tagEditor} data-tag-editor={thread.id}>
            {(thread.tags ?? []).map((tag) => (
              <span key={tag} className={styles.tagChip} data-tag-chip={tag}>
                {tag}
                <button
                  type="button"
                  className={styles.tagChipRemove}
                  aria-label={`Remove tag ${tag}`}
                  data-tag-remove={tag}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTag(tag);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className={styles.tagInput}
              data-tag-input={thread.id}
              value={tagDraft}
              maxLength={24}
              placeholder="Add tag"
              aria-label="Add tag"
              autoFocus
              onChange={(e) => setTagDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={() => finishTagEdit(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag(tagDraft);
                  setTagDraft("");
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  finishTagEdit(true);
                } else if (
                  e.key === "Backspace" &&
                  tagDraft === "" &&
                  (thread.tags ?? []).length > 0
                ) {
                  e.preventDefault();
                  removeTag((thread.tags ?? []).at(-1)!);
                }
              }}
            />
          </div>
        ) : (
          !compact &&
          (thread.tags ?? []).length > 0 && (
            <div className={styles.tagRow} data-tag-row={thread.id}>
              {(thread.tags ?? []).map((tag) => (
                <span key={tag} className={styles.tagChip} data-tag-chip={tag}>
                  {tag}
                </span>
              ))}
            </div>
          )
        )}
        {!compact && hasLine3 && (
          <div className={styles.cardLine3}>
            {thread.worktreePath ? (
              <span
                className={styles.cardWorktree}
                data-card-worktree=""
                role="img"
                aria-label="Worktree"
                title={`Worktree: ${thread.worktreePath}`}
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
                  <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h2.2a1.5 1.5 0 0 1 1.1.5l.8 1a1.5 1.5 0 0 0 1.1.5H12A1.5 1.5 0 0 1 13.5 6v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V4Z" />
                  <circle cx="8" cy="8.5" r="1.3" />
                </svg>
              </span>
            ) : null}
            {thread.branch ? (
              <span
                className={styles.cardBranch}
                data-card-branch=""
                title={thread.branch}
              >
                {middleTruncate(thread.branch, 32, 0.65)}
              </span>
            ) : (
              <span className={styles.cardBranchSpacer} />
            )}
            {thread.prNumber != null && thread.prUrl && (
              <PrHoverTarget
                projectPath={projectPath}
                repo={repoFromGithubUrl(thread.prUrl)}
                number={thread.prNumber}
              >
                <a
                  className={styles.prLink}
                  data-pr-badge=""
                  data-pr-state={thread.prState?.toLowerCase()}
                  title={
                    thread.prState
                      ? `PR #${thread.prNumber} ${thread.prState.toLowerCase()}`
                      : undefined
                  }
                  href={thread.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <circle cx="4" cy="3.5" r="1.5" />
                    <circle cx="4" cy="12.5" r="1.5" />
                    <circle cx="12" cy="12.5" r="1.5" />
                    <path
                      d={
                        thread.prState === "MERGED"
                          ? "M4 5v6M4 5c0 4 8 3 8 6"
                          : "M4 5v6M12 11V6a2 2 0 0 0-2-2H8"
                      }
                    />
                  </svg>
                  #{thread.prNumber}
                </a>
              </PrHoverTarget>
            )}
            <ConflictForecastBadge
              threadId={thread.id}
              forecast={conflictForecast}
              titles={threadTitles}
            />
            {providerId ? (
              <ProviderMark
                providerId={providerId}
                providers={providers}
                className={styles.cardProvider}
              />
            ) : null}
            {hasDraft ? (
              <span
                className={styles.cardDraft}
                data-card-draft=""
                role="img"
                aria-label="Unsent draft"
                title="Unsent draft"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M11.4 2.4a1.4 1.4 0 0 1 2 2L5 12.8l-3 .8.8-3Z" />
                </svg>
              </span>
            ) : null}
          </div>
        )}
        {!compact && familySummary && onToggleFamily && (
          <button
            type="button"
            className={styles.familyToggle}
            data-family-toggle={thread.id}
            aria-expanded={familyExpanded}
            aria-label={`${familyExpanded ? "Hide" : "Show"} workers: ${familySummary}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFamily(thread.id, e.detail === 0);
            }}
          >
            <span
              className={styles.familyChevron}
              data-open={familyExpanded ? "true" : undefined}
              aria-hidden
            >
              <Icon size={10}>
                <path d="m9 6 6 6-6 6" />
              </Icon>
            </span>
            <span
              data-family-summary={thread.id}
              data-attention={familyAttention ? "true" : undefined}
            >
              {familySummary}
            </span>
          </button>
        )}
        {!compact && !familySummary && wait && (
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
        {!compact && subagentLines.slice(0, 3).map((name, i) => (
          <div
            key={i}
            className={styles.subagentRow}
            data-subagent-row={thread.id}
            title={name}
          >
            {name}
          </div>
        ))}
        {!compact && subagentLines.length > 3 && (
          <div className={styles.subagentRow} data-subagent-row={thread.id}>
            +{subagentLines.length - 3} more
          </div>
        )}
      </div>
    </div>
    {customSnoozeOpen && (
      <CustomSnoozeDialog
        onCancel={() => setCustomSnoozeOpen(false)}
        onSnooze={(until) => {
          void onSetSnoozed?.(thread.id, until);
          setCustomSnoozeOpen(false);
        }}
      />
    )}
    </>
  );
});
