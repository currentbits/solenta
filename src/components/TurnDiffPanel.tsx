import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { DiffResult, FileChange } from "../shared/ipc";
import {
  annotateHunkLines,
  diffHighlightGroups,
  diffLineKind,
  isEmptyDiff,
  type DiffLineKind,
} from "../diffView";
import { parsePatch, type ReviewFilePatch } from "../reviewItinerary";
import { languageForPath, useHighlightedLines } from "../syntaxHighlight";
import {
  splitLineText,
  splitRowIndices,
  type DiffViewMode,
} from "../turnDiff";
import styles from "./TurnDiffPanel.module.css";

export type { DiffViewMode };

/** Diff text, or its highlighted code (prefix stripped) once that is ready. */
function LineText({
  line,
  kind,
  html,
  bare = false,
}: {
  line: string;
  kind: DiffLineKind;
  html: string | null;
  bare?: boolean;
}) {
  const code = splitLineText(line, kind);
  if (html == null) {
    return <span className={styles.text}>{(bare ? code : line) || " "}</span>;
  }
  const marker = bare || code === line ? "" : line[0];
  return (
    <span className={styles.text} data-highlighted="">
      {marker ? <span className={styles.marker}>{marker}</span> : null}
      <span dangerouslySetInnerHTML={{ __html: html || " " }} />
    </span>
  );
}

function PatchLine({
  line,
  kind,
  n = null,
  html = null,
}: {
  line: string;
  kind?: DiffLineKind;
  n?: number | null;
  html?: string | null;
}) {
  const resolved = kind ?? diffLineKind(line);
  return (
    <div className={styles.line} data-kind={resolved}>
      <span className={styles.gutter} aria-hidden>
        {n ?? ""}
      </span>
      <LineText line={line} kind={resolved} html={html} />
    </div>
  );
}

