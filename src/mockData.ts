export type ThreadStatus = "working" | "done" | "idle";

export interface ThreadCard {
  id: string;
  repoSlug: string;
  age: string;
  title: string;
  branch: string;
  prNumber: number | null;
  status: ThreadStatus;
  workingLabel?: string;
}

export interface WorkLogStep {
  id: string;
  label: string;
  done: boolean;
}

export interface WorkLog {
  title: string;
  steps: WorkLogStep[];
  duration: string;
  collapsedByDefault?: boolean;
}

export interface SubagentKickoffRow {
  phase: string;
  agents: string;
  description: string;
}

export interface SubagentKickoffEvent {
  title: string;
  rows: SubagentKickoffRow[];
}

export interface AssistantMessage {
  id: string;
  paragraphs: string[];
}

export interface BackgroundStatus {
  label: string;
  canStop: boolean;
}

export interface ComposerConfig {
  placeholder: string;
  model: string;
  effort: string;
  access: string;
  mode: string;
  sessionId: string;
  worktreeLabel: string;
  branch: string;
}

export type PhaseStatus = "done" | "active" | "pending";

export interface WorkflowPhase {
  id: string;
  name: string;
  status: PhaseStatus;
}

export type AgentDotStatus = "active" | "done" | "pending" | "error";

export interface AgentRow {
  id: string;
  label: string;
  model: string;
  status: AgentDotStatus;
}

export interface PhaseGroup {
  id: string;
  name: string;
  activeCount: number;
  doneCount: number;
  agents: AgentRow[];
  expandedByDefault?: boolean;
}

export interface AgentsWorkflow {
  name: string;
  settledLabel: string;
  phases: WorkflowPhase[];
  groups: PhaseGroup[];
  footerWorking: string;
  footerSettled: string;
  tokenSum: string;
}

export interface ThreadViewData {
  project: string;
  title: string;
  workLog: WorkLog;
  kickoff: SubagentKickoffEvent;
  messages: AssistantMessage[];
  backgroundStatus: BackgroundStatus;
  composer: ComposerConfig;
}

export interface AppMockData {
  appName: string;
  searchPlaceholder: string;
  projectsHeader: string;
  threads: ThreadCard[];
  activeThreadId: string;
  threadView: ThreadViewData;
  agents: AgentsWorkflow;
}

export const mockData: AppMockData = {
  appName: "Solenta",
  searchPlaceholder: "Search threads…",
  projectsHeader: "All projects",
  activeThreadId: "thread-1",
  threads: [
    {
      id: "thread-1",
      repoSlug: "acme/nebula",
      age: "3h",
      title: "Modernize Per-Device Provider Settings",
      branch: "feat/provider-settings",
      prNumber: 842,
      status: "working",
      workingLabel: "Working 2m",
    },
    {
      id: "thread-2",
      repoSlug: "acme/nebula",
      age: "5h",
      title: "Fix worktree path resolution on Windows",
      branch: "fix/win-worktree",
      prNumber: 839,
      status: "done",
    },
    {
      id: "thread-3",
      repoSlug: "acme/ledger",
      age: "1d",
      title: "Add INTEGER-SAFARI workflow runner",
      branch: "feat/integer-safari",
      prNumber: 112,
      status: "working",
      workingLabel: "Working 12m",
    },
    {
      id: "thread-4",
      repoSlug: "acme/ledger",
      age: "2d",
      title: "Tighten CSP for Electron preload",
      branch: "chore/csp",
      prNumber: null,
      status: "idle",
    },
    {
      id: "thread-5",
      repoSlug: "acme/pulse",
      age: "3d",
      title: "Scaffold three-pane desktop shell",
      branch: "agentmux/8d11e8a0",
      prNumber: null,
      status: "done",
    },
  ],
  threadView: {
    project: "acme/nebula",
    title: "Modernize Per-Device Provider Settings",
    workLog: {
      title: "Work Log",
      duration: "Worked for 1m 45s",
      collapsedByDefault: false,
      steps: [
        { id: "s1", label: "Inspected provider settings surface", done: true },
        { id: "s2", label: "Mapped per-device storage keys", done: true },
        { id: "s3", label: "Drafted migration for existing prefs", done: true },
        { id: "s4", label: "Opened worktree for agent fan-out", done: true },
      ],
    },
    kickoff: {
      title: "Kicked off 5 subagents",
      rows: [
        {
          phase: "Analyze",
          agents: "4",
          description: "Explore settings UI, storage, and migration paths",
        },
        {
          phase: "Verify",
          agents: "1",
          description: "Cross-check types and edge cases for device keys",
        },
      ],
    },
    messages: [
      {
        id: "m1",
        paragraphs: [
          "I mapped the per-device provider settings path and found three storage layouts still mixed between local and synced prefs.",
          "Spinning up analyze agents to cover the settings panel, the migration helper, and the device key resolver in parallel.",
        ],
      },
      {
        id: "m2",
        paragraphs: [
          "Once analyze settles, verify will re-run type checks and a small fixture set against the proposed key schema before we synthesize a single patch.",
        ],
      },
    ],
    backgroundStatus: {
      label: "5 agents working in the background",
      canStop: true,
    },
    composer: {
      placeholder:
        "Ask anything, @tag files/folders, $use skills, or / for commands",
      model: "Claude Opus 5",
      effort: "High · 1M",
      access: "Full access",
      mode: "Build",
      sessionId: "bb-1",
      worktreeLabel: "Worktree",
      branch: "feat/provider-settings",
    },
  },
  agents: {
    name: "INTEGER-SAFARI",
    settledLabel: "1/5 settled",
    phases: [
      { id: "seed", name: "Seed", status: "done" },
      { id: "analyze", name: "Analyze", status: "active" },
      { id: "verify", name: "Verify", status: "pending" },
      { id: "judge", name: "Judge", status: "pending" },
      { id: "synthesize", name: "Synthesize", status: "pending" },
    ],
    groups: [
      {
        id: "analyze",
        name: "ANALYZE",
        activeCount: 4,
        doneCount: 0,
        expandedByDefault: true,
        agents: [
          {
            id: "a1",
            label: "analyze:9240",
            model: "sonnet-5",
            status: "active",
          },
          {
            id: "a2",
            label: "analyze:9241",
            model: "sonnet-5",
            status: "active",
          },
          {
            id: "a3",
            label: "analyze:9242",
            model: "sonnet-5",
            status: "active",
          },
          {
            id: "a4",
            label: "analyze:9243",
            model: "haiku-5",
            status: "active",
          },
        ],
      },
      {
        id: "seed",
        name: "SEED",
        activeCount: 0,
        doneCount: 1,
        expandedByDefault: false,
        agents: [
          {
            id: "a0",
            label: "seed:9100",
            model: "sonnet-5",
            status: "done",
          },
        ],
      },
    ],
    footerWorking: "5 working",
    footerSettled: "1 settled",
    tokenSum: "Σ 52.0k tok",
  },
};
