import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentConfigDoctorReport,
  AgentConfigPreview,
  AgentConfigWriteResult,
  ProjectCodeMap,
  MemoryAutoResolved,
  MemoryCitation,
  MemoryEntryInfo,
  MemoryMaintenanceReport,
  MemoryReviewItem,
  MemoryReviewResolution,
} from "../shared/ipc";
import { formatRelativeAge } from "../format";
import styles from "./MemoryTab.module.css";
import {
  actionErrorFor,
  afterCollapse,
  beginConfirmDelete,
  cancelConfirmDelete,
  cancelEdit,
  clearActionError,
  clearAllCardActions,
  clearEntryActions,
  draftFor,
  emptyCardActions,
  isConfirmDelete,
  isEditing,
  memoryCardState,
  setActionError,
  setDraft,
  startEdit,
  type CardActionsById,
} from "../memoryCard";

const MEMORY_NOT_RUNNING = "Memory server is not running.";
const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 3;
const PAGE_SIZE = 20;

type StoreType = "knowledge" | "convention" | "task" | "strategy";
type FilterType = "" | StoreType;

type SessionSnap = {
  projectSlug: string | null;
  query: string;
  filterType: FilterType;
  scrollTop: number;
  formType: StoreType;
  formTitle: string;
  formBody: string;
  adding: boolean;
  cardActions: CardActionsById;
  expandedId: string | null;
};

let sessionSnap: SessionSnap | null = null;

export function resetMemoryTabSession(): void {
  sessionSnap = null;
}

function isDirtySession(s: {
  formTitle: string;
  formBody: string;
  cardActions: CardActionsById;
}): boolean {
  if (s.formTitle.trim() || s.formBody.trim()) return true;
  return (
    Object.keys(s.cardActions.editing).length > 0 ||
    Object.keys(s.cardActions.drafts).length > 0
  );
}

function scopeLabel(slug: string | null | undefined): string {
  return slug ? slug.split("/").filter(Boolean).pop() || slug : "all projects";
}

export interface MemoryTabProps {
  /** Project PATH of the selected thread (falls back to slug). The memory
   *  server canonicalizes a path to the repo-root basename — the same key
   *  agents store under — while a display slug like "owner/solenta" resolves
   *  to a scope no agent ever writes to. */
  projectSlug: string | null;
  /** Project id for the config doctor. Absent = no doctor card. */
  projectId?: string | null;
  searchMemory: (input: {
    query: string;
    project?: string;
    type?: MemoryEntryInfo["type"];
  }) => Promise<MemoryEntryInfo[]>;
  recentMemory: (input?: {
    limit?: number;
    offset?: number;
    project?: string;
    type?: MemoryEntryInfo["type"];
  }) => Promise<MemoryEntryInfo[]>;
  getMemory: (input: { id: string }) => Promise<MemoryEntryInfo>;
  updateMemory: (input: {
    id: string;
    title: string;
    body: string;
  }) => Promise<{ id: string }>;
  removeMemory: (input: { id: string }) => Promise<void>;
  storeMemory: (input: {
    type: MemoryEntryInfo["type"];
    title: string;
    body: string;
    project?: string;
  }) => Promise<{ id: string }>;
  loadCodeMap?: (input: { projectId: string }) => Promise<ProjectCodeMap>;
  lintAgentConfig?: (input: {
    projectId: string;
  }) => Promise<AgentConfigDoctorReport>;
  previewAgentConfig?: (input: {
    projectId: string;
    targets?: string[];
  }) => Promise<AgentConfigPreview>;
  writeAgentConfig?: (input: {
    projectId: string;
    targets?: string[];
  }) => Promise<AgentConfigWriteResult>;
  maintenanceMemory?: (input?: {
    project?: string;
    summary?: boolean;
  }) => Promise<MemoryMaintenanceReport>;
  resolveMemory?: (input: {
    id: number;
    resolution: MemoryReviewResolution;
  }) => Promise<{ ok: boolean; id: number; resolution: string }>;
}

function isNotRunningError(err: unknown): boolean {
  if (err instanceof Error && err.message === MEMORY_NOT_RUNNING) return true;
  return String(err).includes(MEMORY_NOT_RUNNING);
}

function citationLabel(c: MemoryCitation): string {
  if (c.kind === "file") return c.line ? `${c.path}:${c.line}` : c.path;
  if (c.kind === "thread") return `thread ${c.id.slice(0, 8)}`;
  if (c.kind === "commit") return c.sha.slice(0, 7);
  return "";
}

function typeBadgeClass(type: MemoryEntryInfo["type"]): string {
  if (type === "convention") return styles.badgeConvention;
  if (type === "strategy") return styles.badgeStrategy;
  if (type === "knowledge") return styles.badgeKnowledge;
  if (type === "task") return styles.badgeTask;
  return styles.badgeRun;
}

