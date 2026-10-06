// Files pane (#1506): a lazy tree of the thread checkout with a read-only
// preview. Lines picked in the preview go to the composer as review chips.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  CoderApi,
  EditorId,
  EditorOption,
  FilePreview,
  FileTreeEntry,
} from "../shared/ipc";
import type { ReviewComment } from "../diffView";
import { formatBytes } from "../format";
import { languageForPath, useHighlightedLines } from "../syntaxHighlight";
import { MarkdownBody } from "./Markdown";
import { EDITOR_PREF_KEY } from "./WorktreeControl";
import styles from "./FilesPane.module.css";

export type FilesPaneApi = Pick<CoderApi["files"], "tree" | "read"> &
  Pick<CoderApi["shell"], "editors" | "openIn">;

type Listing = { entries: FileTreeEntry[]; truncated: boolean };
type DirState = Listing | { error: string } | "loading";

type Row =
  | { kind: "entry"; entry: FileTreeEntry; level: number }
  | { kind: "status"; key: string; text: string; level: number };

/** Filter results shown at once; the filter narrows past this. */
const FILTER_ROWS = 200;

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Subsequence match of `query` in `path`, higher is better, null when it
 * does not match. Consecutive letters, word starts and the file name score.
 * ponytail: greedy leftmost match, so "ab" in "a/xab" scores the early "a";
 * switch to a DP scorer if rankings look wrong.
 */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = path.toLowerCase();
  const base = t.lastIndexOf("/") + 1;
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    if (i === prev + 1) score += 5;
    if (i === 0 || "/._- ".includes(t[i - 1]!)) score += 8;
    if (i >= base) score += 2;
    prev = i;
    from = i + 1;
  }
  return score - t.length * 0.05;
}

export function FilesPane({
  threadId,
  api,
  remote = false,
  onAddToPrompt,
}: {
  threadId: string;
  api: FilesPaneApi;
  /** Remote (ssh) projects: listing does not go over the remote layer. */
  remote?: boolean;
  onAddToPrompt?: (comment: ReviewComment) => void;
}) {
  if (remote) {
    return (
      <div className={styles.empty} data-files-remote="">
        Files are not available for remote projects yet.
      </div>
    );
  }
  return (
    <FilesBrowser threadId={threadId} api={api} onAddToPrompt={onAddToPrompt} />
  );
}

