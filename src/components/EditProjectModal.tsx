import { useCallback, useRef, useState } from "react";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import type {
  PermissionMode,
  ProjectInfo,
  ProjectQuickAction,
  ProjectThreadDefaults,
  ProjectUpdateInput,
  ProviderInfo,
  ReasoningEffort,
} from "../shared/ipc";
import {
  PERMISSION_MODE_LABELS,
  providerPermissionModes,
  snapToHonouredPermissionMode,
} from "../format";
import { effortDisplayLabel, effortsForModel } from "../modelPicker";
import { ProjectIcon } from "./ProjectIcon";
import styles from "./SettingsModal.module.css";

/**
 * `KEY=value` lines to an env map (#188). Blank and `#` lines are skipped.
 * Returns an error message for the first bad line.
 */
export function parseEnvText(text: string): Record<string, string> | string {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return `Invalid environment line: ${line}`;
    }
    if (key === "PATH") return "PATH cannot be set per project.";
    env[key] = line.slice(eq + 1);
  }
  return env;
}

interface EditProjectModalProps {
  project: ProjectInfo;
  onClose: () => void;
  onSubmit: (input: ProjectUpdateInput) => Promise<unknown>;
  onPickIcon?: () => Promise<{
    iconPath: string;
    iconUrl: string | null;
  } | null>;
  onPreviewIcon?: (iconPath: string | null) => Promise<string | null>;
  /** For the new-thread defaults pickers (#1501). */
  providers?: ProviderInfo[];
  /** settings.defaultProvider; null = the built-in Claude Code default. */
  globalProvider?: string | null;
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
  providers = [],
  globalProvider = null,
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
  const [waitForSetup, setWaitForSetup] = useState(project.waitForSetup === true);
  const [branchPrefix, setBranchPrefix] = useState(project.branchPrefix ?? "");
  const repo = project.repoConfig;
  const [quickActions, setQuickActions] = useState<ProjectQuickAction[]>(
    () => (project.quickActions ?? []).map((a) => ({ ...a })),
  );
  const [defaults, setDefaults] = useState<ProjectThreadDefaults>(
    () => ({ ...project.threadDefaults }),
  );
  // Only sent when touched: "last used" mode rewrites the stored defaults
  // from main, and an unrelated save must not put back a stale copy.
  const [defaultsDirty, setDefaultsDirty] = useState(false);
  const patchDefaults = (patch: Partial<ProjectThreadDefaults>) => {
    setDefaults((d) => ({ ...d, ...patch }));
    setDefaultsDirty(true);
  };
  const defaultProvider = providers.find((p) => p.id === defaults.provider);
  const globalName =
    providers.find((p) => p.id === globalProvider)?.name ?? "Claude Code";
  const defaultEfforts = effortsForModel(defaultProvider, defaults.model);
  const defaultModes = defaults.provider
    ? providerPermissionModes(defaultProvider)
    : providerPermissionModes(null);
  const [envText, setEnvText] = useState(() =>
    Object.entries(project.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  useEscapeClose(!pending, handleClose);
  useModalFocus(true, dialogRef);

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
    const env = parseEnvText(envText);
    if (typeof env === "string") {
      setError(env);
      return;
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
        waitForSetup,
        branchPrefix: branchPrefix.trim() || null,
        quickActions: quickActions
          .map((a) => ({
            id: a.id,
            name: a.name.trim(),
            command: a.command.trim(),
          }))
          .filter((a) => a.name && a.command),
        env,
      };
      if (iconDirty) payload.iconPath = iconPath;
      if (defaultsDirty) {
        payload.threadDefaults = Object.fromEntries(
          Object.entries(defaults).filter(([, v]) => v !== undefined),
        );
      }
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
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-project-title"
        tabIndex={-1}
        data-edit-project-dialog=""
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
          <div className={styles.field} data-edit-project-defaults="">
            <span className={styles.fieldLabel}>New thread defaults</span>
            <div className={styles.fieldRow}>
              <select
                className={styles.input}
                aria-label="Default provider"
                data-edit-project-default-provider=""
                value={defaults.provider ?? ""}
                disabled={pending}
                onChange={(e) => {
                  // A model or effort picked for one CLI is not meaningful
                  // on another; a mode snaps to what the new one honours.
                  const provider = e.target.value || undefined;
                  const info = providers.find((p) => p.id === provider);
                  const mode = defaults.permissionMode
                    ? snapToHonouredPermissionMode(
                        providerPermissionModes(info),
                        defaults.permissionMode,
                      )
                    : undefined;
                  patchDefaults({
                    provider,
                    model: undefined,
                    reasoningEffort: undefined,
                    permissionMode: mode === "default" ? undefined : mode,
                  });
                }}
              >
                <option value="">Global default ({globalName})</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {!p.available ? " (not installed)" : ""}
                  </option>
                ))}
                {defaults.provider && !defaultProvider ? (
                  <option value={defaults.provider}>{defaults.provider}</option>
                ) : null}
              </select>
              {defaults.provider ? (
                <select
                  className={styles.input}
                  aria-label="Default model"
                  data-edit-project-default-model=""
                  value={defaults.model ?? ""}
                  disabled={pending}
                  onChange={(e) => {
                    const model = e.target.value || undefined;
                    const efforts = effortsForModel(defaultProvider, model);
                    patchDefaults({
                      model,
                      ...(defaults.reasoningEffort &&
                      !efforts.includes(defaults.reasoningEffort)
                        ? { reasoningEffort: undefined }
                        : {}),
                    });
                  }}
                >
                  <option value="">Provider default</option>
                  {(defaultProvider?.modelInfo ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {defaults.model &&
                  !defaultProvider?.modelInfo.some(
                    (m) => m.id === defaults.model,
                  ) ? (
                    <option value={defaults.model}>{defaults.model}</option>
                  ) : null}
                </select>
              ) : null}
            </div>
            <div className={styles.fieldRow}>
              {defaultEfforts.length > 0 ? (
                <select
                  className={styles.input}
                  aria-label="Default reasoning effort"
                  data-edit-project-default-effort=""
                  value={defaults.reasoningEffort ?? ""}
                  disabled={pending}
                  onChange={(e) =>
                    patchDefaults({
                      reasoningEffort:
                        (e.target.value as ReasoningEffort) || undefined,
                    })
                  }
                >
                  <option value="">Effort: {effortDisplayLabel(null)}</option>
                  {defaultEfforts.map((level) => (
                    <option key={level} value={level}>
                      Effort: {effortDisplayLabel(level)}
                    </option>
                  ))}
                </select>
              ) : null}
              <select
                className={styles.input}
                aria-label="Default permission mode"
                data-edit-project-default-permission=""
                value={defaults.permissionMode ?? ""}
                disabled={pending}
                onChange={(e) =>
                  patchDefaults({
                    permissionMode:
                      (e.target.value as PermissionMode) || undefined,
                  })
                }
              >
                <option value="">Permissions: {PERMISSION_MODE_LABELS.default}</option>
                {defaultModes
                  .filter((m) => m !== "default")
                  .map((m) => (
                    <option key={m} value={m}>
                      Permissions: {PERMISSION_MODE_LABELS[m]}
                    </option>
                  ))}
              </select>
            </div>
            <label className={styles.fieldRow} htmlFor="edit-project-last-used">
              <input
                id="edit-project-last-used"
                type="checkbox"
                data-edit-project-last-used=""
                checked={defaults.lastUsed === true}
                disabled={pending}
                onChange={(e) =>
                  patchDefaults({
                    lastUsed: e.target.checked ? true : undefined,
                  })
                }
              />
              <span>Follow last used</span>
            </label>
            {defaults.provider &&
            !project.remoteHost &&
            (!defaultProvider || defaultProvider.available === false) ? (
              <p className={styles.fieldError} data-edit-project-default-missing="">
                {defaultProvider?.name ?? defaults.provider} is not installed.
                New threads use {globalName} until it is.
              </p>
            ) : null}
            <p className={styles.note}>
              Applies to new threads in this project. Existing threads keep
              their settings, and an agent profile or worker pool still wins.
              {defaults.lastUsed
                ? " These update to whatever you pick on a new thread before its first message."
                : ""}
            </p>
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
              archived worktrees never take a slot. Those are reclaimed as
              soon as they go quiet. Cleanup removes directories only.
              Branches stay.
            </p>
          </div>
          <div className={styles.field}>
            <label
              className={styles.fieldLabel}
              htmlFor="edit-project-branch-prefix"
            >
              Branch prefix
            </label>
            <input
              id="edit-project-branch-prefix"
              className={`${styles.input} ${styles.monoInput}`}
              data-edit-project-branch-prefix=""
              value={branchPrefix}
              onChange={(e) => setBranchPrefix(e.target.value)}
              placeholder="coder/"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={enterToSubmit}
            />
            <p className={styles.note}>
              New worktree branches are named{" "}
              {(branchPrefix.trim() || "coder/") + "<title>-<id>"}. Existing
              branches keep their names.
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
              {repo?.setupCommand && !setupCommand.trim() ? (
                <span className={styles.sourceTag} data-repo-config-source="setup">
                  from solenta.json
                </span>
              ) : null}
            </label>
            <input
              id="edit-project-setup"
              className={`${styles.input} ${styles.monoInput}`}
              data-edit-project-setup=""
              value={setupCommand}
              onChange={(e) => setSetupCommand(e.target.value)}
              placeholder={repo?.setupCommand ?? "npm install"}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
            />
            <p className={styles.note}>
              Runs once when a new worktree is created, after submodules are
              fetched. Failure is logged on the thread and does not remove the
              worktree.
              {repo?.setupCommand
                ? setupCommand.trim()
                  ? " This overrides the setup in solenta.json."
                  : " Leave empty to use the setup in solenta.json."
                : ""}
            </p>
            <label className={styles.fieldRow} htmlFor="edit-project-wait-setup">
              <input
                id="edit-project-wait-setup"
                type="checkbox"
                data-edit-project-wait-setup=""
                checked={waitForSetup}
                disabled={pending}
                onChange={(e) => setWaitForSetup(e.target.checked)}
              />
              <span>Agent waits for setup</span>
            </label>
            <p className={styles.note}>
              The first message in a new worktree starts once setup finishes.
              If setup fails, the thread says so and the agent starts anyway.
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
              {quickActions.length === 0 && repo?.quickActions?.length
                ? repo.quickActions.map((action) => (
                    <div
                      key={action.id}
                      className={styles.actionRow}
                      data-repo-config-action=""
                    >
                      <span className={styles.note}>{action.name}</span>
                      <code className={styles.repoCommand}>{action.command}</code>
                      <span className={styles.sourceTag}>from solenta.json</span>
                    </div>
                  ))
                : null}
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
              {repo?.quickActions?.length
                ? " Actions added here replace the list in solenta.json."
                : ""}
            </p>
            {repo?.onSettleCommand ? (
              <p className={styles.note} data-repo-on-settle="">
                When a worktree thread settles, solenta.json runs{" "}
                <code>{repo.onSettleCommand}</code> in it.
              </p>
            ) : null}
            {repo?.error ? (
              <p className={styles.fieldError} data-repo-config-error="">
                {repo.error}
              </p>
            ) : repo && !repo.error ? (
              <p className={styles.note} data-repo-config-trust="">
                {repo.trusted
                  ? "The commands in solenta.json are approved for this project."
                  : "Commands from solenta.json ask for your approval before they first run, and again whenever they change."}
              </p>
            ) : null}
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="edit-project-env">
              Environment variables
            </label>
            <textarea
              id="edit-project-env"
              className={`${styles.textarea} ${styles.monoInput}`}
              data-edit-project-env=""
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={"AWS_PROFILE=bedrock-prod\nPORT=3001"}
              rows={4}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
            />
            <p className={styles.note}>
              One KEY=value per line. Applied to agent runs, dev servers,
              terminals and commands in this project. Stored in plain text.
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
