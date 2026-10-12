import { useEffect, useMemo, useRef, useState } from "react";
import {
  automationRunStatusLabel,
  createFormError,
  formatNextRun,
  isTriggerEvent,
  scheduleLabel,
  TRIGGER_EVENT_LABELS,
  triggerLabel,
} from "../automations";
import { formatRelativeAge } from "../format";
import type { RepeatDraft } from "../repeatThread";
import type {
  AutomationInfo,
  AutomationPreset,
  AutomationRunsResult,
  AutomationScope,
  AutomationTrigger,
  AutomationTriggerEvent,
  AutomationWrite,
  ModelRoute,
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
  /** Open this row in the form (automation_create card, #1599). */
  focusId?: string | null;
  onCreate: (input: AutomationWrite) => Promise<void> | void;
  onUpdate: (
    input: Partial<AutomationWrite> & { id: string },
  ) => Promise<void> | void;
  onRemove: (id: string) => Promise<void> | void;
  onRunNow: (id: string, hash?: string) => Promise<void> | void;
  onTrustFile?: (projectId: string, hash: string) => Promise<void> | void;
}

/** Same keys `updateAutomation` uses to decide whether to rewrite solenta.json. */
function definitionChanged(
  fields: {
    name: string;
    prompt: string;
    provider: string;
    model: string | null;
    preset: AutomationPreset;
    hour: number | null;
    trigger: AutomationTrigger | null;
    tier: ModelRoute | null;
  },
  existing: AutomationInfo,
): boolean {
  return (
    fields.name !== existing.name ||
    fields.prompt !== existing.prompt ||
    fields.provider !== existing.provider ||
    fields.model !== (existing.model ?? null) ||
    fields.preset !== existing.preset ||
    fields.hour !== (existing.hour ?? null) ||
    JSON.stringify(fields.trigger) !==
      JSON.stringify(existing.trigger || null) ||
    fields.tier !== (existing.tier ?? null)
  );
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
  focusId,
  onCreate,
  onUpdate,
  onRemove,
  onRunNow,
  onTrustFile,
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
  // #246: "" = run on the provider/model above.
  const [tier, setTier] = useState<ModelRoute | "">("");
  const [hour, setHour] = useState("9");
  // #242: "" = schedule mode, else the GitHub event this automation fires on.
  const [event, setEvent] = useState<AutomationTriggerEvent | "">("");
  const [branch, setBranch] = useState("");
  const [label, setLabel] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [team, setTeam] = useState("");
  const [status, setStatus] = useState("");
  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [environment, setEnvironment] = useState("");
  const [memory, setMemory] = useState("");
  const [scope, setScope] = useState<AutomationScope>("private");
  const [wroteFile, setWroteFile] = useState(false);
  const [dismissedApprove, setDismissedApprove] = useState<Set<string>>(
    () => new Set(),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!draft) return;
    setEditingId(null);
    setName(draft.name);
    setProjectId(draft.projectId);
    setPrompt(draft.prompt);
    setProvider(draft.provider);
    setModel(draft.model ?? "");
  }, [draft]);

  const fillFrom = (auto: AutomationInfo) => {
    setEditingId(auto.id);
    setName(auto.name);
    setProjectId(auto.projectId);
    setPrompt(auto.prompt);
    setProvider(auto.provider);
    setModel(auto.model ?? "");
    setPreset(auto.preset);
    setTier(auto.tier ?? "");
    setHour(auto.hour != null ? String(auto.hour) : "9");
    setEvent(auto.trigger?.event ?? "");
    setBranch(auto.trigger?.branch ?? "");
    setLabel(auto.trigger?.label ?? "");
    setConclusion(auto.trigger?.conclusion ?? "");
    setTeam(auto.trigger?.team ?? "");
    setStatus(auto.trigger?.status ?? "");
    setOrg(auto.trigger?.org ?? "");
    setProject(auto.trigger?.project ?? "");
    setEnvironment(auto.trigger?.environment ?? "");
    setMemory(auto.memory ?? "");
    setScope(auto.scope ?? "private");
    setFormError(null);
  };

  const focusedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || focusedIdRef.current === focusId) return;
    const found = automations.find((a) => a.id === focusId);
    if (!found) return;
    focusedIdRef.current = focusId;
    fillFrom(found);
  }, [focusId, automations]);

  const clearEdit = () => {
    setEditingId(null);
    setName("");
    setPrompt("");
    setModel("");
    setPreset("hourly");
    setTier("");
    setHour("9");
    setEvent("");
    setBranch("");
    setLabel("");
    setConclusion("");
    setTeam("");
    setStatus("");
    setOrg("");
    setProject("");
    setEnvironment("");
    setMemory("");
    setScope("private");
    setFormError(null);
  };

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
  const selectedProject = projectById.get(projectId);
  const projectScopeBlocked = Boolean(
    !selectedProject || selectedProject.remoteHost || !selectedProject.path,
  );
  const approveProjects = projects.filter((p) => {
    const file = p.automationsFile;
    if (!file || dismissedApprove.has(p.id)) return false;
    if (file.error) return true;
    return !file.trusted && file.count > 0;
  });

  useEffect(() => {
    if (projectScopeBlocked && scope === "project" && !editingId) {
      setScope("private");
    }
  }, [projectScopeBlocked, scope, editingId]);

  const needsHour = !event && (preset === "daily" || preset === "weekly");
  const triggerType = isTriggerEvent(event)
    ? event.startsWith("linear_")
      ? "linear"
      : event === "sentry_issue"
        ? "sentry"
        : "github"
    : "github";
  const trigger: AutomationTrigger | null = event
    ? {
        type: triggerType,
        event,
        branch: branch.trim() || null,
        label: label.trim() || null,
        conclusion: (conclusion || null) as AutomationTrigger["conclusion"],
        team:
          event === "linear_issue_created" || event === "linear_status_changed"
            ? team.trim() || null
            : null,
        status: event === "linear_status_changed" ? status.trim() || null : null,
        org: event === "sentry_issue" ? org.trim() || null : null,
        project: event === "sentry_issue" ? project.trim() || null : null,
        environment: event === "sentry_issue" ? environment.trim() || null : null,
      }
    : null;
  const providerModels =
    providers.find((p) => p.id === provider)?.models ?? [];

  /**
   * Click and Enter both call submit() on this form. A useState flag is too
   * late for a same-tick double submit, so the ref is the real lock (#941).
   * Create and edit share this lock so a pending write cannot start twice.
   */
  const submit = async () => {
    if (savingRef.current) return;
    const error = createFormError({
      name,
      projectId,
      prompt,
      provider,
      preset: event ? "hourly" : preset,
      hour,
      event,
      org,
      project,
    });
    if (error) {
      setFormError(error);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        const editing = automations.find((a) => a.id === editingId);
        const hadTier = editing?.tier;
        const nextDef = {
          name: name.trim(),
          prompt,
          provider,
          model: model.trim() || null,
          preset: event ? ("hourly" as const) : preset,
          hour: needsHour ? Number(hour) : null,
          trigger,
          tier: (tier || null) as ModelRoute | null,
        };
        await onUpdate({
          id: editingId,
          name: nextDef.name,
          prompt: nextDef.prompt,
          provider: nextDef.provider,
          model: nextDef.model,
          // Event mode ignores the schedule; hourly needs no hour.
          preset: nextDef.preset,
          hour: nextDef.hour,
          trigger: nextDef.trigger,
          memory,
          ...(tier || hadTier ? { tier: nextDef.tier } : {}),
        });
        setWroteFile(
          Boolean(
            editing?.scope === "project" &&
              editing &&
              definitionChanged(nextDef, editing),
          ),
        );
        clearEdit();
      } else {
        const writeScope = projectScopeBlocked ? "private" : scope;
        await onCreate({
          name: name.trim(),
          projectId,
          prompt,
          provider,
          model: model.trim() || null,
          // Event mode ignores the schedule; hourly needs no hour.
          preset: event ? "hourly" : preset,
          hour: needsHour ? Number(hour) : null,
          trigger,
          enabled: true,
          scope: writeScope,
          ...(tier ? { tier } : {}),
        });
        setWroteFile(writeScope === "project");
        setName("");
        setPrompt("");
        setModel("");
        setTier("");
        setScope("private");
      }
    } catch (err) {
      setFormError(
        err instanceof Error && err.message ? err.message : String(err),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
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
              onChange={(e) => {
                const next = e.target.value;
                setProjectId(next);
                const project = projectById.get(next);
                if (project && (project.remoteHost || !project.path)) {
                  setScope("private");
                }
              }}
              name="projectId"
              aria-label="Project"
              disabled={Boolean(editingId)}
              title={
                editingId
                  ? "Project stays with this automation"
                  : undefined
              }
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
            <span className={styles.label}>Scope</span>
            <select
              className={styles.select}
              value={scope}
              onChange={(e) =>
                setScope(e.target.value as AutomationScope)
              }
              name="scope"
              aria-label="Scope"
              data-automation-scope=""
              disabled={Boolean(editingId)}
              title={
                editingId
                  ? "Scope stays with this automation"
                  : undefined
              }
            >
              <option value="private">Private (this machine)</option>
              <option value="project" disabled={projectScopeBlocked}>
                Project (solenta.json)
              </option>
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
                {model && !providerModels.includes(model) ? (
                  <option value={model}>{model}</option>
                ) : null}
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
            <span className={styles.label}>Routing</span>
            <select
              className={styles.select}
              value={tier}
              onChange={(e) => setTier(e.target.value as ModelRoute | "")}
              name="tier"
              aria-label="Routing"
              title="Pick the model through the project's routing; the provider and model are the fallback"
              data-automation-tier=""
            >
              <option value="">Off</option>
              <option value="auto">Auto</option>
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="strong">Strong</option>
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>When</span>
            <select
              className={styles.select}
              value={event || preset}
              onChange={(e) => {
                const v = e.target.value;
                if (isTriggerEvent(v)) {
                  setEvent(v);
                } else {
                  setEvent("");
                  setPreset(v as AutomationPreset);
                }
              }}
              name="preset"
              aria-label="When"
            >
              <optgroup label="Schedule">
                <option value="hourly">hourly</option>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
              </optgroup>
              <optgroup label="GitHub event (polled every minute)">
                {(
                  Object.keys(TRIGGER_EVENT_LABELS) as AutomationTriggerEvent[]
                )
                  .filter((ev) => !ev.startsWith("linear_") && ev !== "sentry_issue")
                  .map((ev) => (
                    <option key={ev} value={ev}>
                      {TRIGGER_EVENT_LABELS[ev]}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Linear event (polled every minute)">
                <option value="linear_issue_created">{TRIGGER_EVENT_LABELS.linear_issue_created}</option>
                <option value="linear_status_changed">{TRIGGER_EVENT_LABELS.linear_status_changed}</option>
              </optgroup>
              <optgroup label="Sentry event (polled every minute)">
                <option value="sentry_issue">{TRIGGER_EVENT_LABELS.sentry_issue}</option>
              </optgroup>
            </select>
          </label>
          {event === "pr_labeled" ? (
            <label className={styles.field}>
              <span className={styles.label}>Label</span>
              <input
                className={styles.input}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                name="label"
                aria-label="Label"
                placeholder="Any label"
                autoComplete="off"
              />
            </label>
          ) : null}
          {event === "push" || event === "ci_completed" ? (
            <label className={styles.field}>
              <span className={styles.label}>Branch</span>
              <input
                className={styles.input}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                name="branch"
                aria-label="Branch"
                placeholder="Any branch"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : null}
          {event === "ci_completed" ? (
            <label className={styles.field}>
              <span className={styles.label}>Result</span>
              <select
                className={styles.select}
                value={conclusion}
                onChange={(e) => setConclusion(e.target.value)}
                name="conclusion"
                aria-label="Result"
              >
                <option value="">Any</option>
                <option value="success">success</option>
                <option value="failure">failure</option>
                <option value="cancelled">cancelled</option>
                <option value="timed_out">timed out</option>
              </select>
            </label>
          ) : null}
          {event === "linear_issue_created" || event === "linear_status_changed" ? (
            <label className={styles.field}>
              <span className={styles.label}>Team</span>
              <input
                className={styles.input}
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                name="team"
                aria-label="Team"
                placeholder="Any team"
                autoComplete="off"
              />
            </label>
          ) : null}
          {event === "linear_status_changed" ? (
            <label className={styles.field}>
              <span className={styles.label}>Status</span>
              <input
                className={styles.input}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                name="status"
                aria-label="Status"
                placeholder="Any status"
                autoComplete="off"
              />
            </label>
          ) : null}
          {event === "sentry_issue" ? (
            <label className={styles.field}>
              <span className={styles.label}>Org</span>
              <input
                className={styles.input}
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                name="org"
                aria-label="Org"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : null}
          {event === "sentry_issue" ? (
            <label className={styles.field}>
              <span className={styles.label}>Project</span>
              <input
                className={styles.input}
                value={project}
                onChange={(e) => setProject(e.target.value)}
                name="project"
                aria-label="Project"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : null}
          {event === "sentry_issue" ? (
            <label className={styles.field}>
              <span className={styles.label}>Environment</span>
              <input
                className={styles.input}
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                name="environment"
                aria-label="Environment"
                placeholder="Any environment"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : null}
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
        {editingId ? (
          <label className={styles.field}>
            <span className={styles.label}>Memory</span>
            <textarea
              className={styles.textarea}
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
              name="memory"
              aria-label="Memory"
              placeholder="Notes this automation keeps between runs. Runs replace them by ending with an <automation-memory> block."
              data-automation-memory=""
            />
          </label>
        ) : null}
        {formError ? (
          <p className={styles.formError} data-form-error="">
            {formError}
          </p>
        ) : null}
        <div className={styles.formActions}>
          {editingId ? (
            <button
              type="button"
              className={styles.action}
              data-automation-cancel=""
              disabled={saving}
              onClick={() => {
                if (savingRef.current) return;
                clearEdit();
              }}
            >
              Cancel
            </button>
          ) : null}
          <button
            type="submit"
            className={styles.submit}
            disabled={saving}
            aria-busy={saving || undefined}
          >
            {saving
              ? editingId
                ? "Saving…"
                : "Adding…"
              : editingId
                ? "Save"
                : "Add automation"}
          </button>
        </div>
        {wroteFile ? (
          <p className={styles.wrote} data-automation-wrote="">
            Wrote solenta.json — commit it to share.
          </p>
        ) : null}
      </form>

      {approveProjects.length > 0 ? (
        <div className={styles.approveList}>
          {approveProjects.map((project) => {
            const file = project.automationsFile;
            if (!file) return null;
            return (
              <div
                key={project.id}
                className={styles.approveCard}
                role="alertdialog"
                aria-label="Approve solenta.json automations"
                data-automations-approve=""
                data-project={project.id}
              >
                <div className={styles.approveHead}>
                  Run automations from this repo’s solenta.json?
                </div>
                <p className={styles.approveNote}>
                  These come from a checked-in file, so anyone who can
                  push to the repo can change them. You will be asked
                  again if they change.
                </p>
                {file.error ? (
                  <p className={styles.error}>{file.error}</p>
                ) : null}
                <div className={styles.approveActions}>
                  <button
                    type="button"
                    className={styles.approveRun}
                    data-automations-approve-run=""
                    disabled={!onTrustFile || !file.hash}
                    onClick={() => {
                      if (!onTrustFile) return;
                      runRowAction(project.id, () =>
                        onTrustFile(project.id, file.hash),
                      );
                    }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.approveCancel}
                    onClick={() => {
                      setDismissedApprove((prev) => {
                        const next = new Set(prev);
                        next.add(project.id);
                        return next;
                      });
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {automations.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No automations yet</p>
          <p className={styles.emptyHint}>
            Use the form above to run a prompt on a schedule or on a GitHub
            event.
          </p>
        </div>
      ) : (
        <div className={styles.list}>
          {automations.map((auto) => {
            const project = projectById.get(auto.projectId);
            const fileUntrusted = Boolean(
              auto.scope === "project" &&
                project?.automationsFile &&
                !project.automationsFile.trusted,
            );
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
                  <span
                    className={styles.scopeBadge}
                    data-automation-scope-badge=""
                  >
                    {auto.scope === "project" ? "Project" : "Private"}
                  </span>
                </div>
                <div className={styles.rowMeta}>
                  <span className={styles.schedule}>
                    {auto.trigger
                      ? triggerLabel(auto.trigger)
                      : scheduleLabel(auto.preset, auto.hour, auto.nextRunAt)}
                  </span>
                  {auto.model ? (
                    <span className={styles.schedule}>{auto.model}</span>
                  ) : null}
                  {auto.trigger ? null : (
                    <span className={styles.next}>
                      {formatNextRun(auto.nextRunAt, now)}
                    </span>
                  )}
                  {error ? (
                    <span className={styles.error} data-automation-error="">
                      {error}
                    </span>
                  ) : null}
                </div>
                {auto.prompt ? (
                  <p className={styles.prompt} data-automation-prompt="">
                    {auto.prompt}
                  </p>
                ) : null}
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
                      disabled={fileUntrusted}
                      title={
                        auto.scope === "project"
                          ? auto.enabled
                            ? "Stop running on this machine"
                            : "Run on this machine"
                          : auto.enabled
                            ? "Disable"
                            : "Enable"
                      }
                      aria-label={
                        auto.scope === "project"
                          ? auto.enabled
                            ? "Stop running on this machine"
                            : "Run on this machine"
                          : auto.enabled
                            ? "Disable"
                            : "Enable"
                      }
                      onChange={() => {
                        if (fileUntrusted) return;
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
                      runRowAction(auto.id, () => {
                        if (fileUntrusted && project?.automationsFile) {
                          return onRunNow(
                            auto.id,
                            project.automationsFile.hash,
                          );
                        }
                        return onRunNow(auto.id);
                      });
                    }}
                  >
                    Run now
                  </button>
                  <button
                    type="button"
                    className={styles.action}
                    data-automation-edit=""
                    title="Edit"
                    disabled={saving}
                    onClick={() => {
                      if (savingRef.current) return;
                      fillFrom(auto);
                    }}
                  >
                    Edit
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
