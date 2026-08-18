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
  AttachmentInfo,
  AutomationInfo,
  UpdateStatus,
  CheckpointInfo,
  CoderApi,
  DistilledWorkflow,
  RunStatInfo,
  DevServerState,
  DiffResult,
  FetchIssueResult,
  GitStatus,
  GitSyncInfo,
  GitRepoInfo,
  GitPullResult,
  ListPrsResult,
  LocalServerInfo,
  MemoryEntryInfo,
  PrChecksResult,
  PrInfo,
  ProjectInfo,
  ProviderInfo,
  SkillInfo,
  SkillTarget,
  SpaceInfo,
  ThreadDetail,
  ThreadPatch,
  ThreadInfo,
  ThreadSummaryInfo,
  CrewTaskView,
  RewindResult,
  UsageByDay,
  FleetEvidence,
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
  /** Push a thread:updated event (a full detail is a valid ThreadPatch). */
  emitThread(detail: ThreadPatch): void;
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

export function space(over: Partial<SpaceInfo> = {}): SpaceInfo {
  return { id: "s1", name: "Client work", ...over };
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
    lastError: null,
    createdAt,
    updatedAt,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    // Round 49: null unless created by threads.fork.
    handoffFrom: null,
    muted: false,
    notes: "",
    queued: null,
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
  spaces?: SpaceInfo[];
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
  /** Override attachments.saveImage result (default: { attachment: null }). */
  saveImage?: (input: unknown) => { attachment: AttachmentInfo | null };
  /** Override attachments.fromPaths result (default: { attachments: [] }). */
  fromPaths?: (input: unknown) => { attachments: AttachmentInfo[] };
  /** Electron-only path resolver for dropped Files. */
  droppedFilePath?: (file: File) => string;
  /** Override runs.distill result. */
  distill?: DistilledWorkflow;
}

