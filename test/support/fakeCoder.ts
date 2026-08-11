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
  CoderApi,
  DiffResult,
  GitStatus,
  MemoryEntryInfo,
  PrInfo,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "../../src/shared/ipc";

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
  details?: Record<string, ThreadDetail>;
  status?: AppStatus;
  settings?: AppSettings;
  /** Force a channel to reject, e.g. { "runs.start": new Error("boom") }. */
  fail?: Record<string, Error>;
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
  const details = opts.details ?? {};
  const fail = opts.fail ?? {};

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
      get: () =>
        rec("settings.get", [], opts.settings ?? ({ dailyBudgetUsd: null } as AppSettings)),
      set: (patch: unknown) =>
        rec("settings.set", [patch], {
          ...(opts.settings ?? { dailyBudgetUsd: null }),
          ...(patch as object),
        } as AppSettings),
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
    projects: {
      list: () => rec("projects.list", [], projects.map((p) => ({ ...p }))),
      add: (path: string) => rec("projects.add", [path], project({ path })),
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
        return rec(
          "threads.setSettled",
          [input],
          thread({
            id: i.threadId,
            settledOverride: i.override,
            settledAt: i.override ? Date.now() : null,
          }),
        );
      },
      setProvider: (input: unknown) => rec("threads.setProvider", [input], thread()),
      setReasoningEffort: (input: unknown) =>
        rec("threads.setReasoningEffort", [input], thread()),
      delete: (input: unknown) => rec("threads.delete", [input], undefined),
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
