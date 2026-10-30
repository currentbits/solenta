import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CoderApi,
  FileChange,
  PrCommit,
  PrDiffResult,
} from "../shared/ipc";
import { isEmptyDiff } from "../diffView";
import { parsePatch } from "../reviewItinerary";
import {
  FileHunks,
  TestFilesBar,
  TreeListToggle,
  filterTestFiles,
} from "./TurnDiffPanel";
import { useDiffHideTests, useDiffTreeView } from "../uiPrefs";
import {
  buildFileTree,
  type FileTreeDir,
  type FileTreeNode,
} from "../fileTree";
import type { DiffViewMode } from "../turnDiff";
import diffStyles from "./TurnDiffPanel.module.css";
import styles from "./PrWorkspacePanel.module.css";

type FilePatchState = {
  patch: string;
  truncated: boolean;
  loading?: boolean;
  error?: string;
};

function coderGit(): CoderApi["git"] | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { coder?: CoderApi }).coder?.git;
}

function viewedLabel(file: FileChange): string | null {
  if (file.viewed === "viewed") return "Viewed";
  if (file.viewed === "changed") return "Changed";
  return null;
}

/** Same glyph as the Git pane's copy-path button (#1772). */
function CopyGlyph() {
  return (
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
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  );
}

/** One file entry: a chip in List view, a full-width row in Tree view. */
function FileEntry({
  file,
  selected,
  tree = false,
  depth = 0,
  copied,
  onSelect,
  onCopy,
}: {
  file: FileChange;
  selected: boolean;
  tree?: boolean;
  depth?: number;
  copied: boolean;
  onSelect: (path: string) => void;
  onCopy: (path: string) => void;
}) {
  return (
    <div
      className={diffStyles.fileChip}
      data-tree={tree ? "" : undefined}
      style={tree && depth ? { paddingLeft: depth * 14 } : undefined}
    >
      <button
        type="button"
        className={diffStyles.entryBtn}
        data-pr-code-file={file.path}
        data-selected={selected ? "" : undefined}
        data-viewed={file.viewed || "unseen"}
        aria-pressed={selected}
        onClick={() => onSelect(file.path)}
      >
        <span className={diffStyles.filePath} title={file.path}>
          {file.path}
        </span>
        <span className={diffStyles.fileStats}>
          <span className={diffStyles.adds}>+{file.additions}</span>
          <span className={diffStyles.dels}>−{file.deletions}</span>
        </span>
        {viewedLabel(file) ? (
          <span className={styles.viewedChip} data-pr-viewed-state={file.viewed}>
            {viewedLabel(file)}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className={diffStyles.fileCopy}
        data-file-copy-path={file.path}
        aria-label={`Copy path ${file.path}`}
        title="Copy path"
        onClick={(e) => {
          e.stopPropagation();
          onCopy(file.path);
        }}
      >
        {copied ? "✓" : <CopyGlyph />}
      </button>
    </div>
  );
}

/** Tree view (#1772) directory row: file count, summed +/-, collapsible. */
function DirEntry({
  node,
  depth,
  collapsed,
  onToggle,
}: {
  node: FileTreeDir<FileChange>;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={diffStyles.dirRow}
      data-dir-row={node.path}
      aria-expanded={!collapsed}
      style={depth ? { paddingLeft: depth * 14 } : undefined}
      onClick={onToggle}
    >
      <span
        className={diffStyles.dirTwisty}
        data-open={collapsed ? undefined : ""}
        aria-hidden
      >
        ›
      </span>
      <span className={diffStyles.dirName} title={node.path}>
        {node.name}
      </span>
      <span className={diffStyles.fileStats}>
        <span className={diffStyles.dirCount}>{node.fileCount}</span>
        <span className={diffStyles.adds}>+{node.additions}</span>
        <span className={diffStyles.dels}>−{node.deletions}</span>
      </span>
    </button>
  );
}

export function PrCodeTab({
  projectPath,
  prNumber,
  repo,
}: {
  projectPath: string;
  prNumber: number;
  repo?: string;
}) {
  const [result, setResult] = useState<PrDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commit, setCommit] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffViewMode>("unified");
  const [filePatches, setFilePatches] = useState<Record<string, FilePatchState>>(
    {},
  );
  /** Tree view (#1772) collapse state; kept while the tab stays mounted. */
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(
    () => new Set(),
  );
  /** Copy-path feedback: which path was just copied, if any. */
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
    };
  }, []);
  const loadGen = useRef(0);

  const load = async (nextCommit = commit) => {
    const git = coderGit();
    if (!git?.prDiff) {
      setError("PR diff is not available");
      setLoading(false);
      return;
    }
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    setFilePatches({});
    try {
      const out = await git.prDiff({
        projectPath,
        prNumber,
        ...(repo ? { repo } : {}),
        ...(nextCommit ? { commit: nextCommit } : {}),
      });
      if (loadGen.current !== gen) return;
      setResult(out);
      if (!out.ok) setError(out.reason);
    } catch (err) {
      if (loadGen.current !== gen) return;
      setError(err instanceof Error && err.message ? err.message : "Couldn't load the diff");
      setResult(null);
    } finally {
      if (loadGen.current === gen) setLoading(false);
    }
  };

  useEffect(() => {
    setCommit("");
    setCollapsedDirs(new Set());
    setCopiedPath(null);
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, prNumber, repo]);

  const files = result && result.ok ? result.files : [];
  const headSha = result && result.ok ? result.headSha : "";
  const commits: PrCommit[] = result && result.ok ? result.commits : [];
  const hideTests = useDiffHideTests();
  const treeView = useDiffTreeView();
  const testFilter = useMemo(() => filterTestFiles(files, hideTests), [files, hideTests]);
  const shownFiles = testFilter.shown;
  const tree = useMemo(() => buildFileTree(shownFiles), [shownFiles]);

  const copyPath = (path: string) => {
    navigator.clipboard?.writeText(path).then(
      () => {
        setCopiedPath(path);
        if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
          setCopiedPath(null);
          copyTimerRef.current = null;
        }, 1400);
      },
      () => {},
    );
  };

  const toggleDir = (path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** Tree view rows: same FileEntry as the chip list, nested under DirEntry. */
  const renderTree = (
    nodes: FileTreeNode<FileChange>[],
    depth: number,
  ): ReactNode[] => {
    const rows: ReactNode[] = [];
    for (const node of nodes) {
      if (node.kind === "file") {
        rows.push(
          <FileEntry
            key={node.path}
            file={node.file}
            selected={selectedPath === node.path}
            tree
            depth={depth}
            copied={copiedPath === node.path}
            onSelect={setSelectedPath}
            onCopy={copyPath}
          />,
        );
        continue;
      }
      const collapsed = collapsedDirs.has(node.path);
      rows.push(
        <DirEntry
          key={node.path}
          node={node}
          depth={depth}
          collapsed={collapsed}
          onToggle={() => toggleDir(node.path)}
        />,
      );
      if (!collapsed) rows.push(...renderTree(node.children, depth + 1));
    }
    return rows;
  };

  useEffect(() => {
    if (shownFiles.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (selectedPath && shownFiles.some((f) => f.path === selectedPath)) return;
    setSelectedPath(shownFiles[0]!.path);
  }, [shownFiles, selectedPath]);

  const fetchFile = async (path: string, full: boolean) => {
    const git = coderGit();
    if (!git?.prDiff) return;
    const gen = loadGen.current;
    setFilePatches((prev) => ({
      ...prev,
      [path]: { patch: "", truncated: false, loading: true },
    }));
    try {
      const out = await git.prDiff({
        projectPath,
        prNumber,
        ...(repo ? { repo } : {}),
        ...(commit ? { commit } : {}),
        path,
        ...(full ? { full: true } : {}),
      });
      if (loadGen.current !== gen) return;
      if (!out.ok) {
        setFilePatches((prev) => ({
          ...prev,
          [path]: { patch: "", truncated: false, error: out.reason },
        }));
        return;
      }
      setFilePatches((prev) => ({
        ...prev,
        [path]: { patch: out.patch, truncated: out.truncated },
      }));
    } catch (err) {
      if (loadGen.current !== gen) return;
      setFilePatches((prev) => ({
        ...prev,
        [path]: {
          patch: "",
          truncated: false,
          error: err instanceof Error && err.message ? err.message : "Failed to load diff",
        },
      }));
    }
  };

  const selected = files.find((f) => f.path === selectedPath) ?? null;
  useEffect(() => {
    if (selected?.patchOmitted !== "lazy" || filePatches[selected.path]) return;
    void fetchFile(selected.path, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, filePatches]);

  const listPatch = result && result.ok ? result.patch : "";
  const visiblePatch =
    selected && filePatches[selected.path]?.patch
      ? filePatches[selected.path]!.patch
      : listPatch;
  const patches = useMemo(() => parsePatch(visiblePatch), [visiblePatch]);
  const visible = selectedPath
    ? patches.filter((p) => p.path === selectedPath)
    : patches;
  const empty =
    !loading && !error && result && result.ok && isEmptyDiff(result);

  const markViewed = async (file: FileChange) => {
    const git = coderGit();
    if (!git?.prMarkViewed || !headSha) return;
    const next = file.viewed === "viewed" ? false : true;
    await git.prMarkViewed({
      projectPath,
      prNumber,
      ...(repo ? { repo } : {}),
      path: file.path,
      headSha,
      ...(file.blobSha ? { blobSha: file.blobSha } : {}),
      viewed: next,
    });
    void load(commit);
  };

  return (
    <div className={styles.codeTab} data-pr-code="">
      <div className={styles.codeToolbar}>
        <label className={styles.codePicker}>
          <span className={styles.label}>Commits</span>
          <select
            data-pr-commit=""
            aria-label="PR commits"
            value={commit}
            onChange={(e) => {
              const next = e.target.value;
              setCommit(next);
              void load(next);
            }}
          >
            <option value="">All commits</option>
            {commits.map((c) => (
              <option key={c.sha} value={c.sha}>
                {c.sha.slice(0, 7)} {c.title}
              </option>
            ))}
          </select>
        </label>
        <div className={diffStyles.modes} role="group" aria-label="Diff layout">
          <button
            type="button"
            className={diffStyles.modeBtn}
            aria-pressed={mode === "unified"}
            onClick={() => setMode("unified")}
          >
            Unified
          </button>
          <button
            type="button"
            className={diffStyles.modeBtn}
            aria-pressed={mode === "split"}
            onClick={() => setMode("split")}
          >
            Split
          </button>
        </div>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {loading && !result ? <p className={styles.hint}>Loading diff…</p> : null}
      {empty ? <p className={styles.hint}>No textual diff</p> : null}

      <TreeListToggle />
      <TestFilesBar {...testFilter} />
      {shownFiles.length > 0 ? (
        treeView ? (
          <div className={diffStyles.fileTree} data-pr-code-tree="">
            {renderTree(tree, 0)}
          </div>
        ) : (
          <div className={diffStyles.files}>
            {shownFiles.map((file) => (
              <FileEntry
                key={file.path}
                file={file}
                selected={selectedPath === file.path}
                copied={copiedPath === file.path}
                onSelect={setSelectedPath}
                onCopy={copyPath}
              />
            ))}
          </div>
        )
      ) : null}

      {selected ? (
        <div className={styles.viewedRow}>
          <button
            type="button"
            className={styles.ghost}
            data-pr-mark-viewed=""
            onClick={() => void markViewed(selected)}
          >
            {selected.viewed === "viewed" ? "Unmark viewed" : "Mark viewed"}
          </button>
        </div>
      ) : null}

      {selected?.patchOmitted === "large" && !filePatches[selected.path] ? (
        <div className={styles.hint} data-diff-large={selected.path}>
          <p>Large diff. Hidden to keep review fast.</p>
          <button
            type="button"
            className={styles.ghost}
            onClick={() => void fetchFile(selected.path, true)}
          >
            Show anyway
          </button>
        </div>
      ) : null}

      {filePatches[selectedPath || ""]?.loading ? (
        <p className={styles.hint}>Loading diff…</p>
      ) : null}
      {filePatches[selectedPath || ""]?.error ? (
        <p className={styles.error} role="alert">
          {filePatches[selectedPath || ""]!.error}
        </p>
      ) : null}

      {visible.length > 0 ? (
        <div className={diffStyles.patch} data-pr-code-patch="">
          {visible.map((p) => (
            <Fragment key={p.path}>
              <FileHunks patch={p} mode={mode} />
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
