import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsBrowseEntry, FsBrowseInput, FsBrowseResult } from "../shared/ipc";
import {
  appendBrowsePathSegment,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  filterPinnedBrowseEntries,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getFilesystemBrowsePath,
  isWindowsPlatform,
} from "../browsePath";
import styles from "./SettingsModal.module.css";

export interface PathBrowserProps {
  id: string;
  value: string;
  onChange: (path: string) => void;
  onBrowse: (input: FsBrowseInput) => Promise<FsBrowseResult>;
  /** Native folder dialog; omit where none exists (web / remote). */
  onPickDirectory?: () => Promise<string | null>;
  /** SSH user@host. Empty = local. */
  environment?: string | null;
  cwd?: string | null;
  disabled?: boolean;
  placeholder?: string;
  /** Clone destination: pin `<parent>/<repo>` onto the browsed path (#459). */
  pinnedDirectoryName?: string | null;
  /** Enter with no highlighted row submits the typed path. */
  onSubmit?: () => void;
  /** data-* attribute on the path input (tests). */
  inputDataAttr: string;
  /** data-* attribute on the native Browse button (tests). */
  browseDataAttr?: string;
}

function browsePlatform(): string {
  if (typeof navigator !== "undefined" && navigator.platform) {
    return navigator.platform;
  }
  return "";
}

