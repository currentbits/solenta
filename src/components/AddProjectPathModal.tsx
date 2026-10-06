import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import type {
  CloneProgressPush,
  CloneProjectInput,
  FsBrowseInput,
  FsBrowseResult,
  ProjectInfo,
  WindowsDoctorCheck,
} from "../shared/ipc";
import { getAddProjectInitialQuery, resolveAddProjectPath } from "../browsePath";
import { PathBrowser } from "./PathBrowser";
import styles from "./SettingsModal.module.css";

function failedDoctorChecks(result: unknown): WindowsDoctorCheck[] {
  if (!result || typeof result !== "object") return [];
  const checks = (result as ProjectInfo).windowsDoctor?.checks;
  return Array.isArray(checks) ? checks.filter((c) => !c.ok) : [];
}

/**
 * Client copy of the main-process rule (projectClone.js): https:// or ssh
 * only. Main re-checks; this just keeps the button honest.
 */
export function isCloneUrl(raw: string): boolean {
  const u = raw.trim();
  return (
    /^https:\/\/[^/\s]+\/\S+$/i.test(u) ||
    /^ssh:\/\/[^/\s]+\/\S+$/i.test(u) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/\s]\S*$/.test(u)
  );
}

/** Folder name git picks for a URL: last segment without `.git`. */
export function cloneFolderName(raw: string): string {
  return (
    raw
      .trim()
      .replace(/[/\\]+$/, "")
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/i, "") ?? ""
  );
}

function browsePlatform(): string {
  if (typeof navigator !== "undefined" && navigator.platform) {
    return navigator.platform;
  }
  return "";
}

interface AddProjectPathModalProps {
  onClose: () => void;
  /** Add an existing checkout: path (or remote host/path pair). */
  onSubmit: (
    path: string,
    remotes?: { remoteHost?: string; remotePath?: string },
  ) => Promise<unknown>;
  /** Create a brand-new folder + git repo inside an existing parent dir. */
  onCreate: (name: string, parentDir: string) => Promise<unknown>;
  /** git clone a URL into parentDir, then add it (#1506). Omit to hide. */
  onClone?: (input: CloneProjectInput) => Promise<unknown>;
  onCancelClone?: (cloneId: string) => void;
  /** Subscribe to "clone:progress"; returns the unsubscribe. */
  onCloneProgress?: (cb: (push: CloneProgressPush) => void) => () => void;
  /**
   * Native directory picker; omit where no dialog exists (web mode) and the
   * Browse buttons disappear, leaving the typed/browsable path.
   */
  onPickDirectory?: () => Promise<string | null>;
  /** IPC-backed directory listing (local or SSH). */
  onBrowse: (input: FsBrowseInput) => Promise<FsBrowseResult>;
  /** Active project cwd so `./` and `../` can resolve. */
  currentProjectCwd?: string | null;
}

/**
 * Add-project dialog in both modes. "Add existing" is a typed/browsable
 * destination (#609): the query is both the input and the browse cursor,
 * Browse… stays a local OS-dialog shortcut, and a folder that is missing or
 * not yet a git repo is created/initialized on add. "Create new" mkdirs a
 * fresh folder via projects.create (git-init happens in addProject). Reuses
 * the Settings modal chrome so we do not invent a second dialog system.
 */
