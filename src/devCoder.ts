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
  CloneProgressPush,
  AppStatus,
  UpdateStatus,
  CheckpointInfo,
  CoderApi,
  McpServerInfo,
  PrInfo,
  SpeechStatus,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "./shared/ipc";
import { mockData } from "./mockData.ts";
import { createAutomations } from "./dev/automations.ts";
import type { DevCore, DevCtx } from "./dev/context.ts";
import { createGit } from "./dev/git.ts";
import { createSourceControl, createIssues } from "./dev/issues.ts";
import { createMcp } from "./dev/mcp.ts";
import type { MemoryRow } from "./dev/memory.ts";
import { seedMemoryEntries, createMemory } from "./dev/memory.ts";
import { createProjects, devCloneProgress } from "./dev/projects.ts";
import type { RunState } from "./dev/runs.ts";
import { createRunEngine, createRuns } from "./dev/runs.ts";
import {
  DEV_PROVIDERS,
  seedProjects,
  seedThreads,
  seedDetail,
} from "./dev/seed.ts";
import { createSettings, createPairing, createWeb } from "./dev/settings.ts";
import { createSkills } from "./dev/skills.ts";
import { createThreads } from "./dev/threads.ts";
import { createUsage } from "./dev/usage.ts";
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
import { createWorkspace } from "./dev/workspace.ts";
export { DEV_MCP_CATALOG, devMcpCatalogRows } from "./dev/mcp.ts";
export type { DevMcpCatalogEntry } from "./dev/mcp.ts";

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
  /** User-defined + builtin workflow templates (in-memory). */
  let templates: WorkflowTemplateInfo[] = [cloneTemplate(STANDARD_TEMPLATE)];
  /** Aggregated cost of finished fake runs this session (stands in for "today"). */
  let spendTodayUsd = 0;
  let dailyBudgetUsd: number | null = null;
  /** User MCP servers (Skills tab), in-memory. */
  let mcpServers: McpServerInfo[] = [];
  let quotaWaitAutoResume = true;
  /** Shared-memory stub (always running in dev). */
  let memoryEntries: MemoryRow[] = seedMemoryEntries(now());
  /** Live PR state keyed by thread id (state can change after create). */
  const prByThread = new Map<string, PrInfo>();

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
      branch: thread.branch ?? `${project?.branchPrefix ?? "coder/"}${slug}-${thread.id.slice(0, 6)}`,
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
    ...createSourceControl(),
    ...createWorkflows(ctx),
    ...createAutomations(ctx),
    ...createProjects(ctx),
    ...createThreads(ctx),
    ...createRuns(ctx),
    ...createUsage(ctx),
    ...createGit(ctx),
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
    ...createPairing(ctx),
    ...createWeb(),
    ...createIssues(ctx),
    ...createWorkspace(),
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
      if (channel === "clone:progress") {
        const fn = cb as (push: CloneProgressPush) => void;
        devCloneProgress.add(fn);
        return () => {
          devCloneProgress.delete(fn);
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

export const devCoder: CoderApi = /* @__PURE__ */ buildDevCoder();
