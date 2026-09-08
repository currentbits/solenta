import { useEffect, useMemo, useRef, useState } from "react";
import {
  automationRunStatusLabel,
  createFormError,
  formatNextRun,
  scheduleLabel,
} from "../automations";
import { formatRelativeAge } from "../format";
import type { RepeatDraft } from "../repeatThread";
import type {
  AutomationInfo,
  AutomationPreset,
  AutomationRunsResult,
  AutomationWrite,
  ProjectInfo,
  ProviderInfo,
  ThreadStatus,
} from "../shared/ipc";
import styles from "./AutomationsView.module.css";

export interface AutomationsViewProps {
  automations: AutomationInfo[];
  projects: ProjectInfo[];
  providers: ProviderInfo[];
  /** Prefill the create form (issue #285 "repeat this"). */
  draft?: RepeatDraft | null;
  /** Typed retained-run query; viewing history starts no run. */
  loadRuns?: (id: string) => Promise<AutomationRunsResult>;
  onSelectThread?: (id: string) => void;
  /**
   * Live sidebar rows. Used to overlay current status and to hide Open
   * thread when a retained id has since been deleted. Omit while the
   * list is still loading — treat runs as openable.
   */
  liveThreads?: Array<{ id: string; status: ThreadStatus }>;
  onCreate: (input: AutomationWrite) => Promise<void> | void;
  onUpdate: (
    input: Partial<AutomationWrite> & { id: string },
  ) => Promise<void> | void;
  onRemove: (id: string) => Promise<void> | void;
  onRunNow: (id: string) => Promise<void> | void;
}

function liveThreadKey(
  threads: AutomationsViewProps["liveThreads"],
): string {
  if (!threads) return "";
  return threads.map((t) => t.id).join("\n");
}

function AutomationRunHistory({
  automation,
  loadRuns,
  onSelectThread,
  liveThreads,
  now,
}: {
  automation: AutomationInfo;
  loadRuns: (id: string) => Promise<AutomationRunsResult>;
  onSelectThread?: (id: string) => void;
  liveThreads?: Array<{ id: string; status: ThreadStatus }>;
  now: number;
}) {
  const [result, setResult] = useState<AutomationRunsResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRef = useRef(loadRuns);
  loadRef.current = loadRuns;
  const idsKey = liveThreadKey(liveThreads);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadRef.current(automation.id);
        if (cancelled) return;
        setResult(next);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error && err.message ? err.message : String(err),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [automation.id, idsKey]);

  const liveById = useMemo(() => {
    const map = new Map<string, ThreadStatus>();
    for (const t of liveThreads ?? []) map.set(t.id, t.status);
    return map;
  }, [liveThreads]);
  const liveLoaded = liveThreads != null;

  const resolved = (result?.runs ?? []).map((run) => {
    const missing = liveLoaded && !liveById.has(run.threadId);
    const status = liveById.get(run.threadId) ?? run.status;
    return { ...run, status, missing };
  });
  const latest = resolved[0] ?? null;
  const lastRunMissing =
    result != null &&
    !loadError &&
    automation.lastRunAt != null &&
    resolved.length === 0;

  const openThread = (threadId: string) => {
    onSelectThread?.(threadId);
  };

  return (
    <div className={styles.runsBlock}>
      {loadError ? (
        <p className={styles.error} data-automation-runs-error="">
          {loadError}
        </p>
      ) : null}
      {latest && !latest.missing ? (
        <div className={styles.latest} data-automation-latest="">
          <span className={styles.latestLabel}>Latest run</span>
          <span className={styles.runAge}>
            {formatRelativeAge(latest.startedAt, now)}
          </span>
          <span
            className={styles.runStatus}
            data-automation-latest-status={latest.status}
            data-run-display={automationRunStatusLabel(latest.status)}
          >
            {automationRunStatusLabel(latest.status)}
          </span>
          <button
            type="button"
            className={styles.action}
            data-automation-open-thread=""
            title="Open thread"
            onClick={() => openThread(latest.threadId)}
          >
            Open thread
          </button>
        </div>
      ) : latest?.missing ? (
        <div className={styles.latest} data-automation-latest="">
          <span className={styles.latestLabel}>Latest run</span>
          <span className={styles.unavailable}>Transcript unavailable</span>
        </div>
      ) : lastRunMissing ? (
        <p className={styles.missing} data-automation-runs-missing="">
          The last run is no longer retained.
        </p>
      ) : null}
      {resolved.length > 0 || result?.retentionLimitReached ? (
        <>
          <button
            type="button"
            className={styles.runsToggle}
            data-automation-runs-toggle=""
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            Recent retained runs
          </button>
          {expanded ? (
            <ul className={styles.runs} data-automation-runs="">
              {resolved.map((run) => (
                <li key={run.threadId}>
                  {run.missing ? (
                    <div
                      className={styles.runRow}
                      data-automation-run-row={run.threadId}
                      data-thread-unavailable=""
                    >
                      <span className={styles.runAge}>
                        {formatRelativeAge(run.startedAt, now)}
                      </span>
                      <span className={styles.runStatus}>
                        {automationRunStatusLabel(run.status)}
                      </span>
                      <span className={styles.unavailable}>
                        Transcript unavailable
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={styles.runRow}
                      data-automation-run-row={run.threadId}
                      title="Open thread"
                      onClick={() => openThread(run.threadId)}
                    >
                      <span className={styles.runAge}>
                        {formatRelativeAge(run.startedAt, now)}
                      </span>
                      <span
                        className={styles.runStatus}
                        data-run-display={automationRunStatusLabel(run.status)}
                      >
                        {automationRunStatusLabel(run.status)}
                      </span>
                    </button>
                  )}
                </li>
              ))}
              {result?.retentionLimitReached ? (
                <li
                  className={styles.pruned}
                  data-automation-retention-limit=""
                >
                  Older runs may no longer be retained.
                </li>
              ) : null}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function AutomationsView({
  automations,
  projects,
  providers,
  draft,
  loadRuns,
  onSelectThread,
  liveThreads,
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
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
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

  /**
   * Click and Enter both call submit() on this form. A useState flag is too
   * late for a same-tick double submit, so the ref is the real lock (#941).
   */
  const submit = async () => {
    if (creatingRef.current) return;
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
    creatingRef.current = true;
    setCreating(true);
    setFormError(null);
    try {
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
    } catch (err) {
      setFormError(
        err instanceof Error && err.message ? err.message : String(err),
      );
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
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
        <button
          type="submit"
          className={styles.submit}
          disabled={creating}
          aria-busy={creating || undefined}
        >
          {creating ? "Adding…" : "Add automation"}
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
                {loadRuns ? (
                  <AutomationRunHistory
                    automation={auto}
                    loadRuns={loadRuns}
                    onSelectThread={onSelectThread}
                    liveThreads={liveThreads}
                    now={now}
                  />
                ) : null}
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
