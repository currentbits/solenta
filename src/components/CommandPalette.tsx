import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import { statusLabelFor } from "./sidebar/status";
import {
  groupPaletteItems,
  KIND_ORDER,
  paletteActionShortcut,
  paletteModeLabel,
  palettePlaceholder,
  rankPaletteItems,
  scoreMatch,
  splitSnippetMatch,
  type FileContentHit,
  type PaletteAction,
  type PaletteItem,
  type PaletteMode,
} from "../commandPalette";
import type {
  ProjectInfo,
  ThreadInfo,
  ThreadSearchInput,
  ThreadSearchResult,
  ThreadSearchMessagesInput,
  ThreadSearchMessagesResult,
} from "../shared/ipc";
import styles from "./CommandPalette.module.css";

const DEBOUNCE_MS = 150;
const RESULT_CAP = 40;
const RECENT_THREAD_CAP = 8;
const MESSAGE_RESULT_CAP = 8;
const MESSAGE_QUERY_MIN = 3;

export interface CommandPaletteProps {
  open: boolean;
  mode: PaletteMode;
  onClose: () => void;
  onModeChange: (mode: PaletteMode) => void;
  threads: ThreadInfo[];
  isThreadVisible?: (id: string) => boolean;
  projects: ProjectInfo[];
  searchThreads: (input: ThreadSearchInput) => Promise<ThreadSearchResult>;
  searchMessages: (
    input: ThreadSearchMessagesInput,
  ) => Promise<ThreadSearchMessagesResult>;
  listFiles?: (query: string, opts?: { limit?: number }) => Promise<string[]>;
  searchFileContents?: (query: string) => Promise<FileContentHit[]>;
  canSearchWorkspace: boolean;
  onSelectThread: (id: string) => void;
  onSelectMessage: (threadId: string, messageId: string) => void;
  onSelectProject: (projectId: string) => void;
  onRunAction: (id: string) => void;
  onOpenFile: (relPath: string, opts?: { reveal?: boolean }) => void;
  actions: readonly PaletteAction[];
}

function projectName(
  projects: readonly ProjectInfo[],
  projectId: string,
): string {
  return projects.find((p) => p.id === projectId)?.name ?? "";
}

/**
 * Compact status chip for a palette row (#1800): reuses the sidebar's
 * statusLabelFor rather than reinventing the status vocabulary/colours.
 * No wait-state or "currently open" context here, so those two inputs are
 * always null/false; that only affects the rarer delegating/woke labels.
 */
function threadStatus(thread: ThreadInfo): { text: string; tone: string } | null {
  const label = statusLabelFor(thread, Date.now(), null, false);
  return label ? { text: label.text, tone: label.tone } : null;
}

function threadSubtitle(
  thread: ThreadInfo,
  projects: readonly ProjectInfo[],
  fromContent: boolean,
): string {
  const name = projectName(projects, thread.projectId);
  const bits: string[] = [];
  if (name) bits.push(name);
  if (thread.archived) bits.push("archived");
  if (fromContent) bits.push("in transcript");
  return bits.join(" · ");
}

/* Leading row glyphs (#1860): 24-unit Lucide-style paths, one per action
   and a fallback per kind, so every row has the same left anchor. */
const ACTION_ICON: Record<string, string> = {
  "new-thread": "M12 5v14M5 12h14",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  "search-files": "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6",
  "search-content": "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4",
  kanban: "M5 4h4v16H5zM15 4h4v10h-4z",
  planboard: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  prs: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9",
  usage: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  fleet: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  insights: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
  digest: "M5 4h14v16H5zM9 8h6M9 12h6M9 16h4",
  approvals: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4",
  "add-project": "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6",
  "toggle-agents": "M4 4h16v16H4zM15 4v16",
  "reopen-pane": "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
  "restart-agent-session": "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  "stop-all-threads": "M7 7h10v10H7z",
};

const KIND_ICON: Record<PaletteItem["kind"], string> = {
  action: "M5 12h14M13 6l6 6-6 6",
  thread: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  message: "M7 8h10M7 12h6M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  project: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6",
  content: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4",
};

function rowIconPath(item: PaletteItem): string {
  if (item.kind === "action") {
    return ACTION_ICON[item.id.slice("action:".length)] ?? KIND_ICON.action;
  }
  return KIND_ICON[item.kind];
}

