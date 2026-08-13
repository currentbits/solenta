/**
 * A recording stand-in for the whole preload surface (`window.coder`).
 *
 * Why this exists: `useCoder` resolves its API from `window.coder`
 * (`useCoder.ts:137-141`), and every component test to date stubs the props a
 * component receives. Nothing checks that App and useCoder hand the RIGHT
 * preload channel to each component. Passing `searchMemory` where
 * `recentMemory` belongs, or wiring Stop to the wrong thread, is invisible to
 * both tsc (the signatures match) and to every existing test.
 *
 * Install it on window before mounting App, then assert on `calls`.
 *
 * Every method records `{ channel, args }` in call order, so a test can prove
 * not just THAT a channel fired but which one, with what, and in what sequence.
 */
import type {
  AppSettings,
  AppStatus,
  AutomationInfo,
  CheckpointInfo,
  CoderApi,
  RunStatInfo,
  DevServerState,
  DiffResult,
  FetchIssueResult,
  GitStatus,
  GitSyncInfo,
  ListPrsResult,
  LocalServerInfo,
  MemoryEntryInfo,
  PrChecksResult,
  PrInfo,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  ThreadSummaryInfo,
  WorkLogItem,
  WorkflowTemplateInfo,
} from "../../src/shared/ipc";
import { buildActivity } from "../../src/activity";

export interface Call {
  channel: string;
  args: unknown[];
}

export interface FakeCoder {
  api: CoderApi;
  calls: Call[];
  /** Channels only, in order. Handy for sequence assertions. */
  channels(): string[];
  /** Every call to one channel. */
  of(channel: string): Call[];
  /** The single call to a channel; throws unless there is exactly one. */
  only(channel: string): Call;
  /** Push a threads:changed event to whatever subscribed. */
  emitThreads(threads: ThreadInfo[]): void;
  /** Push a thread:updated event. */
  emitThread(detail: ThreadDetail): void;
  /** Subscriptions that have not been torn down. */
  liveSubscriptions(): number;
}

export function project(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p1",
    slug: "owner/repo",
    name: "repo",
    path: "/tmp/repo",
    ...over,
  };
}

/** Fresh activity clock so round-39 inactivity settle does not fold fixtures. */
const FRESH = Date.now();

export function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  const createdAt = over.createdAt ?? FRESH;
  const updatedAt = over.updatedAt ?? createdAt;
  return {
    id: "t1",
    projectId: "p1",
    title: "first thread",
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt,
    updatedAt,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    // Round 49: null unless created by threads.fork.
    handoffFrom: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    // Default lastVisitedAt to updatedAt so fixtures that only bump updatedAt
    // stay read. Pass lastVisitedAt explicitly for unread cases.
    lastVisitedAt:
      over.lastVisitedAt !== undefined ? over.lastVisitedAt : updatedAt,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  } as ThreadInfo;
}

export function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    thread: thread(),
    messages: [],
    workLog: [],
    usage: null,
    workflow: null,
    ...over,
  } as ThreadDetail;
}

export interface FakeOptions {
  projects?: ProjectInfo[];
  threads?: ThreadInfo[];
  providers?: ProviderInfo[];
  workflows?: WorkflowTemplateInfo[];
  automations?: AutomationInfo[];
  details?: Record<string, ThreadDetail>;
  status?: AppStatus;
  settings?: AppSettings;
  /**
   * Per-thread checkpoint lists (newest-first). listCheckpoints returns []
   * when the thread has no worktreePath regardless of this map.
   */
  checkpoints?: Record<string, CheckpointInfo[]>;
  /** Per-thread runStats override. When omitted, derived from checkpoints. */
  runStats?: Record<string, RunStatInfo[]>;
  /** Force a channel to reject, e.g. { "runs.start": new Error("boom") }. */
  fail?: Record<string, Error>;
  /** Override issues.fetch result (default: a successful fixture). */
  issueFetch?: FetchIssueResult;
}

