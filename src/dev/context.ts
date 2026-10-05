/**
 * State and helpers buildDevCoder (src/devCoder.ts) shares with the domain
 * modules under src/dev/ for the browser-dev fixture. Each `create<Domain>(ctx)`
 * owns its private state; anything two domains touch lives here. Reassigned
 * values are get/set accessors over buildDevCoder's own `let`s, so read them
 * as `ctx.threads` at call time, never destructure them.
 */
import type {
  CheckpointInfo,
  CoderApi,
  McpServerInfo,
  PrInfo,
  ProjectInfo,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "../shared/ipc";
import type { MemoryRow } from "./memory.ts";
import type { RunState } from "./runs.ts";

export type DevCtx = {
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  templates: WorkflowTemplateInfo[];
  memoryEntries: MemoryRow[];
  spendTodayUsd: number;
  dailyBudgetUsd: number | null;
  mcpServers: McpServerInfo[];
  quotaWaitAutoResume: boolean;
  details: Map<string, ThreadDetail>;
  rewindRestore: Map<
    string,
    { messages: ThreadDetail["messages"]; workLog: ThreadDetail["workLog"]; thread: ThreadInfo }
  >;
  runTimers: Map<string, ReturnType<typeof setInterval>>;
  runStates: Map<string, RunState>;
  clearedDiff: Set<string>;
  prByThread: Map<string, PrInfo>;
  checkpointsByThread: Map<string, CheckpointInfo[]>;
  emitThreads: () => void;
  emitDetail: (detail: ThreadDetail) => void;
  syncThreadRow: (thread: ThreadInfo) => void;
  patchThread: (threadId: string, patch: Partial<ThreadInfo>) => ThreadInfo;
  newThread: (over?: Partial<ThreadInfo>) => ThreadInfo;
  registerThread: (t: ThreadInfo) => ThreadInfo;
  fakeWorktree: (thread: ThreadInfo) => Partial<ThreadInfo>;
  clearRunTimer: (threadId: string) => void;
  isSimulate: (thread: ThreadInfo) => boolean;
  settleRunSpend: (detail: ThreadDetail, run: RunState | undefined) => void;
  assertUnderBudget: () => void;
  startRunTimer: (threadId: string) => void;
  appendDevCheckpoint: (thread: ThreadInfo) => void;
  /** The assembled api, for cross-namespace calls. Only call it lazily. */
  api: () => CoderApi;
};