export function createFakeCoder(opts: FakeOptions = {}): FakeCoder {
  const calls: Call[] = [];
  let projects = opts.projects ?? [project()];
  let spaces = opts.spaces ?? [];
  let threads = opts.threads ?? [thread()];
  let nextSpaceId = 1;
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
    orchestrationBudgetUsd: null,
    autoSettleAfterDays: 3,
    autoSettleOnMerge: true,
    mcpServers: [],
    defaultWorktree: false,
    updateChannel: null,
    quotaWaitAutoResume: true,
    ...(opts.settings ?? {}),
  };
  const ALL_SKILL_TARGETS: SkillTarget[] = [
    "claude",
    "agents",
    "codex",
    "grok",
    "opencode",
    "kimi",
  ];

  function skillMdBytes(name: string, description: string, body: string): number {
    const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
    return new TextEncoder().encode(md).length;
  }

  /** In-memory skill rows for the Skills tab; add/remove/sync mutate this. */
  let skillsState: SkillInfo[] = [
    {
      name: "review-pr",
      description: "Review a pull request end to end",
      source: "claude",
      installedIn: [...ALL_SKILL_TARGETS],
      missingFrom: [],
      bytes: 4800,
    },
    {
      name: "write-tests",
      description: "Add tests for the current change",
      source: "agents",
      installedIn: ["claude", "agents", "codex", "grok", "opencode"],
      missingFrom: ["kimi"],
      bytes: 800,
    },
    {
      name: "local-rules",
      description: "Project-local rules",
      source: "project",
      installedIn: [],
      missingFrom: [],
      bytes: 400,
    },
  ];

  const threadSubs: Array<(t: ThreadInfo[]) => void> = [];
  const detailSubs: Array<(d: ThreadPatch) => void> = [];

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
              build: { version: "0.0.0-test", sha: null, time: null, channel: null },
            } as AppStatus),
        ),
      checkUpdate: () =>
        rec("app.checkUpdate", [], {
          state: "disabled",
          channel: null,
          tag: null,
          url: null,
          error: null,
        } as UpdateStatus),
      downloadUpdate: () =>
        rec("app.downloadUpdate", [], {
          state: "disabled",
          channel: null,
          tag: null,
          url: null,
          error: null,
        } as UpdateStatus),
      applyUpdate: () => rec("app.applyUpdate", [], undefined),
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
        if (Object.prototype.hasOwnProperty.call(p, "orchestrationBudgetUsd")) {
          const v = p.orchestrationBudgetUsd;
          if (v !== null && v !== undefined) {
            if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) {
              calls.push({ channel: "settings.set", args: [patch] });
              return Promise.reject(
                new Error(
                  "Orchestration budget must be a positive number or null",
                ),
              );
            }
          }
          next.orchestrationBudgetUsd = v === null || v === undefined ? null : v;
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
        if (Object.prototype.hasOwnProperty.call(p, "mcpServers")) {
          const v = p.mcpServers;
          if (!Array.isArray(v)) {
            calls.push({ channel: "settings.set", args: [patch] });
            return Promise.reject(new Error("mcpServers must be an array"));
          }
          next.mcpServers = v.map((s) => ({ ...s }));
        }
        if (Object.prototype.hasOwnProperty.call(p, "defaultWorktree")) {
          const v = p.defaultWorktree;
          if (typeof v !== "boolean") {
            calls.push({ channel: "settings.set", args: [patch] });
            return Promise.reject(
              new Error("defaultWorktree must be a boolean"),
            );
          }
          next.defaultWorktree = v;
        }
        if (Object.prototype.hasOwnProperty.call(p, "updateChannel")) {
          const v = p.updateChannel;
          if (v !== null && v !== undefined && v !== "prod" && v !== "nightly") {
            calls.push({ channel: "settings.set", args: [patch] });
            return Promise.reject(
              new Error('updateChannel must be "prod", "nightly", or null'),
            );
          }
          next.updateChannel = v ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(p, "quotaWaitAutoResume")) {
          const v = p.quotaWaitAutoResume;
          if (typeof v !== "boolean") {
            calls.push({ channel: "settings.set", args: [patch] });
            return Promise.reject(
              new Error("quotaWaitAutoResume must be a boolean"),
            );
          }
          next.quotaWaitAutoResume = v;
        }
        settingsState = next;
        return rec("settings.set", [patch], { ...settingsState });
      },
    },
    skills: {
      list: (input: unknown) =>
        rec(
          "skills.list",
          [input],
          skillsState.map((s) => ({
            ...s,
            installedIn: [...s.installedIn],
            missingFrom: [...s.missingFrom],
          })),
        ),
      add: (input: unknown) => {
        const w = input as {
          name: string;
          description: string;
          body: string;
        };
        if (!/^[a-z0-9-]+$/.test(w.name)) {
          calls.push({ channel: "skills.add", args: [input] });
          return Promise.reject(
            new Error("Skill name must be lowercase letters, digits, dashes"),
          );
        }
        const installedIn = [...ALL_SKILL_TARGETS];
        skillsState = [
          ...skillsState.filter(
            (s) => !(s.name === w.name && s.source !== "project"),
          ),
          {
            name: w.name,
            description: w.description,
            source: "claude",
            installedIn,
            missingFrom: [],
            bytes: skillMdBytes(w.name, w.description, w.body),
          },
        ];
        return rec("skills.add", [input], {
          name: w.name,
          installedIn: [...installedIn],
        });
      },
      remove: (input: unknown) => {
        const r = input as { name: string };
        skillsState = skillsState.filter(
          (s) => !(s.name === r.name && s.source !== "project"),
        );
        return rec("skills.remove", [input], undefined);
      },
      sync: () => {
        const names: string[] = [];
        let copied = 0;
        skillsState = skillsState.map((s) => {
          if (s.source === "project" || s.missingFrom.length === 0) {
            return {
              ...s,
              installedIn: [...s.installedIn],
              missingFrom: [...s.missingFrom],
            };
          }
          copied += 1;
          names.push(s.name);
          return {
            ...s,
            installedIn: [...s.installedIn, ...s.missingFrom],
            missingFrom: [],
          };
        });
        return rec("skills.sync", [], { copied, skills: names });
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
      create: (input: { name: string; parentDir: string }) => {
        const name = input.name.trim();
        const created = project({
          name,
          slug: name,
          path: `${input.parentDir.trim().replace(/\/+$/, "")}/${name}`,
        });
        return rec("projects.create", [input], created);
      },
      pickDirectory: () =>
        rec("projects.pickDirectory", [], null as string | null),
      update: (input: {
        projectId: string;
        name?: string;
        remoteHost?: string;
        remotePath?: string;
        spaceId?: string;
      }) => {
        const found = projects.find((p) => p.id === input.projectId);
        const updated = found ? { ...found } : project();
        if (typeof input.name === "string" && input.name.trim()) {
          updated.name = input.name.trim();
        }
        if (typeof input.spaceId === "string") {
          const spaceId = input.spaceId.trim();
          if (spaceId) updated.spaceId = spaceId;
          else delete updated.spaceId;
        }
        const host = input.remoteHost?.trim() ?? "";
        if (host) {
          updated.remoteHost = host;
          updated.remotePath = input.remotePath?.trim() ?? "";
        } else if (
          input.remoteHost !== undefined ||
          input.remotePath !== undefined
        ) {
          delete updated.remoteHost;
          delete updated.remotePath;
        }
        return rec("projects.update", [input], updated).then((v) => {
          if (found) {
            projects = projects.map((p) => (p.id === updated.id ? updated : p));
          }
          return v;
        });
      },
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
    spaces: {
      list: () => rec("spaces.list", [], spaces.map((s) => ({ ...s }))),
      add: (input: { name: string }) => {
        const created = space({
          id: `s-new-${nextSpaceId++}`,
          name: input.name.trim(),
        });
        return rec("spaces.add", [input], created).then((v) => {
          spaces = [...spaces, created];
          return v;
        });
      },
      update: (input: { id: string; name: string }) => {
        const found = spaces.find((s) => s.id === input.id);
        const updated = { ...(found ?? space({ id: input.id })), name: input.name.trim() };
        return rec("spaces.update", [input], updated).then((v) => {
          spaces = spaces.map((s) => (s.id === updated.id ? updated : s));
          return v;
        });
      },
      remove: (input: { id: string }) =>
        rec("spaces.remove", [input], undefined).then((v) => {
          spaces = spaces.filter((s) => s.id !== input.id);
          projects = projects.map((p) =>
            p.spaceId === input.id ? (({ spaceId, ...rest }) => rest)(p) : p,
          );
          return v;
        }),
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
      crewTasks: (input: { threadId: string }) =>
        rec(
          "threads.crewTasks",
          [input],
          {
            rootThreadId: input.threadId,
            tasks: [] as CrewTaskView[],
          },
        ),
      search: (input: unknown) => rec("threads.search", [input], [] as ThreadInfo[]),
      create: (input: unknown) => {
        const createdAt = Date.now();
        const wantWorktree =
          typeof input === "object" &&
          input !== null &&
          (input as { worktree?: boolean }).worktree === true;
        const wantTeach =
          typeof input === "object" &&
          input !== null &&
          (input as { teach?: boolean }).teach === true;
        const issueNumber =
          typeof input === "object" &&
          input !== null &&
          typeof (input as { issueNumber?: unknown }).issueNumber === "number"
            ? (input as { issueNumber: number }).issueNumber
            : null;
        // Match production createThread: a brand-new thread is visited at birth.
        const t = thread({
          id: "t-new",
          createdAt,
          updatedAt: createdAt,
          lastVisitedAt: createdAt,
          issueNumber,
          // Mirror the threads:create worktree flag (electron ipc.js): the
          // thread starts on the placeholder branch in its own worktree.
          ...(wantWorktree
            ? {
                branch: "coder/new-thread-t-new",
                worktreePath: "/fake/worktrees/t-new",
              }
            : {}),
          ...(wantTeach
            ? { teach: { autonomy: "hint" as const, reviewsPassed: 0 } }
            : {}),
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
      /**
       * Sibling load for the divergence compare (issue #393). Same payload
       * as get, but visiting is not implied — lastVisitedAt stays put.
       */
      peek: (id: string) => {
        const existing = threads.find((t) => t.id === id);
        const base =
          details[id] ??
          detail({ thread: existing ?? thread({ id }) });
        const row = existing
          ? { ...base.thread, ...existing }
          : { ...base.thread };
        const peeked: ThreadDetail = { ...base, thread: row };
        details[id] = peeked;
        return rec("threads.peek", [id], peeked);
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
        // Mutual exclusion (contract): setSettled("settled") clears the pin
        // and unsnoozes immediately so the row leaves the snoozed shelf.
        const next: ThreadInfo = {
          ...(existing ?? thread({ id: i.threadId })),
          settledOverride: i.override,
          settledAt: i.override ? Date.now() : null,
          pinnedAt:
            i.override === "settled"
              ? null
              : (existing?.pinnedAt ?? null),
          snoozedUntil:
            i.override === "settled" ? null : (existing?.snoozedUntil ?? null),
          snoozedAt:
            i.override === "settled" ? null : (existing?.snoozedAt ?? null),
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
       * Honest type-ahead queue (issue #137). prompt === null clears; a
       * non-null prompt appends. Never bumps updatedAt.
       */
      setQueued: (input: unknown) => {
        const i = input as {
          threadId: string;
          prompt: string | null;
          attachments?: AttachmentInfo[];
        };
        const existing = threads.find((t) => t.id === i.threadId);
        if (!existing) {
          calls.push({ channel: "threads.setQueued", args: [input] });
          return Promise.reject(new Error(`Unknown thread: ${i.threadId}`));
        }
        let queued: ThreadInfo["queued"] = null;
        if (i.prompt !== null) {
          const prev = existing.queued;
          const files = [
            ...(prev?.attachments ?? []),
            ...(i.attachments ?? []),
          ];
          queued = {
            prompt: prev ? `${prev.prompt}\n\n${i.prompt}` : i.prompt,
            attachments: files.length ? files : undefined,
          };
        }
        const next: ThreadInfo = { ...existing, queued };
        threads = threads.map((t) => (t.id === i.threadId ? next : t));
        return rec("threads.setQueued", [input], next);
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
      setQuotaWaitAutoResume: (input: unknown) => {
        const i = input as { threadId: string; enabled: boolean | null };
        calls.push({ channel: "threads.setQuotaWaitAutoResume", args: [input] });
        const existing = threads.find((t) => t.id === i.threadId);
        if (!existing) {
          return Promise.reject(new Error(`Unknown thread: ${i.threadId}`));
        }
        if (i.enabled !== true && i.enabled !== false && i.enabled !== null) {
          return Promise.reject(
            new Error("quotaWaitAutoResume must be true, false, or null"),
          );
        }
        const next: ThreadInfo = {
          ...existing,
          quotaWaitAutoResume: i.enabled,
        };
        threads = threads.map((t) => (t.id === i.threadId ? next : t));
        return Promise.resolve(next);
      },
      /** Honest mute: flips the flag in place, never bumps updatedAt. */
      setMuted: (input: unknown) => {
        const i = input as { threadId: string; muted: boolean };
        calls.push({ channel: "threads.setMuted", args: [input] });
        const base =
          threads.find((t) => t.id === i.threadId) ?? thread({ id: i.threadId });
        const next: ThreadInfo = { ...base, muted: i.muted === true };
        threads = threads.some((t) => t.id === i.threadId)
          ? threads.map((t) => (t.id === i.threadId ? next : t))
          : [next, ...threads];
        return Promise.resolve(next);
      },
      startTeach: (input: unknown) => {
        const i = input as { threadId: string };
        calls.push({ channel: "threads.startTeach", args: [input] });
        const existing = threads.find((t) => t.id === i.threadId);
        if (!existing) {
          return Promise.reject(new Error(`Unknown thread: ${i.threadId}`));
        }
        if (existing.teach) return Promise.resolve({ ...existing });
        const next: ThreadInfo = {
          ...existing,
          teach: { autonomy: "hint", reviewsPassed: 0 },
          permissionMode:
            existing.permissionMode === "default" ||
            existing.permissionMode === "plan"
              ? existing.permissionMode
              : "default",
        };
        threads = threads.map((t) => (t.id === i.threadId ? next : t));
        return Promise.resolve(next);
      },
      stopTeach: (input: unknown) => {
        const i = input as { threadId: string };
        calls.push({ channel: "threads.stopTeach", args: [input] });
        const existing = threads.find((t) => t.id === i.threadId);
        if (!existing) {
          return Promise.reject(new Error(`Unknown thread: ${i.threadId}`));
        }
        const next: ThreadInfo = { ...existing, teach: null };
        threads = threads.map((t) => (t.id === i.threadId ? next : t));
        return Promise.resolve(next);
      },
      requestTeachReview: (input: unknown) => {
        const i = input as { threadId: string };
        calls.push({ channel: "threads.requestTeachReview", args: [input] });
        const existing = threads.find((t) => t.id === i.threadId);
        if (!existing) {
          return Promise.reject(new Error(`Unknown thread: ${i.threadId}`));
        }
        if (!existing.teach) {
          return Promise.reject(new Error("Thread is not in teach mode"));
        }
        return Promise.resolve({ ...existing });
      },
      /** Honest notes: trims, caps at 2000, never bumps updatedAt. */
      setNotes: (input: unknown) => {
        const i = input as { threadId: string; notes: string };
        calls.push({ channel: "threads.setNotes", args: [input] });
        const existing = threads.find((t) => t.id === i.threadId);
        if (!existing) {
          return Promise.reject(new Error(`Unknown thread: ${i.threadId}`));
        }
        const next: ThreadInfo = {
          ...existing,
          notes: String(i.notes ?? "").trim().slice(0, 2000),
        };
        threads = threads.map((t) => (t.id === i.threadId ? next : t));
        return Promise.resolve(next);
      },
      rename: (input: unknown) => {
        const i = input as { threadId: string; title: string };
        calls.push({ channel: "threads.rename", args: [input] });
        const existing = threads.find((t) => t.id === i.threadId);
        if (!existing) {
          return Promise.reject(new Error(`Unknown thread: ${i.threadId}`));
        }
        const title = String(i.title ?? "").trim().slice(0, 60);
        if (!title) {
          return Promise.reject(new Error("Thread title cannot be empty"));
        }
        const next: ThreadInfo = { ...existing, title };
        threads = threads.map((t) => (t.id === i.threadId ? next : t));
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
          teach: source.teach ?? null,
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
      /**
       * Edit-and-resubmit rewind (#254). Truncates at the target user
       * message and returns; does not start a run. Fail injection still
       * records the call then rejects, matching restoreCheckpoint.
       */
      rewind: (input: unknown) => {
        const i = input as {
          threadId: string;
          messageId: string;
          prompt: string;
          restoreFiles?: boolean;
        };
        calls.push({ channel: "threads.rewind", args: [input] });
        const err = fail["threads.rewind"];
        if (err) return Promise.reject(err);

        const existing = threads.find((t) => t.id === i.threadId);
        if (!existing) {
          return Promise.reject(new Error(`Unknown thread: ${i.threadId}`));
        }
        if (existing.status === "working") {
          return Promise.reject(
            new Error("Cannot rewind while a run is active"),
          );
        }
        if (!String(i.prompt ?? "").trim()) {
          return Promise.reject(new Error("Prompt cannot be empty"));
        }
        const d = details[i.threadId];
        const at = d?.messages.findIndex((m) => m.id === i.messageId) ?? -1;
        if (!d || at < 0 || d.messages[at]!.role !== "user") {
          return Promise.reject(
            new Error(`Not a user message: ${i.messageId}`),
          );
        }
        const dropped = d.messages.slice(at);
        d.messages = d.messages.slice(0, at);
        const next: ThreadInfo = {
          ...existing,
          sessionId: null,
          replayContext: true,
        };
        threads = threads.map((t) => (t.id === i.threadId ? next : t));
        d.thread = next;
        const result: RewindResult = {
          thread: next,
          droppedMessages: dropped.length,
          restoredSha: i.restoreFiles ? "deadbeef" : null,
        };
        return Promise.resolve(result);
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
    usage: {
      byDay: () => rec("usage.byDay", [], {} as UsageByDay),
    },
    fleet: {
      evidence: (input?: unknown) =>
        rec("fleet.evidence", [input], {
          collectedAt: Date.now(),
          durabilityWindowDays: 14,
          threads: [],
          prs: [],
          notes: [],
        } as FleetEvidence),
    },
    runs: {
      start: (input: unknown) => rec("runs.start", [input], { runId: "r1" }),
      startWorkflow: (input: unknown) =>
        rec("runs.startWorkflow", [input], { runId: "r2" }),
      distill: (input: unknown) =>
        rec(
          "runs.distill",
          [input],
          opts.distill ?? {
            name: "Distilled workflow",
            phases: [
              {
                name: "replay",
                agentCount: 1,
                instruction: "Replay what worked",
                provider: "claude",
                model: null,
              },
            ],
          },
        ),
      stop: (input: unknown) => rec("runs.stop", [input], undefined),
      resumeQuotaWait: (input: unknown) =>
        rec("runs.resumeQuotaWait", [input], { runId: "r-quota" }),
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
      repoInfo: (input: unknown) =>
        rec("git.repoInfo", [input], {
          ok: true,
          owner: "owner",
          repo: "repo",
          webUrl: "https://github.com/owner/repo",
        } as GitRepoInfo),
      pull: (input: unknown) =>
        rec("git.pull", [input], {
          ok: true,
          summary: "Already up to date",
        } as GitPullResult),
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
      image: (input: unknown) =>
        rec("files.image", [input], { dataUrl: null }),
      resolve: (input: unknown) => {
        const paths = ((input as { paths?: string[] }).paths ?? []).map(String);
        const known = new Set([
          "src/App.tsx",
          "src/main.tsx",
          "README.md",
          "package.json",
        ]);
        return rec("files.resolve", [input], {
          resolved: paths.map((p) => ({
            path: p,
            abs: known.has(p) ? `/tmp/wt/${p}` : null,
          })),
        });
      },
    },
    attachments: {
      pick: () => rec("attachments.pick", [], { attachments: [] }),
      fromPaths: (input: unknown) =>
        rec(
          "attachments.fromPaths",
          [input],
          opts.fromPaths?.(input) ?? { attachments: [] },
        ),
      saveImage: (input: unknown) =>
        rec(
          "attachments.saveImage",
          [input],
          opts.saveImage?.(input) ?? { attachment: null },
        ),
      readImage: (input: unknown) =>
        rec("attachments.readImage", [input], { dataUrl: null }),
      ...(opts.droppedFilePath
        ? { droppedFilePath: opts.droppedFilePath }
        : {}),
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
      detailSubs.push(cb as (d: ThreadPatch) => void);
      return () => {
        const i = detailSubs.indexOf(cb as (d: ThreadPatch) => void);
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
