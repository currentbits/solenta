import { useEffect, useMemo, useState } from "react";
import {
  createFormError,
  formatNextRun,
  scheduleLabel,
} from "../automations";
import type { RepeatDraft } from "../repeatThread";
import type {
  AutomationInfo,
  AutomationPreset,
  AutomationWrite,
  ProjectInfo,
  ProviderInfo,
} from "../shared/ipc";
import styles from "./AutomationsView.module.css";

export interface AutomationsViewProps {
  automations: AutomationInfo[];
  projects: ProjectInfo[];
  providers: ProviderInfo[];
  /** Prefill the create form (issue #285 "repeat this"). */
  draft?: RepeatDraft | null;
  onCreate: (input: AutomationWrite) => Promise<void> | void;
  onUpdate: (
    input: Partial<AutomationWrite> & { id: string },
  ) => Promise<void> | void;
  onRemove: (id: string) => Promise<void> | void;
  onRunNow: (id: string) => Promise<void> | void;
}

export function AutomationsView({
  automations,
  projects,
  providers,
  draft,
  onCreate,
  onUpdate,
  onRemove,
  onRunNow,
}: AutomationsViewProps) {
  const [name, setName] = useState(draft?.name ?? "");
  const [projectId, setProjectId] = useState(
    draft?.projectId ?? projects[0]?.id ?? "",
  );
  const [prompt, setPrompt] = useState(draft?.prompt ?? "");
  const [provider, setProvider] = useState(
    draft?.provider ?? providers[0]?.id ?? "claude",
  );
  const [model, setModel] = useState(draft?.model ?? "");
  const [preset, setPreset] = useState<AutomationPreset>("hourly");
  const [hour, setHour] = useState("9");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!draft) return;
    setName(draft.name);
    setProjectId(draft.projectId);
    setPrompt(draft.prompt);
    setProvider(draft.provider);
    setModel(draft.model ?? "");
  }, [draft]);

  /**
   * Row actions are fire-and-forget from an onClick, so a rejection has to
   * land somewhere visible instead of becoming an unhandled rejection (#85).
   */
  const runRowAction = (id: string, action: () => Promise<void> | void) => {
    setRowError(null);
    void (async () => {
      try {
        await action();
      } catch (err) {
        setRowError({
          id,
          message:
            err instanceof Error && err.message ? err.message : String(err),
        });
      }
    })();
  };

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  const needsHour = preset === "daily" || preset === "weekly";
  const providerModels =
    providers.find((p) => p.id === provider)?.models ?? [];

  const submit = async () => {
    const error = createFormError({
      name,
      projectId,
      prompt,
      provider,
      preset,
      hour,
    });
    if (error) {
      setFormError(error);
      return;
    }
    setFormError(null);
    await onCreate({
      name: name.trim(),
      projectId,
      prompt,
      provider,
      model: model.trim() || null,
      preset,
      hour: needsHour ? Number(hour) : null,
      enabled: true,
    });
    setName("");
    setPrompt("");
    setModel("");
  };

  return (
    <main className={styles.main} data-automations="">
      <header className={styles.header}>
        <h1 className={styles.title}>Automations</h1>
      </header>

      <form
        className={styles.form}
        data-automation-create=""
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className={styles.formRow}>
          <label className={`${styles.field} ${styles.grow}`}>
            <span className={styles.label}>Name</span>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              name="name"
              aria-label="Name"
            />
          </label>
          <label className={`${styles.field} ${styles.grow}`}>
            <span className={styles.label}>Project</span>
            <select
              className={styles.select}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              name="projectId"
              aria-label="Project"
            >
              {projects.length === 0 ? (
                <option value="">No projects</option>
              ) : (
                projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.slug}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Provider</span>
            <select
              className={styles.select}
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel("");
              }}
              name="provider"
              aria-label="Provider"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Model</span>
            {providerModels.length > 0 ? (
              <select
                className={styles.select}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                name="model"
                aria-label="Model"
                data-automation-model=""
              >
                <option value="">Default</option>
                {providerModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={styles.input}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                name="model"
                aria-label="Model"
                placeholder="Default"
                autoComplete="off"
                spellCheck={false}
                data-automation-model=""
              />
            )}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Schedule</span>
            <select
              className={styles.select}
              value={preset}
              onChange={(e) => setPreset(e.target.value as AutomationPreset)}
              name="preset"
              aria-label="Schedule"
            >
              <option value="hourly">hourly</option>
              <option value="daily">daily</option>
              <option value="weekly">weekly</option>
            </select>
          </label>
          {needsHour ? (
            <label className={styles.field}>
              <span className={styles.label}>Hour</span>
              <input
                className={`${styles.input} ${styles.hourInput}`}
                type="number"
                min={0}
                max={23}
                value={hour}
                onChange={(e) => setHour(e.target.value)}
                name="hour"
                aria-label="Hour"
              />
            </label>
          ) : null}
        </div>
        <label className={styles.field}>
          <span className={styles.label}>Prompt</span>
          <textarea
            className={styles.textarea}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            name="prompt"
            aria-label="Prompt"
          />
        </label>
        {formError ? (
          <p className={styles.formError} data-form-error="">
            {formError}
          </p>
        ) : null}
        <button type="submit" className={styles.submit}>
          Add automation
        </button>
      </form>

      {automations.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No automations yet</p>
          <p className={styles.emptyHint}>
            Use the form above to run a prompt on a schedule.
          </p>
        </div>
      ) : (
        <div className={styles.list}>
          {automations.map((auto) => {
            const project = projectById.get(auto.projectId);
            const error =
              rowError && rowError.id === auto.id
                ? rowError.message
                : auto.lastError;
            return (
              <div
                key={auto.id}
                className={styles.row}
                data-automation-row={auto.id}
              >
                <div className={styles.rowTop}>
                  <span className={styles.name}>{auto.name}</span>
                  <span className={styles.slug}>
                    {project?.slug ?? auto.projectId}
                  </span>
                </div>
                <div className={styles.rowMeta}>
                  <span className={styles.schedule}>
                    {scheduleLabel(auto.preset, auto.hour, auto.nextRunAt)}
                  </span>
                  {auto.model ? (
                    <span className={styles.schedule}>{auto.model}</span>
                  ) : null}
                  <span className={styles.next}>
                    {formatNextRun(auto.nextRunAt, now)}
                  </span>
                  {error ? (
                    <span className={styles.error} data-automation-error="">
                      {error}
                    </span>
                  ) : null}
                </div>
                <div className={styles.rowActions}>
                  <label className={styles.toggle}>
                    <input
                      type="checkbox"
                      checked={auto.enabled}
                      data-automation-toggle=""
                      title={auto.enabled ? "Disable" : "Enable"}
                      aria-label={auto.enabled ? "Disable" : "Enable"}
                      onChange={() => {
                        runRowAction(auto.id, () =>
                          onUpdate({ id: auto.id, enabled: !auto.enabled }),
                        );
                      }}
                    />
                    {auto.enabled ? "On" : "Off"}
                  </label>
                  <button
                    type="button"
                    className={styles.action}
                    data-automation-run=""
                    title="Run now"
                    onClick={() => {
                      runRowAction(auto.id, () => onRunNow(auto.id));
                    }}
                  >
                    Run now
                  </button>
                  <button
                    type="button"
                    className={styles.action}
                    data-automation-delete=""
                    data-confirm={confirmId === auto.id ? "true" : undefined}
                    title={
                      confirmId === auto.id ? "Confirm delete" : "Delete"
                    }
                    onClick={() => {
                      if (confirmId !== auto.id) {
                        setConfirmId(auto.id);
                        return;
                      }
                      setConfirmId(null);
                      runRowAction(auto.id, () => onRemove(auto.id));
                    }}
                  >
                    {confirmId === auto.id ? "Confirm delete" : "Delete"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