function FilesBrowser({
  threadId,
  api,
  onAddToPrompt,
}: {
  threadId: string;
  api: FilesPaneApi;
  onAddToPrompt?: (comment: ReviewComment) => void;
}) {
  const uid = useId();
  const [showIgnored, setShowIgnored] = useState(false);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [allFiles, setAllFiles] = useState<FileTreeEntry[] | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [editor, setEditor] = useState<EditorOption | null>(null);
  const gen = useRef(0);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const treeRef = useRef<HTMLDivElement>(null);

  const loadDir = useCallback(
    (dir: string) => {
      const mine = gen.current;
      setDirs((prev) => ({ ...prev, [dir]: "loading" }));
      api.tree({ threadId, dir: dir || undefined, showIgnored }).then(
        (res) => {
          if (gen.current === mine) setDirs((prev) => ({ ...prev, [dir]: res }));
        },
        (err) => {
          if (gen.current === mine) {
            setDirs((prev) => ({ ...prev, [dir]: { error: errorText(err) } }));
          }
        },
      );
    },
    [api, threadId, showIgnored],
  );

  // First load, the ignored toggle and Refresh all relist what is open.
  useEffect(() => {
    gen.current += 1;
    setDirs({});
    setAllFiles(null);
    loadDir("");
    for (const dir of expandedRef.current) loadDir(dir);
  }, [loadDir, epoch]);

  const filtering = filter.trim() !== "";
  useEffect(() => {
    if (!filtering || allFiles) return;
    let live = true;
    api.tree({ threadId, all: true }).then(
      (res) => live && setAllFiles(res.entries),
      () => live && setAllFiles([]),
    );
    return () => {
      live = false;
    };
  }, [api, threadId, filtering, allFiles]);

  useEffect(() => {
    let live = true;
    api.editors().then(
      (rows) => {
        if (!live) return;
        let pref: string | null = null;
        try {
          pref = window.localStorage.getItem(EDITOR_PREF_KEY);
        } catch {
          // storage blocked: first editor wins
        }
        const real = rows.filter((r) => r.id !== "finder" && r.id !== "terminal");
        setEditor(rows.find((r) => r.id === pref) ?? real[0] ?? rows[0] ?? null);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api]);

  const rows = useMemo<Row[]>(() => {
    if (filtering) {
      return (allFiles ?? [])
        .map((entry) => ({ entry, score: fuzzyScore(filter, entry.path) }))
        .filter((r): r is { entry: FileTreeEntry; score: number } => r.score != null)
        .sort((a, b) => b.score - a.score)
        .slice(0, FILTER_ROWS)
        .map(({ entry }) => ({
          kind: "entry",
          entry: { ...entry, name: entry.path },
          level: 0,
        }));
    }
    const out: Row[] = [];
    const walk = (dir: string, level: number) => {
      const st = dirs[dir];
      if (st === "loading" || st === undefined) {
        out.push({ kind: "status", key: `${dir}:loading`, text: "Loading…", level });
        return;
      }
      if ("error" in st) {
        out.push({ kind: "status", key: `${dir}:error`, text: st.error, level });
        return;
      }
      if (!dir && st.entries.length === 0) {
        out.push({ kind: "status", key: "empty", text: "No files", level });
      }
      for (const entry of st.entries) {
        out.push({ kind: "entry", entry, level });
        if (entry.dir && expanded.has(entry.path)) walk(entry.path, level + 1);
      }
      if (st.truncated) {
        out.push({
          kind: "status",
          key: `${dir}:more`,
          text: "More entries not shown",
          level,
        });
      }
    };
    walk("", 0);
    return out;
  }, [filtering, filter, allFiles, dirs, expanded]);

  const nav = useMemo(
    () =>
      rows.flatMap((r) => (r.kind === "entry" ? [r.entry] : [])),
    [rows],
  );
  const rowId = (path: string) => `${uid}-${encodeURIComponent(path)}`;
  const activePath =
    cursor && nav.some((e) => e.path === cursor) ? cursor : (nav[0]?.path ?? null);

  useEffect(() => {
    if (!activePath) return;
    document
      .getElementById(`${uid}-${encodeURIComponent(activePath)}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [uid, activePath]);

  const toggleDir = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      const st = dirs[path];
      if (!st || (typeof st === "object" && "error" in st)) loadDir(path);
    }
    setExpanded(next);
  };

  const activate = (entry: FileTreeEntry) => {
    setCursor(entry.path);
    if (entry.dir) toggleDir(entry.path);
    else setOpenPath(entry.path);
  };

  const onKeyDown = (e: KeyboardEvent, fromInput = false) => {
    const i = nav.findIndex((n) => n.path === activePath);
    const cur = nav[i];
    const go = (entry: FileTreeEntry | undefined) => entry && setCursor(entry.path);
    switch (e.key) {
      case "ArrowDown":
        go(nav[Math.min(nav.length - 1, i + 1)]);
        break;
      case "ArrowUp":
        go(nav[Math.max(0, i - 1)]);
        break;
      case "Home":
        if (fromInput) return;
        go(nav[0]);
        break;
      case "End":
        if (fromInput) return;
        go(nav[nav.length - 1]);
        break;
      case "ArrowRight":
        if (fromInput || !cur?.dir || filtering) return;
        if (!expanded.has(cur.path)) toggleDir(cur.path);
        else go(nav[i + 1]);
        break;
      case "ArrowLeft": {
        if (fromInput || !cur || filtering) return;
        if (cur.dir && expanded.has(cur.path)) toggleDir(cur.path);
        else {
          const parent = cur.path.slice(0, cur.path.lastIndexOf("/"));
          if (parent) setCursor(parent);
        }
        break;
      }
      case "Enter":
      case " ":
        if (e.key === " " && fromInput) return;
        if (cur) activate(cur);
        break;
      case "Escape":
        if (!fromInput || !filter) return;
        setFilter("");
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className={styles.pane} data-files-pane="">
      <div className={styles.side}>
        <div className={styles.toolbar}>
          <input
            className={styles.filter}
            type="search"
            placeholder="Filter files"
            aria-label="Filter files"
            aria-controls={`${uid}-tree`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => onKeyDown(e, true)}
            data-files-filter=""
          />
          <button
            type="button"
            className={styles.iconBtn}
            aria-pressed={showIgnored}
            aria-label="Show ignored files"
            title={showIgnored ? "Hide ignored files" : "Show ignored files"}
            onClick={() => setShowIgnored((v) => !v)}
            data-files-show-ignored=""
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
              <circle cx="8" cy="8" r="2" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Refresh files"
            title="Refresh"
            onClick={() => setEpoch((n) => n + 1)}
            data-files-refresh=""
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />
            </svg>
          </button>
        </div>
        <div
          ref={treeRef}
          id={`${uid}-tree`}
          className={styles.tree}
          role="tree"
          aria-label="Files"
          tabIndex={0}
          aria-activedescendant={activePath ? rowId(activePath) : undefined}
          onKeyDown={(e) => onKeyDown(e)}
          data-files-tree=""
        >
          {filtering && !allFiles ? (
            <div className={styles.status}>Loading…</div>
          ) : filtering && rows.length === 0 ? (
            <div className={styles.status}>No matching files</div>
          ) : null}
          {rows.map((row) =>
            row.kind === "status" ? (
              <div
                key={row.key}
                className={styles.status}
                style={{ paddingLeft: 22 + row.level * 12 }}
              >
                {row.text}
              </div>
            ) : (
              <div
                key={row.entry.path}
                id={rowId(row.entry.path)}
                className={styles.row}
                role="treeitem"
                aria-level={row.level + 1}
                aria-expanded={row.entry.dir ? expanded.has(row.entry.path) : undefined}
                aria-selected={row.entry.path === openPath}
                data-active={row.entry.path === activePath ? "" : undefined}
                data-ignored={row.entry.ignored ? "" : undefined}
                data-files-row={row.entry.path}
                style={{ paddingLeft: 8 + row.level * 12 }}
                onMouseDown={(e) => {
                  // Keep focus on the tree so arrows keep working.
                  e.preventDefault();
                  treeRef.current?.focus();
                }}
                onClick={() => activate(row.entry)}
              >
                <span
                  className={styles.twisty}
                  data-open={expanded.has(row.entry.path) ? "" : undefined}
                  aria-hidden="true"
                >
                  {row.entry.dir ? "›" : ""}
                </span>
                <span className={styles.name}>{row.entry.name}</span>
              </div>
            ),
          )}
        </div>
      </div>
      <div className={styles.preview}>
        {openPath ? (
          <Preview
            key={`${openPath}:${epoch}`}
            threadId={threadId}
            api={api}
            path={openPath}
            editor={editor}
            onAddToPrompt={onAddToPrompt}
          />
        ) : (
          <div className={styles.empty}>Pick a file to preview it.</div>
        )}
      </div>
    </div>
  );
}

function Preview({
  threadId,
  api,
  path,
  editor,
  onAddToPrompt,
}: {
  threadId: string;
  api: FilesPaneApi;
  path: string;
  editor: EditorOption | null;
  onAddToPrompt?: (comment: ReviewComment) => void;
}) {
  const [state, setState] = useState<
    { preview: FilePreview } | { error: string } | null
  >(null);
  const [source, setSource] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.read({ threadId, path }).then(
      (preview) => live && setState({ preview }),
      (err) => live && setState({ error: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [api, threadId, path]);

  const preview = state && "preview" in state ? state.preview : null;
  const markdown = /\.(md|markdown)$/i.test(path) && preview?.kind === "text";
  const openIn = (id: EditorId) =>
    api.openIn({ threadId, path, editor: id }).then(
      () => setOpenError(null),
      (err) => setOpenError(errorText(err)),
    );

  return (
    <>
      <div className={styles.toolbar} data-files-preview-header="">
        <span className={styles.path} title={path}>
          {path}
        </span>
        {preview ? (
          <span className={styles.size}>{formatBytes(preview.size)}</span>
        ) : null}
        {markdown ? (
          <button
            type="button"
            className={styles.textBtn}
            aria-pressed={source}
            onClick={() => setSource((v) => !v)}
            data-files-md-source=""
          >
            {source ? "Rendered" : "Source"}
          </button>
        ) : null}
        {editor ? (
          <button
            type="button"
            className={styles.textBtn}
            onClick={() => void openIn(editor.id)}
            data-files-open-in={editor.id}
          >
            Open in {editor.name}
          </button>
        ) : null}
      </div>
      {openError ? (
        <div className={styles.notice} role="alert">
          {openError}
        </div>
      ) : null}
      {state === null ? (
        <div className={styles.empty}>Loading…</div>
      ) : "error" in state ? (
        <div className={styles.empty} role="alert">
          {state.error}
        </div>
      ) : state.preview.kind === "tooLarge" ? (
        <div className={styles.empty} data-files-too-large="">
          Too large to preview ({formatBytes(state.preview.size)}). Previews stop
          at 1 MB.
        </div>
      ) : state.preview.kind === "binary" ? (
        <div className={styles.empty} data-files-binary="">
          Binary file, no preview.
        </div>
      ) : state.preview.kind === "image" ? (
        <div className={styles.image}>
          <img src={state.preview.dataUrl} alt={path} data-files-image="" />
        </div>
      ) : markdown && !source ? (
        <div className={styles.markdown} data-files-markdown="">
          <MarkdownBody text={state.preview.text} />
        </div>
      ) : (
        <TextPreview
          path={path}
          text={state.preview.text}
          onAddToPrompt={onAddToPrompt}
        />
      )}
    </>
  );
}

function TextPreview({
  path,
  text,
  onAddToPrompt,
}: {
  path: string;
  text: string;
  onAddToPrompt?: (comment: ReviewComment) => void;
}) {
  const lines = useMemo(() => text.replace(/\r?\n$/, "").split(/\r?\n/), [text]);
  const html = useHighlightedLines(languageForPath(path), lines);
  const [sel, setSel] = useState<{ anchor: number; start: number; end: number } | null>(null);
  const [note, setNote] = useState("");
  const [added, setAdded] = useState(false);

  const pick = (n: number, extend: boolean) => {
    setAdded(false);
    setSel((prev) =>
      extend && prev
        ? {
            anchor: prev.anchor,
            start: Math.min(prev.anchor, n),
            end: Math.max(prev.anchor, n),
          }
        : { anchor: n, start: n, end: n },
    );
  };

  const label = sel
    ? sel.start === sel.end
      ? `L${sel.start}`
      : `L${sel.start}-${sel.end}`
    : "";

  return (
    <>
      <div
        className={styles.code}
        data-files-code=""
        onKeyDown={(e) => {
          if (e.key === "Escape" && sel) {
            e.stopPropagation();
            setSel(null);
          }
        }}
      >
        {lines.map((line, i) => {
          const n = i + 1;
          const on = sel != null && n >= sel.start && n <= sel.end;
          const lineHtml = html[i];
          return (
            <div
              key={i}
              className={styles.line}
              data-selected={on ? "" : undefined}
            >
              <button
                type="button"
                className={styles.gutter}
                aria-label={`Select line ${n}`}
                aria-pressed={on}
                title="Click to select, shift-click to extend"
                onClick={(e) => pick(n, e.shiftKey)}
                data-files-line={n}
              >
                {n}
              </button>
              {lineHtml ? (
                <code
                  className={styles.src}
                  dangerouslySetInnerHTML={{ __html: lineHtml }}
                />
              ) : (
                <code className={styles.src}>{line}</code>
              )}
            </div>
          );
        })}
      </div>
      {sel && onAddToPrompt ? (
        <form
          className={styles.selBar}
          data-files-selection=""
          onSubmit={(e) => {
            e.preventDefault();
            onAddToPrompt({
              id: crypto.randomUUID(),
              path,
              startLine: sel.start,
              endLine: sel.end,
              removed: false,
              code: lines.slice(sel.start - 1, sel.end).join("\n"),
              text: note.trim(),
              excerpt: true,
            });
            setSel(null);
            setNote("");
            setAdded(true);
          }}
        >
          <span className={styles.selLabel}>{label}</span>
          <input
            className={styles.note}
            placeholder="Note (optional)"
            aria-label={`Note on ${path}:${label}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="submit" className={styles.addBtn} data-files-add="">
            Add to prompt
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Clear selection"
            onClick={() => setSel(null)}
          >
            ×
          </button>
        </form>
      ) : added ? (
        <div className={styles.selBar} role="status">
          <span className={styles.selLabel}>Added to the prompt</span>
        </div>
      ) : null}
    </>
  );
}
