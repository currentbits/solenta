import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type {
  CoderApi,
  FileChange,
  PrCommit,
  PrDiffResult,
} from "../shared/ipc";
import { isEmptyDiff } from "../diffView";
import { parsePatch } from "../reviewItinerary";
import { FileHunks } from "./TurnDiffPanel";
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
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, prNumber, repo]);

  const files = result && result.ok ? result.files : [];
  const headSha = result && result.ok ? result.headSha : "";
  const commits: PrCommit[] = result && result.ok ? result.commits : [];

  useEffect(() => {
    if (files.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (selectedPath && files.some((f) => f.path === selectedPath)) return;
    setSelectedPath(files[0]!.path);
  }, [files, selectedPath]);

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

      {files.length > 0 ? (
        <div className={diffStyles.files}>
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              className={diffStyles.fileBtn}
              data-pr-code-file={file.path}
              data-selected={selectedPath === file.path ? "" : undefined}
              data-viewed={file.viewed || "unseen"}
              aria-pressed={selectedPath === file.path}
              onClick={() => setSelectedPath(file.path)}
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
          ))}
        </div>
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