export function PathBrowser({
  id,
  value,
  onChange,
  onBrowse,
  onPickDirectory,
  environment,
  cwd,
  disabled,
  placeholder,
  pinnedDirectoryName,
  onSubmit,
  inputDataAttr,
  browseDataAttr,
}: PathBrowserProps) {
  const platform = browsePlatform();
  const browsePath = useMemo(
    () => getFilesystemBrowsePath(value, platform),
    [value, platform],
  );
  const [entries, setEntries] = useState<FsBrowseEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const navRef = useRef(createBrowseNavigationCoordinator());

  const pinned = pinnedDirectoryName?.trim() || "";
  const filtered = useMemo(() => {
    if (pinned) {
      return filterPinnedBrowseEntries({
        browseEntries: entries,
        filterQuery: browsePath.filterQuery,
        pinnedDirectoryName: pinned,
        caseSensitive: !isWindowsPlatform(platform),
      });
    }
    return filterFilesystemBrowseEntries(entries, browsePath.filterQuery);
  }, [entries, browsePath.filterQuery, pinned, platform]);

  const rows: Array<{ kind: "up" } | { kind: "dir"; entry: FsBrowseEntry }> =
    useMemo(() => {
      const list: Array<
        { kind: "up" } | { kind: "dir"; entry: FsBrowseEntry }
      > = [];
      if (browsePath.canBrowseUp) list.push({ kind: "up" });
      for (const entry of filtered.visibleEntries) {
        list.push({ kind: "dir", entry });
      }
      return list;
    }, [browsePath.canBrowseUp, filtered.visibleEntries]);

  useEffect(() => {
    if (disabled || !browsePath.isBrowsing || !browsePath.directoryPath) {
      setEntries([]);
      setParentPath(null);
      return;
    }
    const navigation = navRef.current;
    let cancelled = false;
    /** @type {FsBrowseResult | { error: string } | null} */
    let next: FsBrowseResult | { error: string } | null = null;
    void navigation.run(
      async () => {
        try {
          next = await onBrowse({
            path: browsePath.directoryPath,
            environment: environment || undefined,
            cwd: cwd || undefined,
          });
        } catch (err) {
          next = {
            error:
              err instanceof Error && err.message
                ? err.message
                : "Could not list that folder.",
          };
        }
      },
      () => {
        if (cancelled || !next) return;
        if ("error" in next) {
          setEntries([]);
          setParentPath(browsePath.directoryPath);
          setBrowseError(next.error);
          return;
        }
        setBrowseError(null);
        setEntries(next.entries || []);
        setParentPath(next.parentPath || browsePath.directoryPath);
      },
    );
    return () => {
      cancelled = true;
      navigation.invalidate();
    };
  }, [
    browsePath.isBrowsing,
    browsePath.directoryPath,
    environment,
    cwd,
    onBrowse,
    disabled,
  ]);

  useEffect(() => {
    setHighlight(-1);
  }, [browsePath.directoryPath, browsePath.filterQuery, environment]);

  const descend = useCallback(
    (name: string) => {
      const entry = entries.find((e) => e.name === name);
      const next = pinned
        ? getCloneDestinationBrowsePath({
            browseDirectoryPath: browsePath.directoryPath,
            selectedDirectoryName: name,
            cloneDirectoryName: pinned,
            caseSensitive: !isWindowsPlatform(platform),
          })
        : entry?.recent && entry.fullPath
          ? entry.fullPath.endsWith("/") || entry.fullPath.endsWith("\\")
            ? entry.fullPath
            : `${entry.fullPath}${value.includes("\\") ? "\\" : "/"}`
          : appendBrowsePathSegment(value, name);
      onChange(next);
      setHighlight(-1);
    },
    [browsePath.directoryPath, entries, onChange, pinned, platform, value],
  );

  const browseUp = useCallback(() => {
    const parent = browsePath.parentPath;
    if (!parent) return;
    onChange(getCloneDestinationPath(parent, pinned || null));
    setHighlight(-1);
  }, [browsePath.parentPath, onChange, pinned]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rows.length === 0) return;
      setHighlight((h) => (h < 0 ? 0 : Math.min(h + 1, rows.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      setHighlight((h) => (h <= 0 ? 0 : h - 1));
      return;
    }
    if (e.key === "ArrowRight") {
      const row = rows[highlight];
      if (row) {
        e.preventDefault();
        if (row.kind === "up") browseUp();
        else descend(row.entry.name);
      }
      return;
    }
    if (e.key === "ArrowLeft") {
      if (browsePath.canBrowseUp && !browsePath.filterQuery) {
        e.preventDefault();
        browseUp();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[highlight];
      if (row) {
        if (row.kind === "up") browseUp();
        else descend(row.entry.name);
        return;
      }
      onSubmit?.();
    }
  };

  const pick = async () => {
    if (disabled || !onPickDirectory) return;
    try {
      const picked = await onPickDirectory();
      if (picked) onChange(picked);
    } catch {
      // Parent submit path shows picker errors; a cancelled dialog is null.
    }
  };

  const willCreate =
    browsePath.isBrowsing &&
    Boolean(browsePath.filterQuery) &&
    !filtered.exactEntry;

  return (
    <div className={styles.field} data-path-browser="">
      <div className={styles.fieldRow}>
        <input
          id={id}
          className={`${styles.input} ${styles.pathInput}`}
          {...{ [inputDataAttr]: "" }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
        />
        {onPickDirectory && (
          <button
            type="button"
            className={styles.btn}
            {...(browseDataAttr ? { [browseDataAttr]: "" } : {})}
            disabled={disabled}
            onClick={() => void pick()}
          >
            Browse…
          </button>
        )}
      </div>
      {browsePath.isBrowsing && (
        <ul
          id={`${id}-list`}
          className={styles.browseList}
          role="listbox"
          data-path-browser-list=""
        >
          {browseError ? (
            <li className={styles.browseEmpty} role="presentation">
              {browseError}
            </li>
          ) : rows.length === 0 ? (
            <li className={styles.browseEmpty} role="presentation">
              {willCreate
                ? "No matching folder — Add will create this path."
                : "No folders here."}
            </li>
          ) : (
            rows.map((row, i) =>
              row.kind === "up" ? (
                <li key="up" role="option" aria-selected={highlight === i}>
                  <button
                    type="button"
                    className={styles.browseRow}
                    data-browse-up=""
                    data-highlighted={highlight === i ? "true" : undefined}
                    disabled={disabled}
                    onClick={browseUp}
                  >
                    ..
                  </button>
                </li>
              ) : (
                <li
                  key={row.entry.fullPath}
                  role="option"
                  aria-selected={highlight === i}
                >
                  <button
                    type="button"
                    className={styles.browseRow}
                    data-browse-entry={row.entry.name}
                    data-browse-recent={row.entry.recent ? "" : undefined}
                    data-highlighted={highlight === i ? "true" : undefined}
                    disabled={disabled}
                    onClick={() => descend(row.entry.name)}
                  >
                    {row.entry.recent ? `${row.entry.name}  (recent)` : row.entry.name}
                  </button>
                </li>
              ),
            )
          )}
        </ul>
      )}
      {willCreate && (
        <p className={styles.browseHint} data-path-will-create="">
          This folder will be created if it does not exist.
        </p>
      )}
      {parentPath ? (
        <span hidden data-browse-parent={parentPath} />
      ) : null}
    </div>
  );
}