/** One file's hunks, unified or split, with syntax colour (#1493). */
function FileHunks({ patch, mode }: { patch: ReviewFilePatch; mode: DiffViewMode }) {
  const layout = useMemo(() => {
    let offset = 0;
    return patch.hunks.map((hunk) => {
      const rows = annotateHunkLines(hunk.header, hunk.body);
      const out = { hunk, rows, pairs: splitRowIndices(rows), offset };
      offset += rows.length;
      return out;
    });
  }, [patch]);
  const codes = useMemo(
    () => layout.flatMap((h) => h.rows.map((r) => splitLineText(r.text, r.kind))),
    [layout],
  );
  const groups = useMemo(() => diffHighlightGroups(layout), [layout]);
  const html = useHighlightedLines(languageForPath(patch.path), codes, groups);
  const hl = (offset: number, i: number, text: string) =>
    text.startsWith("\\") ? null : (html[offset + i] ?? null);

  return layout.map(({ hunk, rows, pairs, offset }) => (
    <Fragment key={hunk.id}>
      <div className={styles.hunkHead}>{hunk.header}</div>
      {mode === "split"
        ? pairs.map((pair, r) => (
            <div
              key={`${hunk.id}:${r}`}
              className={styles.splitRow}
              data-turn-diff-split-row=""
            >
              {[pair.left, pair.right].map((i, side) => {
                const row = i == null ? null : rows[i]!;
                return (
                  <div
                    key={side}
                    className={styles.cell}
                    data-kind={row ? row.kind : "empty"}
                  >
                    <span className={styles.gutter} aria-hidden>
                      {(row && (side === 0 ? row.oldLine : row.newLine)) ?? ""}
                    </span>
                    {row ? (
                      <LineText
                        line={row.text}
                        kind={row.kind}
                        html={hl(offset, i!, row.text)}
                        bare
                      />
                    ) : (
                      <span className={styles.text}> </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        : rows.map((row, i) => (
            <PatchLine
              key={`${hunk.id}:${i}`}
              line={row.text}
              kind={row.kind}
              n={row.kind === "del" ? row.oldLine : row.newLine}
              html={hl(offset, i, row.text)}
            />
          ))}
    </Fragment>
  ));
}

function FileChip({
  file,
  selected,
  onSelect,
}: {
  file: FileChange;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className={styles.fileBtn}
      data-turn-diff-file={file.path}
      data-selected={selected ? "" : undefined}
      aria-pressed={selected}
      onClick={() => onSelect(file.path)}
    >
      <span className={styles.filePath} title={file.path}>
        {file.path}
      </span>
      <span className={styles.fileStats}>
        <span className={styles.adds}>+{file.additions}</span>
        <span className={styles.dels}>−{file.deletions}</span>
      </span>
    </button>
  );
}

export function TurnDiffPanel({
  threadId,
  sha,
  turn,
  mode,
  onModeChange,
  onFetch,
}: {
  threadId: string;
  sha: string;
  turn: number;
  mode: DiffViewMode;
  onModeChange: (mode: DiffViewMode) => void;
  onFetch: (threadId: string, sha: string) => Promise<DiffResult>;
}) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const cacheRef = useRef(new Map<string, DiffResult>());
  const requestRef = useRef(0);

  useEffect(() => {
    const cached = cacheRef.current.get(sha);
    if (cached) {
      setDiff(cached);
      setLoading(false);
      setError(null);
      return;
    }
    const req = ++requestRef.current;
    setLoading(true);
    setError(null);
    setDiff(null);
    void onFetch(threadId, sha)
      .then((result) => {
        if (requestRef.current !== req) return;
        cacheRef.current.set(sha, result);
        setDiff(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (requestRef.current !== req) return;
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Failed to load turn diff",
        );
        setLoading(false);
      });
  }, [threadId, sha, onFetch]);

  useEffect(() => {
    if (!diff || diff.files.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (selectedPath && diff.files.some((f) => f.path === selectedPath)) return;
    setSelectedPath(diff.files[0]!.path);
  }, [diff, selectedPath]);

  const patches = useMemo(
    () => (diff ? parsePatch(diff.patch) : []),
    [diff],
  );
  const visible = selectedPath
    ? patches.filter((p) => p.path === selectedPath)
    : patches;

  const empty = !loading && !error && diff != null && isEmptyDiff(diff);

  return (
    <section
      className={styles.panel}
      data-turn-diff=""
      data-turn-diff-sha={sha}
      data-turn-diff-mode={mode}
      aria-label={`Turn ${turn} diff`}
    >
      <header className={styles.head}>
        <span className={styles.title}>
          Turn {turn} · {sha.slice(0, 7)}
        </span>
        <div className={styles.modes} role="group" aria-label="Diff layout">
          <button
            type="button"
            className={styles.modeBtn}
            data-turn-diff-mode-btn="unified"
            aria-pressed={mode === "unified"}
            onClick={() => onModeChange("unified")}
          >
            Unified
          </button>
          <button
            type="button"
            className={styles.modeBtn}
            data-turn-diff-mode-btn="split"
            aria-pressed={mode === "split"}
            onClick={() => onModeChange("split")}
          >
            Split
          </button>
        </div>
      </header>

      {error ? (
        <p className={styles.empty} role="alert">
          {error}
        </p>
      ) : null}

      {loading && !diff ? (
        <p className={styles.empty}>Loading turn diff…</p>
      ) : null}

      {empty ? (
        <p className={styles.empty}>No textual diff for this turn</p>
      ) : null}

      {diff && !empty ? (
        <>
          {diff.files.length > 0 ? (
            <div className={styles.files}>
              {diff.files.map((f) => (
                <FileChip
                  key={f.path}
                  file={f}
                  selected={selectedPath === f.path}
                  onSelect={setSelectedPath}
                />
              ))}
            </div>
          ) : null}
          {visible.length === 0 ? (
            <p className={styles.empty}>No textual diff for this file</p>
          ) : (
            <div className={styles.patch}>
              {visible.map((p) => (
                <Fragment key={p.path}>
                  {p.hunks.length === 0 ? (
                    p.text.split("\n").map((line, i) => (
                      <PatchLine key={`${p.path}:${i}`} line={line} />
                    ))
                  ) : (
                    <FileHunks patch={p} mode={mode} />
                  )}
                </Fragment>
              ))}
            </div>
          )}
          {diff.truncated ? (
            <p className={styles.truncated}>Diff truncated</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
