import { useCallback, useEffect, useRef, useState } from "react";
import { ProjectIcon } from "../ProjectIcon";
import type {
  CoderApi,
  GitSyncInfo,
  MemoryEntryInfo,
  ProjectInfo,
  ProviderInfo,
  ThreadInfo,
} from "../../shared/ipc";
import { isDevBuild, resolveCoderApi } from "../../coderApi";
import {
  RETURN_VIEW_LABEL,
  type ReturnableView,
} from "../../viewReturn";
import type { ContextBreakdownSegment } from "../../contextBreakdown";
import type { ContextRingView } from "../../contextRing";
import { formatElapsed, formatRelativeAge } from "../../format";
import { useEscapeClose } from "../../useEscapeClose";
import styles from "../ThreadView.module.css";

const RING_R = 8;

const RING_C = 2 * Math.PI * RING_R;

/** Per-thread sandbox yes/no; reason lives on hover (#436). */
export function SandboxBadge({
  sandbox,
}: {
  sandbox: { sandboxed: boolean; reason: string };
}) {
  const label = sandbox.sandboxed ? "Sandboxed" : "Not sandboxed";
  return (
    <span
      className={styles.sandboxBadge}
      data-sandbox-badge=""
      data-sandboxed={sandbox.sandboxed ? "yes" : "no"}
      title={sandbox.reason}
      aria-label={`${label}: ${sandbox.reason}`}
    >
      {label}
    </span>
  );
}