export function createFakeCoder(opts: FakeOptions = {}): FakeCoder {
  const calls: Call[] = [];
  let projects = opts.projects ?? [project()];
  let threads = opts.threads ?? [thread()];
  const providers =
    opts.providers ??
    ([
      {
        id: "claude",
        name: "Claude Code",
        available: true,
        supportsResume: true,
        models: [],
        modelInfo: [],
        efforts: [],
      },
    ] as ProviderInfo[]);
  const workflows = opts.workflows ?? [];
  let automations = opts.automations ?? [];
  const details = opts.details ?? {};
  const fail = opts.fail ?? {};
  /** Mutable per-thread checkpoint lists (newest-first). */
  const checkpoints: Record<string, CheckpointInfo[]> = {
    ...(opts.checkpoints ?? {}),
  };
  let settingsState: AppSettings = {
    dailyBudgetUsd: null,
    autoSettleAfterDays: 3,
    ...(opts.settings ?? {}),
  };

  const threadSubs: Array<(t: ThreadInfo[]) => void> = [];
  const detailSubs: Array<(d: ThreadDetail) => void> = [];

  /** Record the call, then either reject (if configured) or resolve. */
  function rec<T>(channel: string, args: unknown[], value: T): Promise<T> {
    calls.push({ channel, args });
    const err = fail[channel];
    if (err) return Promise.reject(err);
    return Promise.resolve(value);
  }

  const api = {
    app: {
      status: () =>
        rec(
          "app.status",
          [],
          opts.status ??
            ({
              spendTodayUsd: 0,
              memory: {
                running: false,
                adopted: false,
                port: null,
                entries: null,
                vectors: null,
                lastError: null,
              },
              build: { version: "0.0.0-test", sha: null, time: null },
            } as AppStatus),
        ),
    },
    memory: {
      search: (input: unknown) => rec("memory.search", [input], [] as MemoryEntryInfo[]),
      recent: (input: unknown) => rec("memory.recent", [input], [] as MemoryEntryInfo[]),
      get: (input: unknown) =>
        rec("memory.get", [input], {
          id: "m1",
          type: "knowledge",
          title: "t",
          body: "b",
          project: null,
          importance: 3,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        } as MemoryEntryInfo),
      store: (input: unknown) => rec("memory.store", [input], { id: "m-new" }),
      update: (input: unknown) => rec("memory.update", [input], { id: "m-upd" }),
      remove: (input: unknown) => rec("memory.remove", [input], undefined),
    },
    settings: {
      get: () => rec("settings.get", [], { ...settingsState }),
      /**
       * Honest settings.set: validate like electron/store.setSettings so
       * round-trip modal tests cannot pass against a silent merge.
       */
      set: (patch: unknown) => {
        const p = (patch ?? {}) as Partial<AppSettings>;
        const next: AppSettings = { ...settingsState };
        if (Object.prototype.hasOwnProperty.call(p, "dailyBudgetUsd")) {
          const v = p.dailyBudgetUsd;
          if (v !== null && v !== undefined) {
            if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) {
              calls.push({ channel: "settings.set", args: [patch] });
              return Promise.reject(
                new Error("Daily budget must be a positive number or null"),
              );
            }
          }
          next.dailyBudgetUsd = v === null || v === undefined ? null : v;
        }
        if (Object.prototype.hasOwnProperty.call(p, "autoSettleAfterDays")) {
          const v = p.autoSettleAfterDays;
          if (v !== null && v !== undefined) {
            if (
              typeof v !== "number" ||
              !Number.isFinite(v) ||
              !Number.isInteger(v) ||
              !(v > 0)
            ) {
              calls.push({ channel: "settings.set", args: [patch] });
              return Promise.reject(
                new Error(
                  `Auto-settle days must be a positive integer or null (got ${String(v)})`,
                ),
              );
            }
          }
          next.autoSettleAfterDays =
            v === null || v === undefined ? null : v;
        }
        settingsState = next;
        return rec("settings.set", [patch], { ...settingsState });
      },
    },
    providers: { list: () => rec("providers.list", [], providers) },
    workflows: {
      list: () => rec("workflows.list", [], workflows),
      save: (t: unknown) =>
        rec("workflows.save", [t], {
          id: "w-new",
          builtin: false,
          ...(t as object),
        } as WorkflowTemplateInfo),
      remove: (input: unknown) => rec("workflows.remove", [input], undefined),
    },
    automations: {
      list: () =>
        rec("automations.list", [], automations.map((a) => ({ ...a }))),
      add: (input: unknown) => {
        const created = {
          id: "auto-new",
          model: null,
          hour: null,
          enabled: true,
          lastRunAt: null,
          nextRunAt: Date.now() + 3600_000,
          lastError: null,
          ...(input as object),
        } as AutomationInfo;
        automations = [...automations, created];
        return rec("automations.add", [input], created);
      },
      update: (input: unknown) => {
        const patch = input as Partial<AutomationInfo> & { id: string };
        const existing = automations.find((a) => a.id === patch.id);
        const updated = { ...(existing ?? {}), ...patch } as AutomationInfo;
        automations = existing
          ? automations.map((a) => (a.id === patch.id ? updated : a))
          : automations;
        return rec("automations.update", [input], updated);
      },
      remove: (input: unknown) => {
        const id = String((input as { id?: string } | null)?.id ?? "");
        automations = automations.filter((a) => a.id !== id);
        return rec("automations.remove", [input], undefined);
      },
      runNow: (input: unknown) => {
        const id = String((input as { id?: string } | null)?.id ?? "");
        const existing = automations.find((a) => a.id === id);
        const updated = existing
          ? { ...existing, lastRunAt: Date.now() }
          : ({ id } as AutomationInfo);
        if (existing) {
          automations = automations.map((a) => (a.id === id ? updated : a));
        }
        return rec("automations.runNow", [input], updated);
      },
    },
    projects: {
      list: () => rec("projects.list", [], projects.map((p) => ({ ...p }))),
      add: (path: string, opts?: { remoteHost?: string; remotePath?: string }) =>
        rec(
          "projects.add",
          opts ? [path, opts] : [path],
          project({
            path: path || opts?.remotePath || "/tmp/repo",
            remoteHost: opts?.remoteHost,
            remotePath: opts?.remotePath,
          }),
        ),
      addViaDialog: () => rec("projects.addViaDialog", [], project()),
      remove: (input: unknown) => {
        const projectId = String(
          (input as { projectId?: string } | null)?.projectId ?? "",
        );
        return rec("projects.remove", [input], undefined).then((v) => {
          // Mutate so a post-remove list() reflects the drop (useCoder
          // re-lists projects + threads after remove).
          projects = projects.filter((p) => p.id !== projectId);
          threads = threads.filter((t) => t.projectId !== projectId);
          return v;
        });
      },
    },
    threads: {
      list: () => rec("threads.list", [], threads.map((t) => ({ ...t }))),
      /** Mirror electron services.threadSummaries (team view). */
      summaries: () =>
        rec(
          "threads.summaries",
          [],
          threads.map((t): ThreadSummaryInfo => {
            const msgs = details[t.id]?.messages ?? [];
            let last: (typeof msgs)[number] | null = null;
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if (m && m.role === "assistant" && m.text.trim() !== "") {
                last = m;
                break;
              }
            }
            return {
              id: t.id,
              title: t.title,
              provider: t.provider,
              status: t.status,
              handoffFrom: t.handoffFrom ?? null,
              lastActivity: last
                ? {
                    text: last.text.split(/\r?\n/, 1)[0].trim(),
                    at: last.createdAt || t.updatedAt,
                  }
                : null,
            };
          }),
        ),
      search: (input: unknown) => rec("threads.search", [input], [] as ThreadInfo[]),
      create: (input: unknown) => {
        const createdAt = Date.now();
        // Match production createThread: a brand-new thread is visited at birth.
        const t = thread({
          id: "t-new",
          createdAt,
          updatedAt: createdAt,
          lastVisitedAt: createdAt,
        });
        threads = [t, ...threads.filter((x) => x.id !== t.id)];
        return rec("threads.create", [input], t);
      },
      /**
       * Production stamps lastVisitedAt inside threads.get (select = visit)
       * without bumping updatedAt. Keep this fake honest so renderer tests
       * that select-and-clear-unread do not pass against a silent no-op.
       * Round-37 lesson: a fake that drifts from reality ships green and broken.
       */
      get: (id: string) => {
        const stamp = Date.now();
        const existing = threads.find((t) => t.id === id);
        if (existing) {
          // Visiting is not activity: lastVisitedAt only, never updatedAt.
          const stampedRow: ThreadInfo = {
            ...existing,
            lastVisitedAt: stamp,
          };
          threads = threads.map((t) => (t.id === id ? stampedRow : t));
          const base = details[id] ?? detail({ thread: stampedRow });
          const stampedDetail: ThreadDetail = {
            ...base,
            thread: { ...base.thread, ...stampedRow, lastVisitedAt: stamp },
          };
          details[id] = stampedDetail;
          return rec("threads.get", [id], stampedDetail);
        }
        const fallback = details[id] ?? detail({ thread: thread({ id, lastVisitedAt: stamp }) });
        const stampedFallback: ThreadDetail = {
          ...fallback,
          thread: { ...fallback.thread, lastVisitedAt: stamp },
        };
        return rec("threads.get", [id], stampedFallback);
      },
      setPermissionMode: (input: unknown) =>
        rec("threads.setPermissionMode", [input], thread()),
      setArchived: (input: unknown) => {
        const i = input as { threadId: string; archived: boolean };
        return rec(
          "threads.setArchived",
          [input],
          thread({ id: i.threadId, archived: i.archived }),
        );
      },
      setSettled: (input: unknown) => {
        const i = input as {
          threadId: string;
          override: "settled" | "active" | null;
        };
        const existing = threads.find((t) => t.id === i.threadId);
        // Mutual exclusion (contract): setSettled("settled") clears the pin.
        const next: ThreadInfo = {
          ...(existing ?? thread({ id: i.threadId })),
          settledOverride: i.override,
          settledAt: i.override ? Date.now() : null,
          pinnedAt:
            i.override === "settled"
              ? null
              : (existing?.pinnedAt ?? null),
        };
        threads = threads.map((t) => (t.id === i.threadId ? next : t));
        return rec("threads.setSettled", [input], next);
      },
      /**
       * Honest pin (round 44). Pinning clears a "settled" override; never
       * bumps updatedAt. Round-37/43 lesson: fakes that drift ship green+broken.
       */
      setPinned: (input: unknown) => {
        const i = input as { threadId: string; pinned: boolean };
        const existing = threads.find((t) => t.id === i.threadId);
        if (!existing) {
          return rec(
            "threads.setPinned",
            [input],
            thread({
              id: i.threadId,
              pinnedAt: i.pinned ? Date.now() : null,
            }),
          );
        }
        const now = Date.now();
        const next: ThreadInfo = {
          ...existing,
          pinnedAt: i.pinned ? now : null,
          // Mutual exclusion: pin clears a settled override, not "active".
          settledOverride:
            i.pinned && existing.settledOverride === "settled"
              ? null
              : existing.settledOverride,
          settledAt:
            i.pinned && existing.settledOverride === "settled"
              ? null
              : existing.settledAt,
          // Never bump updatedAt — pin is bookkeeping.
        };
        threads = threads.map((t) => (t.id === i.threadId ? next : t));
        return rec("threads.setPinned", [input], next);
      },
      /**
       * Honest snooze. Rejects non-future until; stamps snoozedAt = now.
       * Does NOT clear pin (suspends). Never bumps updatedAt.
       */
      setSnoozed: (input: unknown) => {
        const i = input as { threadId: string; until: number | null };
        const existing = threads.find((t) => t.id === i.threadId);
        const now = Date.now();
        calls.push({ channel: "threads.setSnoozed", args: [input] });
        if (i.until != null) {
          if (!Number.isFinite(i.until) || i.until <= now) {
            return Promise.reject(
              new Error(
                `Snooze until must be strictly in the future (got ${i.until})`,
              ),
            );
          }
        }
        const base = existing ?? thread({ id: i.threadId });
        const next: ThreadInfo = {
          ...base,
          snoozedUntil: i.until,
          snoozedAt: i.until == null ? null : now,
        };
        if (existing) {
          threads = threads.map((t) => (t.id === i.threadId ? next : t));
        } else {
          threads = [next, ...threads];
        }
        return Promise.resolve(next);
      },
      setProvider: (input: unknown) => rec("threads.setProvider", [input], thread()),
      setReasoningEffort: (input: unknown) =>
        rec("threads.setReasoningEffort", [input], thread()),
      /**
       * Honest fork (round 49 contract / electron forkThread): new thread
       * same project, copies provider/model/permissionMode unless overridden;
       * sessionId null; handoffFrom = source id; reasoningEffort always null
       * (production createThread+patch path never carries it). Title uses the
       * same THREAD_TITLE_MAX=60 cap as createThread. SOURCE is never modified.
       * Rejects unknown source and invalid provider/model with production
       * error strings (byte-equal).
       */
      fork: (input: unknown) => {
        const i = input as {
          threadId: string;
          provider?: string;
          model?: string | null;
        };
        calls.push({ channel: "threads.fork", args: [input] });
        const err = fail["threads.fork"];
        if (err) return Promise.reject(err);

        const source = threads.find((t) => t.id === i.threadId);
        if (!source) {
          // Match electron/services.js forkThread exactly.
          return Promise.reject(new Error(`Unknown thread: ${i.threadId}`));
        }

        const providerProvided = Object.prototype.hasOwnProperty.call(
          i,
          "provider",
        );
        const modelProvided = Object.prototype.hasOwnProperty.call(i, "model");

        let nextProvider = source.provider;
        if (providerProvided) {
          const id = String(i.provider ?? "");
          const known = providers.some((p) => p.id === id) || id === "simulate";
          if (!known) {
            return Promise.reject(new Error(`Unknown provider: ${i.provider}`));
          }
          nextProvider = id;
        }

        const providerChanging =
          providerProvided && String(nextProvider) !== String(source.provider);

        let nextModel: string | null = source.model;
        if (providerChanging) {
          // Hand-off: drop the old harness model unless this call supplies one.
          if (modelProvided) {
            if (i.model == null || i.model === "") {
              nextModel = null;
            } else {
              const trimmed = String(i.model).trim();
              if (!trimmed) {
                return Promise.reject(
                  new Error("Model must be a non-empty string"),
                );
              }
              if (trimmed.length > 100) {
                return Promise.reject(
                  new Error("Model must be at most 100 characters"),
                );
              }
              nextModel = trimmed;
            }
          } else {
            nextModel = null;
          }
        } else if (modelProvided) {
          if (i.model == null || i.model === "") {
            nextModel = null;
          } else {
            const trimmed = String(i.model).trim();
            if (!trimmed) {
              return Promise.reject(
                new Error("Model must be a non-empty string"),
              );
            }
            if (trimmed.length > 100) {
              return Promise.reject(
                new Error("Model must be at most 100 characters"),
              );
            }
            nextModel = trimmed;
          }
        }

        const now = Date.now();
        // Match electron THREAD_TITLE_MAX / truncateThreadTitle (createThread path).
        const THREAD_TITLE_MAX = 60;
        const sourceTitle =
          source.title != null && String(source.title) !== ""
            ? String(source.title)
            : "New Thread";
        const rawTitle = `Fork: ${sourceTitle}`;
        const title =
          rawTitle.length > THREAD_TITLE_MAX
            ? rawTitle.slice(0, THREAD_TITLE_MAX)
            : rawTitle;
        const forked = thread({
          id: `t-fork-${now}`,
          projectId: source.projectId,
          title,
          createdAt: now,
          updatedAt: now,
          lastVisitedAt: now,
          status: "idle",
          runStartedAt: null,
          archived: false,
          settledOverride: null,
          settledAt: null,
          pinnedAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          handoffFrom: source.id,
          provider: nextProvider,
          model: nextModel,
          sessionId: null,
          permissionMode: source.permissionMode,
          // Production fork never patches reasoningEffort; create leaves null.
          reasoningEffort: null,
          branch: null,
          prNumber: null,
          prUrl: null,
          prState: null,
          worktreePath: null,
        });
        threads = [forked, ...threads];
        details[forked.id] = detail({ thread: forked, messages: [] });
        return Promise.resolve(forked);
      },
      delete: (input: unknown) => rec("threads.delete", [input], undefined),
    },
    activity: {
      list: () => {
        const workLogByThread: Record<string, WorkLogItem[]> = {};
        for (const [id, d] of Object.entries(details)) {
          workLogByThread[id] = d.workLog;
        }
        return rec(
          "activity.list",
          [],
          buildActivity(threads, workLogByThread, Date.now()),
        );
      },
    },
    runs: {
      start: (input: unknown) => rec("runs.start", [input], { runId: "r1" }),
      startWorkflow: (input: unknown) =>
        rec("runs.startWorkflow", [input], { runId: "r2" }),
      stop: (input: unknown) => rec("runs.stop", [input], undefined),
    },
    git: {
      status: (projectId: string) =>
        rec("git.status", [projectId], {
          isRepo: true,
          branch: "main",
          dirty: false,
        } as GitStatus),
      setupWorktree: (input: unknown) => rec("git.setupWorktree", [input], thread()),
      diff: (input: unknown) =>
        rec("git.diff", [input], {
          files: [],
          patch: "",
          truncated: false,
        } as DiffResult),
      commit: (input: unknown) =>
        rec("git.commit", [input], { subject: "test commit" }),
      revertFile: (input: unknown) =>
        rec("git.revertFile", [input], { path: "file.ts" }),
      suggestCommitMessage: (input: unknown) =>
        rec("git.suggestCommitMessage", [input], {
          message: "feat: suggested message",
        }),
      mergeWorktree: (input: unknown) => rec("git.mergeWorktree", [input], thread()),
      removeWorktree: (input: unknown) => rec("git.removeWorktree", [input], thread()),
      push: (input: unknown) =>
        rec("git.push", [input], { remote: "origin", branch: "b" }),
      createPr: (input: unknown) =>
        rec("git.createPr", [input], {
          number: 1,
          url: "https://github.com/owner/repo/pull/1",
          state: "OPEN",
          branch: "b",
          created: true,
        } as PrInfo),
      prStatus: (input: unknown) => rec("git.prStatus", [input], null),
      prChecks: (input: unknown) =>
        rec("git.prChecks", [input], {
          ok: true,
          checks: [],
        } as PrChecksResult),
      prMerge: (input: unknown) =>
        rec("git.prMerge", [input], {
          number: 1,
          url: "https://github.com/owner/repo/pull/1",
          state: "MERGED",
          branch: "b",
          created: false,
        } as PrInfo),
      listPrs: (projectPath: string) =>
        rec("git.listPrs", [projectPath], {
          ok: true,
          prs: [],
        } as ListPrsResult),
      /**
       * Round 50 contract: newest-first; empty without a worktree.
       * SOURCE list is never mutated by list.
       */
      listCheckpoints: (input: unknown) => {
        const i = input as { threadId: string };
        const t = threads.find((x) => x.id === i.threadId);
        if (!t || !t.worktreePath) {
          return rec("git.listCheckpoints", [input], [] as CheckpointInfo[]);
        }
        const list = (checkpoints[i.threadId] ?? []).slice();
        // Newest-first by `at` (stable for equal timestamps: keep insertion order).
        list.sort((a, b) => b.at - a.at);
        return rec("git.listCheckpoints", [input], list);
      },
      /**
       * Hard-reset worktree to a thread-owned sha. Production guards:
       * run active, missing worktree, unknown sha. Truncates later
       * (newer) checkpoints from the list so a subsequent list matches
       * a real reset.
       */
      restoreCheckpoint: (input: unknown) => {
        const i = input as { threadId: string; sha: string };
        calls.push({ channel: "git.restoreCheckpoint", args: [input] });
        const err = fail["git.restoreCheckpoint"];
        if (err) return Promise.reject(err);

        const t = threads.find((x) => x.id === i.threadId);
        if (!t) {
          // Match electron/worktrees.js restoreCheckpoint.
          return Promise.reject(new Error(`Unknown thread: ${i.threadId}`));
        }
        if (t.status === "working") {
          return Promise.reject(
            new Error("Cannot restore a checkpoint while a run is active"),
          );
        }
        if (!t.worktreePath) {
          return Promise.reject(
            new Error(
              `Thread ${i.threadId} has no worktree; call setupWorktree first`,
            ),
          );
        }
        const list = (checkpoints[i.threadId] ?? []).slice();
        list.sort((a, b) => b.at - a.at);
        const idx = list.findIndex((c) => c.sha === i.sha);
        if (idx < 0) {
          return Promise.reject(new Error(`Unknown checkpoint: ${i.sha}`));
        }
        // Keep the restored checkpoint and older ones; drop newer (earlier
        // indices in newest-first order).
        checkpoints[i.threadId] = list.slice(idx);
        return Promise.resolve(undefined);
      },
      syncInfo: (input: unknown) =>
        rec("git.syncInfo", [input], { hasUpstream: false } as GitSyncInfo),
      fetch: (input: unknown) => rec("git.fetch", [input], undefined),
      runStats: (input: unknown) => {
        const i = input as { threadId: string };
        const t = threads.find((x) => x.id === i.threadId);
        if (!t || !t.worktreePath) {
          return rec("git.runStats", [input], [] as RunStatInfo[]);
        }
        const override = opts.runStats?.[i.threadId];
        if (override) {
          return rec("git.runStats", [input], override.slice());
        }
        const list = (checkpoints[i.threadId] ?? [])
          .slice()
          .sort((a, b) => a.turn - b.turn);
        const derived: RunStatInfo[] = list.map((c) => ({
          sha: c.sha,
          turn: c.turn,
          files: 1,
          additions: 1,
          deletions: 0,
        }));
        return rec("git.runStats", [input], derived);
      },
    },
    issues: {
      fetch: (input: unknown) =>
        rec(
          "issues.fetch",
          [input],
          opts.issueFetch ??
            ({
              ok: true,
              issue: {
                number: 12,
                title: "Fix login",
                body: "Repro steps",
                url: "https://github.com/owner/repo/issues/12",
              },
            } as FetchIssueResult),
        ),
    },
    servers: {
      list: (input: unknown) => rec("servers.list", [input], [] as LocalServerInfo[]),
    },
    shell: {
      reveal: (input: unknown) => rec("shell.reveal", [input], undefined),
      openPath: (input: unknown) => rec("shell.openPath", [input], undefined),
    },
    devserver: {
      scripts: (input: unknown) => rec("devserver.scripts", [input], ["dev"]),
      start: (input: unknown) => {
        const script = (input as { script?: string }).script ?? "dev";
        return rec("devserver.start", [input], {
          running: true,
          script,
          url: "http://localhost:5173/",
          startedAt: Date.now(),
          lastLines: ["  Local: http://localhost:5173/"],
        } as DevServerState);
      },
      stop: (input: unknown) =>
        rec("devserver.stop", [input], { running: false } as DevServerState),
      status: (input: unknown) =>
        rec("devserver.status", [input], { running: false } as DevServerState),
    },
    files: {
      list: (input: unknown) => {
        const q = ((input as { query?: string }).query ?? "").toLowerCase();
        const all = ["src/App.tsx", "src/main.tsx", "README.md", "package.json"];
        return rec("files.list", [input], {
          files: all.filter((f) => !q || f.toLowerCase().includes(q)),
        });
      },
    },
    on: (channel: string, cb: unknown) => {
      calls.push({ channel: `on:${channel}`, args: [] });
      if (channel === "threads:changed") {
        threadSubs.push(cb as (t: ThreadInfo[]) => void);
        return () => {
          const i = threadSubs.indexOf(cb as (t: ThreadInfo[]) => void);
          if (i >= 0) threadSubs.splice(i, 1);
        };
      }
      if (channel === "thread:select") {
        return () => {};
      }
      detailSubs.push(cb as (d: ThreadDetail) => void);
      return () => {
        const i = detailSubs.indexOf(cb as (d: ThreadDetail) => void);
        if (i >= 0) detailSubs.splice(i, 1);
      };
    },
  } as unknown as CoderApi;

  return {
    api,
    calls,
    channels: () => calls.map((c) => c.channel),
    of: (channel) => calls.filter((c) => c.channel === channel),
    only: (channel) => {
      const hits = calls.filter((c) => c.channel === channel);
      if (hits.length !== 1) {
        throw new Error(
          `expected exactly one ${channel} call, got ${hits.length}: ${JSON.stringify(
            hits.map((h) => h.args),
          )}`,
        );
      }
      return hits[0];
    },
    emitThreads: (next) => threadSubs.forEach((cb) => cb(next)),
    emitThread: (d) => detailSubs.forEach((cb) => cb(d)),
    liveSubscriptions: () => threadSubs.length + detailSubs.length,
  };
}

/** Install on window so useCoder's resolveApi() picks it up instead of devCoder. */
export function installFakeCoder(fake: FakeCoder): void {
  (globalThis as unknown as { window: { coder: CoderApi } }).window.coder =
    fake.api;
}