function ageFromIso(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return formatRelativeAge(ms, now);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function autoResolvedActivity(auto: MemoryAutoResolved): string | null {
  if (auto.last7Days <= 0) return null;
  const head = `${auto.last7Days} pair${auto.last7Days === 1 ? "" : "s"} auto-resolved this week: ${auto.invalidated} invalidated, ${auto.kept} kept`;
  const rules = Object.entries(auto.byRule)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([rule, n]) => `${rule.replace(/_/g, " ")} ${n}`);
  return rules.length ? `${head} · ${rules.join(", ")}` : head;
}

function gradeClass(grade: AgentConfigDoctorReport["grade"]): string {
  if (grade === "A" || grade === "B") return styles.gradeGood;
  if (grade === "C") return styles.gradeMid;
  return styles.gradeBad;
}

function CodeMapCard({
  projectId,
  loadCodeMap,
}: {
  projectId: string;
  loadCodeMap: (input: { projectId: string }) => Promise<ProjectCodeMap>;
}) {
  const [map, setMap] = useState<ProjectCodeMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const epochRef = useRef(0);
  const liveProjectRef = useRef(projectId);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const projectChanged = liveProjectRef.current !== projectId;
    liveProjectRef.current = projectId;
    if (projectChanged) {
      setMap(null);
      setOpen(null);
      setError(null);
    }
  }, [projectId]);

  useEffect(() => {
    if (!opened) return;
    epochRef.current += 1;
    const epoch = epochRef.current;
    setError(null);
    const live = () =>
      mounted.current &&
      epoch === epochRef.current &&
      liveProjectRef.current === projectId;
    void loadCodeMap({ projectId })
      .then((next) => {
        if (live()) setMap(next);
      })
      .catch((err: unknown) => {
        if (live()) {
          setError(errorMessage(err));
          setMap(null);
        }
      });
  }, [loadCodeMap, projectId, opened, refresh]);

  const sha = map?.headSha ? map.headSha.slice(0, 7) : "";
  const loc = [map?.defaultBranch, sha && `@ ${sha}`].filter(Boolean).join(" ");
  const age = map?.updatedAt ? ageFromIso(new Date(map.updatedAt).toISOString()) : "";

  return (
    <details
      className={styles.section}
      data-code-map=""
      open={opened}
    >
      <summary
        className={styles.disclosureSummary}
        onClick={(e) => {
          e.preventDefault();
          setOpened((on) => !on);
        }}
      >
        <span className={styles.sectionTitle}>Code map</span>
        {map && map.fileCount > 0 ? (
          <span className={styles.sectionMeta}>
            {map.fileCount} files · {map.symbolCount} symbols
          </span>
        ) : null}
      </summary>
      {opened ? (
        <>
      <p className={styles.mapHint}>
        Regenerated wiki of the repo, not agent memory.
        {loc ? ` ${loc}` : ""}
        {age ? ` · ${age}` : ""}
      </p>
      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      {map && map.modules.length === 0 && !error ? (
        <p className={styles.mapEmpty}>No index yet. It builds from the checkout.</p>
      ) : null}
      {map && map.modules.length > 0 ? (
        <ul className={styles.mapModules}>
          {map.modules.map((mod) => {
            const expanded = open === mod.name;
            return (
              <li key={mod.name}>
                <button
                  type="button"
                  className={styles.mapModule}
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : mod.name)}
                >
                  <span className={styles.mapModuleName}>{mod.name}/</span>
                  <span className={styles.mapModuleCount}>
                    {mod.fileCount} file{mod.fileCount === 1 ? "" : "s"}
                  </span>
                </button>
                {expanded ? (
                  <ul className={styles.mapHot}>
                    {mod.hot.map((file) => (
                      <li key={file.path}>
                        <span className={styles.mapFile}>{file.path}</span>
                        {file.symbols.length > 0 ? (
                          <span className={styles.mapSymbols}>
                            {file.symbols.join(", ")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {map && map.dependencies.length > 0 ? (
        <p className={styles.mapDeps}>
          <span className={styles.sectionMeta}>Dependencies</span>
          {map.dependencies.join(", ")}
        </p>
      ) : null}
      <button
        type="button"
        className={styles.retryBtn}
        onClick={() => setRefresh((n) => n + 1)}
      >
        Refresh
      </button>
        </>
      ) : null}
    </details>
  );
}

function projectLabelOf(slug: string | null | undefined, projectId: string): string {
  const base = slug?.split("/").filter(Boolean).pop();
  return base || projectId;
}

function ConfigDoctorCard({
  projectId,
  projectLabel,
  lintAgentConfig,
  previewAgentConfig,
  writeAgentConfig,
}: {
  projectId: string;
  projectLabel: string;
  lintAgentConfig: (input: {
    projectId: string;
  }) => Promise<AgentConfigDoctorReport>;
  previewAgentConfig?: (input: {
    projectId: string;
    targets?: string[];
  }) => Promise<AgentConfigPreview>;
  writeAgentConfig?: (input: {
    projectId: string;
    targets?: string[];
  }) => Promise<AgentConfigWriteResult>;
}) {
  const [opened, setOpened] = useState(false);
  const [report, setReport] = useState<AgentConfigDoctorReport | null>(null);
  const [preview, setPreview] = useState<AgentConfigPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [wrote, setWrote] = useState<string[] | null>(null);
  const mounted = useRef(true);
  /** Bumped on project change so A's in-flight lint/preview cannot paint B. */
  const epochRef = useRef(0);
  const liveProjectRef = useRef(projectId);
  const wroteByProject = useRef<Record<string, string[]>>({});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    epochRef.current += 1;
    liveProjectRef.current = projectId;
    setPreview(null);
    setConfirmWrite(false);
    setReport(null);
    setError(null);
    setBusy(false);
    setWrote(wroteByProject.current[projectId] ?? null);
  }, [projectId]);

  const stillThisProject = (epoch: number, forProject: string) =>
    mounted.current &&
    epochRef.current === epoch &&
    liveProjectRef.current === forProject;

  const loadLint = useCallback(async () => {
    const epoch = epochRef.current;
    const forProject = projectId;
    setBusy(true);
    setError(null);
    try {
      const next = await lintAgentConfig({ projectId: forProject });
      if (!stillThisProject(epoch, forProject)) return;
      setReport(next);
    } catch (err) {
      if (!stillThisProject(epoch, forProject)) return;
      setError(errorMessage(err));
      setReport(null);
    } finally {
      if (stillThisProject(epoch, forProject)) setBusy(false);
    }
  }, [lintAgentConfig, projectId]);

  useEffect(() => {
    if (!opened) return;
    void loadLint();
  }, [loadLint, opened]);

  const onPreview = async () => {
    if (!previewAgentConfig) return;
    const epoch = epochRef.current;
    const forProject = projectId;
    setBusy(true);
    setError(null);
    try {
      const next = await previewAgentConfig({ projectId: forProject });
      if (!stillThisProject(epoch, forProject)) return;
      setPreview(next);
      setConfirmWrite(false);
    } catch (err) {
      if (!stillThisProject(epoch, forProject)) return;
      setError(errorMessage(err));
    } finally {
      if (stillThisProject(epoch, forProject)) setBusy(false);
    }
  };

  const onWrite = async () => {
    if (!writeAgentConfig) return;
    if (!confirmWrite) {
      setConfirmWrite(true);
      return;
    }
    const forProject = projectId;
    setBusy(true);
    setError(null);
    try {
      const result = await writeAgentConfig({ projectId: forProject });
      wroteByProject.current[forProject] = result.written;
      if (!mounted.current || liveProjectRef.current !== forProject) return;
      setWrote(result.written);
      setConfirmWrite(false);
      setPreview(null);
      const next = await lintAgentConfig({ projectId: forProject });
      if (!mounted.current || liveProjectRef.current !== forProject) return;
      setReport(next);
    } catch (err) {
      if (!mounted.current || liveProjectRef.current !== forProject) return;
      setError(errorMessage(err));
    } finally {
      if (mounted.current && liveProjectRef.current === forProject) {
        setBusy(false);
      }
    }
  };

  const missing = report?.memory.missing.length ?? 0;
  const considered = report?.memory.considered ?? 0;

  return (
    <details
      className={styles.section}
      data-config-doctor=""
      data-config-project={projectId}
      open={opened}
    >
      <summary
        className={styles.disclosureSummary}
        onClick={(e) => {
          e.preventDefault();
          setOpened((on) => !on);
        }}
      >
        <span className={styles.sectionTitle}>Config doctor</span>
        {report ? (
          <span
            className={`${styles.grade} ${gradeClass(report.grade)}`}
            data-grade={report.grade}
          >
            {report.grade} {report.score}
          </span>
        ) : null}
      </summary>
      {opened ? (
        <>
      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      <p className={styles.doctorMeta} data-config-target="">
        {projectLabel}
        {report
          ? ` · ${
              report.files.length === 0
                ? "No AGENTS.md or CLAUDE.md"
                : `${report.files.length} file${report.files.length === 1 ? "" : "s"}`
            }${
              considered > 0
                ? ` · ${report.memory.covered}/${considered} memory`
                : ""
            }`
          : ""}
      </p>
      {report ? (
        <>
          {report.files.length > 0 ? (
            <ul className={styles.doctorFiles}>
              {report.files.map((file) => (
                <li key={file.path}>
                  <span className={styles.doctorFilePath}>{file.path}</span>
                  <span className={styles.doctorFileGrade}>
                    {file.grade} {file.score}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {missing > 0 ? (
            <p className={styles.doctorGap}>
              {missing} memor{missing === 1 ? "y" : "ies"} not in the files
            </p>
          ) : null}
        </>
      ) : null}
      {preview ? (
        <pre className={styles.doctorPreview} data-config-preview="">
          {preview.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n")}
        </pre>
      ) : null}
      {preview && preview.warnings && preview.warnings.length > 0 ? (
        <p className={styles.doctorGap} data-config-warnings="">
          {preview.warnings.join(" · ")}
        </p>
      ) : null}
      {wrote ? (
        <p className={styles.doctorWrote} data-config-wrote="">
          Wrote {wrote.join(", ")}
        </p>
      ) : null}
      <div className={styles.doctorActions}>
        {previewAgentConfig ? (
          <button
            type="button"
            className={styles.retryBtn}
            disabled={busy}
            onClick={() => void onPreview()}
          >
            {preview ? "Refresh preview" : "Preview"}
          </button>
        ) : null}
        {writeAgentConfig ? (
          <button
            type="button"
            className={confirmWrite ? styles.dangerBtn : styles.saveBtn}
            disabled={busy}
            onClick={() => void onWrite()}
          >
            {confirmWrite
              ? `Confirm write to ${projectLabel}`
              : preview
                ? `Write ${preview.files.map((f) => f.path).join(", ")}`
                : "Write from memory"}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.retryBtn}
          disabled={busy}
          onClick={() => void loadLint()}
        >
          Refresh
        </button>
      </div>
        </>
      ) : null}
    </details>
  );
}

function ReviewQueueCard({
  projectSlug,
  maintenanceMemory,
  resolveMemory,
}: {
  projectSlug: string | null;
  maintenanceMemory: (input?: {
    project?: string;
    summary?: boolean;
  }) => Promise<MemoryMaintenanceReport>;
  resolveMemory?: (input: {
    id: number;
    resolution: MemoryReviewResolution;
  }) => Promise<{ ok: boolean; id: number; resolution: string }>;
}) {
  const [report, setReport] = useState<MemoryMaintenanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [opened, setOpened] = useState(false);
  const [detailLoaded, setDetailLoaded] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (full: boolean) => {
    setError(null);
    try {
      const next = await maintenanceMemory({
        project: projectSlug || undefined,
        ...(full ? {} : { summary: true }),
      });
      if (!mounted.current) return;
      setReport(next);
      if (full) setDetailLoaded(true);
    } catch (err) {
      if (!mounted.current) return;
      setError(errorMessage(err));
      if (full) setReport(null);
    }
  }, [maintenanceMemory, projectSlug]);

  useEffect(() => {
    setOpened(false);
    setDetailLoaded(false);
    void load(false);
  }, [load]);

  const onResolve = async (id: number, resolution: MemoryReviewResolution) => {
    if (!resolveMemory) return;
    setBusyId(id);
    setError(null);
    try {
      await resolveMemory({ id, resolution });
      if (!mounted.current) return;
      await load(true);
    } catch (err) {
      if (!mounted.current) return;
      setError(errorMessage(err));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  const items: MemoryReviewItem[] = report?.queue.items ?? [];
  const open = report?.queue.open ?? 0;
  const activity = report?.autoResolved
    ? autoResolvedActivity(report.autoResolved)
    : null;
  if (!error && report && open === 0 && !activity) return null;

  return (
    <section className={styles.section} data-review-queue="">
      <div className={styles.sectionHead}>
        <button
          type="button"
          className={styles.reviewChip}
          data-review-open=""
          aria-expanded={opened}
          onClick={() => {
            const next = !opened;
            setOpened(next);
            if (next && !detailLoaded) void load(true);
          }}
        >
          {open > 0
            ? `${open} need${open === 1 ? "s" : ""} your call`
            : "Review"}
        </button>
        {opened ? (
          <button
            type="button"
            className={styles.retryBtn}
            onClick={() => void load(true)}
          >
            Refresh
          </button>
        ) : null}
      </div>
      {opened ? (
        <>
      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      {activity ? (
        <p className={styles.doctorMeta} data-review-activity="">
          {activity}
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul className={styles.queueList} data-needs-your-call="">
          {items.map((item) => (
            <li key={item.id} className={styles.queueItem}>
              <p className={styles.queuePair}>
                <span className={styles.queueKind}>{item.kind.replace(/_/g, " ")}</span>
                {" · "}
                {item.a.title || item.a.id}
                {" ↔ "}
                {item.b.title || item.b.id}
              </p>
              {resolveMemory ? (
                <div className={styles.doctorActions}>
                  <button
                    type="button"
                    className={styles.retryBtn}
                    disabled={busyId === item.id}
                    onClick={() => void onResolve(item.id, "noop")}
                  >
                    Keep both
                  </button>
                  <button
                    type="button"
                    className={styles.retryBtn}
                    disabled={busyId === item.id}
                    onClick={() => void onResolve(item.id, "update")}
                  >
                    Mark reviewed
                  </button>
                  <button
                    type="button"
                    className={styles.dangerBtn}
                    disabled={busyId === item.id}
                    onClick={() => void onResolve(item.id, "invalidate")}
                  >
                    Invalidate older
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
        </>
      ) : null}
    </section>
  );
}

export function MemoryTab({
  projectSlug,
  projectId,
  searchMemory,
  recentMemory,
  getMemory,
  updateMemory,
  removeMemory,
  storeMemory,
  loadCodeMap,
  lintAgentConfig,
  previewAgentConfig,
  writeAgentConfig,
  maintenanceMemory,
  resolveMemory,
}: MemoryTabProps) {
  const snap = sessionSnap;
  const [entries, setEntries] = useState<MemoryEntryInfo[]>([]);
  const [query, setQuery] = useState(() => snap?.query ?? "");
  const [filterType, setFilterType] = useState<FilterType>(
    () => snap?.filterType ?? "",
  );
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(
    () => snap?.expandedId ?? null,
  );
  /**
   * Drafts, edit intent, delete-confirm, and action errors keyed by entry id.
   * Collapse keeps drafts; card A cannot paint on card B by construction.
   */
  const [cardActions, setCardActions] = useState(
    () => snap?.cardActions ?? emptyCardActions(),
  );
  const [actionBusy, setActionBusy] = useState(false);
  const [fullBodies, setFullBodies] = useState<Record<string, string>>({});
  /** Ids whose memory.get failed (non-not-running); re-click retries. */
  const [failedIds, setFailedIds] = useState<Record<string, string>>({});
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [formType, setFormType] = useState<StoreType>(
    () => snap?.formType ?? "knowledge",
  );
  const [formTitle, setFormTitle] = useState(() => snap?.formTitle ?? "");
  const [formBody, setFormBody] = useState(() => snap?.formBody ?? "");
  const [adding, setAdding] = useState(() => snap?.adding ?? false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [listProject, setListProject] = useState<string | null>(() => {
    if (snap && isDirtySession(snap) && snap.projectSlug !== projectSlug) {
      return snap.projectSlug;
    }
    return projectSlug;
  });
  const [discardOpen, setDiscardOpen] = useState(() =>
    Boolean(snap && isDirtySession(snap) && snap.projectSlug !== projectSlug),
  );

  /** Bumped so late awaits do not clobber newer list results. */
  const listGen = useRef(0);
  const expandedRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  /** Latest search box text for Retry after not-running. */
  const queryRef = useRef(query);
  const entriesRef = useRef(entries);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const persistRef = useRef<SessionSnap>({
    projectSlug: listProject,
    query,
    filterType,
    scrollTop: snap?.scrollTop ?? 0,
    formType,
    formTitle,
    formBody,
    adding,
    cardActions,
    expandedId,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    expandedRef.current = expandedId;
  }, [expandedId]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    persistRef.current = {
      projectSlug: listProject,
      query,
      filterType,
      scrollTop: scrollRef.current?.scrollTop ?? persistRef.current.scrollTop,
      formType,
      formTitle,
      formBody,
      adding,
      cardActions,
      expandedId,
    };
  }, [
    listProject,
    query,
    filterType,
    formType,
    formTitle,
    formBody,
    adding,
    cardActions,
    expandedId,
  ]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && snap && snap.projectSlug === listProject) {
      el.scrollTop = snap.scrollTop;
    }
    return () => {
      persistRef.current.scrollTop = scrollRef.current?.scrollTop ?? 0;
      sessionSnap = persistRef.current;
    };
    // Restore once on mount; persist on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    if (listProject === projectSlug) {
      setDiscardOpen(false);
      return;
    }
    if (isDirtySession({ formTitle, formBody, cardActions })) {
      setDiscardOpen(true);
      return;
    }
    setListProject(projectSlug);
    setEntries([]);
    setFullBodies({});
    setExpandedId(null);
    setFailedIds({});
    setCardActions(clearAllCardActions());
    setDiscardOpen(false);
  }, [projectSlug, listProject, formTitle, formBody, cardActions]);

  const discardAndSwitch = () => {
    setCardActions(clearAllCardActions());
    setFormTitle("");
    setFormBody("");
    setAdding(false);
    setExpandedId(null);
    setFullBodies({});
    setFailedIds({});
    setDiscardOpen(false);
    setListProject(projectSlug);
  };

  const loadRecent = useCallback(
    async (mode: "replace" | "append" = "replace") => {
      const gen = mode === "replace" ? ++listGen.current : listGen.current;
      if (mode === "replace") setLoading(true);
      else setLoadingMore(true);
      try {
        const project = listProject ?? undefined;
        const offset = mode === "append" ? entriesRef.current.length : 0;
        const list = await recentMemory({
          limit: PAGE_SIZE,
          ...(offset > 0 ? { offset } : {}),
          ...(project ? { project } : {}),
          ...(filterType ? { type: filterType } : {}),
        });
        if (!mountedRef.current || listGen.current !== gen) return;
        if (mode === "append") {
          const have = new Set(entriesRef.current.map((row) => row.id));
          setEntries([...entriesRef.current, ...list.filter((row) => !have.has(row.id))]);
        } else {
          setEntries(list);
        }
        setHasMore(list.length === PAGE_SIZE);
        setListError(null);
        setServerDown(false);
      } catch (err) {
        if (!mountedRef.current || listGen.current !== gen) return;
        if (isNotRunningError(err)) {
          setServerDown(true);
          if (mode === "replace") setEntries([]);
          setListError(null);
        } else {
          setListError(errorMessage(err));
          if (mode === "replace") setEntries([]);
        }
      } finally {
        if (mountedRef.current && listGen.current === gen) {
          if (mode === "replace") setLoading(false);
          else setLoadingMore(false);
        }
      }
    },
    [recentMemory, listProject, filterType],
  );

  const runSearch = useCallback(
    async (q: string) => {
      const gen = ++listGen.current;
      setLoading(true);
      try {
        const project = listProject ?? undefined;
        const list = await searchMemory({
          query: q,
          ...(project ? { project } : {}),
          ...(filterType ? { type: filterType } : {}),
        });
        if (!mountedRef.current || listGen.current !== gen) return;
        setEntries(list);
        setHasMore(false);
        setListError(null);
        setServerDown(false);
      } catch (err) {
        if (!mountedRef.current || listGen.current !== gen) return;
        if (isNotRunningError(err)) {
          setServerDown(true);
          setEntries([]);
          setListError(null);
        } else {
          setListError(errorMessage(err));
          setEntries([]);
        }
      } finally {
        if (mountedRef.current && listGen.current === gen) {
          setLoading(false);
        }
      }
    },
    [searchMemory, listProject, filterType],
  );

  /** Retry after not-running: re-run active search when query is long enough. */
  const reloadCurrent = useCallback(() => {
    const trimmed = queryRef.current.trim();
    if (trimmed.length >= MIN_QUERY_LEN) {
      void runSearch(trimmed);
    } else {
      void loadRecent("replace");
    }
  }, [loadRecent, runSearch]);

  // Empty / short query → recent; 3+ chars → search after 300ms.
  // Short queries keep the recent list and explain the three-character minimum.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      void loadRecent("replace");
      return;
    }

    const handle = window.setTimeout(() => {
      void runSearch(trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, loadRecent, runSearch, listProject, filterType]);

  const toggleExpand = async (id: string) => {
    // Collapse keeps drafts and edit intent (afterCollapse only drops confirm UI).
    // Never wipe cardActions here: that is what silently destroyed mid-edit text.
    if (expandedId === id) {
      setExpandedId(null);
      setCardActions((prev) => afterCollapse(prev, id));
      return;
    }
    setExpandedId(id);
    if (fullBodies[id]) return;

    setExpandingId(id);
    setFailedIds((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const entry = await getMemory({ id });
      if (!mountedRef.current || expandedRef.current !== id) return;
      setFullBodies((prev) => ({ ...prev, [id]: entry.body }));
      setFailedIds((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setServerDown(false);
    } catch (err) {
      if (!mountedRef.current) return;
      if (isNotRunningError(err)) {
        setServerDown(true);
        setExpandedId(null);
      } else if (expandedRef.current === id) {
        setFailedIds((prev) => ({ ...prev, [id]: errorMessage(err) }));
      }
    } finally {
      if (mountedRef.current) setExpandingId(null);
    }
  };

  const handleSave = async () => {
    setFormError(null);
    const title = formTitle.trim();
    const body = formBody.trim();
    if (!title) {
      setFormError("Title is required");
      return;
    }
    if (!body) {
      setFormError("Body is required");
      return;
    }
    setSaving(true);
    try {
      await storeMemory({
        type: formType,
        title,
        body,
        // Always belongs to the current project when there is one.
        ...(projectSlug ? { project: projectSlug } : {}),
      });
      if (!mountedRef.current) return;
      setFormTitle("");
      setFormBody("");
      setFormType("knowledge");
      setAdding(false);
      setServerDown(false);
      setQuery("");
      await loadRecent("replace");
    } catch (err) {
      if (!mountedRef.current) return;
      if (isNotRunningError(err)) {
        setServerDown(true);
      } else {
        setFormError(
          err instanceof Error && err.message
            ? err.message
            : "Failed to store memory",
        );
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  /** Only ever called with the fetched body; the Edit button is disabled without it. */
  const beginEdit = (entry: MemoryEntryInfo, fullBody: string) => {
    setCardActions((prev) => startEdit(prev, entry.id, entry.title, fullBody));
  };

  const saveEdit = async (id: string) => {
    const draft = draftFor(cardActions, id);
    if (!draft) return;
    const title = draft.title.trim();
    const body = draft.body.trim();
    if (!title || !body) {
      setCardActions((prev) =>
        setActionError(prev, id, "Title and body are required"),
      );
      return;
    }
    setActionBusy(true);
    setCardActions((prev) => clearActionError(prev, id));
    try {
      await updateMemory({ id, title, body });
      if (!mountedRef.current) return;
      setCardActions((prev) => clearEntryActions(prev, id));
      setExpandedId(null);
      reloadCurrent();
    } catch (err) {
      if (!mountedRef.current) return;
      if (isNotRunningError(err)) setServerDown(true);
      else
        setCardActions((prev) => setActionError(prev, id, errorMessage(err)));
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  };

  const confirmDelete = async (id: string) => {
    setActionBusy(true);
    setCardActions((prev) => clearActionError(prev, id));
    try {
      await removeMemory({ id });
      if (!mountedRef.current) return;
      setCardActions((prev) => clearEntryActions(prev, id));
      setExpandedId(null);
      reloadCurrent();
    } catch (err) {
      if (!mountedRef.current) return;
      if (isNotRunningError(err)) setServerDown(true);
      else
        setCardActions((prev) => setActionError(prev, id, errorMessage(err)));
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  };

  const mapCard =
    loadCodeMap && projectId ? (
      <CodeMapCard projectId={projectId} loadCodeMap={loadCodeMap} />
    ) : null;

  const secondary = (
    <div className={styles.secondary} data-memory-secondary="">
      {mapCard}
      {lintAgentConfig && projectId ? (
        <ConfigDoctorCard
          projectId={projectId}
          projectLabel={projectLabelOf(projectSlug, projectId)}
          lintAgentConfig={lintAgentConfig}
          previewAgentConfig={previewAgentConfig}
          writeAgentConfig={writeAgentConfig}
        />
      ) : null}
      {maintenanceMemory ? (
        <ReviewQueueCard
          projectSlug={projectSlug}
          maintenanceMemory={maintenanceMemory}
          resolveMemory={resolveMemory}
        />
      ) : null}
    </div>
  );

  const toolbar = (
    <div className={styles.searchRow}>
      <input
        type="search"
        className={styles.searchInput}
        placeholder="Search shared memory..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search shared memory"
      />
      <select
        className={styles.select}
        value={filterType}
        onChange={(e) => setFilterType(e.target.value as FilterType)}
        aria-label="Filter memory type"
      >
        <option value="">all types</option>
        <option value="knowledge">knowledge</option>
        <option value="convention">convention</option>
        <option value="strategy">strategy</option>
        <option value="task">task</option>
      </select>
      <span className={styles.filterLabel} title="Memory is scoped to this project">
        {scopeLabel(projectSlug)}
      </span>
      <button
        type="button"
        className={styles.addBtn}
        aria-expanded={adding}
        onClick={() => setAdding((on) => !on)}
      >
        {adding ? "Close" : "Add memory"}
      </button>
    </div>
  );

  const shortQuery = query.trim().length > 0 && query.trim().length < MIN_QUERY_LEN;
  const scopedName = scopeLabel(listProject);

  const rememberForm = adding ? (
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <h2 className={styles.sectionTitle}>Remember something</h2>
        <div className={styles.formRow}>
          <select
            className={styles.select}
            value={formType}
            onChange={(e) => setFormType(e.target.value as StoreType)}
            aria-label="Memory type"
          >
            <option value="knowledge">knowledge</option>
            <option value="convention">convention</option>
            <option value="strategy">strategy</option>
            <option value="task">task</option>
          </select>
          <input
            type="text"
            className={styles.titleInput}
            placeholder="Title"
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            aria-label="Memory title"
          />
        </div>
        <textarea
          className={styles.bodyInput}
          placeholder="What should future sessions know?"
          value={formBody}
          onChange={(e) => setFormBody(e.target.value)}
          rows={3}
          aria-label="Memory body"
        />
        <p className={styles.formHint}>
          {projectSlug
            ? `Saved to ${projectSlug}`
            : "Saved without a project (select a thread to scope it)"}
        </p>
        {formError && (
          <p className={styles.formError} role="alert">
            {formError}
          </p>
        )}
        <button
          type="submit"
          className={styles.saveBtn}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
  ) : null;

  if (serverDown) {
    return (
      <div className={styles.root}>
        {toolbar}
        <div className={styles.scroll} data-memory-scroll="" ref={scrollRef}>
          {rememberForm}
          <div className={styles.downWrap}>
            <p className={styles.downMessage}>{MEMORY_NOT_RUNNING}</p>
            <button
              type="button"
              className={styles.retryBtn}
              onClick={() => {
                setServerDown(false);
                reloadCurrent();
              }}
            >
              Retry
            </button>
          </div>
          {secondary}
        </div>
      </div>
    );
  }

  const entryCountLabel = loading && entries.length === 0
    ? "Loading"
    : `${entries.length} loaded`;

  return (
    <div className={styles.root}>
      {toolbar}
      <div className={styles.scroll} data-memory-scroll="" ref={scrollRef}>
        {discardOpen ? (
          <div className={styles.discardBanner} role="alertdialog">
            <p>
              Load memories for {scopeLabel(projectSlug)}? Unsaved edits will be
              discarded.
            </p>
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={discardAndSwitch}
            >
              Discard and switch
            </button>
          </div>
        ) : null}
        {rememberForm}

      <section className={styles.section} data-memory-list="">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Memories</h2>
          <span className={styles.sectionMeta}>{entryCountLabel}</span>
        </div>
      {shortQuery ? (
        <p className={styles.searchHint} role="status">
          Type 3 or more characters to search. Showing recent memories.
        </p>
      ) : null}
      <div className={styles.list}>
        {listError && (
          <p className={styles.formError} role="alert">
            {listError}
            <button
              type="button"
              className={styles.retryBtn}
              onClick={() => reloadCurrent()}
            >
              Retry
            </button>
          </p>
        )}
        {loading && entries.length === 0 ? (
          <p className={styles.empty}>Loading…</p>
        ) : entries.length === 0 && !listError ? (
          <p className={styles.empty}>
            {query.trim().length >= MIN_QUERY_LEN
              ? "No matching memories"
              : filterType
                ? `No ${filterType} memories`
                : "No memories in this project"}
          </p>
        ) : (
          entries.map((entry) => {
            const open = expandedId === entry.id;
            const full = fullBodies[entry.id];
            const getError = failedIds[entry.id];
            const draft = draftFor(cardActions, entry.id);
            const cardError = actionErrorFor(cardActions, entry.id);
            const { loadingBody, showError, editing, showActions, canEdit } =
              memoryCardState({
                expanding: expandingId === entry.id,
                hasFull: full != null,
                hasError: getError != null,
                editRequested: isEditing(cardActions, entry.id),
              });
            return (
              <div key={entry.id} className={styles.card} data-expanded={open}>
                {/* The toggle is its own button so the edit form and the
                    Edit/Delete controls are siblings, not nested interactives. */}
                <button
                  type="button"
                  className={styles.cardToggle}
                  data-memory-toggle=""
                  onClick={() => void toggleExpand(entry.id)}
                  aria-expanded={open}
                >
                  <div className={styles.rowHead}>
                    <span className={styles.cardTitle}>{entry.title}</span>
                    <span
                      className={`${styles.badge} ${typeBadgeClass(entry.type)}`}
                    >
                      {entry.type}
                    </span>
                    <span className={styles.age}>
                      {ageFromIso(entry.updatedAt, now)}
                    </span>
                  </div>
                </button>
                {open ? (
                  <div className={styles.fullBodyWrap}>
                    {loadingBody ? (
                      <p className={styles.bodyLoading}>Loading…</p>
                    ) : showError ? (
                      <p className={styles.bodyError} role="alert">
                        {getError}
                      </p>
                    ) : editing && draft ? (
                      <div className={styles.editWrap}>
                        <input
                          className={styles.titleInput}
                          value={draft.title}
                          onChange={(e) =>
                            setCardActions((prev) =>
                              setDraft(prev, entry.id, {
                                title: e.target.value,
                                body: draft.body,
                              }),
                            )
                          }
                          aria-label="Edit title"
                        />
                        <textarea
                          className={styles.bodyInput}
                          value={draft.body}
                          onChange={(e) =>
                            setCardActions((prev) =>
                              setDraft(prev, entry.id, {
                                title: draft.title,
                                body: e.target.value,
                              }),
                            )
                          }
                          rows={6}
                          aria-label="Edit body"
                        />
                        <div className={styles.entryActions}>
                          <button
                            type="button"
                            className={styles.saveBtn}
                            disabled={actionBusy}
                            onClick={() => void saveEdit(entry.id)}
                          >
                            {actionBusy ? "Saving…" : "Save correction"}
                          </button>
                          <button
                            type="button"
                            className={styles.retryBtn}
                            disabled={actionBusy}
                            onClick={() =>
                              setCardActions((prev) =>
                                cancelEdit(prev, entry.id),
                              )
                            }
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : full ? (
                      <>
                      <pre className={styles.fullBody}>{full}</pre>
                      {entry.citations && entry.citations.length > 0 ? (
                        <div className={styles.citations} data-citations="">
                          {entry.citations.map((c, i) => (
                            <span
                              key={`${c.kind}-${i}`}
                              className={styles.citation}
                              title={c.kind === "file" ? c.excerpt : undefined}
                            >
                              {citationLabel(c)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {entry.source ? (
                        <p className={styles.sourceLine}>Source: {entry.source}</p>
                      ) : null}
                      </>
                    ) : (
                      <p className={styles.bodyLoading}>Loading…</p>
                    )}
                    {showActions && (
                      <div className={styles.entryActions}>
                        {isConfirmDelete(cardActions, entry.id) ? (
                          <>
                            <span className={styles.confirmText}>
                              Delete permanently?
                            </span>
                            <button
                              type="button"
                              className={styles.dangerBtn}
                              disabled={actionBusy}
                              onClick={() => void confirmDelete(entry.id)}
                            >
                              {actionBusy ? "Deleting…" : "Delete"}
                            </button>
                            <button
                              type="button"
                              className={styles.retryBtn}
                              disabled={actionBusy}
                              onClick={() =>
                                setCardActions((prev) =>
                                  cancelConfirmDelete(prev, entry.id),
                                )
                              }
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={styles.retryBtn}
                              // entry.body is the list excerpt, not the body:
                              // editing without the real body would save the
                              // truncation over the original.
                              disabled={!canEdit}
                              title={
                                canEdit ? undefined : "Body not loaded yet"
                              }
                              onClick={() => beginEdit(entry, full!)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className={styles.retryBtn}
                              onClick={() =>
                                setCardActions((prev) =>
                                  beginConfirmDelete(prev, entry.id),
                                )
                              }
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {cardError ? (
                      <p className={styles.bodyError} role="alert">
                        {cardError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {entry.project &&
                scopeLabel(entry.project) !== scopedName ? (
                  <span className={styles.projectTag} title={entry.project}>
                    {entry.project}
                  </span>
                ) : null}
              </div>
            );
          })
        )}
        {hasMore && !loading && query.trim().length < MIN_QUERY_LEN ? (
          <button
            type="button"
            className={styles.loadMore}
            disabled={loadingMore}
            onClick={() => void loadRecent("append")}
          >
            {loadingMore ? "Loading…" : "Load older memories"}
          </button>
        ) : null}
      </div>
      </section>
      {secondary}
      </div>
    </div>
  );
}