/** Small context-fill ring + percent; hover/focus/`/context` opens the breakdown. */
export function ContextRingBadge({
  ring,
  segments,
  used,
  open,
  onOpenChange,
  onFork,
  onCompact,
}: {
  ring: ContextRingView;
  segments: ContextBreakdownSegment[];
  used: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFork?: () => void;
  /** Provider-native compaction; absent when the provider has none. */
  onCompact?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEscapeClose(open, useCallback(() => onOpenChange(false), [onOpenChange]));
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onOpenChange]);
  const label = `Context ${ring.percentLabel} of ${ring.windowLabel}`;
  return (
    <div
      className={styles.menuWrap}
      ref={wrapRef}
      onMouseEnter={() => onOpenChange(true)}
      onMouseLeave={() => onOpenChange(false)}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.contextRing}
        data-context-ring=""
        data-warn={ring.warn ? "true" : undefined}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onFocus={() => onOpenChange(true)}
        onBlur={(e) => {
          if (!wrapRef.current?.contains(e.relatedTarget as Node)) {
            onOpenChange(false);
          }
        }}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
          <circle cx="10" cy="10" r={RING_R} className={styles.ringTrack} />
          <circle
            cx="10"
            cy="10"
            r={RING_R}
            className={styles.ringFill}
            strokeDasharray={`${(ring.fraction * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span className={styles.ringLabel}>{ring.percentLabel}</span>
      </button>
      {open && (
        <div
          className={`${styles.menu} ${styles.contextPopover}`}
          role="region"
          aria-label="Context breakdown"
          data-context-popover=""
        >
          <div className={styles.contextPopoverHead}>
            <span>
              {used.toLocaleString()} / {ring.windowLabel}
            </span>
            <span>{ring.percentLabel}</span>
          </div>
          <ul className={styles.contextSegList}>
            {segments.map((seg) => (
              <li key={seg.key} className={styles.contextSeg}>
                <span>{seg.label}</span>
                <span className={styles.contextSegTokens}>
                  {seg.tokens.toLocaleString()}
                </span>
                <span className={styles.contextSegPct}>
                  {Math.round(seg.fraction * 100)}%
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.contextNote}>Estimated from the thread (chars÷4)</p>
          {(ring.warn || onCompact) && (
            <div className={styles.contextWarn}>
              {ring.warn && (
                <p className={styles.contextWarnNote}>Compaction is close</p>
              )}
              {onCompact && (
                <button
                  type="button"
                  className={styles.contextForkBtn}
                  data-context-compact=""
                  onClick={() => {
                    triggerRef.current?.focus();
                    onOpenChange(false);
                    onCompact();
                  }}
                >
                  Compact context
                </button>
              )}
              {ring.warn && onFork && (
                <button
                  type="button"
                  className={styles.contextForkBtn}
                  data-context-fork=""
                  onClick={() => {
                    triggerRef.current?.focus();
                    onOpenChange(false);
                    onFork();
                  }}
                >
                  Fork to fresh context
                </button>
              )}
              {ring.warn && onFork && !onCompact && (
                <p className={styles.contextNote}>
                  This provider can't compact in place, so /compact forks.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function syncPillLabel(info: GitSyncInfo | null): string | null {
  if (!info || !info.hasUpstream) return null;
  if (info.ahead === 0 && info.behind === 0) return "Synced";
  const parts: string[] = [];
  if (info.ahead > 0) parts.push(`${info.ahead} ahead`);
  if (info.behind > 0) parts.push(`${info.behind} behind`);
  return parts.join(" · ");
}

/**
 * Small upstream-state pill next to Push. Fetches then reads on mount and
 * whenever refreshNonce bumps (after a push); clicking refetches. Hidden
 * entirely when the thread root has no upstream.
 */
export function SyncPill({
  threadId,
  gitSyncInfo,
  gitFetch,
  refreshNonce,
}: {
  threadId: string;
  gitSyncInfo: (threadId: string) => Promise<GitSyncInfo>;
  gitFetch: (threadId: string) => Promise<void>;
  refreshNonce: number;
}) {
  const [info, setInfo] = useState<GitSyncInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const threadRef = useRef(threadId);
  threadRef.current = threadId;

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await gitFetch(threadId);
    } catch {
      // Offline or no remote: fall through to re-reading local state.
    }
    try {
      const next = await gitSyncInfo(threadId);
      if (threadRef.current === threadId) setInfo(next);
    } catch {
      if (threadRef.current === threadId) setInfo(null);
    } finally {
      if (threadRef.current === threadId) setBusy(false);
    }
  }, [threadId, gitFetch, gitSyncInfo]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshNonce]);

  const label = syncPillLabel(info);
  if (!label) return null;
  return (
    <button
      type="button"
      className={styles.syncPill}
      data-sync-pill=""
      title="Fetch from remote"
      aria-busy={busy || undefined}
      onClick={() => void refresh()}
    >
      {label}
    </button>
  );
}

/** "48s", "2m 14s", then formatElapsed's "1h 4m" past the hour. */
export function formatRunClock(from: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - from) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return formatElapsed(from, now);
}

/** Self-ticking so a running turn doesn't re-render the whole ThreadView. */
export function ElapsedClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className={styles.statusElapsed} data-run-elapsed="">
      {formatRunClock(since, now)}
    </span>
  );
}

/**
 * One header control that always names the next git step (issue #382).
 * Replaces the always-visible Push + Create PR pair.
 */
/** recent() caps at 50 server-side; a full page reads as "50+". */
const MEMORY_PILL_LIMIT = 50;

/**
 * New-thread memory pill (#1429 F8): what this project's agents already know.
 * Hidden when the memory server is down or the project has no entries.
 */
export function MemoryPill({
  projectPath,
  label,
}: {
  projectPath: string;
  label: string;
}) {
  const [entries, setEntries] = useState<MemoryEntryInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    setEntries(null);
    // Only an existing bridge (or the dev mock): never open a wire socket
    // just for a decorative pill.
    const api =
      (window as unknown as { coder?: CoderApi }).coder ??
      (isDevBuild() ? resolveCoderApi() : undefined);
    const recent = api?.memory?.recent;
    if (typeof recent !== "function") return;
    recent({ project: projectPath, limit: MEMORY_PILL_LIMIT }).then(
      (list) => {
        if (live) setEntries(list);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [projectPath]);
  if (!entries || entries.length === 0) return null;
  const n = entries.length;
  const count = n >= MEMORY_PILL_LIMIT ? `${n}+` : String(n);
  const last = entries[0]!;
  const at = Date.parse(last.createdAt);
  const age = Number.isFinite(at) ? formatRelativeAge(at) : null;
  const when = age == null ? "" : age === "now" ? " just now" : ` ${age} ago`;
  const tail = last.agent
    ? ` · last from ${last.agent}${when}`
    : when
      ? ` · last saved${when}`
      : "";
  return (
    <span className={styles.memoryPill} data-memory-pill="">
      <i className={styles.memoryDiamond} aria-hidden="true" />
      {`${count} ${n === 1 ? "memory" : "memories"} in ${label}${tail}`}
    </span>
  );
}

/** Dotted project name in the new-thread hero; picks move the draft. */
export function DraftProjectChooser({
  current,
  projects,
  onPick,
  onStartWithoutProject,
  label: labelOverride,
}: {
  current: ProjectInfo | null;
  projects: readonly ProjectInfo[];
  onPick?: (projectId: string) => void;
  /** "Start without a project" lives in this menu since #1429. */
  onStartWithoutProject?: () => void;
  /** Visible trigger text when there is no current project (Scratch). */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  useEscapeClose(open, () => setOpen(false));
  const label =
    labelOverride ?? (current ? current.slug || current.name : "this project");
  const others = onPick
    ? projects.filter((p) => p.id !== current?.id && !p.remoteHost && !p.scratch)
    : [];
  const markCls = current ? ` ${styles.mark}` : "";
  if (others.length === 0 && !onStartWithoutProject) {
    return <span className={`${styles.heroProject}${markCls}`}>{label}</span>;
  }
  return (
    <span className={styles.heroChooser} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.heroProject}${markCls}`}
        data-hero-project=""
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          others.length > 0
            ? "Move this draft to another project"
            : "Project options"
        }
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open ? (
        <span className={styles.heroMenu} role="menu" aria-label="Project">
          {others.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className={styles.heroMenuItem}
              data-hero-project-option={p.id}
              onClick={() => {
                setOpen(false);
                onPick?.(p.id);
              }}
            >
              <ProjectIcon
                url={p.iconUrl}
                name={p.slug || p.name}
                seed={p.id}
                size={14}
              />
              {p.slug || p.name}
            </button>
          ))}
          {onStartWithoutProject ? (
            <button
              type="button"
              role="menuitem"
              className={`${styles.heroMenuItem}${others.length > 0 ? ` ${styles.heroMenuSplit}` : ""}`}
              data-start-without-project=""
              onClick={() => {
                setOpen(false);
                onStartWithoutProject();
              }}
            >
              Start without a project
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Fork / Hand off in the thread header (moved from the Environment tab's
 * Fork card, same behaviour). The caller hides it while the thread is
 * working and on a draft header.
 */
export function HeaderForkControl({
  thread,
  providers,
  onFork,
}: {
  thread: ThreadInfo;
  providers: ProviderInfo[];
  onFork: (
    opts?: { provider?: string; model?: string | null },
  ) => void | Promise<void | ThreadInfo | null>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const others = providers.filter((p) => p.id !== thread.provider);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEscapeClose(open, () => setOpen(false));

  return (
    <>
      <button
        type="button"
        className={styles.btn}
        data-thread-fork=""
        title="Fork thread (same harness)"
        onClick={() => void onFork()}
      >
        Fork
      </button>
      {others.length > 0 ? (
        <div className={styles.menuWrap} ref={menuRef}>
          <button
            type="button"
            className={styles.btn}
            data-thread-handoff=""
            aria-haspopup="menu"
            aria-expanded={open}
            title="Hand off to another provider"
            onClick={() => setOpen((v) => !v)}
          >
            Hand off to…
          </button>
          {open && (
            <div className={styles.menu} role="menu" data-thread-handoff-menu="">
              {others.map((p) => {
                const disabled = !p.available;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-handoff-provider={p.id}
                    disabled={disabled}
                    aria-disabled={disabled ? "true" : undefined}
                    title={
                      disabled
                        ? `${p.name} is not installed`
                        : `Hand off to ${p.name}`
                    }
                    onClick={() => {
                      if (disabled) return;
                      setOpen(false);
                      void onFork({ provider: p.id });
                    }}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}

export function ReturnToViewButton({
  view,
  onClick,
}: {
  view: ReturnableView;
  onClick: () => void;
}) {
  const label = `Back to ${RETURN_VIEW_LABEL[view]}`;
  return (
    <button
      type="button"
      className={styles.btn}
      data-return-to={view}
      aria-label={label}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function returnToHeader(
  view: ReturnableView | null | undefined,
  onClick: (() => void) | undefined,
) {
  if (!view || !onClick) return null;
  return (
    <header className={styles.header} data-thread-header="">
      <ReturnToViewButton view={view} onClick={onClick} />
    </header>
  );
}
