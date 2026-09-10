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
import {
  groupPaletteItems,
  paletteModeLabel,
  palettePlaceholder,
  rankPaletteItems,
  scoreMatch,
  type FileContentHit,
  type PaletteAction,
  type PaletteItem,
  type PaletteMode,
} from "../commandPalette";
import type { ProjectInfo, ThreadInfo } from "../shared/ipc";
import styles from "./CommandPalette.module.css";

const DEBOUNCE_MS = 150;
const RESULT_CAP = 40;
const RECENT_THREAD_CAP = 8;

export interface CommandPaletteProps {
  open: boolean;
  mode: PaletteMode;
  onClose: () => void;
  onModeChange: (mode: PaletteMode) => void;
  threads: ThreadInfo[];
  projects: ProjectInfo[];
  searchThreads: (input: { query: string }) => Promise<ThreadInfo[]>;
  listFiles?: (query: string, opts?: { limit?: number }) => Promise<string[]>;
  searchFileContents?: (query: string) => Promise<FileContentHit[]>;
  canSearchWorkspace: boolean;
  onSelectThread: (id: string) => void;
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

export function CommandPalette({
  open,
  mode,
  onClose,
  onModeChange,
  threads,
  projects,
  searchThreads,
  listFiles,
  searchFileContents,
  canSearchWorkspace,
  onSelectThread,
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
    setFiles([]);
    setGrepHits([]);
    setRemoteLoading(false);
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [mode, query]);

  const trimmed = query.trim();

  useEffect(() => {
    if (!open || mode !== "command" || trimmed.length < 2) {
      setContentHits(null);
      return;
    }
    const gen = { current: true };
    setRemoteLoading(true);
    const handle = window.setTimeout(() => {
      void searchThreads({ query: trimmed })
        .then((list) => {
          if (gen.current) setContentHits(list);
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
  }, [open, mode, trimmed, searchThreads]);

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
        shortcut: action.shortcut,
        haystack: [action.title, action.subtitle ?? "", action.keywords ?? ""],
      });
    }
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
      if (seen.has(thread.id)) return;
      seen.add(thread.id);
      seeds.push({
        id: `thread:${thread.id}`,
        kind: "thread",
        title: thread.title || "Untitled",
        subtitle: threadSubtitle(thread, projects, fromContent),
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
    return rankPaletteItems(seeds, trimmed, RESULT_CAP);
  }, [
    mode,
    files,
    grepHits,
    actions,
    projects,
    threads,
    contentHits,
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
    [onClose, onModeChange, onOpenFile, onRunAction, onSelectProject, onSelectThread],
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
          <span className={styles.mode}>{paletteModeLabel(mode)}</span>
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
                      <span className={styles.rowBody}>
                        <span className={styles.title}>{item.title}</span>
                        {item.subtitle ? (
                          <span className={styles.subtitle}>{item.subtitle}</span>
                        ) : null}
                      </span>
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
            <kbd>⏎</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
