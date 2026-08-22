import { useCallback, useState } from "react";
import { useEscapeClose } from "../useEscapeClose";
import type {
  ProjectInfo,
  ProjectQuickAction,
  ProjectUpdateInput,
} from "../shared/ipc";
import { ProjectIcon } from "./ProjectIcon";
import styles from "./SettingsModal.module.css";

interface EditProjectModalProps {
  project: ProjectInfo;
  onClose: () => void;
  onSubmit: (input: ProjectUpdateInput) => Promise<unknown>;
  onPickIcon?: () => Promise<{
    iconPath: string;
    iconUrl: string | null;
  } | null>;
  onPreviewIcon?: (iconPath: string | null) => Promise<string | null>;
}

/**
 * Edit an existing project: display name, appearance (#610), and SSH remote
 * fields. The local checkout path is shown read-only (it is the project's
 * identity on disk). Clearing the host turns the project local again. Reuses
 * the Settings modal chrome, same as AddProjectPathModal.
 */
export function EditProjectModal({
  project,
  onClose,
  onSubmit,
  onPickIcon,
  onPreviewIcon,
}: EditProjectModalProps) {
  const [name, setName] = useState(project.name);
  const [remoteHost, setRemoteHost] = useState(project.remoteHost ?? "");
  const [remotePath, setRemotePath] = useState(project.remotePath ?? "");
  const [autoDispatch, setAutoDispatch] = useState(
    project.autoDispatch ?? false,
  );
  const [retentionText, setRetentionText] = useState(
    String(
      typeof project.worktreeRetention === "number"
        ? project.worktreeRetention
        : 10,
    ),
  );
  const [iconPath, setIconPath] = useState(project.iconPath ?? null);
  const [iconUrl, setIconUrl] = useState(project.iconUrl ?? null);
  const [iconDirty, setIconDirty] = useState(false);
  const [setupCommand, setSetupCommand] = useState(project.setupCommand ?? "");
  const [quickActions, setQuickActions] = useState<ProjectQuickAction[]>(
    () => (project.quickActions ?? []).map((a) => ({ ...a })),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  useEscapeClose(true, handleClose);

  const host = remoteHost.trim();
  const rpath = remotePath.trim();
  const canSubmit = name.trim().length > 0 && (host ? Boolean(rpath) : true);

  const submit = async () => {
    if (pending || !canSubmit) return;
    if (host && !rpath.startsWith("/")) {
      setError("Remote path must be an absolute path (start with /).");
      return;
    }
    const retentionRaw = retentionText.trim();
    let worktreeRetention = 0;
    if (retentionRaw !== "") {
      const n = Number(retentionRaw);
      if (!Number.isInteger(n) || n < 0) {
        setError(
          "Keep worktrees must be a non-negative integer. 0 keeps every worktree.",
        );
        return;
      }
      worktreeRetention = n;
    }

    setPending(true);
    setError(null);
    try {
      const payload: ProjectUpdateInput = {
        projectId: project.id,
        name: name.trim(),
        remoteHost: host,
        remotePath: rpath,
        worktreeRetention,
        autoDispatch,
        setupCommand: setupCommand.trim() || null,
        quickActions: quickActions
          .map((a) => ({
            id: a.id,
            name: a.name.trim(),
            command: a.command.trim(),
          }))
          .filter((a) => a.name && a.command),
      };
      if (iconDirty) payload.iconPath = iconPath;
      const updated = await onSubmit(payload);
      if (!updated) {
        setError("Could not save the project.");
      }
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Could not save the project.",
      );
    } finally {
      setPending(false);
    }
  };

  const enterToSubmit = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-edit-project=""
      onClick={handleClose}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-project-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="edit-project-title" className={styles.title}>
            Edit project
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
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="edit-project-name">
              Name
            </label>
            <input
              id="edit-project-name"
              className={styles.input}
              data-edit-project-name=""
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={enterToSubmit}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel} id="edit-project-icon-label">
              Appearance
            </span>
            <div
              className={styles.fieldRow}
              role="group"
              aria-labelledby="edit-project-icon-label"
            >
              {iconUrl ? (
                <span className={styles.iconPreview} data-edit-project-icon="">
                  <ProjectIcon url={iconUrl} size={28} />
                </span>
              ) : (
                <span
                  className={styles.iconPreviewFallback}
                  data-edit-project-icon-fallback=""
                >
                  No icon
                </span>
              )}
              {onPickIcon && (
                <button
                  type="button"
                  className={styles.btn}
                  data-edit-project-pick-icon=""
                  disabled={pending}
                  onClick={() => {
                    void (async () => {
                      try {
                        const picked = await onPickIcon();
                        if (!picked) return;
                        setIconPath(picked.iconPath);
                        setIconUrl(picked.iconUrl);
                        setIconDirty(true);
                        setError(null);
                      } catch (err) {
                        setError(
                          err instanceof Error && err.message
                            ? err.message
                            : "Could not choose an icon.",
                        );
                      }
                    })();
                  }}
                >
                  Choose a project file
                </button>
              )}
              <button
                type="button"
                className={styles.btn}
                data-edit-project-icon-auto=""
                disabled={pending || (!iconDirty && !project.iconPath)}
                onClick={() => {
                  void (async () => {
                    setIconPath(null);
                    setIconDirty(true);
                    if (!onPreviewIcon) {
                      setIconUrl(null);
                      return;
                    }
                    try {
                      setIconUrl(await onPreviewIcon(null));
                      setError(null);
                    } catch (err) {
                      setIconUrl(null);
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Could not restore automatic icon.",
                      );
                    }
                  })();
                }}
              >
                Automatic
              </button>
            </div>
            {iconPath ? (
              <p className={styles.note} data-edit-project-icon-path="">
                Using {iconPath}
              </p>
            ) : (
              <p className={styles.note}>
                Detected from the repo, or the project name if none is found.
              </p>
            )}
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="edit-project-path">
              Local path
            </label>
            <input
              id="edit-project-path"
              className={styles.input}
              data-edit-project-path=""
              value={project.path}
              readOnly
              disabled
            />
            {project.scm?.kind === "jj" ? (
              <p className={styles.note} data-scm-detail="">
                {project.scm.detail ||
                  "Jujutsu is unsupported. Worktrees and diffs still use git."}
              </p>
            ) : null}
          </div>
          <div className={styles.field}>
            <label
              className={styles.fieldLabel}
              htmlFor="edit-project-retention"
            >
              Keep worktrees for the newest N settled threads
            </label>
            <input
              id="edit-project-retention"
              className={styles.input}
              data-edit-project-retention=""
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              placeholder="10"
              value={retentionText}
              onChange={(e) => setRetentionText(e.target.value)}
              disabled={pending}
              onKeyDown={enterToSubmit}
            />
            <p className={styles.note}>
              0 keeps every worktree. New projects start at 10. Fork and
              archived worktrees never take a slot — those are reclaimed as
              soon as they go quiet. Cleanup removes directories only.
              Branches stay.
            </p>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="edit-project-remote-host">
              Remote host (user@host)
            </label>
            <input
              id="edit-project-remote-host"
              className={styles.input}
              data-edit-project-remote-host=""
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
              placeholder="empty = local project"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={enterToSubmit}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="edit-project-remote-path">
              Remote path
            </label>
            <input
              id="edit-project-remote-path"
              className={styles.input}
              data-edit-project-remote-path=""
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              placeholder="/absolute/path/on/the/remote"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={enterToSubmit}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="edit-project-setup">
              Worktree setup
            </label>
            <input
              id="edit-project-setup"
              className={`${styles.input} ${styles.monoInput}`}
              data-edit-project-setup=""
              value={setupCommand}
              onChange={(e) => setSetupCommand(e.target.value)}
              placeholder="npm install"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
            />
            <p className={styles.note}>
              Runs once when a new worktree is created. Failure is logged on
              the thread and does not remove the worktree.
            </p>
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel} id="edit-project-actions-label">
              Quick actions
            </span>
            <div
              className={styles.actionList}
              role="group"
              aria-labelledby="edit-project-actions-label"
              data-edit-project-actions=""
            >
              {quickActions.map((action, index) => (
                <div
                  key={action.id}
                  className={styles.actionRow}
                  data-edit-project-action=""
                >
                  <input
                    className={styles.input}
                    data-edit-project-action-name=""
                    value={action.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      setQuickActions((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, name } : row,
                        ),
                      );
                    }}
                    placeholder="Lint"
                    aria-label="Action name"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending}
                  />
                  <input
                    className={`${styles.input} ${styles.monoInput}`}
                    data-edit-project-action-command=""
                    value={action.command}
                    onChange={(e) => {
                      const command = e.target.value;
                      setQuickActions((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, command } : row,
                        ),
                      );
                    }}
                    placeholder="npm run lint"
                    aria-label="Action command"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending}
                  />
                  <button
                    type="button"
                    className={styles.btn}
                    data-edit-project-action-remove=""
                    aria-label={`Remove ${action.name || "action"}`}
                    disabled={pending}
                    onClick={() => {
                      setQuickActions((rows) =>
                        rows.filter((_, i) => i !== index),
                      );
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {quickActions.length < 8 ? (
                <button
                  type="button"
                  className={styles.btn}
                  data-edit-project-action-add=""
                  disabled={pending}
                  onClick={() => {
                    setQuickActions((rows) => [
                      ...rows,
                      {
                        id:
                          typeof crypto !== "undefined" && crypto.randomUUID
                            ? crypto.randomUUID()
                            : `action-${Date.now()}-${rows.length}`,
                        name: "",
                        command: "",
                      },
                    ]);
                  }}
                >
                  Add action
                </button>
              ) : null}
            </div>
            <p className={styles.note}>
              Named buttons in the thread header. Run from the worktree when
              one exists.
            </p>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldRow} htmlFor="edit-project-auto-dispatch">
              <input
                id="edit-project-auto-dispatch"
                type="checkbox"
                data-edit-project-auto-dispatch=""
                checked={autoDispatch}
                disabled={pending}
                onChange={(e) => setAutoDispatch(e.target.checked)}
              />
              <span>Auto-start threads from plan:todo</span>
            </label>
            <p className={styles.note}>
              Starts a thread for each issue that enters plan:todo.
            </p>
          </div>
          {error && (
            <p className={styles.fieldError} role="alert">
              {error}
            </p>
          )}
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              data-edit-project-submit=""
              disabled={pending || !canSubmit}
              onClick={() => void submit()}
            >
              {pending ? "Saving…" : "Save"}
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
        </div>
      </div>
    </div>
  );
}
