import { useCallback, useState } from "react";
import { useEscapeClose } from "../useEscapeClose";
import type { ProjectInfo, WindowsDoctorCheck } from "../shared/ipc";
import styles from "./SettingsModal.module.css";

function failedDoctorChecks(result: unknown): WindowsDoctorCheck[] {
  if (!result || typeof result !== "object") return [];
  const checks = (result as ProjectInfo).windowsDoctor?.checks;
  return Array.isArray(checks) ? checks.filter((c) => !c.ok) : [];
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
  /**
   * Native directory picker; omit where no dialog exists (web mode) and the
   * Browse buttons disappear, leaving plain text inputs.
   */
  onPickDirectory?: () => Promise<string | null>;
}

/**
 * Add-project dialog in both modes. "Add existing" takes a path (web) or a
 * picked folder (native), with optional SSH remotes. "Create new" mkdirs and
 * git-inits a fresh folder via projects.create. Reuses the Settings modal
 * chrome so we do not invent a second dialog system.
 */
export function AddProjectPathModal({
  onClose,
  onSubmit,
  onCreate,
  onPickDirectory,
}: AddProjectPathModalProps) {
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [path, setPath] = useState("");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doctorIssues, setDoctorIssues] = useState<WindowsDoctorCheck[] | null>(
    null,
  );

  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  useEscapeClose(true, handleClose);

  const host = remoteHost.trim();
  const rpath = remotePath.trim();
  const canSubmit =
    mode === "create"
      ? Boolean(name.trim()) && Boolean(location.trim())
      : host
        ? Boolean(rpath)
        : Boolean(path.trim());

  const browse = async (apply: (picked: string) => void) => {
    if (pending || !onPickDirectory) return;
    setError(null);
    try {
      const picked = await onPickDirectory();
      if (picked) apply(picked);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Could not open the folder picker.",
      );
    }
  };

  const submit = async () => {
    if (pending || !canSubmit) return;
    setPending(true);
    setError(null);
    try {
      if (mode === "create") {
        const created = await onCreate(name.trim(), location.trim());
        if (!created) {
          setError("Could not create that project.");
          return;
        }
        const failed = failedDoctorChecks(created);
        if (failed.length) setDoctorIssues(failed);
        else onClose();
      } else {
        if (host && !rpath.startsWith("/")) {
          setError("Remote path must be an absolute path (start with /).");
          return;
        }
        const remotes = host
          ? { remoteHost: host, remotePath: rpath }
          : undefined;
        const added = await onSubmit(path.trim(), remotes);
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
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-path-title"
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
          </div>

          {mode === "create" ? (
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
                <input
                  id="add-project-create-location"
                  className={styles.input}
                  data-add-project-create-location=""
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="/absolute/path/to/parent"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  onKeyDown={onEnter}
                />
                {onPickDirectory && (
                  <div className={styles.fieldRow}>
                    <button
                      type="button"
                      className={styles.btn}
                      data-add-project-browse-location=""
                      disabled={pending}
                      onClick={() => void browse(setLocation)}
                    >
                      Browse…
                    </button>
                  </div>
                )}
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
                <input
                  id="add-project-path-input"
                  className={styles.input}
                  data-add-project-path-input=""
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/absolute/path/to/repo"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  onKeyDown={onEnter}
                />
                {onPickDirectory && (
                  <div className={styles.fieldRow}>
                    <button
                      type="button"
                      className={styles.btn}
                      data-add-project-browse-path=""
                      disabled={pending}
                      onClick={() => void browse(setPath)}
                    >
                      Browse…
                    </button>
                  </div>
                )}
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
                <input
                  id="add-project-remote-path"
                  className={styles.input}
                  data-add-project-remote-path=""
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.target.value)}
                  placeholder="/absolute/path/on/the/remote"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  onKeyDown={onEnter}
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
                  : "Adding…"
                : mode === "create"
                  ? "Create"
                  : "Add"}
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={pending}
              onClick={handleClose}
            >
              Cancel
            </button>
          </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
