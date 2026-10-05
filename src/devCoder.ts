/**
 * Fixture CoderApi for plain Vite browser dev (`npm run dev:browser`) and for
 * the demo/trailer captures. Seeded from mockData.
 *
 * NOT a second implementation of the app. `npm run dev` runs the renderer
 * against the real main process, so nothing here has to agree with
 * electron/services.js — and when the two disagree, electron is right. Keep
 * this file dumb: store what you are given, return something plausible, and
 * leave rules (validation, guards, git, PR state machines) to main.
 *
 * The one thing it must keep doing is MOVE: real provider sessions stream text
 * and tool cards, and the seeded simulate thread ticks a workflow, because the
 * trailer records this UI.
 */
import type {
  ActivityItem,
  AppStatus,
  UpdateStatus,
  CheckpointInfo,
  CoderApi,
  RunStatInfo,
  ConflictForecast,
  DiffResult,
  DevServerState,
  TerminalState,
  PreviewSnapshot,
  FailureKind,
  FailureMode,
  FleetEvidence,
  FetchIssueResult,
  ListIssuesResult,
  CheckoutPrResult,
  PrCommentResult,
  PrDetail,
  PrDetailResult,
  PrTemplateResult,
  LocalServerInfo,
  McpServerInfo,
  PairingCreated,
  PairingCreateInput,
  PairingInfo,
  PairingList,
  PlanIssue,
  PlanStatus,
  SetPlanStatusResult,
  PrCheckInfo,
  PrInfo,
  SourceControlDiscovery,
  SpeechStatus,
  ThreadDetail,
  ThreadInfo,
  DigestResult,
  UsageEntry,
  UsageReport,
  UsageThreadEntry,
  ProviderUsage,
  WorkLogItem,
  WorkflowTemplateInfo,
  VibeKanbanPreview,
  VibeKanbanImportResult,
} from "./shared/ipc";
import { buildActivity } from "./activity.ts";
import { mockData } from "./mockData.ts";
import { createAutomations } from "./dev/automations.ts";
import type { DevCore, DevCtx } from "./dev/context.ts";
import { createMcp } from "./dev/mcp.ts";
import type { MemoryRow } from "./dev/memory.ts";
import { seedMemoryEntries, createMemory } from "./dev/memory.ts";
import { createProjects } from "./dev/projects.ts";
import type { RunState } from "./dev/runs.ts";
import { createRunEngine, createRuns } from "./dev/runs.ts";
import {
  DEV_PROVIDERS,
  seedProjects,
  seedThreads,
  seedDetail,
  fakeDiff,
  EMPTY_DIFF,
} from "./dev/seed.ts";
import { createSettings } from "./dev/settings.ts";
import { createSkills } from "./dev/skills.ts";
import { createThreads } from "./dev/threads.ts";
import {
  TRAILER,
  TITLE_MAX,
  now,
  id,
  capitalize,
  cloneDetail,
} from "./dev/util.ts";
import {
  STANDARD_TEMPLATE,
  cloneTemplate,
  createWorkflows,
} from "./dev/workflows.ts";
export { DEV_MCP_CATALOG, devMcpCatalogRows } from "./dev/mcp.ts";
export type { DevMcpCatalogEntry } from "./dev/mcp.ts";

const WORKTREE_DELAY_MS = 450;
const PUSH_DELAY_MS = 350;
type ListenerMap = {
  "threads:changed": Set<(threads: ThreadInfo[]) => void>;
  "thread:updated": Set<(detail: ThreadDetail) => void>;
  "boot:ready": Set<() => void>;
  "speech:changed": Set<(status: SpeechStatus) => void>;
};

/** Factory for tests / isolated in-memory sessions. */
export function createDevCoder(): CoderApi {
  return buildDevCoder();
}