export function AddProjectPathModal({
  onClose,
  onSubmit,
  onCreate,
  onClone,
  onCancelClone,
  onCloneProgress,
  onPickDirectory,
  onBrowse,
  currentProjectCwd,
}: AddProjectPathModalProps) {
  const [mode, setMode] = useState<"existing" | "create" | "clone">(
    "existing",
  );
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [cloneProgress, setCloneProgress] = useState<string | null>(null);
  const cloneIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onCloneProgress) return;
    return onCloneProgress((push) => {
      if (push.cloneId === cloneIdRef.current) setCloneProgress(push.line);
    });
  }, [onCloneProgress]);
  const [path, setPath] = useState(() => getAddProjectInitialQuery(null));
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePath, setRemotePath] = useState(() =>
    getAddProjectInitialQuery(null),
  );
  const [name, setName] = useState("");
  const [location, setLocation] = useState(() =>
    getAddProjectInitialQuery(null),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doctorIssues, setDoctorIssues] = useState<WindowsDoctorCheck[] | null>(
    null,
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  useEscapeClose(!pending, handleClose);
  useModalFocus(true, dialogRef);

  const host = remoteHost.trim();
  const rpath = remotePath.trim();
  const canSubmit =
    mode === "clone"
      ? isCloneUrl(cloneUrl) && Boolean(location.trim())
      : mode === "create"
      ? Boolean(name.trim()) && Boolean(location.trim())
      : host
        ? Boolean(rpath)
        : Boolean(path.trim());

  const submit = async () => {
    if (pending || !canSubmit) return;
    setPending(true);
    setError(null);
    try {
      if (mode === "clone" && onClone) {
        const resolved = resolveAddProjectPath({
          rawPath: location.trim(),
          platform: browsePlatform(),
          currentProjectCwd,
        });
        if (!resolved.ok) {
          setError(resolved.error);
          return;
        }
        const cloneId =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `clone-${Date.now()}`;
        cloneIdRef.current = cloneId;
        setCloneProgress("Starting clone");
        try {
          const cloned = await onClone({
            url: cloneUrl.trim(),
            parentDir: resolved.path,
            ...(cloneName.trim() ? { name: cloneName.trim() } : {}),
            cloneId,
          });
          if (!cloned) {
            setError("Could not clone that repository.");
            return;
          }
          const failed = failedDoctorChecks(cloned);
          if (failed.length) setDoctorIssues(failed);
          else onClose();
        } finally {
          cloneIdRef.current = null;
          setCloneProgress(null);
        }
      } else if (mode === "create") {
        const resolved = resolveAddProjectPath({
          rawPath: location.trim(),
          platform: browsePlatform(),
          currentProjectCwd,
        });
        if (!resolved.ok) {
          setError(resolved.error);
          return;
        }
        const created = await onCreate(name.trim(), resolved.path);
        if (!created) {
          setError("Could not create that project.");
          return;
        }
        const failed = failedDoctorChecks(created);
        if (failed.length) setDoctorIssues(failed);
        else onClose();
      } else {
        if (host && !(rpath.startsWith("/") || rpath.startsWith("~"))) {
          setError("Remote path must be an absolute path (start with / or ~).");
          return;
        }
        let submitPath = path.trim();
        if (!host) {
          const resolved = resolveAddProjectPath({
            rawPath: submitPath,
            platform: browsePlatform(),
            currentProjectCwd,
          });
          if (!resolved.ok) {
            setError(resolved.error);
            return;
          }
          submitPath = resolved.path;
        }
        const remotes = host
          ? { remoteHost: host, remotePath: rpath }
          : undefined;
        const added = await onSubmit(submitPath, remotes);
        if (!added) {
          setError("Could not add that path.");
          return;
        }
        const failed = failedDoctorChecks(added);
        if (failed.length) setDoctorIssues(failed);
        else onClose();
      }
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : mode === "create"
            ? "Could not create that project."
            : mode === "clone"
              ? "Could not clone that repository."
              : "Could not add that path.",
      );
    } finally {
      setPending(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-add-project-path=""
      onClick={handleClose}
    >
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-path-title"
        tabIndex={-1}
        data-add-project-path-dialog=""
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="add-project-path-title" className={styles.title}>
            Add project
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={handleClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className={styles.body}>
          {doctorIssues ? (
            <>
              <p className={styles.doctorLead}>
                Project added. Fix these before they bite:
              </p>
              <ul className={styles.doctorList} data-windows-doctor="">
                {doctorIssues.map((check) => (
                  <li
                    key={check.id}
                    className={styles.doctorItem}
                    data-windows-doctor-check={check.id}
                  >
                    <span className={styles.fieldError}>{check.message}</span>
                    {check.fix ? (
                      <p className={styles.doctorFix}>{check.fix}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className={styles.fieldRow}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  data-windows-doctor-continue=""
                  onClick={onClose}
                >
                  Continue
                </button>
              </div>
            </>
          ) : (
            <>
          <div className={styles.fieldRow} role="group" aria-label="Add mode">
            <button
              type="button"
              className={
                mode === "existing"
                  ? `${styles.btn} ${styles.btnPrimary}`
                  : styles.btn
              }
              data-add-project-mode-existing=""
              aria-pressed={mode === "existing"}
              disabled={pending}
              onClick={() => {
                setMode("existing");
                setError(null);
              }}
            >
              Add existing
            </button>
            <button
              type="button"
              className={
                mode === "create"
                  ? `${styles.btn} ${styles.btnPrimary}`
                  : styles.btn
              }
              data-add-project-mode-create=""
              aria-pressed={mode === "create"}
              disabled={pending}
              onClick={() => {
                setMode("create");
                setError(null);
              }}
            >
              Create new
            </button>
            {onClone ? (
              <button
                type="button"
                className={
                  mode === "clone"
                    ? `${styles.btn} ${styles.btnPrimary}`
                    : styles.btn
                }
                data-add-project-mode-clone=""
                aria-pressed={mode === "clone"}
                disabled={pending}
                onClick={() => {
                  setMode("clone");
                  setError(null);
                }}
              >
                Clone from URL
              </button>
            ) : null}
          </div>

          {mode === "clone" ? (
            <>
              <div className={styles.field}>
                <label
                  className={styles.fieldLabel}
                  htmlFor="add-project-clone-url"
                >
                  Repository URL
                </label>
                <input
                  id="add-project-clone-url"
                  className={`${styles.input} ${styles.monoInput}`}
                  data-add-project-clone-url=""
                  value={cloneUrl}
                  onChange={(e) => setCloneUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo.git"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  onKeyDown={onEnter}
                />
                {cloneUrl.trim() && !isCloneUrl(cloneUrl) ? (
                  <p className={styles.fieldNote} data-add-project-clone-url-hint="">
                    Use an https:// or ssh URL, for example
                    git@github.com:owner/repo.git
                  </p>
                ) : null}
              </div>
              <div className={styles.field}>
                <label
                  className={styles.fieldLabel}
                  htmlFor="add-project-clone-location"
                >
                  Clone into
                </label>
                <PathBrowser
                  id="add-project-clone-location"
                  value={location}
                  onChange={setLocation}
                  onBrowse={onBrowse}
                  onPickDirectory={onPickDirectory}
                  cwd={currentProjectCwd}
                  disabled={pending}
                  placeholder="~/code"
                  onSubmit={() => void submit()}
                  inputDataAttr="data-add-project-clone-location"
                  browseDataAttr="data-add-project-browse-clone-location"
                />
              </div>
              <div className={styles.field}>
                <label
                  className={styles.fieldLabel}
                  htmlFor="add-project-clone-name"
                >
                  Folder name
                </label>
                <input
                  id="add-project-clone-name"
                  className={styles.input}
                  data-add-project-clone-name=""
                  value={cloneName}
                  onChange={(e) => setCloneName(e.target.value)}
                  placeholder={cloneFolderName(cloneUrl) || "repo"}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  onKeyDown={onEnter}
                />
                <p className={styles.fieldNote}>
                  The folder must not exist yet, or be empty.
                </p>
              </div>
              {cloneProgress ? (
                <p
                  className={`${styles.fieldNote} ${styles.monoInput}`}
                  data-add-project-clone-progress=""
                  aria-live="polite"
                >
                  {cloneProgress}
                </p>
              ) : null}
            </>
          ) : mode === "create" ? (
            <>
              <div className={styles.field}>
                <label
                  className={styles.fieldLabel}
                  htmlFor="add-project-create-input"
                >
                  Project name
                </label>
                <input
                  id="add-project-create-input"
                  className={styles.input}
                  data-add-project-create-input=""
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-new-project"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  onKeyDown={onEnter}
                />
              </div>
              <div className={styles.field}>
                <label
                  className={styles.fieldLabel}
                  htmlFor="add-project-create-location"
                >
                  Create in
                </label>
                <PathBrowser
                  id="add-project-create-location"
                  value={location}
                  onChange={setLocation}
                  onBrowse={onBrowse}
                  onPickDirectory={onPickDirectory}
                  cwd={currentProjectCwd}
                  disabled={pending}
                  placeholder="~/code"
                  onSubmit={() => void submit()}
                  inputDataAttr="data-add-project-create-location"
                  browseDataAttr="data-add-project-browse-location"
                />
              </div>
            </>
          ) : (
            <>
              <div className={styles.field}>
                <label
                  className={styles.fieldLabel}
                  htmlFor="add-project-path-input"
                >
                  Project path
                </label>
                <PathBrowser
                  id="add-project-path-input"
                  value={path}
                  onChange={setPath}
                  onBrowse={onBrowse}
                  onPickDirectory={onPickDirectory}
                  cwd={currentProjectCwd}
                  disabled={pending}
                  placeholder="~/code/my-repo"
                  onSubmit={() => void submit()}
                  inputDataAttr="data-add-project-path-input"
                  browseDataAttr="data-add-project-browse-path"
                />
                <p className={styles.fieldNote} data-add-project-git-init-note="">
                  If the folder does not exist yet, or is not a git repository,
                  Solenta will create and initialize it.
                </p>
              </div>
              <div className={styles.field}>
                <label
                  className={styles.fieldLabel}
                  htmlFor="add-project-remote-host"
                >
                  Remote host (user@host)
                </label>
                <input
                  id="add-project-remote-host"
                  className={styles.input}
                  data-add-project-remote-host=""
                  value={remoteHost}
                  onChange={(e) => setRemoteHost(e.target.value)}
                  placeholder="user@host"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  onKeyDown={onEnter}
                />
              </div>
              <div className={styles.field}>
                <label
                  className={styles.fieldLabel}
                  htmlFor="add-project-remote-path"
                >
                  Remote path
                </label>
                <PathBrowser
                  id="add-project-remote-path"
                  value={remotePath}
                  onChange={setRemotePath}
                  onBrowse={onBrowse}
                  environment={host || null}
                  disabled={pending || !host}
                  placeholder="/absolute/path/on/the-remote"
                  onSubmit={() => void submit()}
                  inputDataAttr="data-add-project-remote-path"
                />
              </div>
            </>
          )}

          {error && (
            <p className={styles.fieldError} role="alert">
              {error}
            </p>
          )}
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              data-add-project-path-submit=""
              disabled={pending || !canSubmit}
              onClick={() => void submit()}
            >
              {pending
                ? mode === "create"
                  ? "Creating…"
                  : mode === "clone"
                    ? "Cloning…"
                    : "Adding…"
                : mode === "create"
                  ? "Create"
                  : mode === "clone"
                    ? "Clone"
                    : "Add"}
            </button>
            {pending && mode === "clone" && onCancelClone ? (
              <button
                type="button"
                className={styles.btn}
                data-add-project-clone-cancel=""
                onClick={() => {
                  if (cloneIdRef.current) onCancelClone(cloneIdRef.current);
                }}
              >
                Stop clone
              </button>
            ) : (
              <button
                type="button"
                className={styles.btn}
                disabled={pending}
                onClick={handleClose}
              >
                Cancel
              </button>
            )}
          </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