export function CommandPalette({
  open,
  mode,
  onClose,
  onModeChange,
  threads,
  isThreadVisible,
  projects,
  searchThreads,
  searchMessages,
  listFiles,
  searchFileContents,
  canSearchWorkspace,
  onSelectThread,
  onSelectMessage,
  onSelectProject,
  onRunAction,
  onOpenFile,
  actions,
}: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [contentHits, setContentHits] = useState<ThreadInfo[] | null>(null);
  const [messageHits, setMessageHits] = useState<
    ThreadSearchMessagesResult["hits"]
  >([]);
  const [files, setFiles] = useState<string[]>([]);
  const [grepHits, setGrepHits] = useState<FileContentHit[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const handleClose = useCallback(() => onClose(), [onClose]);
  useEscapeClose(open, handleClose);
  useModalFocus(open, dialogRef);
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    setContentHits(null);
    setMessageHits([]);
    setFiles([]);
    setGrepHits([]);
    setRemoteLoading(false);
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [mode, query]);

  // A leading ">" narrows the command palette to actions (#1506).
  const actionsOnly = mode === "command" && query.trimStart().startsWith(">");
  const trimmed = actionsOnly ? query.trimStart().slice(1).trim() : query.trim();

  useEffect(() => {
    if (!open || mode !== "command" || actionsOnly || trimmed.length < 2) {
      setContentHits(null);
      return;
    }
    const gen = { current: true };
    setRemoteLoading(true);
    const handle = window.setTimeout(() => {
      void searchThreads({ query: trimmed })
        .then((res) => {
          if (gen.current) setContentHits(res.threads);
        })
        .catch(() => {
          if (gen.current) setContentHits([]);
        })
        .finally(() => {
          if (gen.current) setRemoteLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      gen.current = false;
      window.clearTimeout(handle);
    };
  }, [open, mode, actionsOnly, trimmed, searchThreads]);

  // Separate debounce from the thread content-hits search above: both run
  // off the same query in "command" mode, and the backend already gives
  // them independent worker slots so one does not cancel the other (#1761).
  useEffect(() => {
    if (
      !open ||
      mode !== "command" ||
      actionsOnly ||
      trimmed.length < MESSAGE_QUERY_MIN
    ) {
      setMessageHits([]);
      return;
    }
    const gen = { current: true };
    const handle = window.setTimeout(() => {
      void searchMessages({ query: trimmed })
        .then((res) => {
          if (gen.current) setMessageHits(res.hits);
        })
        .catch(() => {
          if (gen.current) setMessageHits([]);
        });
    }, DEBOUNCE_MS);
    return () => {
      gen.current = false;
      window.clearTimeout(handle);
    };
  }, [open, mode, actionsOnly, trimmed, searchMessages]);

  useEffect(() => {
    if (!open || mode !== "files" || !canSearchWorkspace || !listFiles) {
      setFiles([]);
      return;
    }
    const gen = { current: true };
    setRemoteLoading(true);
    const handle = window.setTimeout(() => {
      void listFiles(trimmed, { limit: 50 })
        .then((list) => {
          if (gen.current) setFiles(list);
        })
        .catch(() => {
          if (gen.current) setFiles([]);
        })
        .finally(() => {
          if (gen.current) setRemoteLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      gen.current = false;
      window.clearTimeout(handle);
    };
  }, [open, mode, trimmed, canSearchWorkspace, listFiles]);

  useEffect(() => {
    if (!open || mode !== "content" || !canSearchWorkspace || !searchFileContents) {
      setGrepHits([]);
      return;
    }
    if (trimmed.length < 2) {
      setGrepHits([]);
      setRemoteLoading(false);
      return;
    }
    const gen = { current: true };
    setRemoteLoading(true);
    const handle = window.setTimeout(() => {
      void searchFileContents(trimmed)
        .then((list) => {
          if (gen.current) setGrepHits(list);
        })
        .catch(() => {
          if (gen.current) setGrepHits([]);
        })
        .finally(() => {
          if (gen.current) setRemoteLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      gen.current = false;
      window.clearTimeout(handle);
    };
  }, [open, mode, trimmed, canSearchWorkspace, searchFileContents]);

  const items = useMemo((): PaletteItem[] => {
    if (mode === "files") {
      if (!canSearchWorkspace) return [];
      return files.map((path) => ({
        id: `file:${path}`,
        kind: "file" as const,
        title: path.split("/").filter(Boolean).pop() || path,
        subtitle: path,
        target: path,
        score: 0,
      }));
    }
    if (mode === "content") {
      if (!canSearchWorkspace) return [];
      return grepHits.map((hit, i) => ({
        id: `content:${i}:${hit.path}:${hit.line}`,
        kind: "content" as const,
        title: `${hit.path}:${hit.line}`,
        subtitle: hit.text.trim(),
        target: hit.path,
        score: 0,
      }));
    }

    const seeds: Array<Omit<PaletteItem, "score"> & { haystack: string[] }> =
      [];
    for (const action of actions) {
      seeds.push({
        id: `action:${action.id}`,
        kind: "action",
        title: action.title,
        subtitle: action.subtitle,
        shortcut: paletteActionShortcut(action),
        haystack: [action.title, action.subtitle ?? "", action.keywords ?? ""],
      });
    }
    if (actionsOnly) return rankPaletteItems(seeds, trimmed, RESULT_CAP);
    if (trimmed.length > 0) {
      for (const project of projects) {
        seeds.push({
          id: `project:${project.id}`,
          kind: "project",
          title: project.name,
          subtitle: project.slug,
          haystack: [project.name, project.slug, project.path],
        });
      }
    }
    const byId = new Map(threads.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const addThread = (thread: ThreadInfo, fromContent: boolean) => {
      if (seen.has(thread.id) || isThreadVisible?.(thread.id) === false) return;
      seen.add(thread.id);
      const status = threadStatus(thread);
      seeds.push({
        id: `thread:${thread.id}`,
        kind: "thread",
        title: thread.title || "Untitled",
        subtitle: threadSubtitle(thread, projects, fromContent),
        statusText: status?.text,
        statusTone: status?.tone,
        haystack: [
          thread.title,
          projectName(projects, thread.projectId),
          thread.branch ?? "",
        ],
      });
    };
    const local =
      trimmed.length === 0
        ? [...threads]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, RECENT_THREAD_CAP)
        : threads;
    for (const thread of local) {
      if (
        trimmed.length > 0 &&
        scoreMatch(
          trimmed,
          thread.title,
          projectName(projects, thread.projectId),
          thread.branch ?? "",
        ) == null
      ) {
        continue;
      }
      addThread(thread, false);
    }
    if (contentHits) {
      for (const thread of contentHits) {
        addThread(byId.get(thread.id) ?? thread, true);
      }
    }
    const ranked = rankPaletteItems(seeds, trimmed, RESULT_CAP);
    if (!messageHits.length) return ranked;
    // Message hits are already relevance-ranked (newest first) by the
    // backend; the query rarely matches their thread title, so they skip
    // rankPaletteItems' scoreMatch (it would just drop them) and are
    // merged in after, sorted into KIND_ORDER's "message" slot.
    const messageItems: PaletteItem[] = messageHits
      .filter((hit) => isThreadVisible?.(hit.threadId) !== false)
      .slice(0, MESSAGE_RESULT_CAP)
      .map((hit) => {
        const hitThread = byId.get(hit.threadId);
        const status = hitThread ? threadStatus(hitThread) : null;
        return {
          id: `message:${hit.threadId}:${hit.messageId}`,
          kind: "message" as const,
          title: hitThread?.title || "Untitled",
          subtitle: hit.snippet,
          statusText: status?.text,
          statusTone: status?.tone,
          score: 0,
        };
      });
    const combined = [...ranked, ...messageItems];
    combined.sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
    );
    return combined;
  }, [
    mode,
    files,
    grepHits,
    actions,
    projects,
    threads,
    isThreadVisible,
    canSearchWorkspace,
    contentHits,
    messageHits,
    actionsOnly,
    trimmed,
  ]);

  const groups = useMemo(() => groupPaletteItems(items), [items]);
  const clampedIndex = items.length === 0 ? 0 : Math.min(index, items.length - 1);
  const active = items[clampedIndex] ?? null;

  useEffect(() => {
    if (!open) return;
    const root = listRef.current;
    if (!root) return;
    const row = root.querySelector<HTMLElement>(
      `[data-palette-index="${clampedIndex}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [open, clampedIndex, items.length]);

  const runItem = useCallback(
    (item: PaletteItem) => {
      if (item.kind === "action") {
        const id = item.id.slice("action:".length);
        if (id === "search-files") {
          setQuery("");
          onModeChange("files");
          return;
        }
        if (id === "search-content") {
          setQuery("");
          onModeChange("content");
          return;
        }
        onClose();
        onRunAction(id);
        return;
      }
      if (item.kind === "thread") {
        onClose();
        onSelectThread(item.id.slice("thread:".length));
        return;
      }
      if (item.kind === "message") {
        const rest = item.id.slice("message:".length);
        const sep = rest.indexOf(":");
        onClose();
        onSelectMessage(rest.slice(0, sep), rest.slice(sep + 1));
        return;
      }
      if (item.kind === "project") {
        onClose();
        onSelectProject(item.id.slice("project:".length));
        return;
      }
      if (item.kind === "file") {
        const path = item.target || item.subtitle || item.title;
        onClose();
        onOpenFile(path, { reveal: path.endsWith("/") });
        return;
      }
      if (item.kind === "content") {
        const path = item.target;
        onClose();
        if (path) onOpenFile(path);
      }
    },
    [
      onClose,
      onModeChange,
      onOpenFile,
      onRunAction,
      onSelectMessage,
      onSelectProject,
      onSelectThread,
    ],
  );

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length === 0) return;
      setIndex((i) => (i + 1) % items.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      setIndex((i) => (i - 1 + items.length) % items.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (active) runItem(active);
    }
  };

  if (!open) return null;

  let empty = "No matching threads, projects, or actions";
  if (mode === "files") {
    empty = canSearchWorkspace
      ? remoteLoading
        ? "Searching files…"
        : "No matching files"
      : "Open a thread to search files in its project";
  } else if (mode === "content") {
    if (!canSearchWorkspace) {
      empty = "Open a thread to search file contents";
    } else if (trimmed.length < 2) {
      empty = "Type at least two characters to search file contents";
    } else if (remoteLoading) {
      empty = "Searching…";
    } else {
      empty = "No matching file contents";
    }
  } else if (remoteLoading && items.length === 0) {
    empty = "Searching…";
  }

  const activeId = active ? `palette-opt-${clampedIndex}` : undefined;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-command-palette=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={palettePlaceholder(mode)}
        tabIndex={-1}
        data-command-palette-dialog=""
        data-palette-mode={mode}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.searchRow}>
          <svg
            className={styles.searchIcon}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4" />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={palettePlaceholder(mode)}
            aria-label={palettePlaceholder(mode)}
            aria-autocomplete="list"
            aria-controls="command-palette-list"
            aria-activedescendant={activeId}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-command-palette-input=""
          />
          {actionsOnly || mode !== "command" ? (
            <span className={styles.mode}>{actionsOnly ? "Actions" : paletteModeLabel(mode)}</span>
          ) : null}
        </div>
        <div
          ref={listRef}
          className={styles.results}
          id="command-palette-list"
          role="listbox"
          aria-label="Results"
        >
          {items.length === 0 ? (
            <p className={styles.empty} data-command-palette-empty="">
              {empty}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.kind} className={styles.group}>
                <h3 className={styles.groupLabel}>{group.label}</h3>
                {group.items.map((item) => {
                  const i = items.indexOf(item);
                  const highlighted = i === clampedIndex;
                  const snippetMatch =
                    item.kind === "message" && item.subtitle
                      ? splitSnippetMatch(item.subtitle, trimmed)
                      : null;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      id={`palette-opt-${i}`}
                      role="option"
                      aria-selected={highlighted}
                      className={styles.row}
                      data-highlighted={highlighted ? "true" : undefined}
                      data-palette-kind={item.kind}
                      data-palette-index={i}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => runItem(item)}
                    >
                      <svg
                        className={styles.rowIcon}
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d={rowIconPath(item)} />
                      </svg>
                      <span className={styles.rowBody}>
                        <span className={styles.title}>{item.title}</span>
                        {item.subtitle ? (
                          <span className={styles.subtitle}>
                            {snippetMatch ? (
                              <>
                                {snippetMatch.pre}
                                <mark className={styles.match}>
                                  {snippetMatch.match}
                                </mark>
                                {snippetMatch.post}
                              </>
                            ) : (
                              item.subtitle
                            )}
                          </span>
                        ) : null}
                      </span>
                      {item.statusText ? (
                        <span
                          className={styles.statusChip}
                          data-palette-status={item.statusText}
                          data-tone={item.statusTone}
                        >
                          <span className={styles.statusDot} aria-hidden />
                          {item.statusText}
                        </span>
                      ) : null}
                      {item.shortcut ? (
                        <kbd className={styles.shortcut}>{item.shortcut}</kbd>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className={styles.footer}>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