function buildDevCoder(): CoderApi {
  // let: projects.remove must rebind the array (const would not compile).
  let projects = seedProjects();
  let threads = seedThreads(projects);
  const details = new Map<string, ThreadDetail>();
  const rewindRestore = new Map<
    string,
    { messages: ThreadDetail["messages"]; workLog: ThreadDetail["workLog"]; thread: ThreadInfo }
  >();
  const runTimers = new Map<string, ReturnType<typeof setInterval>>();
  const runStates = new Map<string, RunState>();
  /** Threads whose worktree was merged/removed; fakeDiff stays empty until re-setup. */
  const clearedDiff = new Set<string>();
  /** Directories already reclaimed by the #316 GC demo stubs. */
  const gcRemoved = new Set<string>();
  /** User-defined + builtin workflow templates (in-memory). */
  let templates: WorkflowTemplateInfo[] = [cloneTemplate(STANDARD_TEMPLATE)];
  /** Aggregated cost of finished fake runs this session (stands in for "today"). */
  let spendTodayUsd = 0;
  let dailyBudgetUsd: number | null = null;
  /** User MCP servers (Skills tab), in-memory. */
  let mcpServers: McpServerInfo[] = [];
  let pairings: PairingInfo[] = [];

  let quotaWaitAutoResume = true;
  /** Shared-memory stub (always running in dev). */
  let memoryEntries: MemoryRow[] = seedMemoryEntries(now());
  /** Live PR state keyed by thread id (state can change after create). */
  const prByThread = new Map<string, PrInfo>();
  /** Synthetic PR numbers for harness creates (avoid colliding with seeds). */
  let nextPrNumber = 900;
  /** In-memory per-thread demo servers (Vite-only; Electron uses electron/devservers.js). */
  const demoDevServers = new Map<string, DevServerState>();
  /** Terminal scrollback per thread. The browser harness has no shell. */
  const demoTerminals = new Map<string, string>();

  function demoTerminal(
    threadId: string,
    since: number | null | undefined,
  ): TerminalState {
    const all = demoTerminals.get(threadId);
    if (all == null) {
      return {
        running: false,
        cwd: "",
        shell: "",
        cursor: 0,
        text: "",
        pending: "",
        reset: true,
        startedAt: 0,
      };
    }
    const stale = typeof since !== "number" || since < 0 || since > all.length;
    return {
      running: true,
      cwd: "/demo/worktree",
      shell: "/bin/zsh",
      cursor: all.length,
      text: stale ? all : all.slice(since),
      pending: "",
      reset: stale,
      startedAt: 0,
    };
  }
  /** Planboard label moves made this session (issue number → plan status). */
  const demoPlanStatus = new Map<number, PlanStatus>();

  // Seed prByThread for threads that already carry prNumber/prUrl.
  for (const t of threads) {
    if (t.prNumber != null && t.prUrl) {
      prByThread.set(t.id, {
        number: t.prNumber,
        url: t.prUrl,
        state: "OPEN",
        branch: t.branch ?? "",
        created: false,
      });
    }
  }

  for (const t of threads) {
    if (t.id === mockData.activeThreadId) {
      const detail = seedDetail(t);
      details.set(t.id, detail);
      if (t.status === "working") {
        const runId =
          detail.workLog[0]?.runId ??
          detail.messages.find((m) => m.runId)?.runId ??
          id("run");
        const announced = new Set<string>();
        const settled = new Set<string>();
        for (const item of detail.workLog) {
          if (item.runId !== runId) continue;
          announced.add(item.label);
          if (item.done) settled.add(item.label);
        }
        if (detail.workflow) {
          for (const phase of detail.workflow.phases) {
            const label = capitalize(phase.name);
            const item = detail.workLog.find(
              (w) => w.runId === runId && w.label === label,
            );
            if (item) {
              announced.add(phase.name);
              if (item.done) settled.add(phase.name);
            }
            const allTerminal =
              phase.agents.length > 0 &&
              phase.agents.every(
                (a) => a.status === "settled" || a.status === "failed",
              );
            if (allTerminal) {
              announced.add(phase.name);
              settled.add(phase.name);
            } else if (phase.agents.some((a) => a.status === "running")) {
              announced.add(phase.name);
            }
          }
        }
        runStates.set(t.id, {
          runId,
          announced,
          settled,
          assistantMsgId:
            detail.messages.find((m) => m.role === "assistant" && m.runId === runId)
              ?.id ?? null,
          sessionStep: 0,
          kind:
            t.provider === "simulate" ||
            (TRAILER && t.id === mockData.activeThreadId)
              ? "simulate"
              : "session",
          workflowStep: 0,
          costBaseline: detail.usage?.costUsd ?? 0,
        });
      }
    } else {
      details.set(t.id, {
        thread: t,
        messages: [],
        workLog: [],
        workflow: null,
        usage: t.sessionId
          ? {
              model: "claude-opus-4",
              inputTokens: 1200,
              outputTokens: 400,
              costUsd: 0.0091,
              turns: 1,
            }
          : null,
      });
    }
  }

  const listeners: ListenerMap = {
    "threads:changed": new Set(),
    "thread:updated": new Set(),
    "boot:ready": new Set(),
    "speech:changed": new Set(),
  };

  const emitThreads = () => {
    const snapshot = threads.map((t) => ({ ...t }));
    for (const cb of listeners["threads:changed"]) cb(snapshot);
  };

  const emitDetail = (detail: ThreadDetail) => {
    const snap = cloneDetail(detail);
    for (const cb of listeners["thread:updated"]) cb(snap);
  };

  const syncThreadRow = (thread: ThreadInfo) => {
    threads = threads.map((t) => (t.id === thread.id ? { ...thread } : t));
    emitThreads();
  };

  /** Apply a field patch to a thread and push it to the UI. */
  const patchThread = (
    threadId: string,
    patch: Partial<ThreadInfo>,
  ): ThreadInfo => {
    const detail = details.get(threadId);
    if (!detail) throw new Error(`Thread not found: ${threadId}`);
    const thread: ThreadInfo = { ...detail.thread, ...patch };
    detail.thread = thread;
    details.set(threadId, detail);
    syncThreadRow(thread);
    emitDetail(detail);
    return { ...thread };
  };

  /** A fresh ThreadInfo with every field at its idle default. */
  const newThread = (over: Partial<ThreadInfo> = {}): ThreadInfo => {
    const t0 = now();
    return {
      id: id("thread"),
      projectId: "",
      branch: null,
      baseBranch: null,
      prNumber: null,
      prUrl: null,
      status: "idle",
      lastError: null,
      lastErrorKind: null,
      createdAt: t0,
      updatedAt: t0,
      runStartedAt: null,
      archived: false,
      settledOverride: null,
      settledAt: null,
      prState: null,
      // Just-created is not unread.
      lastVisitedAt: t0,
      pinnedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      provider: "claude",
      model: null,
      sessionId: null,
      permissionMode: "default",
      reasoningEffort: null,
      webSearch: false,
      worktreePath: null,
      handoffFrom: null,
      muted: false,
      ejected: false,
      notes: "",
      messagePins: [],
      tags: [],
      queued: null,
      verifyCommand: null,
      verify: null,
      ...over,
      title: (over.title || "New Thread").slice(0, TITLE_MAX),
    };
  };

  /** Put a new thread at the top of the list with an empty transcript. */
  const registerThread = (t: ThreadInfo): ThreadInfo => {
    threads = [t, ...threads];
    details.set(t.id, {
      thread: t,
      messages: [],
      workLog: [],
      workflow: null,
      usage: null,
    });
    emitThreads();
    return { ...t };
  };

  /** Plausible branch + worktree path for the demo. No rules, just strings. */
  const fakeWorktree = (thread: ThreadInfo): Partial<ThreadInfo> => {
    const slug =
      thread.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "thread";
    const project = projects.find((p) => p.id === thread.projectId);
    return {
      pendingWorktree: false,
      pendingFork: false,
      branch: thread.branch ?? `coder/${slug}-${thread.id.slice(0, 6)}`,
      worktreePath: `${project?.path ?? "/Users/demo/project"}/.coder/worktrees/${thread.id}`,
    };
  };

  /**
   * In-memory checkpoints per thread, newest first: enough for the timeline
   * to render. electron/worktrees.js owns the real git log.
   */
  const checkpointsByThread = new Map<string, CheckpointInfo[]>();

  // Shared with the src/dev domain modules; see src/dev/context.ts.
  const core: DevCore = {
    get projects() {
      return projects;
    },
    set projects(v) {
      projects = v;
    },
    get threads() {
      return threads;
    },
    set threads(v) {
      threads = v;
    },
    get templates() {
      return templates;
    },
    set templates(v) {
      templates = v;
    },
    get memoryEntries() {
      return memoryEntries;
    },
    set memoryEntries(v) {
      memoryEntries = v;
    },
    get spendTodayUsd() {
      return spendTodayUsd;
    },
    set spendTodayUsd(v) {
      spendTodayUsd = v;
    },
    get dailyBudgetUsd() {
      return dailyBudgetUsd;
    },
    set dailyBudgetUsd(v) {
      dailyBudgetUsd = v;
    },
    get mcpServers() {
      return mcpServers;
    },
    set mcpServers(v) {
      mcpServers = v;
    },
    get quotaWaitAutoResume() {
      return quotaWaitAutoResume;
    },
    set quotaWaitAutoResume(v) {
      quotaWaitAutoResume = v;
    },
    details,
    rewindRestore,
    runTimers,
    runStates,
    clearedDiff,
    prByThread,
    checkpointsByThread,
    emitThreads,
    emitDetail,
    syncThreadRow,
    patchThread,
    newThread,
    registerThread,
    fakeWorktree,
    api: () => api,
  };
  const ctx: DevCtx = Object.assign(core, createRunEngine(core));
  const { startRunTimer } = ctx;

  for (const t of threads) {
    if (t.status === "working") {
      startRunTimer(t.id);
    }
  }

  const api: CoderApi = {
    app: {
      async status(): Promise<AppStatus> {
        return {
          spendTodayUsd,
          memory: {
            running: true,
            adopted: false,
            port: 49999,
            entries: memoryEntries.length,
            vectors: memoryEntries.length,
            lastError: null,
          },
          build: { version: "0.1.0-dev", sha: null, time: null, channel: null },
        };
      },
      async checkUpdate(): Promise<UpdateStatus> {
        return {
          state: "disabled",
          channel: null,
          tag: null,
          url: null,
          error: null,
        };
      },
      async downloadUpdate(): Promise<UpdateStatus> {
        return this.checkUpdate();
      },
      async applyUpdate(): Promise<void> {},
      async openRemoteConnection(): Promise<{ host: string; remotePort: number; tokenSaved: boolean }> {
        throw new Error("Remote Connections require the desktop app.");
      },
      async forgetRemoteConnection(): Promise<void> {},
      async feedback(input: {
        text: string;
        threadId?: string;
      }): Promise<void> {
        // Browser dev has no endpoint: log it and confirm, same as a real send.
        console.info("[dev] feedback:", input.text);
        const detail = input.threadId ? details.get(input.threadId) : null;
        detail?.messages.push({
          id: id("evt"),
          role: "event",
          text: "Feedback sent to the Solenta team. Thank you.",
          createdAt: now(),
        });
      },
    },
    ...createMemory(ctx),
    ...createSettings(ctx),
    ...createMcp(ctx),
    ...createSkills(),
    providers: {
      async list() {
        return DEV_PROVIDERS.map((p) => ({
          ...p,
          models: [...p.models],
        }));
      },
    },
    sourceControl: {
      async discover(): Promise<SourceControlDiscovery> {
        return {
          sourceControlProviders: [
            {
              kind: "github",
              label: "GitHub",
              status: "available",
              installHint: "gh auth login",
              version: "2.97.0",
              auth: { status: "authenticated", detail: "dev" },
            },
            {
              kind: "gitlab",
              label: "GitLab",
              status: "missing",
              installHint: "brew install glab",
              version: null,
              auth: {
                status: "unauthenticated",
                detail: "GitLab CLI (glab) is not installed.",
              },
            },
            {
              kind: "bitbucket",
              label: "Bitbucket",
              status: "available",
              installHint:
                'export SOLENTA_BITBUCKET_ACCESS_TOKEN="your-access-token"',
              version: null,
              auth: {
                status: "unauthenticated",
                detail:
                  "Set SOLENTA_BITBUCKET_ACCESS_TOKEN, or SOLENTA_BITBUCKET_EMAIL plus SOLENTA_BITBUCKET_API_TOKEN.",
              },
            },
            {
              kind: "azure-devops",
              label: "Azure DevOps",
              status: "missing",
              installHint: "brew install azure-cli",
              version: null,
              auth: {
                status: "unauthenticated",
                detail: "Azure CLI (az) is not installed.",
              },
            },
          ],
          probedAt: Date.now(),
        };
      },
    },
    ...createWorkflows(ctx),
    ...createAutomations(ctx),
    ...createProjects(ctx),
    ...createThreads(ctx),
    ...createRuns(ctx),
    activity: {
      async list(): Promise<ActivityItem[]> {
        const workLogByThread: Record<string, WorkLogItem[]> = {};
        for (const [id, d] of details) {
          workLogByThread[id] = d.workLog;
        }
        return buildActivity(threads, workLogByThread, now());
      },
    },
    usage: {
      async byDay(): Promise<UsageReport> {
        const cell = (
          costUsd: number,
          inputTokens: number,
          outputTokens: number,
          turns: number,
          extra: Partial<UsageEntry> = {},
        ): UsageEntry => ({
          costUsd,
          inputTokens,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens,
          turns,
          wastedUsd: 0,
          ...extra,
        });
        const day = (offset: number) => {
          const d = new Date(now());
          d.setDate(d.getDate() - offset);
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          return `${y}-${m}-${dd}`;
        };
        const threadCell = (
          costUsd: number,
          inputTokens: number,
          outputTokens: number,
          turns: number,
          meta: Pick<
            UsageThreadEntry,
            "projectId" | "projectName" | "title" | "provider" | "model"
          >,
          extra: Partial<UsageEntry> = {},
        ): UsageThreadEntry => ({
          ...cell(costUsd, inputTokens, outputTokens, turns, extra),
          ...meta,
        });
        const nebula = {
          projectId: "proj-1",
          projectName: "nebula",
        };
        const ledger = {
          projectId: "proj-2",
          projectName: "ledger",
        };
        return {
          byDay: {
            [day(0)]: {
              claude: {
                "claude-opus-4": cell(12.4, 3000, 8200, 6, {
                  cachedInputTokens: 2_400_000,
                  cacheWriteTokens: 80_000,
                  wastedUsd: 2.1,
                }),
              },
              grok: {
                "grok-4": cell(4.2, 18000, 3200, 4),
              },
              kimi: {
                "kimi-k2": cell(0, 0, 0, 41),
              },
            },
            [day(1)]: {
              claude: {
                "claude-sonnet-4": cell(0.41, 15000, 2400, 3, {
                  cachedInputTokens: 120_000,
                  cacheWriteTokens: 4_000,
                }),
              },
            },
            [day(3)]: {
              grok: {
                "grok-4": cell(1.1, 22000, 4100, 5),
              },
            },
          },
          threadsByDay: {
            [day(0)]: {
              "thread-1": threadCell(10.2, 2000, 6200, 4, {
                ...nebula,
                title: "Modernize Per-Device Provider Settings",
                provider: "claude",
                model: "claude-opus-4",
              }, {
                cachedInputTokens: 1_800_000,
                cacheWriteTokens: 60_000,
                wastedUsd: 2.1,
              }),
              "thread-2": threadCell(2.2, 1000, 2000, 2, {
                ...nebula,
                title: "Fix worktree path resolution on Windows",
                provider: "claude",
                model: "claude-opus-4",
              }, {
                cachedInputTokens: 600_000,
                cacheWriteTokens: 20_000,
              }),
              "thread-grok-1": threadCell(4.2, 18000, 3200, 4, {
                ...ledger,
                title: "Tighten CSP for Electron preload",
                provider: "grok",
                model: "grok-4",
              }),
              "thread-kimi-1": threadCell(0, 0, 0, 21, {
                ...ledger,
                title: "Add INTEGER-SAFARI workflow runner",
                provider: "kimi",
                model: "kimi-k2",
              }),
            },
            [day(1)]: {
              "thread-1": threadCell(0.41, 15000, 2400, 3, {
                ...nebula,
                title: "Modernize Per-Device Provider Settings",
                provider: "claude",
                model: "claude-sonnet-4",
              }, {
                cachedInputTokens: 120_000,
                cacheWriteTokens: 4_000,
              }),
              "thread-kimi-1": threadCell(0, 0, 0, 20, {
                ...ledger,
                title: "Add INTEGER-SAFARI workflow runner",
                provider: "kimi",
                model: "kimi-k2",
              }),
            },
            [day(3)]: {
              "thread-grok-2": threadCell(1.1, 22000, 4100, 5, {
                ...ledger,
                title: "Scaffold three-pane desktop shell",
                provider: "grok",
                model: "grok-4",
              }),
            },
          },
        };
      },
      async providerLimits(): Promise<ProviderUsage[]> {
        const t = now();
        const window = (
          label: string,
          usedPercent: number,
          windowSeconds: number,
          resetsInMs: number,
        ) => ({
          label,
          usedPercent,
          resetsAt: t + resetsInMs,
          windowSeconds,
        });
        return [
          {
            provider: "claude",
            status: "ok",
            fetchedAt: t,
            windows: [
              window("5-hour", 33, 5 * 3600, 2 * 3600 * 1000),
              window("weekly", 12, 7 * 24 * 3600, 3 * 24 * 3600 * 1000),
            ],
          },
          {
            provider: "codex",
            status: "ok",
            fetchedAt: t,
            windows: [
              window("GPT-5.3-Codex-Spark 5-hour", 8, 5 * 3600, 4 * 3600 * 1000),
              window("GPT-5.3-Codex-Spark weekly", 41, 7 * 24 * 3600, 5 * 24 * 3600 * 1000),
              window("gpt-reserve weekly", 15, 7 * 24 * 3600, 5 * 24 * 3600 * 1000),
            ],
          },
          {
            provider: "kimi",
            status: "ok",
            fetchedAt: t,
            windows: [
              window("5-hour", 18, 5 * 3600, 90 * 60 * 1000),
              window("weekly", 54, 7 * 24 * 3600, 2 * 24 * 3600 * 1000),
            ],
          },
          {
            provider: "grok",
            status: "ok",
            fetchedAt: t,
            windows: [window("weekly", 36, 7 * 24 * 3600, 3 * 24 * 3600 * 1000)],
          },
          {
            provider: "opencode",
            status: "unavailable",
            fetchedAt: null,
            windows: [],
            message: "OpenCode CLI reports local stats, not account quotas.",
          },
          {
            provider: "cursor",
            status: "unavailable",
            fetchedAt: null,
            windows: [],
            message: "Cursor CLI has no documented usage or quota command.",
          },
          {
            provider: "muse",
            status: "unavailable",
            fetchedAt: null,
            windows: [],
            message: "Muse CLI has no documented usage or quota command.",
          },
        ];
      },
    },
    fleet: {
      // Fixture only. The real collection lives in electron/fleet.js.
      async evidence(): Promise<FleetEvidence> {
        const t0 = now();
        const hour = 3_600_000;
        const day = 24 * hour;
        const a = threads[0];
        const b = threads[1];
        const c = threads[2];
        const projectId = a?.projectId ?? "proj-1";
        const slug =
          projects.find((p) => p.id === projectId)?.slug ?? "acme/nebula";
        const github = (n: number) => `https://github.com/${slug}/pull/${n}`;
        return {
          collectedAt: t0,
          durabilityWindowDays: 14,
          threads: [
            {
              threadId: a?.id ?? "thread-1",
              projectId,
              title: a?.title ?? "Modernize Per-Device Provider Settings",
              provider:
                a?.provider && a.provider !== "simulate" ? a.provider : "claude",
              model: a?.model ?? "claude-opus-4",
              createdAt: t0 - 20 * day,
              endedAt: t0 - 18 * day,
              activeMs: 2.5 * hour,
              costUsd: 4.82,
              inputTokens: 120000,
              outputTokens: 18000,
              turns: 12,
              feltSavedMs: 4 * hour,
              linesAdded: 420,
              linesSurviving: 310,
              durabilityMeasurable: true,
            },
            {
              threadId: b?.id ?? "thread-2",
              projectId: b?.projectId ?? projectId,
              title: b?.title ?? "Fix worktree path resolution on Windows",
              provider: "codex",
              model: "gpt-5.3-codex",
              createdAt: t0 - 3 * day,
              endedAt: t0 - 1 * day,
              activeMs: 50 * 60 * 1000,
              costUsd: 1.15,
              inputTokens: 40000,
              outputTokens: 8000,
              turns: 6,
              feltSavedMs: 2 * hour,
              linesAdded: 80,
              linesSurviving: 80,
              durabilityMeasurable: false,
            },
            {
              threadId: c?.id ?? "thread-3",
              projectId: c?.projectId ?? projectId,
              title: c?.title ?? "Add INTEGER-SAFARI workflow runner",
              provider: "claude",
              model: "claude-sonnet-4",
              createdAt: t0 - 5 * day,
              endedAt: t0 - 4 * day,
              activeMs: 80 * 60 * 1000,
              costUsd: 2.4,
              inputTokens: 60000,
              outputTokens: 9000,
              turns: 8,
              feltSavedMs: null,
              linesAdded: null,
              linesSurviving: null,
              durabilityMeasurable: false,
            },
          ],
          prs: [
            {
              projectId,
              number: 842,
              url: github(842),
              title: a?.title ?? "Modernize Per-Device Provider Settings",
              headRefName: "feat/provider-settings",
              state: "MERGED",
              createdAt: t0 - 20 * day + hour,
              mergedAt: t0 - 18 * day,
              closedAt: t0 - 18 * day,
              additions: 420,
              deletions: 90,
              firstReviewAt: t0 - 20 * day + 6 * hour,
              threadId: a?.id ?? "thread-1",
            },
            {
              projectId: b?.projectId ?? projectId,
              number: 839,
              url: github(839),
              title: b?.title ?? "Fix worktree path resolution on Windows",
              headRefName: "fix/win-worktree",
              state: "OPEN",
              createdAt: t0 - 3 * day + hour,
              mergedAt: null,
              closedAt: null,
              additions: 80,
              deletions: 12,
              firstReviewAt: t0 - 3 * day + 3 * hour,
              threadId: b?.id ?? "thread-2",
            },
            {
              projectId: c?.projectId ?? projectId,
              number: 112,
              url: github(112),
              title: c?.title ?? "Add INTEGER-SAFARI workflow runner",
              headRefName: "feat/integer-safari",
              state: "CLOSED",
              createdAt: t0 - 5 * day + hour,
              mergedAt: null,
              closedAt: t0 - 4 * day,
              additions: 200,
              deletions: 40,
              firstReviewAt: null,
              threadId: c?.id ?? "thread-3",
            },
            {
              projectId,
              number: 801,
              url: github(801),
              title: "Tighten auth cookie flags",
              headRefName: "fix/cookie-flags",
              state: "MERGED",
              createdAt: t0 - 12 * day,
              mergedAt: t0 - 11 * day,
              closedAt: t0 - 11 * day,
              additions: 24,
              deletions: 6,
              firstReviewAt: t0 - 12 * day + 2 * hour,
              threadId: null,
            },
          ],
          notes: [
            "acme/ledger: gh missing",
            "acme/nebula: blame budget reached, 4 commits unmeasured",
          ],
        };
      },
    },
    insights: {
      // Fixture only. The real clustering lives in electron/failuremodes.js.
      async failureModes(): Promise<FailureMode[]> {
        const rows = threads.slice(0, 3);
        if (rows.length < 2) return [];
        return [
          {
            id: "fixture-enoent",
            signature: "Error: spawn <cmd> ENOENT",
            sample: "Error: spawn claude ENOENT",
            count: rows.length,
            lastAt: now(),
            offenders: rows.map((t, i) => ({
              threadId: t.id,
              threadTitle: t.title,
              projectId: t.projectId,
              provider: t.provider,
              kind: (i === 0 ? "failed" : "retried") as FailureKind,
              at: now() - i * 3_600_000,
            })),
          },
          {
            id: "fixture-budget",
            signature: "Daily budget of $<n> reached",
            sample: "Daily budget of $20 reached",
            count: 2,
            lastAt: now() - 7_200_000,
            offenders: rows.slice(0, 2).map((t, i) => ({
              threadId: t.id,
              threadTitle: t.title,
              projectId: t.projectId,
              provider: t.provider,
              kind: "failed" as FailureKind,
              at: now() - 7_200_000 - i * 60_000,
            })),
          },
        ];
      },
    },
    digest: {
      // ponytail: fixed fixture, one row per bucket — dev mode never runs
      // unattended, so there is nothing real to collect here.
      async list(input): Promise<DigestResult> {
        const generatedAt = now();
        const sinceMs = input?.sinceMs ?? generatedAt - 12 * 60 * 60 * 1000;
        const base = {
          projectId: projects[0]?.id ?? "p1",
          projectSlug: projects[0]?.slug ?? "coder",
          provider: "claude",
          turns: 6,
          prNumber: null,
          prState: null,
        };
        return {
          sinceMs,
          generatedAt,
          runs: [
            {
              ...base,
              threadId: "dev-digest-1",
              title: "Add usage rollup endpoint",
              status: "done",
              awaitingInput: false,
              lastError: null,
              endedAt: generatedAt - 3 * 60 * 60 * 1000,
              costUsd: 2.14,
              filesChanged: 4,
              additions: 180,
              deletions: 22,
              commits: 2,
              checks: { ran: true, failed: false, label: "npm test" },
            },
            {
              ...base,
              threadId: "dev-digest-2",
              title: "Migrate store to v3 schema",
              status: "failed",
              awaitingInput: false,
              lastError: "Run error: provider exited 1",
              endedAt: generatedAt - 5 * 60 * 60 * 1000,
              costUsd: 1.02,
              filesChanged: 26,
              additions: 900,
              deletions: 310,
              commits: 0,
              checks: { ran: true, failed: true, label: "npm test" },
            },
            {
              ...base,
              threadId: "dev-digest-3",
              title: "Investigate flaky reconnect test",
              status: "done",
              awaitingInput: false,
              lastError: null,
              endedAt: generatedAt - 7 * 60 * 60 * 1000,
              costUsd: 0.87,
              filesChanged: 0,
              additions: 0,
              deletions: 0,
              commits: 0,
              checks: { ran: false, failed: false, label: null },
            },
          ],
        };
      },
      async markSeen(input): Promise<{ seenAt: number }> {
        return { seenAt: input?.atMs ?? now() };
      },
    },
    git: {
      async listBranches() {
        return { defaultBranch: "main", branches: ["main"] };
      },
      async status(_projectId) {
        return {
          isRepo: true,
          branch: "main",
          dirty: false,
        };
      },
      async push(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const branch = detail.thread.branch;
        if (!branch) {
          throw new Error("No git remote configured for this project.");
        }
        await new Promise((r) => setTimeout(r, PUSH_DELAY_MS));
        return { remote: "origin", branch };
      },
      // PR fixture: one open PR per thread, merged on demand. The real
      // guards (branch/title required, re-open returns created:false, merge
      // state machine) live in electron/worktrees.js.
      async createPr(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const existing = prByThread.get(input.threadId);
        if (existing) {
          patchThread(input.threadId, {
            prNumber: existing.number,
            prUrl: existing.url,
            prState: existing.state,
          });
          return { ...existing, created: false };
        }
        const project = projects.find((p) => p.id === detail.thread.projectId);
        const number = nextPrNumber++;
        const info: PrInfo = {
          number,
          url: `https://github.com/${project?.slug ?? "owner/repo"}/pull/${number}`,
          state: "OPEN",
          branch: detail.thread.branch ?? "main",
          created: true,
        };
        prByThread.set(input.threadId, { ...info, created: false });
        patchThread(input.threadId, {
          prNumber: info.number,
          prUrl: info.url,
          prState: info.state,
          updatedAt: now(),
        });
        return info;
      },
      async prStatus(input) {
        const existing = prByThread.get(input.threadId);
        if (!existing) return null;
        patchThread(input.threadId, {
          prNumber: existing.number,
          prUrl: existing.url,
          prState: existing.state,
        });
        return { ...existing, created: false };
      },
      async prChecks(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const existing = prByThread.get(input.threadId);
        if (!existing) return { ok: false as const, reason: "no PR" };
        const checks: PrCheckInfo[] =
          existing.state === "MERGED"
            ? [
                { name: "test", bucket: "pass" },
                { name: "lint", bucket: "pass" },
              ]
            : [
                { name: "test", bucket: "pass" },
                { name: "lint", bucket: "pending" },
              ];
        return { ok: true as const, checks };
      },
      async prMerge(input) {
        const existing = prByThread.get(input.threadId);
        if (!existing) {
          throw new Error("No pull request found for this branch");
        }
        const merged: PrInfo = { ...existing, state: "MERGED", created: false };
        prByThread.set(input.threadId, merged);
        patchThread(input.threadId, {
          prNumber: merged.number,
          prUrl: merged.url,
          prState: merged.state,
          updatedAt: now(),
        });
        return merged;
      },
      async listPrs(projectPath: string) {
        const project = projects.find((p) => p.path === projectPath);
        if (!project) return { ok: true, prs: [], complete: true, limit: 50 };
        const prs = threads
          .filter(
            (t) =>
              t.projectId === project.id &&
              t.prNumber != null &&
              t.prUrl != null,
          )
          .map((t) => ({
            number: t.prNumber as number,
            title: t.title,
            url: t.prUrl as string,
            state: (t.prState ?? "OPEN") as "OPEN" | "CLOSED" | "MERGED",
            headRefName: t.branch ?? "",
          }));
        return { ok: true, prs, complete: true, limit: prs.length };
      },
      async checkoutPr(input: { projectId: string; prNumber: number }) {
        const project = projects.find((p) => p.id === input.projectId);
        if (!project) return { ok: false as const, reason: "Unknown project" };
        const existing = threads.find(
          (t) =>
            t.projectId === input.projectId && t.prNumber === input.prNumber,
        );
        if (existing && existing.worktreePath) {
          return {
            ok: true as const,
            created: false,
            readOnly: !existing.branch,
            prompt: `GitHub pull request #${input.prNumber}: ${existing.title}\n`,
            thread: { ...existing },
          } satisfies CheckoutPrResult;
        }
        const base = newThread({
          projectId: input.projectId,
          title: `PR #${input.prNumber}`,
          prNumber: input.prNumber,
          prUrl: `https://github.com/example/repo/pull/${input.prNumber}`,
        });
        const t = registerThread({
          ...base,
          ...fakeWorktree(base),
          prNumber: input.prNumber,
          prUrl: base.prUrl,
        });
        return {
          ok: true as const,
          created: true,
          readOnly: false,
          prompt: `GitHub pull request #${input.prNumber}: ${t.title}\n${t.prUrl}\n`,
          thread: t,
        } satisfies CheckoutPrResult;
      },
      async prTemplate(_input: { projectPath: string }): Promise<PrTemplateResult> {
        return { ok: true, body: "", path: null, templates: [] };
      },
      async prDetail(input: {
        projectPath: string;
        prNumber: number;
      }): Promise<PrDetailResult> {
        const t = threads.find((x) => x.prNumber === input.prNumber);
        const pr: PrDetail = {
          number: input.prNumber,
          title: t?.title ?? `PR #${input.prNumber}`,
          body: "",
          url:
            t?.prUrl ??
            `https://github.com/example/repo/pull/${input.prNumber}`,
          state: (t?.prState ?? "OPEN") as PrDetail["state"],
          isDraft: false,
          headRefName: t?.branch ?? `feat/${input.prNumber}`,
          comments: [],
        };
        return { ok: true, pr };
      },
      async prEdit(input: {
        projectPath: string;
        prNumber: number;
        title?: string;
        body?: string;
      }): Promise<PrDetailResult> {
        const viewed = await this.prDetail(input);
        if (!viewed.ok) return viewed;
        return {
          ok: true,
          pr: {
            ...viewed.pr,
            title: input.title ?? viewed.pr.title,
            body: input.body ?? viewed.pr.body,
          },
        };
      },
      async prComment(_input: {
        projectPath: string;
        prNumber: number;
        body: string;
      }): Promise<PrCommentResult> {
        return {
          ok: true,
          url: "https://github.com/example/repo/pull/1#issuecomment-1",
        };
      },
      async prClose(input: {
        projectPath: string;
        prNumber: number;
      }): Promise<PrDetailResult> {
        const viewed = await this.prDetail(input);
        if (!viewed.ok) return viewed;
        return { ok: true, pr: { ...viewed.pr, state: "CLOSED" } };
      },
      async prReady(input: {
        projectPath: string;
        prNumber: number;
        undo?: boolean;
      }): Promise<PrDetailResult> {
        const viewed = await this.prDetail(input);
        if (!viewed.ok) return viewed;
        return { ok: true, pr: { ...viewed.pr, isDraft: Boolean(input.undo) } };
      },
      async prMergeAt(input: {
        projectPath: string;
        prNumber: number;
      }): Promise<PrDetailResult> {
        const viewed = await this.prDetail(input);
        if (!viewed.ok) return viewed;
        return { ok: true, pr: { ...viewed.pr, state: "MERGED", isDraft: false } };
      },
      async listCheckpoints(input: { threadId: string }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Unknown thread: ${input.threadId}`);
        if (!detail.thread.worktreePath) return [];
        return (checkpointsByThread.get(input.threadId) || []).map((c) => ({
          ...c,
        }));
      },
      async syncInfo(_input: { threadId: string }) {
        return { hasUpstream: false as const };
      },
      async fetch(_input: { threadId: string }) {
        // Dev mock: no remotes.
      },
      async repoInfo(input: { threadId: string }) {
        const detail = details.get(input.threadId);
        if (!detail) return { ok: false as const };
        const project = projects.find((p) => p.id === detail.thread.projectId);
        const slug = project?.slug ?? "";
        const [owner, repo] = slug.split("/");
        if (!owner || !repo) return { ok: false as const };
        return {
          ok: true as const,
          owner,
          repo,
          webUrl: `https://github.com/${owner}/${repo}`,
        };
      },
      async pull(_input: { threadId: string }) {
        // Dev mock: local fixture repos have no upstream to pull from.
        return { ok: true as const, summary: "Already up to date" };
      },
      async restoreCheckpoint(input: { threadId: string; sha: string }) {
        // Fixture twin of electron/worktrees.js restoreCheckpoint: drop
        // newer checkpoints and rewind the transcript (issue #149).
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Unknown thread: ${input.threadId}`);
        const list = checkpointsByThread.get(input.threadId) || [];
        const want = String(input.sha || "").trim();
        const idx = list.findIndex((c) => c.sha.startsWith(want));
        if (idx < 0) throw new Error(`Unknown checkpoint: ${input.sha}`);
        checkpointsByThread.set(input.threadId, list.slice(idx));
        const match = list[idx]!;
        const slackEnd = match.at + 999;
        const dropIdx = detail.messages.findIndex(
          (m) => Number.isFinite(m.createdAt) && m.createdAt > slackEnd,
        );
        if (dropIdx >= 0) {
          const droppedRuns = new Set(
            detail.messages
              .slice(dropIdx)
              .map((m) => m.runId)
              .filter((r): r is string => !!r),
          );
          detail.messages = detail.messages.slice(0, dropIdx);
          detail.workLog = detail.workLog.filter(
            (w) => !w.runId || !droppedRuns.has(w.runId),
          );
        }
        patchThread(input.threadId, {
          sessionId: null,
          replayContext: true,
        });
      },
      async runStats(input: { threadId: string }): Promise<RunStatInfo[]> {
        try {
          const detail = details.get(input.threadId);
          if (!detail || !detail.thread.worktreePath) return [];
          const list = checkpointsByThread.get(input.threadId) || [];
          return list
            .slice()
            .sort((a, b) => a.turn - b.turn)
            .map((c) => ({
              sha: c.sha,
              turn: c.turn,
              files: 1,
              additions: 1,
              deletions: 0,
            }));
        } catch {
          return [];
        }
      },
      async turnDiff(input: { threadId: string; sha: string }): Promise<DiffResult> {
        try {
          const detail = details.get(input.threadId);
          if (!detail || !detail.thread.worktreePath) return { ...EMPTY_DIFF };
          const list = checkpointsByThread.get(input.threadId) || [];
          if (!list.some((c) => c.sha === input.sha)) return { ...EMPTY_DIFF };
          return fakeDiff(detail.thread);
        } catch {
          return { ...EMPTY_DIFF };
        }
      },
      async conflictForecast(input: {
        projectId: string;
      }): Promise<ConflictForecast> {
        // ponytail: fake one hotspot between the first two worktree threads of
        // the project so the browser dev build has something to render.
        const ids = threads
          .filter((t) => t.projectId === input.projectId && t.worktreePath)
          .map((t) => t.id);
        const pairs =
          ids.length >= 2
            ? [
                {
                  threadA: ids[0]!,
                  threadB: ids[1]!,
                  overlap: ["src/useCoder.ts", "src/shared/ipc.ts"],
                  conflicts: ["src/shared/ipc.ts"],
                },
              ]
            : [];
        return { pairs, computedAt: now() };
      },
      async gcScan() {
        const first = projects[0];
        const second = projects[1] ?? first;
        if (!first) return { candidates: [], usage: [], totalBytes: 0 };
        const all = [
          {
            path: "/tmp/solenta-worktrees/orphan-abc",
            bytes: 48 * 1024 * 1024,
            reason: "orphan" as const,
            threadId: null,
            title: null,
            projectId: first.id,
            branch: "solenta/orphan-abc",
          },
          {
            path: "/tmp/solenta-worktrees/old-thread",
            bytes: 12 * 1024 * 1024,
            reason: "retention" as const,
            threadId: threads[0]?.id ?? null,
            title: "old settled thread",
            projectId: first.id,
            branch: "solenta/old-thread",
          },
          {
            path: "/tmp/solenta-worktrees/dirty",
            bytes: 8 * 1024 * 1024,
            reason: "orphan" as const,
            threadId: null,
            title: null,
            projectId: second.id,
            branch: "solenta/dirty",
            blocked: "uncommitted changes",
          },
        ].filter((c) => !gcRemoved.has(c.path));
        const byProject = new Map<string, { worktrees: number; bytes: number }>();
        for (const c of all) {
          if (!c.projectId) continue;
          const row = byProject.get(c.projectId) ?? { worktrees: 0, bytes: 0 };
          row.worktrees += 1;
          row.bytes += c.bytes;
          byProject.set(c.projectId, row);
        }
        const usage = [...byProject.entries()].map(([projectId, row]) => ({
          projectId,
          worktrees: row.worktrees,
          bytes: row.bytes,
        }));
        return {
          candidates: all,
          usage,
          totalBytes: all.reduce((sum, c) => sum + c.bytes, 0),
        };
      },
      async gcClean(input) {
        const paths = Array.isArray(input?.paths) ? input.paths : [];
        const scan = await api.git.gcScan();
        const byPath = new Map(scan.candidates.map((c) => [c.path, c]));
        const removed: string[] = [];
        const failed: Array<{ path: string; error: string }> = [];
        let bytes = 0;
        for (const path of paths) {
          const row = byPath.get(path);
          if (!row || row.blocked) {
            failed.push({
              path,
              error: row?.blocked ?? "not a reclaimable worktree",
            });
            continue;
          }
          gcRemoved.add(path);
          removed.push(path);
          bytes += row.bytes;
        }
        return { removed, failed, bytes };
      },
      async setupWorktree(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        await new Promise((r) => setTimeout(r, WORKTREE_DELAY_MS));
        clearedDiff.delete(input.threadId);
        return patchThread(input.threadId, {
          ...fakeWorktree(detail.thread),
          updatedAt: now(),
        });
      },
      async reviewContext(_input) {
        return { annotation: null, symbols: [], acceptedHunks: [] };
      },
      async setReviewAccepted(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        return patchThread(input.threadId, {
          reviewAcceptedHunks: input.hashes,
        });
      },
      async diff(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        if (clearedDiff.has(input.threadId)) {
          return { ...EMPTY_DIFF };
        }
        // Empty when brand-new idle thread with no messages.
        if (detail.messages.length === 0 && detail.thread.status === "idle") {
          return { ...EMPTY_DIFF };
        }
        return fakeDiff(detail.thread);
      },
      async commit(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const message = input.message.trim();
        if (!message) throw new Error("Commit message is empty");
        clearedDiff.add(input.threadId);
        return { subject: message.split("\n")[0] };
      },
      async revertFile(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        return { path: input.path };
      },
      async suggestCommitMessage(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        return { message: "feat: update the centre pane" };
      },
      async conflictContext(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        return {
          files: [],
          omitted: 0,
          branch: detail.thread.branch ?? null,
          baseBranch: "main",
        };
      },
      async integrateWorker(_input: {
        leadThreadId: string;
        workerThreadId: string;
      }) {
        throw new Error("Set up a lead worktree first");
      },
      async mergeWorktree(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        if (!detail.thread.worktreePath) {
          throw new Error("No worktree set up for this thread");
        }

        await new Promise((r) => setTimeout(r, WORKTREE_DELAY_MS));

        const t = now();
        const thread: ThreadInfo = {
          ...detail.thread,
          worktreePath: null,
          branch: null,
          updatedAt: t,
        };
        detail.thread = thread;
        detail.messages.push({
          id: id("evt"),
          role: "event",
          text: "Merged worktree",
          createdAt: t,
        });
        clearedDiff.add(input.threadId);
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
      },
      async removeWorktree(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        if (!detail.thread.worktreePath) {
          throw new Error("No worktree set up for this thread");
        }

        await new Promise((r) => setTimeout(r, WORKTREE_DELAY_MS));

        const hasChanges =
          !clearedDiff.has(input.threadId) &&
          !(
            detail.messages.length === 0 && detail.thread.status === "idle"
          );

        if (!input.force && hasChanges) {
          // Mimic Electron's invoke wrapper so the renderer dirty path is exercised.
          throw new Error(
            "Error invoking remote method 'git:removeWorktree': Error: WORKTREE_DIRTY: uncommitted changes would be lost:\n  M src/components/Composer.tsx",
          );
        }

        const t = now();
        const thread: ThreadInfo = {
          ...detail.thread,
          worktreePath: null,
          branch: null,
          updatedAt: t,
        };
        detail.thread = thread;
        clearedDiff.add(input.threadId);
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
      },
    },
    mergeQueue: {
      async claimLane(_input: { threadId: string }) {
        return { n: 1, port: 3001, path: "/tmp/lane-1", branch: "lane/1" };
      },
      async listLanes(_input: { projectId: string }) {
        return [];
      },
      async previewLane(input: { projectId: string; lane: number }) {
        return {
          lane: input.lane,
          sha: "demo",
          files: [],
          path: "/tmp/project",
        };
      },
      async restorePreview(_input: { projectId: string }) {
        return { restored: false };
      },
      async setSpotlight(input: { projectId: string; enabled: boolean }) {
        return { spotlight: input.enabled === true };
      },
      async spotlightLane(input: { projectId: string; lane: number }) {
        return {
          lane: input.lane,
          sha: "demo",
          files: [],
          path: "/tmp/project",
          spotlight: true,
        };
      },
      async recycleWedgedLanes(_input: { projectId: string }) {
        return [];
      },
      async heartbeatLane(_input: { threadId: string; now?: number }) {
        return null;
      },
    },
    speech: {
      async status(): Promise<SpeechStatus> {
        return { state: "missing", runtimeReady: false, modelReady: false };
      },
      async download() {
        throw new Error("Speech is not implemented yet.");
      },
      async start() {
        throw new Error("Speech is not implemented yet.");
      },
      async write() {
        throw new Error("Speech is not implemented yet.");
      },
      async stop() {
        throw new Error("Speech is not implemented yet.");
      },
      async cancel() {
        throw new Error("Speech is not implemented yet.");
      },
    },
    pairing: {
      async list(): Promise<PairingList> {
        return {
          pairings,
          server: { running: true, port: 7422, url: "http://127.0.0.1:7422/mcp" },
        };
      },
      async create(input: PairingCreateInput): Promise<PairingCreated> {
        const pairing: PairingInfo = {
          id: `pair-${pairings.length + 1}`,
          name: String(input.name || "Pairing").trim() || "Pairing",
          tokenPrefix: "devtoken",
          capabilities: input.capabilities ?? ["read", "launch"],
          projectIds: input.projectIds ?? null,
          expiresAt:
            input.ttlMs === 0 || input.ttlMs == null
              ? input.ttlMs === 0
                ? null
                : Date.now() + 30 * 24 * 60 * 60 * 1000
              : Date.now() + input.ttlMs,
          createdAt: Date.now(),
          lastUsedAt: null,
          revokedAt: null,
          requireApproval: input.requireApproval !== false,
          managedWorktree: input.managedWorktree !== false,
          launchesPerHour: input.launchesPerHour ?? 30,
          readsPerMinute: input.readsPerMinute ?? 120,
        };
        pairings = pairings.concat(pairing);
        const token = "d".repeat(64);
        const url = "http://127.0.0.1:7422/mcp";
        const claudeDesktopJson = JSON.stringify(
          {
            mcpServers: {
              solenta: {
                type: "http",
                url,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
          null,
          2,
        );
        return {
          pairing,
          token,
          url,
          claudeDesktopJson,
          pairingPrompt: `Connect to Solenta at ${url}`,
        };
      },
      async revoke(input: { id: string }): Promise<PairingInfo> {
        const existing = pairings.find((p) => p.id === input.id);
        if (!existing) throw new Error(`Unknown pairing: ${input.id}`);
        const revoked = { ...existing, revokedAt: Date.now() };
        pairings = pairings.filter((p) => p.id !== input.id);
        return revoked;
      },
      async approve(input: { threadId: string }) {
        const t = threads.find((row) => row.id === input.threadId);
        if (t) {
          t.pendingExternalApproval = false;
          t.pendingExternalPrompt = null;
        }
        return { runId: "dev-run" };
      },
      async reject(input: { threadId: string }): Promise<ThreadInfo> {
        const t = threads.find((row) => row.id === input.threadId);
        if (!t) throw new Error(`Unknown thread: ${input.threadId}`);
        t.pendingExternalApproval = false;
        t.pendingExternalPrompt = null;
        t.archived = true;
        return t;
      },
    },
    vibeKanban: {
      async preview(): Promise<VibeKanbanPreview> {
        return {
          found: false,
          dataDir: null,
          dbPath: null,
          projects: [],
          taskCount: 0,
          worktreeCount: 0,
          alreadyImported: 0,
        };
      },
      async import(): Promise<VibeKanbanImportResult> {
        return {
          dataDir: null,
          dbPath: null,
          projectsAdded: 0,
          projectsReused: 0,
          threadsCreated: 0,
          threadsSkipped: 0,
          worktreesMapped: 0,
          skipped: [],
        };
      },
      async pickDataDir() {
        return null;
      },
      async export() {
        return null;
      },
    },
    issues: {
      async fetch(input: {
        projectPath: string;
        ref: string;
      }): Promise<FetchIssueResult> {
        const raw = String(input.ref || "").trim();
        const linearUrl = raw.match(
          /^https?:\/\/(?:www\.)?linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i,
        );
        const linearId = raw.match(/^([A-Za-z][A-Za-z0-9]*-\d+)$/);
        const linear = (linearUrl && linearUrl[1]) || (linearId && linearId[1]);
        if (linear) {
          const identifier = linear.toUpperCase();
          const num = Number(identifier.split("-")[1]);
          return {
            ok: true,
            issue: {
              number: num,
              title: `Linear ${identifier}`,
              body: `Dev stand-in for ${raw}`,
              url: `https://linear.app/acme/issue/${identifier}`,
              source: "linear",
              identifier,
            },
          };
        }
        const url = raw.match(/\/issues\/(\d+)/);
        const hashed = raw.match(/#(\d+)$/);
        const bare = /^\d+$/.test(raw) ? raw : "";
        const num = Number((url && url[1]) || (hashed && hashed[1]) || bare);
        if (!Number.isInteger(num) || num <= 0) {
          return { ok: false, reason: "invalid issue reference" };
        }
        const project = projects.find((p) => p.path === input.projectPath);
        const slug = project?.slug || "acme/demo";
        return {
          ok: true,
          issue: {
            number: num,
            title: `Issue #${num}`,
            body: `Dev stand-in for ${raw}`,
            url: `https://github.com/${slug}/issues/${num}`,
          },
        };
      },
      async setPlanStatus(input: {
        projectPath: string;
        number: number;
        status: PlanStatus;
      }): Promise<SetPlanStatusResult> {
        demoPlanStatus.set(input.number, input.status);
        return { ok: true };
      },
      async create(_input: {
        projectPath: string;
        title: string;
        body: string;
      }) {
        return {
          ok: true as const,
          number: 1234,
          url: "https://github.com/dev/fixture/issues/1234",
        };
      },
      async list(projectPath: string): Promise<ListIssuesResult> {
        const project = projects.find((p) => p.path === projectPath);
        const slug = project?.slug || "acme/demo";
        const withPlanStatus = (issues: PlanIssue[]): PlanIssue[] =>
          issues.map((issue) => {
            const moved = demoPlanStatus.get(issue.number);
            if (!moved) return issue;
            return {
              ...issue,
              labels: [
                ...issue.labels.filter((l) => !l.startsWith("plan:")),
                `plan:${moved}`,
              ],
            };
          });
        return {
          ok: true,
          issues: withPlanStatus([
            {
              number: 1,
              title: "Ship the planboard",
              url: `https://github.com/${slug}/issues/1`,
              state: "OPEN",
              labels: ["plan:doing", "roadmap"],
            },
            {
              number: 2,
              title: "Write the docs",
              url: `https://github.com/${slug}/issues/2`,
              state: "OPEN",
              labels: ["plan:todo", "task"],
            },
            {
              number: 3,
              title: "Pick the label convention",
              url: `https://github.com/${slug}/issues/3`,
              state: "CLOSED",
              labels: ["plan:done"],
            },
          ]),
        };
      },
    },
    servers: {
      async list(_input: { threadId: string }): Promise<LocalServerInfo[]> {
        return [];
      },
    },
    simulator: {
      async capabilities() {
        return {
          platform: "darwin",
          supported: false,
          developerDir: "",
          xcode: { version: "0", build: "0" },
          licenseAccepted: false,
          runtimes: [],
          capabilities: {
            deviceLifecycle: false,
            screenshot: false,
            recording: false,
            stream: false,
            touch: false,
            keyboard: false,
            hardwareButtons: false,
            accessibility: false,
          },
        };
      },
      async selectDeveloperDir() {
        return this.capabilities({ threadId: "" });
      },
      async listDevices() {
        return [];
      },
      async status() {
        return {
          attached: false,
          state: null,
          isOwner: false,
          generation: null,
          deviceUdid: null,
          bootedBySolenta: null,
          stream: "disconnected" as const,
          input: "disconnected" as const,
          accessibility: "disconnected" as const,
        };
      },
      async attach() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async detach() {
        return { detached: true as const };
      },
      async takeControl() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async streamInfo() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async retryStream() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async sendInput() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async accessibility() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async scrollTo() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async install() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async launch() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async openUrl() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async screenshot() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async startRecording() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async stopRecording() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
    },
    preview: {
      async bind(_input: { threadId: string; webContentsId: number }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async unbind(_input: { threadId: string; webContentsId?: number }) {
        return { ok: true };
      },
      async navigate(input: { threadId: string; url: string }): Promise<PreviewSnapshot> {
        return {
          url: input.url,
          title: "",
          canGoBack: false,
          canGoForward: false,
        };
      },
      async reload(_input: { threadId: string }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async goBack(_input: { threadId: string }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async goForward(_input: { threadId: string }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async info(_input: { threadId: string }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async screenshot(_input: { threadId: string }) {
        return {
          url: "http://localhost:5173/",
          title: "",
          canGoBack: false,
          canGoForward: false,
          dataUrl: "data:image/png;base64,aaa",
        };
      },
      async click(_input: { threadId: string; selector: string }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async type(_input: {
        threadId: string;
        selector: string;
        text: string;
      }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
    },
    devserver: {
      async scripts(_input: { threadId: string }): Promise<string[]> {
        return ["dev"];
      },
      async start(input: { threadId: string; script: string }): Promise<DevServerState> {
        const existing = demoDevServers.get(input.threadId);
        if (existing?.running) return { ...existing };
        const state: DevServerState = {
          running: true,
          script: input.script,
          url: "http://localhost:5173/",
          startedAt: Date.now(),
          lastLines: ["  Local: http://localhost:5173/"],
        };
        demoDevServers.set(input.threadId, state);
        return { ...state };
      },
      async stop(input: { threadId: string }): Promise<DevServerState> {
        demoDevServers.delete(input.threadId);
        return { running: false };
      },
      async status(input: { threadId: string }): Promise<DevServerState> {
        const state = demoDevServers.get(input.threadId);
        return state ? { ...state } : { running: false };
      },
    },
    terminal: {
      async open(input: { threadId: string }): Promise<TerminalState> {
        demoTerminals.set(
          input.threadId,
          "Demo shell. Electron runs a real one.\n",
        );
        return demoTerminal(input.threadId, null);
      },
      async write(input: {
        threadId: string;
        data: string;
        since?: number;
      }): Promise<TerminalState> {
        const prev = demoTerminals.get(input.threadId) ?? "";
        demoTerminals.set(
          input.threadId,
          `${prev}$ ${input.data}\n[demo: nothing runs in the browser]\n`,
        );
        return demoTerminal(input.threadId, input.since);
      },
      async read(input: {
        threadId: string;
        since?: number;
      }): Promise<TerminalState> {
        return demoTerminal(input.threadId, input.since);
      },
      async close(input: { threadId: string }): Promise<TerminalState> {
        demoTerminals.delete(input.threadId);
        return demoTerminal(input.threadId, null);
      },
    },
    files: {
      async list(input: { threadId: string; query?: string; limit?: number }) {
        const q = (input.query ?? "").toLowerCase();
        const all = [
          "src/App.tsx",
          "src/components/ThreadView.tsx",
          "src/components/Composer.tsx",
          "src/useCoder.ts",
          "electron/main.js",
          "README.md",
          "package.json",
        ];
        const cap = Math.min(Math.max(Number(input.limit) || 20, 1), 80);
        return {
          files: all
            .filter((f) => !q || f.toLowerCase().includes(q))
            .slice(0, cap),
        };
      },
      async search(input: { threadId: string; query: string }) {
        const q = (input.query ?? "").toLowerCase();
        if (!q) return { hits: [] };
        const hits = [
          {
            path: "src/App.tsx",
            line: 12,
            text: "export function App() {",
          },
          {
            path: "README.md",
            line: 1,
            text: "# Solenta",
          },
        ].filter(
          (h) =>
            h.path.toLowerCase().includes(q) ||
            h.text.toLowerCase().includes(q),
        );
        return { hits };
      },
      async image(_input: { name: string }) {
        return { dataUrl: null };
      },
      async resolve(input: { threadId: string; paths: string[] }) {
        const known = new Set([
          "src/App.tsx",
          "src/components/ThreadView.tsx",
          "src/components/Composer.tsx",
          "src/useCoder.ts",
          "electron/main.js",
          "README.md",
          "package.json",
        ]);
        return {
          resolved: input.paths.map((p) => ({
            path: p,
            abs: known.has(p) ? `/Users/demo/project/${p}` : null,
          })),
        };
      },
    },
    fs: {
      async browse(input: { path: string; environment?: string | null }) {
        const parent = input.path?.trim() || "~/";
        return {
          parentPath: parent.endsWith("/") ? parent : `${parent}/`,
          existed: true,
          entries: [
            { name: "Code", fullPath: "/Users/demo/Code" },
            { name: "Projects", fullPath: "/Users/demo/Projects" },
          ],
        };
      },
    },
    attachments: {
      async pick() {
        // Dev mock: no native dialog in a browser.
        return { attachments: [] };
      },
      async fromPaths(_input: { paths: string[] }) {
        return { attachments: [] };
      },
      async saveImage(_input: { threadId: string; dataUrl: string }) {
        return { attachment: null };
      },
      async saveFile(_input: {
        threadId: string;
        name: string;
        dataUrl: string;
      }) {
        return { attachment: null };
      },
      async saveFolder(_input: {
        threadId: string;
        name: string;
        files: Array<{ relativePath: string; dataUrl: string }>;
      }) {
        return { attachment: null };
      },
      async readImage(_input: { path: string }) {
        return { dataUrl: null };
      },
      async listWindows() {
        return { windows: [] };
      },
      async captureWindow(_input: { threadId: string; sourceId: string }) {
        return { attachment: null };
      },
    },
    shell: {
      async reveal(_input: { threadId: string; path: string }) {
        // Dev mock: no Finder.
      },
      async openPath(_input: { threadId: string; path: string }) {
        // Dev mock: no editor.
      },
      async editors() {
        return [
          { id: "cursor" as const, name: "Cursor" },
          { id: "vscode" as const, name: "VS Code" },
          { id: "finder" as const, name: "Finder" },
        ];
      },
      async openIn(_input: { threadId: string; path: string; editor: string }) {
        // Dev mock: no editor.
      },
    },
    on(channel, cb) {
      if (channel === "threads:changed") {
        const fn = cb as (threads: ThreadInfo[]) => void;
        listeners["threads:changed"].add(fn);
        return () => {
          listeners["threads:changed"].delete(fn);
        };
      }
      if (channel === "thread:select") {
        return () => {};
      }
      if (channel === "boot:ready") {
        const fn = cb as () => void;
        listeners["boot:ready"].add(fn);
        return () => {
          listeners["boot:ready"].delete(fn);
        };
      }
      if (channel === "speech:changed") {
        const fn = cb as (status: SpeechStatus) => void;
        listeners["speech:changed"].add(fn);
        return () => {
          listeners["speech:changed"].delete(fn);
        };
      }
      const fn = cb as (detail: ThreadDetail) => void;
      listeners["thread:updated"].add(fn);
      return () => {
        listeners["thread:updated"].delete(fn);
      };
    },
  };

  return api;
}

export const devCoder: CoderApi = buildDevCoder();
