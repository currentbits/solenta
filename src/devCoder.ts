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
  AgentView,
  AppSettings,
  AppStatus,
  AttachmentInfo,
  AutomationInfo,
  UpdateStatus,
  AutomationWrite,
  ChatMessage,
  CheckpointInfo,
  CoderApi,
  RunStatInfo,
  ConflictForecast,
  VerifyResult,
  CommandRunResult,
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
  LocalServerInfo,
  MemoryEntryInfo,
  MemoryMaintenanceReport,
  MemoryReviewResolution,
  AgentConfigDoctorReport,
  AgentConfigPreview,
  AgentConfigWriteResult,
  ProjectCodeMap,
  AgentProfile,
  McpCatalogEntry,
  McpImportPreview,
  McpInstallRequest,
  McpInstallResult,
  McpPreviewImportInput,
  McpServerDefinition,
  McpServerInfo,
  McpServerSaveInput,
  SubagentPool,
  OtelSettings,
  WebhookSettings,
  PermissionMode,
  PlanIssue,
  PlanStatus,
  SetPlanStatusResult,
  PrCheckInfo,
  PrInfo,
  ProjectInfo,
  ProviderInfo,
  SourceControlDiscovery,
  ReasoningEffort,
  SessionUsage,
  CliSlashCommand,
  SkillCatalogEntry,
  SkillImportPreview,
  SkillInstallRequest,
  SkillInstallResult,
  SkillPluginExtra,
  SkillPluginInstallResult,
  SkillInfo,
  SkillPreviewImportInput,
  SkillTarget,
  SkillWrite,
  SpaceInfo,
  SpecArtifact,
  ThreadDetail,
  ThreadInfo,
  CrewTaskView,
  DigestResult,
  UsageEntry,
  UsageReport,
  UsageThreadEntry,
  WorkLogItem,
  WorkflowPhaseSpec,
  WorkflowTemplateInfo,
  WorkflowView,
  VibeKanbanPreview,
  VibeKanbanImportResult,
} from "./shared/ipc";
import { SPEC_ARTIFACTS, SPEC_DIR } from "./shared/ipc";
import { buildActivity } from "./activity.ts";
import { mockData } from "./mockData.ts";
import {
  mergeMcpSettingsPatch,
  parseMcpConfigDocument,
  redactMcpServer,
  redactMcpServers,
  redactSettings,
  upsertMcpServer,
  validateMcpServers,
} from "./shared/mcpModel.ts";

/** Stand-in artifact bodies for the browser twin (issue #269). */
const DEV_SPEC_ARTIFACTS: Record<SpecArtifact, string> = {
  requirements:
    "1. WHEN spec mode is on THE SYSTEM SHALL gate each stage on a human approval.\n" +
    "2. WHEN an artifact is submitted THE SYSTEM SHALL stop the thread until it is reviewed.\n\n" +
    "Out of scope: none — tasks.md is a checkbox DAG (needs: <id>) dispatched in waves.",
  design:
    "Thread carries `spec { slug, stage, awaitingApproval }`; artifacts live in\n" +
    "`.solenta/specs/<slug>/` so they diff like code.",
  tasks:
    "- [ ] services: stage machine + standing note\n" +
    "- [ ] runner: append the note to every dispatched prompt\n" +
    "- [ ] UI: spec card with Approve / Request changes",
};

const MEMORY_EXCERPT_LEN = 160;
const MEMORY_NOT_FOUND = "Memory entry not found";

/**
 * Browser-twin mirror of the main-process curated catalog
 * (electron/mcpCatalog.js). Keep ids/definitions in sync with it.
 */
export interface DevMcpCatalogEntry {
  id: string;
  name: string;
  description: string;
  publisher: string;
  homepage: string;
  sourceUrl: string;
  transport: "http" | "sse" | "stdio";
  risk: string;
  definition: Record<string, unknown>;
}

export const DEV_MCP_CATALOG: readonly DevMcpCatalogEntry[] = [
  {
    id: "context7",
    name: "Context7",
    description:
      "Up-to-date library documentation and code examples for LLMs over a remote MCP endpoint.",
    publisher: "Upstash",
    homepage: "https://context7.com",
    sourceUrl: "https://context7.com",
    transport: "http",
    risk: "Remote HTTP endpoint. Review the vendor before sending repository context.",
    definition: {
      name: "context7",
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      enabled: true,
    },
  },
  {
    id: "linear",
    name: "Linear",
    description:
      "Linear issue tracking and project management over a remote MCP endpoint.",
    publisher: "Linear",
    homepage: "https://linear.app",
    sourceUrl: "https://linear.app",
    transport: "http",
    risk: "Remote HTTP with OAuth. No static secret is stored; complete Linear's OAuth flow.",
    definition: {
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      enabled: true,
    },
  },
  {
    id: "playwright",
    name: "Playwright",
    description:
      "Browser automation via the Playwright MCP server. Runs a local npx command.",
    publisher: "Microsoft",
    homepage: "https://playwright.dev",
    sourceUrl: "https://playwright.dev",
    transport: "stdio",
    risk: "Local stdio via npx. Explicit trust is required before the command can run.",
    definition: {
      name: "playwright",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      enabled: false,
      trusted: false,
    },
  },
];

/** Public catalog rows with `installed` derived from the curated servers. */
export function devMcpCatalogRows(
  servers: ReadonlyArray<{ provenance?: string; catalogId?: string }>,
): McpCatalogEntry[] {
  const installedIds = new Set(
    servers
      .filter((s) => s.provenance === "curated" && s.catalogId)
      .map((s) => s.catalogId as string),
  );
  return DEV_MCP_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    publisher: entry.publisher,
    sourceUrl: entry.sourceUrl,
    homepage: entry.homepage,
    transport: entry.transport,
    risk: entry.risk,
    requiredSecrets: [],
    installed: installedIds.has(entry.id),
  }));
}

/** Full in-memory store rows; list/search return excerpts. */
interface MemoryRow {
  id: string;
  type: MemoryEntryInfo["type"];
  title: string;
  body: string;
  project: string | null;
  importance: number;
  createdAt: string;
  updatedAt: string;
  citations?: MemoryEntryInfo["citations"];
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function excerptBody(body: string): string {
  if (body.length <= MEMORY_EXCERPT_LEN) return body;
  return `${body.slice(0, MEMORY_EXCERPT_LEN - 1)}…`;
}

function toListEntry(row: MemoryRow): MemoryEntryInfo {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: excerptBody(row.body),
    project: row.project,
    importance: row.importance,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    citations: row.citations,
  };
}

function toFullEntry(row: MemoryRow): MemoryEntryInfo {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    project: row.project,
    importance: row.importance,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    citations: row.citations,
  };
}

// Memory rows are scoped by the project PATH the Memory tab sends, so the demo
// entries have to carry the demo project paths, not slugs.
const DEMO_NEBULA = "/Users/demo/acme/nebula";
const DEMO_LEDGER = "/Users/demo/acme/ledger";

function seedMemoryEntries(t0: number): MemoryRow[] {
  const hours = (h: number) => toIso(t0 - h * 60 * 60 * 1000);
  return [
    {
      id: "mem-seed-1",
      type: "strategy",
      title: "Rewriting auth was ruled out. Cookie sessions stay",
      body: "Thread 1 costed a move to token auth and dropped it. Refresh lives in src/lib/auth.ts and the 401 retry in src/lib/api.ts. Do not re-open the rewrite without new evidence.",
      project: DEMO_NEBULA,
      importance: 5,
      createdAt: hours(48),
      updatedAt: hours(6),
    },
    {
      id: "mem-seed-2",
      type: "knowledge",
      title: "Per-device overrides read from the settings store, not the env",
      body: "src/settings/store.ts is the single source for per-device overrides. The env reader was a migration shim and is gone. Anything reading process.env for a device key is stale.",
      project: DEMO_NEBULA,
      importance: 4,
      createdAt: hours(36),
      updatedAt: hours(12),
    },
    {
      id: "mem-seed-3",
      type: "knowledge",
      title: "Windows worktree paths need the UNC form",
      body: "A WSL path handed to git on the Windows side resolves relative to the wrong root. Convert to \\\\wsl$\\ before spawning. Found while fixing #839.",
      project: DEMO_NEBULA,
      importance: 4,
      createdAt: hours(72),
      updatedAt: hours(24),
    },
    {
      id: "mem-seed-4",
      type: "convention",
      title: "Every state write after an await re-checks the thread id",
      body: "Applying a result to state after an await must confirm the selected thread still matches the id captured before the call, or a slow response lands in the wrong thread.",
      project: null,
      importance: 5,
      createdAt: hours(20),
      updatedAt: hours(2),
    },
    {
      id: "mem-seed-5",
      type: "strategy",
      title: "Dirty merge: stash by path, merge, pop",
      body: "When merging a worktree into a dirty checkout, do not commit the WIP. Stash by path, merge, then pop. Untracked files trip the dirty guard too.",
      project: null,
      importance: 4,
      createdAt: hours(8),
      updatedAt: hours(3),
    },
    {
      id: "mem-seed-6",
      type: "knowledge",
      title: "The CSP change belongs in the preload, not the page",
      body: "Meta-tag CSP is ignored once the response header is set. Ship the policy from the main process response header and keep the preload surface typed.",
      project: DEMO_LEDGER,
      importance: 3,
      createdAt: hours(10),
      updatedAt: hours(8),
    },
    {
      id: "mem-seed-7",
      type: "task",
      title: "Backfill the migration test before the schema lands",
      body: "The key-schema patch needs a fixture that runs the old rows through the migration. Blocked until the store move in #842 merges.",
      project: DEMO_NEBULA,
      importance: 3,
      createdAt: hours(4),
      updatedAt: hours(1),
    },
  ];
}

const TRAILER = import.meta.env?.VITE_TRAILER === "1";
const TRAILER_PROVIDERS = [
  "claude",
  "codex",
  "kimi",
  "grok",
  "opencode",
] as const;

/**
 * Fixture providers for the browser demo. NOT a copy of
 * electron/providers.js — `npm run dev` runs the real registry, so this only
 * has to make the picker look populated.
 */
function devProvider(
  id: string,
  name: string,
  models: string[],
  available = true,
): ProviderInfo {
  return {
    id,
    name,
    available,
    supportsResume: true,
    models,
    modelInfo: models.map((m, i) => ({
      id: m,
      label: m,
      description: `${name} model`,
      vendor: name,
      recommended: i === 0,
    })),
    efforts: ["low", "medium", "high"],
    permissionModes: [
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ],
  };
}

const DEV_PROVIDERS: ProviderInfo[] = [
  devProvider("claude", "Claude Code", ["claude-opus-5", "claude-sonnet-5"]),
  {
    ...devProvider("codex", "Codex", ["gpt-5.3-codex", "gpt-5.3"]),
    supportsSearch: true,
  },
  {
    ...devProvider("kimi", "Kimi", ["kimi-k3-thinking"]),
    permissionModes: ["bypassPermissions"],
  },
  {
    ...devProvider("grok", "Grok", ["grok-4.6"], TRAILER),
    permissionModes: ["plan", "bypassPermissions"],
  },
  {
    ...devProvider("opencode", "OpenCode", ["opencode/grok-code"]),
    permissionModes: ["default", "bypassPermissions"],
  },
];

/** Builtin Standard template (id "standard"). Seeded into every dev session. */
const STANDARD_TEMPLATE: WorkflowTemplateInfo = {
  id: "standard",
  name: "Standard",
  builtin: true,
  phases: [
    {
      name: "seed",
      agentCount: 1,
      instruction: "Plan context from the prompt",
      provider: "claude",
      model: null,
    },
    {
      name: "analyze",
      agentCount: 2,
      instruction: "Concurrent exploration",
      provider: "claude",
      model: null,
    },
    {
      name: "synthesize",
      agentCount: 1,
      instruction: "Final answer",
      provider: "claude",
      model: null,
    },
  ],
};

const TICK_MS = TRAILER ? 1600 : 700;
const TITLE_MAX = 60;
const WORKTREE_DELAY_MS = 450;
const PUSH_DELAY_MS = 350;
const SETTINGS_BUDGET_ERROR =
  "Daily budget must be a positive number or null";
const SETTINGS_ORCH_BUDGET_ERROR =
  "Orchestration budget must be a positive number or null";

function formatUsd(n: number): string {
  return n.toFixed(2);
}

function dailyBudgetReachedMessage(spent: number, budget: number): string {
  return `Daily budget reached ($${formatUsd(spent)} of $${formatUsd(budget)}). Raise or clear the cap in Settings.`;
}

type TemplateSaveInput = Omit<WorkflowTemplateInfo, "id" | "builtin"> & {
  id?: string;
};

function cloneTemplate(t: WorkflowTemplateInfo): WorkflowTemplateInfo {
  return {
    id: t.id,
    name: t.name,
    builtin: t.builtin,
    phases: t.phases.map((p) => ({ ...p })),
  };
}

/** Shape-only. electron/services.js validateWorkflowTemplate owns the rules. */
function normalizeTemplate(input: TemplateSaveInput): {
  name: string;
  phases: WorkflowPhaseSpec[];
} {
  return {
    name: String(input.name ?? "").trim() || "Untitled",
    phases: (input.phases ?? []).map((p) => ({
      name: String(p?.name ?? "").trim() || "Phase",
      agentCount: Number(p?.agentCount) || 1,
      instruction: String(p?.instruction ?? "").trim(),
      provider: String(p?.provider ?? "claude"),
      model: p?.model || null,
    })),
  };
}

type ListenerMap = {
  "threads:changed": Set<(threads: ThreadInfo[]) => void>;
  "thread:updated": Set<(detail: ThreadDetail) => void>;
  "boot:ready": Set<() => void>;
};

/** Browser-dev fixture for the Agents-tab crew list (issue #277). */
const SEED_CREW_NOW = Date.now();
const SEED_CREW_TASKS: CrewTaskView[] = [
  {
    id: "t1",
    title: "Write the API contract",
    needs: [],
    status: "done",
    owner: null,
    note: "main:docs/contract.md",
    attempts: [{ threadId: "thread-1", at: SEED_CREW_NOW - 90_000 }],
    createdAt: SEED_CREW_NOW - 180_000,
    updatedAt: SEED_CREW_NOW - 90_000,
    blocked: false,
  },
  {
    id: "t2",
    title: "Build the settings form",
    needs: ["t1"],
    status: "claimed",
    owner: "thread-1",
    note: "",
    attempts: [
      { threadId: "thread-2", at: SEED_CREW_NOW - 80_000, outcome: "types drifted" },
      { threadId: "thread-1", at: SEED_CREW_NOW - 20_000 },
    ],
    createdAt: SEED_CREW_NOW - 170_000,
    updatedAt: SEED_CREW_NOW - 20_000,
    blocked: false,
  },
  {
    id: "t3",
    title: "Wire the renderer",
    needs: ["t2"],
    status: "open",
    owner: null,
    note: "",
    attempts: [],
    createdAt: SEED_CREW_NOW - 160_000,
    updatedAt: SEED_CREW_NOW - 160_000,
    blocked: true,
  },
];

/** Per-thread run simulation bookkeeping. */
type RunState = {
  runId: string;
  /** Phases that already have a work-log item (started). */
  announced: Set<string>;
  /** Phases whose work-log item was flipped to done. */
  settled: Set<string>;
  /** Streaming assistant message id for this run (created on first tick). */
  assistantMsgId: string | null;
  /** Session-style run step index (tool/text sequence). */
  sessionStep: number;
  /**
   * session: single-provider turn (runs.start)
   * simulate: mock multi-agent tick for provider === "simulate"
   * workflow: Build orchestration (runs.startWorkflow, template-driven)
   */
  kind: "session" | "simulate" | "workflow";
  /** Index of the currently running phase (startWorkflow only). */
  workflowStep: number;
  /** Phase instructions for dossier text (startWorkflow only). */
  phaseInstructions?: string[];
  /** usage.costUsd at run start; delta is billed to spendTodayUsd on end. */
  costBaseline: number;
};

function now() {
  return Date.now();
}

function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function nextAutomationFire(
  preset: AutomationInfo["preset"],
  hour: number | null,
  fromMs: number,
): number {
  const from = new Date(fromMs);
  if (preset === "hourly") {
    const next = new Date(from);
    next.setMinutes(0, 0, 0);
    if (next.getTime() <= fromMs) next.setHours(next.getHours() + 1);
    return next.getTime();
  }
  const h = hour ?? 0;
  const next = new Date(from);
  next.setHours(h, 0, 0, 0);
  if (next.getTime() <= fromMs) {
    next.setDate(next.getDate() + (preset === "weekly" ? 7 : 1));
  }
  return next.getTime();
}

function normalizeDevAutomation(
  input: Partial<AutomationWrite>,
  projectList: ProjectInfo[],
  existing: AutomationInfo | null,
): Omit<AutomationInfo, "id" | "lastRunAt" | "nextRunAt" | "lastError"> {
  const name = String(
    (Object.prototype.hasOwnProperty.call(input, "name")
      ? input.name
      : existing?.name) ?? "",
  ).trim();
  if (!name) throw new Error("Automation name is required");
  const projectId = String(
    (Object.prototype.hasOwnProperty.call(input, "projectId")
      ? input.projectId
      : existing?.projectId) ?? "",
  );
  if (!projectId || !projectList.some((p) => p.id === projectId)) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  const prompt = String(
    (Object.prototype.hasOwnProperty.call(input, "prompt")
      ? input.prompt
      : existing?.prompt) ?? "",
  );
  if (!prompt.trim()) throw new Error("Prompt is required");
  const provider = String(
    (Object.prototype.hasOwnProperty.call(input, "provider")
      ? input.provider
      : existing?.provider) ?? "",
  );
  if (!provider) throw new Error("Provider is required");
  const model = Object.prototype.hasOwnProperty.call(input, "model")
    ? (input.model ?? null)
    : (existing?.model ?? null);
  const preset = (Object.prototype.hasOwnProperty.call(input, "preset")
    ? input.preset
    : existing?.preset) as AutomationInfo["preset"] | undefined;
  if (preset !== "hourly" && preset !== "daily" && preset !== "weekly") {
    throw new Error("Invalid preset");
  }
  let hour: number | null = null;
  if (preset !== "hourly") {
    const raw = Object.prototype.hasOwnProperty.call(input, "hour")
      ? input.hour
      : existing?.hour;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      throw new Error("Hour must be an integer from 0 to 23");
    }
    hour = n;
  }
  const enabled = Object.prototype.hasOwnProperty.call(input, "enabled")
    ? Boolean(input.enabled)
    : existing
      ? existing.enabled
      : true;
  return { name, projectId, prompt, provider, model, preset, hour, enabled };
}

function ageToMs(age: string): number {
  const m = /^(\d+)([mhd])$/.exec(age);
  if (!m) return 3 * 60 * 60 * 1000;
  const n = Number(m[1]);
  if (m[2] === "m") return n * 60 * 1000;
  if (m[2] === "h") return n * 60 * 60 * 1000;
  return n * 24 * 60 * 60 * 1000;
}

function workingMinutes(label?: string): number {
  if (!label) return 2;
  const m = /(\d+)\s*m/.exec(label);
  return m ? Number(m[1]) : 2;
}

function capitalize(name: string): string {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function seedProjects(): ProjectInfo[] {
  const slugs = [...new Set(mockData.threads.map((t) => t.repoSlug))];
  return slugs.map((slug, i) => {
    const name = slug.includes("/") ? (slug.split("/").pop() ?? slug) : slug;
    return {
      id: `proj-${i + 1}`,
      slug,
      name,
      path: `/Users/demo/${slug}`,
    };
  });
}

function seedThreads(projects: ProjectInfo[]): ThreadInfo[] {
  const bySlug = new Map(projects.map((p) => [p.slug, p]));
  const t0 = now();
  return mockData.threads.map((card, index) => {
    const project = bySlug.get(card.repoSlug)!;
    const ageMs = ageToMs(card.age);
    const workingMs = workingMinutes(card.workingLabel) * 60 * 1000;
    const updatedAt =
      card.status === "working" ? t0 - workingMs : t0 - ageMs;
    const isSimulate = card.id === mockData.activeThreadId;
    const createdAt = t0 - ageMs - 60 * 60 * 1000;
    // Most seeds look visited (lastVisitedAt >= updatedAt). ONE non-active
    // thread is genuinely unread so dev mode demos the sidebar indicator.
    const unreadDemo = card.id === "thread-2";
    // Round 44: one pinned + one snoozed (~tomorrow) so partition demos.
    const pinDemo = !TRAILER && card.id === "thread-4";
    const snoozeDemo = !TRAILER && card.id === "thread-5";
    const dayMs = 24 * 60 * 60 * 1000;
    return {
      id: card.id,
      projectId: project.id,
      title: card.title,
      branch: card.branch,
      prNumber: card.prNumber,
      prUrl:
        card.prNumber != null
          ? `https://github.com/${card.repoSlug}/pull/${card.prNumber}`
          : null,
      status: card.status,
      lastError: null,
      lastErrorKind: null,
      createdAt,
      updatedAt,
      runStartedAt: card.status === "working" ? t0 - workingMs : null,
      archived: false,
      settledOverride: null,
      settledAt: null,
      prState: card.prNumber != null ? "OPEN" : null,
      lastVisitedAt: unreadDemo ? Math.min(createdAt, updatedAt - 1) : updatedAt,
      pinnedAt: pinDemo ? t0 - 30 * 60 * 1000 : null,
      snoozedUntil: snoozeDemo ? t0 + dayMs : null,
      snoozedAt: snoozeDemo ? t0 - 5 * 60 * 1000 : null,
      provider: TRAILER
        ? (TRAILER_PROVIDERS[index] ?? "claude")
        : isSimulate
          ? "simulate"
          : index % 3 === 0
            ? "codex"
            : "claude",
      model: null,
      sessionId: isSimulate
        ? "sim-seed-session-aabbccdd"
        : card.status === "done"
          ? `sess-${card.id.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`
          : null,
      permissionMode: (isSimulate
        ? "bypassPermissions"
        : index % 2 === 0
          ? "default"
          : "acceptEdits") as PermissionMode,
      reasoningEffort: null,
      webSearch: false,
      worktreePath: null,
      handoffFrom: null,
      muted: false,
      // One seeded scratch pad so the browser demo shows #194 once the UI lands.
      notes:
        card.id === "thread-4"
          ? "Merge after #42 lands - waiting on the API rename."
          : "",
      // One seeded verify command so the browser demo shows the #296 gate.
      verifyCommand: card.id === "thread-1" ? "npm test" : null,
      verify: null,
      // thread-3 is working but not the simulate timer, so stalledAt stays.
      stalledAt: card.id === "thread-3" ? t0 - 10 * 60 * 1000 : null,
      queued:
        card.id === "thread-4"
          ? {
              prompt: "retry the failed push",
              error: "CLI exited before ack",
            }
          : null,
      // One working thread carries a mirrored plan so the Planboard's
      // "Thread plans" section has something to show in dev mode.
      planSteps:
        card.id === "thread-1"
          ? [
              { step: "Read the provider settings store", status: "done" },
              { step: "Move per-device overrides to the store", status: "doing" },
              { step: "Backfill the migration test", status: "todo" },
            ]
          : undefined,
      // One seeded ledger so the browser demo shows the #303 card.
      hypotheses:
        card.id === "thread-1"
          ? [
              {
                id: "h-store-flush",
                claim: "Race is in the store flush",
                status: "invalidated" as const,
                reason: "Flush is sync; the hang is in execFile.",
                at: t0 - 25 * 60 * 1000,
              },
              {
                id: "h-fs-walk",
                claim: "Main process is blocked on a sync fs walk",
                status: "invalidated" as const,
                reason: "Profile shows the walk is under 20ms.",
                at: t0 - 18 * 60 * 1000,
              },
              {
                id: "h-execfile",
                claim: "execFile callback never fires under load",
                status: "validated" as const,
                reason: "Reproduced at 40 concurrent git calls.",
                at: t0 - 12 * 60 * 1000,
              },
              {
                id: "h-watcher",
                claim: "A second watcher is doubling the work",
                status: "inconclusive" as const,
                reason: "",
                at: t0 - 4 * 60 * 1000,
              },
            ]
          : undefined,
      // One seeded chip so npm run dev:browser shows the #550 strip.
      suggestions:
        card.id === "thread-1"
          ? [
              {
                id: "sug-reconnect",
                title: "Fix flaky reconnect test",
                prompt:
                  "The reconnect test flakes when the socket handshake races the ready event. Pin the handshake before asserting ready, and add a regression case for a mid-handshake drop.",
                status: "open" as const,
                at: t0 - 8 * 60 * 1000,
              },
            ]
          : undefined,
    };
  });
}

function mapAgentStatus(
  status: "active" | "done" | "pending" | "error",
): AgentView["status"] {
  if (status === "active") return "running";
  if (status === "done") return "settled";
  if (status === "error") return "failed";
  return "pending";
}

/** Workflow shaped like mock agents, mid-run (for the seeded working thread). */
function seedWorkflowMidRun(): WorkflowView {
  const phaseOrder = mockData.agents.phases.map((p) => p.name);
  const agentsByPhase = new Map<string, AgentView[]>();
  const allAgents: AgentView[] = [];

  for (const g of mockData.agents.groups) {
    const phaseName =
      mockData.agents.phases.find((p) => p.id === g.id)?.name ?? g.name;
    const list: AgentView[] = g.agents.map((a) => ({
      id: a.label,
      model: a.model,
      status: mapAgentStatus(a.status),
      tokensUsed:
        a.status === "done" ? 10400 : a.status === "active" ? 8000 : 0,
    }));
    agentsByPhase.set(phaseName, list);
    allAgents.push(...list);
  }

  const phases = phaseOrder.map((name) => ({
    name,
    pipelined: true,
    agents: agentsByPhase.get(name) ?? [],
  }));

  const settled = allAgents.filter((a) => a.status === "settled").length;
  const tokensTotal = allAgents.reduce((s, a) => s + a.tokensUsed, 0);

  return {
    id: id("wf"),
    name: mockData.agents.name,
    phases,
    settled,
    total: allAgents.length || 5,
    tokensTotal: tokensTotal || 52000,
    complete: false,
  };
}

/** Fresh run: all agents pending across the mock phase layout. */
function createFreshWorkflow(): WorkflowView {
  const phaseOrder = mockData.agents.phases.map((p) => p.name);
  const agentsByPhase = new Map<string, AgentView[]>();
  const allAgents: AgentView[] = [];

  for (const g of mockData.agents.groups) {
    const phaseName =
      mockData.agents.phases.find((p) => p.id === g.id)?.name ?? g.name;
    const list: AgentView[] = g.agents.map((a) => ({
      id: a.label,
      model: a.model,
      status: "pending" as const,
      tokensUsed: 0,
    }));
    agentsByPhase.set(phaseName, list);
    allAgents.push(...list);
  }

  for (const name of phaseOrder) {
    if (!agentsByPhase.has(name) || (agentsByPhase.get(name)?.length ?? 0) === 0) {
      const agent: AgentView = {
        id: `${name.toLowerCase()}:1`,
        model: "sonnet-5",
        status: "pending",
        tokensUsed: 0,
      };
      agentsByPhase.set(name, [agent]);
      allAgents.push(agent);
    }
  }

  const phases = phaseOrder.map((name) => ({
    name,
    pipelined: true,
    agents: agentsByPhase.get(name) ?? [],
  }));

  return {
    id: id("wf"),
    name: mockData.agents.name,
    phases,
    settled: 0,
    total: allAgents.length,
    tokensTotal: 0,
    complete: false,
  };
}

/**
 * Build a WorkflowView from a template. First phase agents start running so
 * the first thread:updated already shows progress.
 */
function createWorkflowFromTemplate(
  template: WorkflowTemplateInfo,
): WorkflowView {
  const phases: WorkflowView["phases"] = template.phases.map((p, pi) => {
    const modelLabel = p.model ?? "default";
    const agents: AgentView[] = Array.from({ length: p.agentCount }, (_, i) => ({
      id: `${p.name}:${i + 1}`,
      model: modelLabel,
      status: pi === 0 ? ("running" as const) : ("pending" as const),
      tokensUsed: pi === 0 ? 200 + Math.floor(Math.random() * 100) : 0,
    }));
    return {
      name: p.name,
      pipelined: p.agentCount > 1,
      agents,
    };
  });
  return recomputeWorkflow(phases, {
    id: id("wf"),
    name: template.name,
    phases,
    settled: 0,
    total: 0,
    tokensTotal: 0,
    complete: false,
  });
}

function buildKickoffText(
  wf: WorkflowView,
  phases: WorkflowPhaseSpec[],
): string {
  const lines = [`Kicked off ${wf.total} subagents`];
  for (const p of phases) {
    lines.push(
      `${capitalize(p.name)} · ${p.agentCount} · ${p.instruction}`,
    );
  }
  return lines.join("\n");
}

function appendDossier(
  detail: ThreadDetail,
  run: RunState,
  t: number,
  phaseName: string,
  agent: AgentView,
  instruction: string,
  prompt: string,
): void {
  const short = prompt.split("\n")[0]?.slice(0, 60) || "the task";
  const output = [
    `Phase: ${phaseName}`,
    `Agent: ${agent.id}`,
    `Model: ${agent.model}`,
    `Instruction: ${instruction}`,
    "",
    `Findings for "${short}":`,
    `- Explored relevant modules for ${phaseName}`,
    `- Produced intermediate notes (${agent.tokensUsed} tokens)`,
  ].join("\n");

  detail.messages.push({
    id: id("msg"),
    role: "tool",
    text: `Dossier: ${phaseName} · ${agent.id}`,
    createdAt: t,
    runId: run.runId,
    tool: {
      id: id("tool"),
      name: "Dossier",
      input: JSON.stringify(
        {
          phase: phaseName,
          agentId: agent.id,
          model: agent.model,
          instruction,
        },
        null,
        2,
      ),
      output,
      isError: false,
      done: true,
    },
  });
}

/**
 * Advance template-driven Build workflow one phase per tick.
 * Settles the current phase (appending a dossier per agent), then starts the
 * next. Returns true when the workflow is complete after this tick.
 */
function tickBuildWorkflow(
  detail: ThreadDetail,
  run: RunState,
  t: number,
  prompt: string,
): boolean {
  const wf = detail.workflow;
  if (!wf) return true;

  const phases = wf.phases.map((p) => ({
    ...p,
    agents: p.agents.map((a) => ({ ...a })),
  }));
  const step = run.workflowStep;
  const current = phases[step];
  if (!current) return true;

  const instruction =
    run.phaseInstructions?.[step] ?? `Run phase ${current.name}`;

  for (const a of current.agents) {
    a.status = "settled";
    a.tokensUsed += 900 + Math.floor(Math.random() * 500);
    appendDossier(detail, run, t, current.name, a, instruction, prompt);
  }

  const nextIndex = step + 1;
  const next = phases[nextIndex];
  if (next) {
    for (const a of next.agents) {
      a.status = "running";
      a.tokensUsed = 300 + Math.floor(Math.random() * 200);
    }
    run.workflowStep = nextIndex;
    detail.workflow = recomputeWorkflow(phases, wf);
    syncWorkLogForWorkflow(detail, run, t);
    return false;
  }

  run.workflowStep = nextIndex;
  detail.workflow = recomputeWorkflow(phases, wf);
  syncWorkLogForWorkflow(detail, run, t);

  for (const item of detail.workLog) {
    if (item.runId === run.runId) item.done = true;
  }
  const short = prompt.split("\n")[0]?.slice(0, 80) || "your request";
  const phaseNames = phases.map((p) => p.name).join(" → ");
  detail.messages.push({
    id: id("msg"),
    role: "assistant",
    text: `Workflow answer: completed ${wf.name} for "${short}". Phases: ${phaseNames}.`,
    createdAt: t,
    runId: run.runId,
  });
  detail.messages.push({
    id: id("evt"),
    role: "event",
    text: "Run complete",
    createdAt: t + 1,
    runId: run.runId,
  });
  bumpUsage(detail, {
    inputTokens: 2400,
    outputTokens: 980,
    costUsd: 0.012,
    turns: 1,
    model: detail.thread.model ?? "claude-opus-4",
  });
  return true;
}

function recomputeWorkflow(phases: WorkflowView["phases"], base: WorkflowView): WorkflowView {
  const agents = phases.flatMap((p) => p.agents);
  const settled = agents.filter((a) => a.status === "settled").length;
  const tokensTotal = agents.reduce((s, a) => s + a.tokensUsed, 0);
  const complete =
    agents.length > 0 &&
    agents.every((a) => a.status === "settled" || a.status === "failed");
  return {
    ...base,
    phases,
    settled,
    total: agents.length,
    tokensTotal,
    complete,
  };
}

function advanceWorkflow(wf: WorkflowView): WorkflowView {
  const phases = wf.phases.map((p) => ({
    ...p,
    agents: p.agents.map((a) => ({ ...a })),
  }));

  let acted = false;

  outerRunning: for (const phase of phases) {
    for (const agent of phase.agents) {
      if (agent.status === "running") {
        agent.status = "settled";
        agent.tokensUsed += 1800 + Math.floor(Math.random() * 900);
        acted = true;
        break outerRunning;
      }
    }
  }

  if (!acted) {
    outerPending: for (const phase of phases) {
      for (const agent of phase.agents) {
        if (agent.status === "pending") {
          agent.status = "running";
          agent.tokensUsed = 400 + Math.floor(Math.random() * 400);
          acted = true;
          break outerPending;
        }
      }
    }
  }

  return recomputeWorkflow(phases, wf);
}

/** Trailer-only: settle one worker, then fan out a whole phase at once. */
function advanceWorkflowFanout(wf: WorkflowView): WorkflowView {
  const phases = wf.phases.map((p) => ({
    ...p,
    agents: p.agents.map((a) => ({ ...a })),
  }));

  for (const phase of phases) {
    const running = phase.agents.filter((a) => a.status === "running");
    if (running.length > 0) {
      const agent = running[0];
      agent.status = "settled";
      agent.tokensUsed += 1800 + Math.floor(Math.random() * 900);
      return recomputeWorkflow(phases, wf);
    }
  }

  for (const phase of phases) {
    const pending = phase.agents.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      for (const agent of pending) {
        agent.status = "running";
        agent.tokensUsed = 400 + Math.floor(Math.random() * 400);
      }
      return recomputeWorkflow(phases, wf);
    }
  }

  return recomputeWorkflow(phases, wf);
}

function syncWorkLogForWorkflow(
  detail: ThreadDetail,
  run: RunState,
  t: number,
): void {
  const wf = detail.workflow;
  if (!wf) return;

  for (const phase of wf.phases) {
    const hasRunning = phase.agents.some((a) => a.status === "running");
    const allTerminal =
      phase.agents.length > 0 &&
      phase.agents.every(
        (a) => a.status === "settled" || a.status === "failed",
      );
    const label = capitalize(phase.name);

    if (hasRunning && !run.announced.has(phase.name)) {
      run.announced.add(phase.name);
      detail.workLog.push({
        id: id("wl"),
        runId: run.runId,
        label,
        done: false,
        timestamp: t,
      });
    }

    if (allTerminal && !run.settled.has(phase.name)) {
      run.settled.add(phase.name);
      if (!run.announced.has(phase.name)) {
        run.announced.add(phase.name);
        detail.workLog.push({
          id: id("wl"),
          runId: run.runId,
          label,
          done: true,
          timestamp: t,
        });
      } else {
        const item = detail.workLog.find(
          (w) => w.runId === run.runId && w.label === label,
        );
        if (item) {
          item.done = true;
        }
      }
    }
  }
}

function streamAssistant(detail: ThreadDetail, run: RunState, t: number): void {
  const snippets = [
    "Mapping the request against the current worktree layout.",
    "Agents are exploring the relevant modules in parallel.",
    "Drafting a plan from the analyze phase findings.",
    "Cross-checking types and edge cases before the patch.",
  ];
  const settled = detail.workflow?.settled ?? 0;
  const total = detail.workflow?.total ?? 1;
  const progress = Math.min(
    snippets.length,
    1 + Math.floor((settled / Math.max(total, 1)) * (snippets.length - 1)),
  );
  const text = snippets.slice(0, progress).join("\n\n");

  if (!run.assistantMsgId) {
    const msgId = id("msg");
    run.assistantMsgId = msgId;
    detail.messages.push({
      id: msgId,
      role: "assistant",
      text,
      createdAt: t,
      runId: run.runId,
    });
    return;
  }

  const existing = detail.messages.find((m) => m.id === run.assistantMsgId);
  if (existing) {
    existing.text = text;
  }
}

function emptyUsage(model: string | null = "claude-opus-4"): SessionUsage {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    turns: 0,
    contextTokens: 0,
  };
}

function bumpUsage(detail: ThreadDetail, delta: Partial<SessionUsage> & { model?: string | null }): void {
  const prev = detail.usage ?? emptyUsage(delta.model ?? "claude-opus-4");
  const turnTokens = (delta.inputTokens ?? 0) + (delta.outputTokens ?? 0);
  detail.usage = {
    model: delta.model !== undefined ? delta.model : prev.model,
    inputTokens: prev.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: prev.outputTokens + (delta.outputTokens ?? 0),
    costUsd: prev.costUsd + (delta.costUsd ?? 0),
    turns: prev.turns + (delta.turns ?? 0),
    contextTokens: turnTokens > 0 ? turnTokens : prev.contextTokens ?? 0,
  };
}

/**
 * Session provider ticks:
 * 0 open assistant text
 * 1 Bash tool (running)
 * 2 Bash done + more text
 * 3 Edit tool (running)
 * 4 Edit done + final text + complete
 */
function tickSessionRun(detail: ThreadDetail, run: RunState, t: number): boolean {
  const step = run.sessionStep;

  if (step === 0) {
    const msgId = id("msg");
    run.assistantMsgId = msgId;
    detail.messages.push({
      id: msgId,
      role: "assistant",
      text: "I'll inspect the repo and apply a small fix.",
      createdAt: t,
      runId: run.runId,
    });
    bumpUsage(detail, {
      inputTokens: 420,
      outputTokens: 80,
      costUsd: 0.0042,
      model: "claude-opus-4",
    });
    run.sessionStep = 1;
    return false;
  }

  if (step === 1) {
    detail.messages.push({
      id: id("msg"),
      role: "tool",
      text: "Bash: npm test",
      createdAt: t,
      runId: run.runId,
      tool: {
        id: id("tool"),
        name: "Bash",
        input: JSON.stringify({ command: "npm test" }, null, 2),
        output: null,
        isError: false,
        done: false,
      },
    });
    run.sessionStep = 2;
    return false;
  }

  if (step === 2) {
    const bash = [...detail.messages]
      .reverse()
      .find((m) => m.role === "tool" && m.tool?.name === "Bash" && !m.tool.done);
    if (bash?.tool) {
      bash.tool.done = true;
      bash.tool.output =
        "✓ test/timeline.test.ts (8)\n\n  8 passing\n\nexit 0";
      bash.text = "Bash: npm test";
    }
    if (run.assistantMsgId) {
      const asst = detail.messages.find((m) => m.id === run.assistantMsgId);
      if (asst) {
        asst.text +=
          "\n\nTests are green. Next I'll patch the permission mode selector.";
      }
    }
    bumpUsage(detail, { inputTokens: 210, outputTokens: 120, costUsd: 0.0031 });
    run.sessionStep = 3;
    return false;
  }

  if (step === 3) {
    detail.messages.push({
      id: id("msg"),
      role: "tool",
      text: "Edit: src/components/Composer.tsx",
      createdAt: t,
      runId: run.runId,
      tool: {
        id: id("tool"),
        name: "Edit",
        input: JSON.stringify(
          {
            path: "src/components/Composer.tsx",
            old_string: 'access: "Full access"',
            new_string: "permissionMode selector",
          },
          null,
          2,
        ),
        output: null,
        isError: false,
        done: false,
      },
    });
    run.sessionStep = 4;
    return false;
  }

  // step >= 4: finish Edit + close run
  const edit = [...detail.messages]
    .reverse()
    .find((m) => m.role === "tool" && m.tool?.name === "Edit" && !m.tool.done);
  if (edit?.tool) {
    edit.tool.done = true;
    edit.tool.output = "Applied 1 edit to Composer.tsx";
  }
  detail.messages.push({
    id: id("msg"),
    role: "assistant",
    text: "Done. Permission mode is wired to threads.setPermissionMode and the session card reflects live usage.",
    createdAt: t,
    runId: run.runId,
  });
  detail.messages.push({
    id: id("evt"),
    role: "event",
    text: "Run complete",
    createdAt: t + 1,
    runId: run.runId,
  });
  bumpUsage(detail, {
    inputTokens: 380,
    outputTokens: 160,
    costUsd: 0.0055,
    turns: 1,
  });
  run.sessionStep = 5;
  return true;
}

function seedDetail(thread: ThreadInfo): ThreadDetail {
  const tv = mockData.threadView;
  const t0 = thread.updatedAt;
  const runId = "run-seed-1";

  const messages: ChatMessage[] = [
    {
      id: "msg-user-seed",
      role: "user",
      text: "Modernize per-device provider settings storage.",
      createdAt: t0 - 130_000,
      runId,
    },
    {
      id: "evt-kickoff",
      role: "event",
      text: tv.kickoff.title,
      createdAt: t0 - 90_000,
      runId,
    },
    ...tv.messages.map((m, i) => ({
      id: m.id,
      role: "assistant" as const,
      text: m.paragraphs.join("\n\n"),
      createdAt: t0 - 60_000 + i * 15_000,
      runId,
    })),
  ];

  const workLog: WorkLogItem[] = tv.workLog.steps.map((s, i) => ({
    id: s.id,
    runId,
    label: s.label,
    done: s.done,
    timestamp: t0 - 120_000 + i * 20_000,
  }));

  if (thread.status === "working") {
    const hasAnalyze = workLog.some((w) => /analyze/i.test(w.label));
    if (!hasAnalyze) {
      workLog.push({
        id: id("wl"),
        runId,
        label: "Seed",
        done: true,
        timestamp: t0 - 100_000,
      });
      workLog.push({
        id: id("wl"),
        runId,
        label: "Analyze",
        done: false,
        timestamp: t0 - 40_000,
      });
    }
  }

  const trailerActive = TRAILER && thread.id === mockData.activeThreadId;
  const usage: SessionUsage | null =
    thread.provider === "simulate" || trailerActive
      ? {
          model: "simulate-multiagent",
          inputTokens: 18400,
          outputTokens: 6200,
          costUsd: 0.0,
          turns: 1,
        }
      : thread.sessionId
        ? {
            model: "claude-opus-4",
            inputTokens: 2400,
            outputTokens: 910,
            costUsd: 0.0184,
            turns: 2,
          }
        : null;

  return {
    thread,
    messages,
    workLog,
    workflow:
      (thread.status === "working" && thread.provider === "simulate") ||
      trailerActive
        ? TRAILER
          ? createFreshWorkflow()
          : seedWorkflowMidRun()
        : null,
    usage,
  };
}

function cloneDetail(d: ThreadDetail): ThreadDetail {
  return structuredClone(d);
}

function fakeDiff(thread: ThreadInfo): DiffResult {
  const branch = thread.branch ?? "main";
  const files = [
    {
      path: "src/components/Composer.tsx",
      status: "M",
      additions: 28,
      deletions: 6,
    },
    {
      path: "src/components/ThreadView.tsx",
      status: "M",
      additions: 94,
      deletions: 12,
    },
    {
      path: "src/devCoder.ts",
      status: "M",
      additions: 140,
      deletions: 40,
    },
  ];
  const patch = [
    `diff --git a/src/components/Composer.tsx b/src/components/Composer.tsx`,
    `index 1111111..2222222 100644`,
    `--- a/src/components/Composer.tsx`,
    `+++ b/src/components/Composer.tsx`,
    `@@ -100,7 +100,12 @@ export function Composer({`,
    `     <button type="button" className={styles.pill}>`,
    `-      {STATIC.access}`,
    `+      {permissionModeLabel(permissionMode)}`,
    `+      <span className={styles.caret}>▾</span>`,
    `     </button>`,
    ``,
    `diff --git a/src/components/ThreadView.tsx b/src/components/ThreadView.tsx`,
    `--- a/src/components/ThreadView.tsx`,
    `+++ b/src/components/ThreadView.tsx`,
    `@@ -1,4 +1,8 @@`,
    `+import type { DiffResult } from "../shared/ipc";`,
    `+// Changes panel + tool cards`,
    ` // branch: ${branch}`,
  ].join("\n");

  return {
    files,
    patch,
    truncated: false,
  };
}

const EMPTY_DIFF: DiffResult = { files: [], patch: "", truncated: false };

/** Factory for tests / isolated in-memory sessions. */
export function createDevCoder(): CoderApi {
  return buildDevCoder();
}

function buildDevCoder(): CoderApi {
  // let: projects.remove must rebind the array (const would not compile).
  let projects = seedProjects();
  let spaces: SpaceInfo[] = [];
  let threads = seedThreads(projects);
  const details = new Map<string, ThreadDetail>();
  const runTimers = new Map<string, ReturnType<typeof setInterval>>();
  const runStates = new Map<string, RunState>();
  /** Threads whose worktree was merged/removed; fakeDiff stays empty until re-setup. */
  const clearedDiff = new Set<string>();
  /** Directories already reclaimed by the #316 GC demo stubs. */
  const gcRemoved = new Set<string>();
  /** User-defined + builtin workflow templates (in-memory). */
  let templates: WorkflowTemplateInfo[] = [cloneTemplate(STANDARD_TEMPLATE)];
  /** Scheduled agent runs. */
  let automationsList: AutomationInfo[] = [];
  /** Aggregated cost of finished fake runs this session (stands in for "today"). */
  let spendTodayUsd = 0;
  let dailyBudgetUsd: number | null = null;
  /** Per-orchestration crew spend ceiling (Settings); null = no cap. */
  let orchestrationBudgetUsd: number | null = null;
  /** Default 3 = AUTO_SETTLE_AFTER_DAYS; null disables. */
  let autoSettleAfterDays: number | null = 3;
  /** Default true = MERGED PRs auto-settle. */
  let autoSettleOnMerge = true;
  /** PR size cap in lines (issue #402); default 400, null disables. */
  let prDiffCapLines: number | null = 400;
  /** User MCP servers (Skills tab), in-memory. */
  let mcpServers: McpServerInfo[] = [];

  function redactDevMcp(s: McpServerInfo): McpServerDefinition {
    if (s.transport === "stdio") {
      const env = s.env ?? {};
      return {
        name: s.name,
        transport: "stdio",
        command: s.command,
        args: [...s.args],
        envNames: Object.keys(env),
        hasSecrets: Object.keys(env).length > 0,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        enabled: s.enabled,
        trusted: s.trusted,
        ...(s.provenance ? { provenance: s.provenance } : {}),
        ...(s.catalogId ? { catalogId: s.catalogId } : {}),
      };
    }
    const headers = s.headers ?? {};
    return {
      name: s.name,
      transport: s.transport === "sse" ? "sse" : "http",
      url: s.url,
      headerNames: Object.keys(headers),
      hasToken: Boolean(s.token),
      enabled: s.enabled,
      ...(s.provenance ? { provenance: s.provenance } : {}),
      ...(s.catalogId ? { catalogId: s.catalogId } : {}),
    };
  }

  /** Default new threads into a fake worktree (Settings toggle). */
  let defaultWorktree = false;
  /** Default new threads as orchestrators (Settings toggle). */
  let defaultOrchestrate = false;
  let defaultProvider: string | null = null;
  let defaultModel: string | null = null;
  let quotaFailover: string[] = [];
  /** First-run onboarding wizard finished or skipped. */
  let onboardingSeen = false;
  /** Update channel override; null follows the (absent) dev stamp. */
  let updateChannel: "prod" | "nightly" | null = null;
  let notifications = true;
  let feltEstimatePrompt = false;
  let uiScale = 1;
  let theme: AppSettings["theme"] = "dark";
  let agentsPanelDefault: AppSettings["agentsPanelDefault"] = "closed";
  let agentsPanelRememberLast = false;
  let stayAwake: AppSettings["stayAwake"] = "agent";
  let quotaWaitAutoResume = true;
  let otel: OtelSettings = { endpoint: null, headers: {}, claudeMetrics: false };
  let webhook: WebhookSettings = {
    url: null,
    onDone: true,
    onFailed: true,
    onWaiting: true,
  };
  /** Saved agent profiles (Settings tab), in-memory. */
  let agentProfiles: AgentProfile[] = [];
  /** Planboard Orchestrator: Default (#725). */
  let defaultOrchestratorProfileId: string | null = null;
  /** Described worker-model pool (Settings), in-memory. */
  let subagentPool: SubagentPool = {
    defaultAlias: null,
    force: false,
    entries: [],
  };
  /** Writable targets a skill fans out to (mirrors CoderApi SkillTarget). */
  const ALL_SKILL_TARGETS: SkillTarget[] = [
    "claude",
    "agents",
    "codex",
    "grok",
    "opencode",
    "kimi",
    "cursor",
  ];

  function skillMdBytes(name: string, description: string, body: string): number {
    const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
    return new TextEncoder().encode(md).length;
  }

  /** In-memory skills (Skills tab); dev twin of the on-disk SKILL.md scan. */
  let pendingSkillImport: { kind: "local" | "github" | "catalog"; catalogId?: string } | null =
    null;
  let pendingMcpImport: {
    previewId: string;
    kind: "json" | "github" | "catalog" | "local";
    catalogId?: string;
    servers: ReturnType<typeof parseMcpConfigDocument>["servers"];
  } | null = null;

  function mcpPreviewFromParsed(
    kind: "json" | "github" | "catalog" | "local",
    label: string,
    parsed: ReturnType<typeof parseMcpConfigDocument>,
    catalogId?: string,
  ): McpImportPreview {
    const previewId = "m".repeat(32);
    pendingMcpImport = { previewId, kind, catalogId, servers: parsed.servers };
    const existing = new Set(mcpServers.map((s) => s.name));
    return {
      previewId,
      source: { kind, label },
      warnings: parsed.warnings,
      servers: parsed.servers.map((row) => ({
        name: row.stored.name,
        transport: row.stored.transport,
        command: row.stored.command,
        args: row.stored.args ? [...row.stored.args] : [],
        url: row.stored.url,
        cwd: row.stored.cwd,
        envNames: [...row.meta.envNames],
        headerNames: [...row.meta.headerNames],
        hasToken: row.meta.hasToken,
        requiresTrust: row.stored.transport === "stdio",
        collision: existing.has(row.stored.name),
        warnings: [...row.meta.warnings],
        providers: [
          { id: "claude", supported: true },
          { id: "kimi", supported: true },
          { id: "codex", supported: row.stored.transport !== "sse" },
          { id: "grok", supported: true },
        ],
      })),
    };
  }

  function ponytailPluginPreviewExtras(): SkillPluginExtra[] {
    return [
      {
        provider: "claude",
        label: "ponytail",
        executableFiles: [],
        activation: { kind: "claude-plugin", status: "pending" },
      },
      {
        provider: "codex",
        label: "ponytail",
        executableFiles: [],
        activation: { kind: "codex-plugin", status: "pending" },
      },
      {
        provider: "grok",
        label: "ponytail",
        executableFiles: [],
        activation: { kind: "grok-plugin", status: "pending" },
      },
      {
        provider: "plugin",
        label: "ponytail",
        executableFiles: [],
        activation: { kind: "plugin", status: "pending" },
      },
      {
        provider: "hooks",
        label: "Hooks",
        executableFiles: [
          "hooks/ponytail-statusline.sh",
          "hooks/ponytail-statusline.ps1",
        ],
        activation: { kind: "hooks", status: "pending" },
      },
      {
        provider: "commands",
        label: "Commands",
        executableFiles: [],
        activation: { kind: "commands", status: "pending" },
      },
    ];
  }

  function ponytailPluginInstallResults(
    trustPluginCode: boolean,
  ): SkillPluginInstallResult[] {
    const extras: Array<{ provider: string; label: string }> = [
      { provider: "claude", label: "ponytail" },
      { provider: "codex", label: "ponytail" },
      { provider: "grok", label: "ponytail" },
      { provider: "plugin", label: "ponytail" },
      { provider: "hooks", label: "Hooks" },
      { provider: "commands", label: "Commands" },
    ];
    if (trustPluginCode !== true) {
      return extras.map((extra) => ({ ...extra, status: "skipped" as const }));
    }
    const instructions = [
      "/plugin marketplace add DietrichGebert/ponytail",
      "/plugin install ponytail@ponytail",
    ];
    return [
      { provider: "claude", label: "ponytail", status: "manual", instructions },
      { provider: "codex", label: "ponytail", status: "activated" },
      { provider: "grok", label: "ponytail", status: "activated" },
      { provider: "plugin", label: "ponytail", status: "covered" },
      { provider: "hooks", label: "Hooks", status: "covered" },
      { provider: "commands", label: "Commands", status: "covered" },
    ];
  }
  let skillsList: SkillInfo[] = [
    {
      name: "review-pr",
      description: "Review a pull request end to end",
      source: "claude",
      installedIn: [...ALL_SKILL_TARGETS],
      missingFrom: [],
      bytes: 4800,
      provenance: "added",
    },
    {
      name: "write-tests",
      description: "Add tests for the current change",
      source: "agents",
      installedIn: ["claude", "agents", "codex", "grok", "opencode"],
      missingFrom: ["kimi"],
      bytes: 800,
      provenance: "added",
    },
  ];
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
      notes: "",
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

  const clearRunTimer = (threadId: string) => {
    const handle = runTimers.get(threadId);
    if (handle != null) {
      clearInterval(handle);
      runTimers.delete(threadId);
    }
  };

  const isSimulate = (thread: ThreadInfo) =>
    thread.provider === "simulate" ||
    (TRAILER && thread.id === mockData.activeThreadId);

  /**
   * In-memory checkpoints per thread, newest first: enough for the timeline
   * to render. electron/worktrees.js owns the real git log.
   */
  const checkpointsByThread = new Map<string, CheckpointInfo[]>();

  const appendDevCheckpoint = (thread: ThreadInfo) => {
    if (!thread.worktreePath) return;
    const prev = checkpointsByThread.get(thread.id) || [];
    const turn = prev.length + 1;
    const entry: CheckpointInfo = {
      sha: `devckpt${turn.toString(16).padStart(7, "0")}${id("c").slice(-8)}`,
      turn,
      message: `coder-checkpoint: turn ${turn}`,
      at: now(),
    };
    // newest-first
    checkpointsByThread.set(thread.id, [entry, ...prev]);
  };

  /** Bill the cost delta of a finished/stopped run into today's spend. */
  const settleRunSpend = (detail: ThreadDetail, run: RunState | undefined) => {
    if (!run) return;
    const nowCost = detail.usage?.costUsd ?? 0;
    const delta = Math.max(0, nowCost - run.costBaseline);
    if (delta > 0) spendTodayUsd += delta;
    // Prevent double-billing if settle is called twice for the same run.
    run.costBaseline = nowCost;
  };

  const assertUnderBudget = () => {
    if (dailyBudgetUsd == null) return;
    if (spendTodayUsd >= dailyBudgetUsd) {
      throw new Error(
        dailyBudgetReachedMessage(spendTodayUsd, dailyBudgetUsd),
      );
    }
  };

  const parseBudgetPatch = (patch: Partial<AppSettings>): number | null => {
    if (!Object.prototype.hasOwnProperty.call(patch, "dailyBudgetUsd")) {
      return dailyBudgetUsd;
    }
    const v = patch.dailyBudgetUsd;
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(SETTINGS_BUDGET_ERROR);
    }
    return v;
  };

  const parseOrchBudgetPatch = (patch: Partial<AppSettings>): number | null => {
    if (!Object.prototype.hasOwnProperty.call(patch, "orchestrationBudgetUsd")) {
      return orchestrationBudgetUsd;
    }
    const v = patch.orchestrationBudgetUsd;
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(SETTINGS_ORCH_BUDGET_ERROR);
    }
    return v;
  };

  const SETTINGS_SETTLE_ERROR =
    "Auto-settle days must be a positive integer or null";

  const parseSettleDaysPatch = (
    patch: Partial<AppSettings>,
  ): number | null => {
    if (!Object.prototype.hasOwnProperty.call(patch, "autoSettleAfterDays")) {
      return autoSettleAfterDays;
    }
    const v = patch.autoSettleAfterDays;
    if (v === null) return null;
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      !Number.isInteger(v) ||
      !(v > 0)
    ) {
      throw new Error(`${SETTINGS_SETTLE_ERROR} (got ${String(v)})`);
    }
    return v;
  };

  /** Prompt from the user message of the active run (for workflow final answer). */
  const runPrompt = (detail: ThreadDetail, runId: string): string => {
    const user = [...detail.messages]
      .reverse()
      .find((m) => m.role === "user" && m.runId === runId);
    return user?.text ?? "";
  };

  const tickRun = (threadId: string) => {
    const detail = details.get(threadId);
    if (!detail) {
      clearRunTimer(threadId);
      return;
    }

    let run = runStates.get(threadId);
    if (!run) {
      run = {
        runId: id("run"),
        announced: new Set(),
        settled: new Set(),
        assistantMsgId: null,
        sessionStep: 0,
        kind: isSimulate(detail.thread) ? "simulate" : "session",
        workflowStep: 0,
        costBaseline: detail.usage?.costUsd ?? 0,
      };
      runStates.set(threadId, run);
    }

    const t = now();
    let thread: ThreadInfo = {
      ...detail.thread,
      updatedAt: t,
    };
    let complete = false;

    if (run.kind === "workflow" && detail.workflow && !detail.workflow.complete) {
      complete = tickBuildWorkflow(
        detail,
        run,
        t,
        runPrompt(detail, run.runId),
      );
    } else if (
      (run.kind === "simulate" || isSimulate(thread)) &&
      detail.workflow &&
      !detail.workflow.complete
    ) {
      const advanced = TRAILER
        ? advanceWorkflowFanout(detail.workflow)
        : advanceWorkflow(detail.workflow);
      detail.workflow = advanced;
      syncWorkLogForWorkflow(detail, run, t);
      streamAssistant(detail, run, t);
      if (advanced.complete) {
        complete = true;
        for (const item of detail.workLog) {
          if (item.runId === run.runId) item.done = true;
        }
        detail.messages.push({
          id: id("evt"),
          role: "event",
          text: "Run complete",
          createdAt: t,
          runId: run.runId,
        });
        bumpUsage(detail, {
          inputTokens: 900,
          outputTokens: 400,
          costUsd: 0,
          turns: 1,
          model: "simulate-multiagent",
        });
      }
    } else if (run.kind === "session" || !isSimulate(thread)) {
      complete = tickSessionRun(detail, run, t);
    } else {
      complete = true;
    }

    if (complete) {
      settleRunSpend(detail, run);
      thread = {
        ...thread,
        status: "done",
        updatedAt: t,
        runStartedAt: null,
      };
      clearRunTimer(threadId);
      appendDevCheckpoint(thread);
    }

    detail.thread = thread;
    details.set(threadId, detail);
    syncThreadRow(thread);
    emitDetail(detail);
  };

  const startRunTimer = (threadId: string) => {
    clearRunTimer(threadId);
    const handle = setInterval(() => tickRun(threadId), TICK_MS);
    runTimers.set(threadId, handle);
  };

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
    memory: {
      async search(input: {
        query: string;
        project?: string;
      }): Promise<MemoryEntryInfo[]> {
        const q = input.query.trim().toLowerCase();
        if (!q) return [];
        let rows = memoryEntries.filter((row) => {
          const hay = `${row.title}\n${row.body}`.toLowerCase();
          return hay.includes(q);
        });
        if (input.project != null && input.project !== "") {
          rows = rows.filter((row) => row.project === input.project);
        }
        rows = [...rows].sort((a, b) =>
          a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
        );
        return rows.map(toListEntry);
      },
      async recent(input?: {
        limit?: number;
        project?: string;
      }): Promise<MemoryEntryInfo[]> {
        const limit =
          input?.limit != null && input.limit > 0 ? Math.floor(input.limit) : 20;
        let rows = [...memoryEntries];
        if (input?.project != null && input.project !== "") {
          rows = rows.filter((row) => row.project === input.project);
        }
        rows = rows.sort((a, b) =>
          a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
        );
        return rows.slice(0, limit).map(toListEntry);
      },
      async get(input: { id: string }): Promise<MemoryEntryInfo> {
        const row = memoryEntries.find((e) => e.id === input.id);
        if (!row) throw new Error(MEMORY_NOT_FOUND);
        return toFullEntry(row);
      },
      async store(input: {
        type: MemoryEntryInfo["type"];
        title: string;
        body: string;
        project?: string;
        citations?: MemoryEntryInfo["citations"];
      }): Promise<{ id: string }> {
        const title = input.title.trim();
        const body = input.body.trim();
        if (!title) throw new Error("Title is required");
        if (!body) throw new Error("Body is required");
        const ts = toIso(now());
        const entry: MemoryRow = {
          id: id("mem"),
          type: input.type,
          title,
          body,
          project:
            input.project != null && input.project !== ""
              ? input.project
              : null,
          importance:
            input.type === "convention"
              ? 5
              : input.type === "strategy"
                ? 4
                : input.type === "run"
                  ? 1
                  : 3,
          createdAt: ts,
          updatedAt: ts,
          citations: input.citations,
        };
        memoryEntries = [entry, ...memoryEntries];
        return { id: entry.id };
      },
      async update(input: {
        id: string;
        title: string;
        body: string;
      }): Promise<{ id: string }> {
        const title = input.title.trim();
        const body = input.body.trim();
        if (!title) throw new Error("Title is required");
        if (!body) throw new Error("Body is required");
        const old = memoryEntries.find((e) => e.id === input.id);
        if (!old) throw new Error(`no entry with id ${input.id}`);
        const ts = toIso(now());
        const successor: MemoryRow = {
          ...old,
          id: id("mem"),
          title,
          body,
          createdAt: ts,
          updatedAt: ts,
        };
        // Supersede semantics: the old row stops being served.
        memoryEntries = [
          successor,
          ...memoryEntries.filter((e) => e.id !== input.id),
        ];
        return { id: successor.id };
      },
      async remove(input: { id: string }): Promise<void> {
        const before = memoryEntries.length;
        memoryEntries = memoryEntries.filter((e) => e.id !== input.id);
        if (memoryEntries.length === before) {
          throw new Error(`no entry with id ${input.id}`);
        }
      },
      async maintenance(_input?: {
        project?: string;
      }): Promise<MemoryMaintenanceReport> {
        return {
          queue: { open: 0, oldestAgeDays: 0, items: [] },
          autoResolved: { last7Days: 0, invalidated: 0, kept: 0, byRule: {} },
          nearDupes: [],
          agingRuns: [],
          fatConventions: [],
          trust: { agents: [], suspect: [] },
        };
      },
      async resolve(input: {
        id: number;
        resolution: MemoryReviewResolution;
      }): Promise<{ ok: boolean; id: number; resolution: string }> {
        return { ok: true, id: input.id, resolution: input.resolution };
      },
    },
    settings: {
      async get(): Promise<AppSettings> {
        return redactSettings({
          dailyBudgetUsd,
          orchestrationBudgetUsd,
          autoSettleAfterDays,
          autoSettleOnMerge,
          prDiffCapLines,
          mcpServers,
          defaultWorktree,
          defaultOrchestrate,
          defaultProvider,
          defaultModel,
          quotaFailover: quotaFailover.slice(),
          onboardingSeen,
          updateChannel,
          notifications,
          feltEstimatePrompt,
          uiScale,
          theme,
          agentsPanelDefault,
          agentsPanelRememberLast,
          stayAwake,
          quotaWaitAutoResume,
          agentProfiles: agentProfiles.map((p) => ({ ...p })),
          defaultOrchestratorProfileId,
          subagentPool: {
            ...subagentPool,
            entries: subagentPool.entries.map((e) => ({ ...e })),
          },
          otel: { ...otel, headers: { ...otel.headers } },
          webhook: { ...webhook },
        }) as AppSettings;
      },
      async set(patch: Partial<AppSettings>): Promise<AppSettings> {
        dailyBudgetUsd = parseBudgetPatch(patch);
        orchestrationBudgetUsd = parseOrchBudgetPatch(patch);
        autoSettleAfterDays = parseSettleDaysPatch(patch);
        if (Object.prototype.hasOwnProperty.call(patch, "autoSettleOnMerge")) {
          if (typeof patch.autoSettleOnMerge !== "boolean") {
            throw new Error("autoSettleOnMerge must be a boolean");
          }
          autoSettleOnMerge = patch.autoSettleOnMerge;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "prDiffCapLines")) {
          const v = patch.prDiffCapLines;
          if (
            v !== null &&
            (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
          ) {
            throw new Error("PR diff cap must be a positive integer or null");
          }
          prDiffCapLines = v;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "mcpServers")) {
          if (!Array.isArray(patch.mcpServers)) {
            throw new Error("mcpServers must be an array");
          }
          mcpServers = validateMcpServers(
            mergeMcpSettingsPatch(mcpServers, patch.mcpServers),
          ) as McpServerInfo[];
        }
        if (Object.prototype.hasOwnProperty.call(patch, "defaultWorktree")) {
          if (typeof patch.defaultWorktree !== "boolean") {
            throw new Error("defaultWorktree must be a boolean");
          }
          defaultWorktree = patch.defaultWorktree;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "defaultOrchestrate")) {
          if (typeof patch.defaultOrchestrate !== "boolean") {
            throw new Error("defaultOrchestrate must be a boolean");
          }
          defaultOrchestrate = patch.defaultOrchestrate;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "defaultProvider")) {
          const v = patch.defaultProvider;
          if (v !== null && typeof v !== "string") {
            throw new Error("defaultProvider must be a string or null");
          }
          defaultProvider = v && v.trim() ? v.trim() : null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "defaultModel")) {
          const v = patch.defaultModel;
          if (v !== null && typeof v !== "string") {
            throw new Error("defaultModel must be a string or null");
          }
          defaultModel = v && v.trim() ? v.trim() : null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "quotaFailover")) {
          if (!Array.isArray(patch.quotaFailover)) {
            throw new Error("quotaFailover must be an array");
          }
          const seen = new Set<string>();
          quotaFailover = [];
          for (const item of patch.quotaFailover) {
            if (typeof item !== "string" || !item.trim()) {
              throw new Error("quotaFailover entries must be non-empty strings");
            }
            const id = item.trim();
            if (seen.has(id)) continue;
            seen.add(id);
            quotaFailover.push(id);
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, "onboardingSeen")) {
          if (typeof patch.onboardingSeen !== "boolean") {
            throw new Error("onboardingSeen must be a boolean");
          }
          onboardingSeen = patch.onboardingSeen;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "updateChannel")) {
          const v = patch.updateChannel;
          if (v !== null && v !== "prod" && v !== "nightly") {
            throw new Error('updateChannel must be "prod", "nightly", or null');
          }
          updateChannel = v ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "notifications")) {
          if (typeof patch.notifications !== "boolean") {
            throw new Error("notifications must be a boolean");
          }
          notifications = patch.notifications;
        }
        if (
          Object.prototype.hasOwnProperty.call(patch, "feltEstimatePrompt")
        ) {
          if (typeof patch.feltEstimatePrompt !== "boolean") {
            throw new Error("feltEstimatePrompt must be a boolean");
          }
          feltEstimatePrompt = patch.feltEstimatePrompt;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "uiScale")) {
          const v = patch.uiScale;
          if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new Error("uiScale must be a number");
          }
          const stepped = Math.round(v * 10) / 10;
          uiScale = Math.min(1.6, Math.max(0.8, stepped));
        }
        if (Object.prototype.hasOwnProperty.call(patch, "theme")) {
          const v = patch.theme;
          if (v !== "system" && v !== "light" && v !== "dark") {
            throw new Error('theme must be "system", "light", or "dark"');
          }
          theme = v;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "agentsPanelDefault")) {
          const v = patch.agentsPanelDefault;
          if (v !== "closed" && v !== "open") {
            throw new Error('agentsPanelDefault must be "closed" or "open"');
          }
          agentsPanelDefault = v;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "agentsPanelRememberLast")) {
          if (typeof patch.agentsPanelRememberLast !== "boolean") {
            throw new Error("agentsPanelRememberLast must be a boolean");
          }
          agentsPanelRememberLast = patch.agentsPanelRememberLast;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "stayAwake")) {
          const v = patch.stayAwake;
          if (v !== "agent" && v !== "on" && v !== "off") {
            throw new Error('stayAwake must be "agent", "on", or "off"');
          }
          stayAwake = v;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "quotaWaitAutoResume")) {
          if (typeof patch.quotaWaitAutoResume !== "boolean") {
            throw new Error("quotaWaitAutoResume must be a boolean");
          }
          quotaWaitAutoResume = patch.quotaWaitAutoResume;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "agentProfiles")) {
          if (!Array.isArray(patch.agentProfiles)) {
            throw new Error("agentProfiles must be an array");
          }
          agentProfiles = patch.agentProfiles.map((p) => ({ ...p }));
          if (
            defaultOrchestratorProfileId &&
            !agentProfiles.some((p) => p.id === defaultOrchestratorProfileId)
          ) {
            defaultOrchestratorProfileId = null;
          }
        }
        if (
          Object.prototype.hasOwnProperty.call(
            patch,
            "defaultOrchestratorProfileId",
          )
        ) {
          const v = patch.defaultOrchestratorProfileId;
          if (v !== null && typeof v !== "string") {
            throw new Error(
              "defaultOrchestratorProfileId must be a string or null",
            );
          }
          const id = v != null ? v.trim() : "";
          if (id && !agentProfiles.some((p) => p.id === id)) {
            throw new Error(
              "defaultOrchestratorProfileId must match an agent profile or be null",
            );
          }
          defaultOrchestratorProfileId = id || null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "subagentPool")) {
          const v = patch.subagentPool;
          if (!v || typeof v !== "object" || Array.isArray(v)) {
            throw new Error("subagentPool must be an object");
          }
          if (!Array.isArray(v.entries)) {
            throw new Error("subagentPool.entries must be an array");
          }
          subagentPool = {
            defaultAlias: v.defaultAlias ?? null,
            force: v.force === true,
            entries: v.entries.map((e) => ({ ...e })),
          };
        }
        if (Object.prototype.hasOwnProperty.call(patch, "otel")) {
          const v = patch.otel;
          if (!v || typeof v !== "object") {
            throw new Error("otel must be an object");
          }
          if (
            v.endpoint != null &&
            !/^https?:\/\/\S+$/.test(String(v.endpoint).trim())
          ) {
            throw new Error("OTLP endpoint must be an http(s) URL or null");
          }
          otel = {
            endpoint: v.endpoint ? String(v.endpoint).trim().replace(/\/+$/, "") : null,
            headers: { ...(v.headers ?? {}) },
            claudeMetrics: v.claudeMetrics === true,
          };
        }
        if (Object.prototype.hasOwnProperty.call(patch, "webhook")) {
          const v = patch.webhook;
          if (!v || typeof v !== "object") {
            throw new Error("webhook must be an object");
          }
          if (
            v.url != null &&
            v.url !== "" &&
            !/^https?:\/\/\S+$/.test(String(v.url).trim())
          ) {
            throw new Error("Webhook URL must be an http(s) URL or empty");
          }
          webhook = {
            url: v.url ? String(v.url).trim() : null,
            onDone: v.onDone !== false,
            onFailed: v.onFailed !== false,
            onWaiting: v.onWaiting !== false,
          };
        }
        return {
          dailyBudgetUsd,
          orchestrationBudgetUsd,
          autoSettleAfterDays,
          autoSettleOnMerge,
          prDiffCapLines,
          mcpServers: mcpServers.map(redactDevMcp) as AppSettings["mcpServers"],
          defaultWorktree,
          defaultOrchestrate,
          defaultProvider,
          defaultModel,
          quotaFailover: quotaFailover.slice(),
          onboardingSeen,
          updateChannel,
          notifications,
          feltEstimatePrompt,
          uiScale,
          theme,
          agentsPanelDefault,
          agentsPanelRememberLast,
          stayAwake,
          quotaWaitAutoResume,
          agentProfiles: agentProfiles.map((p) => ({ ...p })),
          defaultOrchestratorProfileId,
          subagentPool: {
            ...subagentPool,
            entries: subagentPool.entries.map((e) => ({ ...e })),
          },
          otel: { ...otel, headers: { ...otel.headers } },
          webhook: { ...webhook },
        };
      },
      async testWebhook() {
        // ponytail: dev browser has no main process to POST from; report the
        // shape the real handler returns so the Settings row stays exercisable.
        if (!webhook.url) return { ok: false, error: "Save an http(s) webhook URL first" };
        return { ok: true, status: 200 };
      },
    },
    stayAwake: {
      // ponytail: no real power blocker in the dev browser; mirror the shape
      // main returns so the sidebar control stays exercisable.
      async status() {
        const anyWorking = threads.some((t) => t.status === "working");
        return {
          mode: stayAwake,
          blocking:
            stayAwake === "on" || (stayAwake === "agent" && anyWorking),
          onBattery: false,
          anyWorking,
        };
      },
    },
    mcp: {
      async list(): Promise<McpServerDefinition[]> {
        return redactMcpServers(mcpServers) as unknown as McpServerDefinition[];
      },
      async save(input: McpServerSaveInput): Promise<McpServerDefinition> {
        mcpServers = upsertMcpServer(mcpServers, input) as McpServerInfo[];
        const saved = mcpServers.find((s) => s.name === input.name);
        if (!saved) throw new Error("MCP save failed");
        return redactDevMcp(saved);
      },
      async remove(input: { name: string }): Promise<void> {
        mcpServers = mcpServers.filter((s) => s.name !== input.name);
      },
      async setEnabled(input: {
        name: string;
        enabled: boolean;
      }): Promise<McpServerDefinition> {
        const existing = mcpServers.find((s) => s.name === input.name);
        if (!existing) throw new Error(`Unknown MCP server: ${input.name}`);
        if (
          existing.transport === "stdio" &&
          input.enabled &&
          existing.trusted !== true
        ) {
          throw new Error("Local MCP server must be trusted to enable");
        }
        mcpServers = mcpServers.map((s) =>
          s.name === input.name ? { ...s, enabled: input.enabled } : s,
        );
        const saved = mcpServers.find((s) => s.name === input.name);
        if (!saved) throw new Error(`Unknown MCP server: ${input.name}`);
        return redactDevMcp(saved);
      },
      async catalog(): Promise<McpCatalogEntry[]> {
        return devMcpCatalogRows(mcpServers);
      },
      async pickImport(): Promise<McpImportPreview | null> {
        return null;
      },
      async previewImport(input: McpPreviewImportInput): Promise<McpImportPreview> {
        if (input.kind === "json") {
          return mcpPreviewFromParsed("json", "JSON", parseMcpConfigDocument(input.text));
        }
        if (input.kind === "github") {
          return mcpPreviewFromParsed(
            "github",
            "github",
            parseMcpConfigDocument({
              mcpServers: { "gh-tools": { url: "https://gh.example.com/mcp" } },
            }),
          );
        }
        const entry = DEV_MCP_CATALOG.find((e) => e.id === input.id);
        if (!entry) throw new Error("Unknown catalog item");
        return mcpPreviewFromParsed(
          "catalog",
          entry.name,
          parseMcpConfigDocument([entry.definition]),
          entry.id,
        );
      },
      async installImport(input: McpInstallRequest): Promise<McpInstallResult> {
        if (!pendingMcpImport || pendingMcpImport.previewId !== input.previewId) {
          throw new Error("Import preview is invalid");
        }
        const selected = new Set(input.selected);
        const installed: McpServerDefinition[] = [];
        for (const row of pendingMcpImport.servers) {
          if (!selected.has(row.stored.name)) continue;
          const entry = { ...row.stored };
          if (pendingMcpImport.catalogId) {
            entry.provenance = "curated";
            entry.catalogId = pendingMcpImport.catalogId;
          } else {
            entry.provenance = "added";
          }
          if (entry.transport === "stdio") {
            const trusted =
              input.trustLocal === true || input.trustLocalCommands === true;
            if (!trusted) {
              throw new Error("Local MCP commands require explicit trust");
            }
            entry.trusted = true;
            entry.enabled = true;
          }
          mcpServers = upsertMcpServer(mcpServers, entry) as McpServerInfo[];
          installed.push(redactMcpServer(entry) as unknown as McpServerDefinition);
        }
        pendingMcpImport = null;
        return { installed };
      },
      async discardImport(input: { previewId: string }): Promise<void> {
        if (pendingMcpImport?.previewId === input.previewId) pendingMcpImport = null;
      },
    },
    skills: {
      async list(input?: { projectPath?: string }): Promise<SkillInfo[]> {
        const out = skillsList.map((s) => ({
          ...s,
          installedIn: [...s.installedIn],
          missingFrom: [...s.missingFrom],
        }));
        if (input?.projectPath) {
          out.push({
            name: "project-conventions",
            description: "Project-local review rules",
            source: "project",
            installedIn: [],
            missingFrom: [],
            bytes: 400,
            provenance: "project",
          });
        }
        return out;
      },
      async add(
        input: SkillWrite,
      ): Promise<{ name: string; installedIn: SkillTarget[] }> {
        if (!/^[a-z0-9-]+$/.test(input.name)) {
          throw new Error("Skill name must be lowercase letters, digits, dashes");
        }
        const installedIn = [...ALL_SKILL_TARGETS];
        skillsList = [
          ...skillsList.filter(
            (s) => !(s.name === input.name && s.source !== "project"),
          ),
          {
            name: input.name,
            description: input.description,
            source: "claude",
            installedIn,
            missingFrom: [],
            bytes: skillMdBytes(input.name, input.description, input.body),
            provenance: "added",
          },
        ];
        return { name: input.name, installedIn: [...installedIn] };
      },
      async remove(input: { name: string }): Promise<void> {
        skillsList = skillsList.filter(
          (s) => !(s.name === input.name && s.source !== "project"),
        );
      },
      async sync(): Promise<{ copied: number; skills: string[] }> {
        const skills: string[] = [];
        let copied = 0;
        skillsList = skillsList.map((s) => {
          if (s.source === "project" || s.missingFrom.length === 0) {
            return {
              ...s,
              installedIn: [...s.installedIn],
              missingFrom: [...s.missingFrom],
            };
          }
          copied += 1;
          skills.push(s.name);
          return {
            ...s,
            installedIn: [...s.installedIn, ...s.missingFrom],
            missingFrom: [],
          };
        });
        return { copied, skills };
      },
      async commands(): Promise<CliSlashCommand[]> {
        return skillsList
          .filter((s) => s.source !== "project")
          .map((s) => ({
            name: `/${s.name}`,
            hint: s.description,
            kind: "insert" as const,
          }));
      },
      async catalog(): Promise<SkillCatalogEntry[]> {
        return [
          {
            id: "ponytail",
            name: "Ponytail",
            description:
              "Lazy senior dev mode. Forces the simplest, shortest solution that actually works.",
            publisher: "Dietrich Gebert",
            sourceUrl: "https://github.com/DietrichGebert/ponytail",
            homepage: "https://github.com/DietrichGebert/ponytail",
            installed: skillsList.some(
              (s) =>
                s.provenance === "curated" && s.origin?.catalogId === "ponytail",
            ),
          },
        ];
      },
      async pickImport(): Promise<SkillImportPreview | null> {
        pendingSkillImport = { kind: "local" };
        return null;
      },
      async previewImport(
        input: SkillPreviewImportInput,
      ): Promise<SkillImportPreview> {
        const fromCatalog = input.kind === "catalog";
        pendingSkillImport = fromCatalog
          ? { kind: "catalog", catalogId: input.id }
          : { kind: "github" };
        return {
          previewId: "0".repeat(32),
          source: {
            kind: fromCatalog ? "catalog" : "github",
            label: fromCatalog ? "Ponytail" : "github",
          },
          skills: [
            {
              name: "review-pr",
              description: "Dev preview skill",
              files: ["SKILL.md"],
              bytes: 80,
              warnings: [],
              collision: skillsList.some((s) => s.name === "review-pr"),
            },
          ],
          plugins: fromCatalog ? ponytailPluginPreviewExtras() : [],
        };
      },
      async installImport(
        input: SkillInstallRequest,
      ): Promise<SkillInstallResult> {
        const installedIn = [...ALL_SKILL_TARGETS];
        const curated =
          pendingSkillImport?.kind === "catalog" &&
          Boolean(pendingSkillImport.catalogId);
        for (const name of input.selected) {
          skillsList = [
            ...skillsList.filter(
              (s) => !(s.name === name && s.source !== "project"),
            ),
            {
              name,
              description: name,
              source: "claude",
              installedIn,
              missingFrom: [],
              bytes: 80,
              provenance: curated ? "curated" : "added",
              origin: curated
                ? { catalogId: pendingSkillImport?.catalogId }
                : undefined,
            },
          ];
        }
        return {
          installed: input.selected.map((name) => ({
            name,
            installedIn: [...installedIn],
          })),
          plugins:
            pendingSkillImport?.kind === "catalog" &&
            pendingSkillImport.catalogId === "ponytail"
              ? ponytailPluginInstallResults(input.trustPluginCode === true)
              : [],
        };
      },
      async discardImport(): Promise<void> {},
    },
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
    workflows: {
      async list() {
        return templates.map(cloneTemplate);
      },
      async save(input) {
        const cleaned = normalizeTemplate(input);
        const existing =
          input.id != null
            ? templates.find((t) => t.id === input.id)
            : undefined;

        // Saving a builtin always creates a copy (never mutates the builtin).
        // Name: append " (copy)" when the submitted name equals the builtin name
        if (existing?.builtin) {
          const renamed =
            cleaned.name.length > 0 &&
            cleaned.name !== String(existing.name || "");
          const copy: WorkflowTemplateInfo = {
            id: id("wf-tpl"),
            name: renamed ? cleaned.name : `${existing.name} (copy)`,
            builtin: false,
            phases: cleaned.phases,
          };
          templates = [...templates, copy];
          return cloneTemplate(copy);
        }

        if (existing) {
          const updated: WorkflowTemplateInfo = {
            id: existing.id,
            name: cleaned.name,
            builtin: false,
            phases: cleaned.phases,
          };
          templates = templates.map((t) =>
            t.id === existing.id ? updated : t,
          );
          return cloneTemplate(updated);
        }

        const created: WorkflowTemplateInfo = {
          id: input.id && input.id.trim() ? input.id.trim() : id("wf-tpl"),
          name: cleaned.name,
          builtin: false,
          phases: cleaned.phases,
        };
        // Guard: never allow overwriting standard via a fresh create with that id.
        if (created.id === "standard" || templates.some((t) => t.id === created.id)) {
          created.id = id("wf-tpl");
        }
        templates = [...templates, created];
        return cloneTemplate(created);
      },
      async remove(input) {
        const tid = String(input.id);
        const existing = templates.find((t) => t.id === tid);
        if (!existing) {
          throw new Error(`Unknown template: ${tid}`);
        }
        if (existing.builtin) {
          throw new Error(`Cannot remove builtin template: ${tid}`);
        }
        templates = templates.filter((t) => t.id !== tid);
      },
    },
    automations: {
      async list() {
        return automationsList.map((a) => ({ ...a }));
      },
      async add(input: AutomationWrite) {
        const fields = normalizeDevAutomation(input, projects, null);
        const created: AutomationInfo = {
          id: id("auto"),
          ...fields,
          lastRunAt: null,
          nextRunAt: nextAutomationFire(fields.preset, fields.hour, now()),
          lastError: null,
        };
        automationsList = [...automationsList, created];
        return { ...created };
      },
      async update(input: Partial<AutomationWrite> & { id: string }) {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
        const fields = normalizeDevAutomation(input, projects, existing);
        const scheduleChanged =
          fields.preset !== existing.preset || fields.hour !== existing.hour;
        const updated: AutomationInfo = {
          ...existing,
          ...fields,
          nextRunAt: scheduleChanged
            ? nextAutomationFire(fields.preset, fields.hour, now())
            : existing.nextRunAt,
        };
        automationsList = automationsList.map((a) =>
          a.id === existing.id ? updated : a,
        );
        return { ...updated };
      },
      async remove(input) {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
        automationsList = automationsList.filter((a) => a.id !== input.id);
      },
      async runNow(input) {
        const existing = automationsList.find((a) => a.id === input.id);
        if (!existing) {
          throw new Error(`Unknown automation: ${input.id}`);
        }
        const firedAt = now();
        const nextRunAt = nextAutomationFire(
          existing.preset,
          existing.hour,
          firedAt,
        );
        try {
          const thread = await api.threads.create({
            projectId: existing.projectId,
            title: existing.name,
          });
          await api.threads.setProvider({
            threadId: thread.id,
            provider: existing.provider,
            model: existing.model,
          });
          await api.runs.start({
            threadId: thread.id,
            prompt: existing.prompt,
          });
          const updated: AutomationInfo = {
            ...existing,
            lastRunAt: firedAt,
            nextRunAt,
            lastError: null,
          };
          automationsList = automationsList.map((a) =>
            a.id === existing.id ? updated : a,
          );
          return { ...updated };
        } catch (err) {
          const updated: AutomationInfo = {
            ...existing,
            lastRunAt: firedAt,
            nextRunAt,
            lastError: err instanceof Error ? err.message : String(err),
          };
          automationsList = automationsList.map((a) =>
            a.id === existing.id ? updated : a,
          );
          throw err;
        }
      },
    },
    projects: {
      async list() {
        return projects.map((p) => ({ ...p }));
      },
      async add(path: string, opts?: { remoteHost?: string; remotePath?: string }) {
        const remoteHost = opts?.remoteHost?.trim() || "";
        const remotePath = opts?.remotePath?.trim() || "";
        if (remoteHost) {
          if (!remotePath) {
            throw new Error("Remote path is required when remote host is set");
          }
          if (!remotePath.startsWith("/")) {
            throw new Error("Remote path must be an absolute path (start with /)");
          }
          const folder =
            remotePath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ||
            "remote";
          const project: ProjectInfo = {
            id: id("proj"),
            slug: folder,
            name: folder,
            path: path || remotePath,
            remoteHost,
            remotePath,
          };
          projects.push(project);
          return { ...project };
        }
        if (/not-a-git|nongit/i.test(path)) {
          throw new Error("Not a git repository...");
        }
        const slug =
          path
            .replace(/\\/g, "/")
            .split("/")
            .filter(Boolean)
            .slice(-2)
            .join("/") || "local/project";
        const project: ProjectInfo = {
          id: id("proj"),
          slug,
          name: slug.includes("/") ? (slug.split("/").pop() ?? slug) : slug,
          path,
        };
        projects.push(project);
        return { ...project };
      },
      async addViaDialog() {
        const n = projects.length + 1;
        return api.projects.add(`/Users/demo/demo-org/project-${n}`);
      },
      async create(input: { name: string; parentDir: string }) {
        const name = input.name.trim();
        const parentDir = input.parentDir.trim().replace(/\/+$/, "");
        if (!name) throw new Error("Project name is required");
        if (name === "." || name === ".." || /[/\\\0]/.test(name)) {
          throw new Error("Project name must be a plain folder name (no slashes)");
        }
        if (!parentDir) throw new Error("Location is required");
        const project: ProjectInfo = {
          id: id("proj"),
          slug: name,
          name,
          path: `${parentDir}/${name}`,
        };
        projects.push(project);
        return { ...project };
      },
      async pickDirectory() {
        // No native dialog in the browser dev mock; cancel like the real one.
        return null;
      },
      async pickIcon() {
        return null;
      },
      async resolveIcon(input: {
        projectId: string;
        iconPath?: string | null;
      }) {
        const project = projects.find((p) => p.id === input.projectId);
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);
        const override =
          input.iconPath === undefined ? project.iconPath : input.iconPath;
        return {
          iconUrl:
            override === null ? null : project.iconUrl ?? null,
        };
      },
      /** Empty host clears the remote fields. */
      async update(input: {
        projectId: string;
        name?: string;
        remoteHost?: string;
        remotePath?: string;
        spaceId?: string;
        iconPath?: string | null;
        setupCommand?: string | null;
        quickActions?: ProjectInfo["quickActions"];
      }) {
        const project = projects.find((p) => p.id === input.projectId);
        if (!project) {
          throw new Error(`Unknown project: ${input.projectId}`);
        }
        if (typeof input.name === "string") {
          const name = input.name.trim();
          if (!name) throw new Error("Name cannot be empty");
          project.name = name;
        }
        if (typeof input.spaceId === "string") {
          const spaceId = input.spaceId.trim();
          if (spaceId && !spaces.some((s) => s.id === spaceId)) {
            throw new Error(`Unknown space: ${spaceId}`);
          }
          if (spaceId) project.spaceId = spaceId;
          else delete project.spaceId;
        }
        if (
          typeof input.remoteHost === "string" ||
          typeof input.remotePath === "string"
        ) {
          const host = (input.remoteHost ?? "").trim();
          const rpath = (input.remotePath ?? "").trim();
          if (host) {
            if (!rpath) {
              throw new Error("Remote path is required when remote host is set");
            }
            if (!rpath.startsWith("/")) {
              throw new Error(
                "Remote path must be an absolute path (start with /)",
              );
            }
            project.remoteHost = host;
            project.remotePath = rpath;
          } else {
            delete project.remoteHost;
            delete project.remotePath;
          }
        }
        if (Object.prototype.hasOwnProperty.call(input, "iconPath")) {
          if (input.iconPath) project.iconPath = input.iconPath;
          else {
            delete project.iconPath;
            delete project.iconUrl;
          }
        }
        if (Object.prototype.hasOwnProperty.call(input, "setupCommand")) {
          const cmd =
            typeof input.setupCommand === "string"
              ? input.setupCommand.trim()
              : "";
          if (cmd) project.setupCommand = cmd;
          else delete project.setupCommand;
        }
        if (Object.prototype.hasOwnProperty.call(input, "quickActions")) {
          const rows = Array.isArray(input.quickActions)
            ? input.quickActions.filter((a) => a && a.name && a.command)
            : [];
          if (rows.length) project.quickActions = rows;
          else delete project.quickActions;
        }
        return { ...project };
      },
      /** Drops the project entry + its thread history. Repo on disk untouched. */
      async remove(input: { projectId: string }) {
        const projectId = String(input.projectId ?? "");
        if (!projects.some((p) => p.id === projectId)) {
          throw new Error(`Unknown project: ${projectId}`);
        }
        for (const t of threads.filter((t) => t.projectId === projectId)) {
          clearRunTimer(t.id);
          runStates.delete(t.id);
          clearedDiff.delete(t.id);
          details.delete(t.id);
        }
        threads = threads.filter((t) => t.projectId !== projectId);
        projects = projects.filter((p) => p.id !== projectId);
        emitThreads();
      },
      async codeMap(input: { projectId: string }): Promise<ProjectCodeMap> {
        const project = projects.find((p) => p.id === input.projectId);
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);
        return {
          projectId: project.id,
          updatedAt: Date.now() - 5 * 60_000,
          fileCount: 42,
          symbolCount: 180,
          headSha: "abc1234deadbeef",
          defaultBranch: "main",
          modules: [
            {
              name: "src",
              fileCount: 20,
              symbolCount: 90,
              hot: [
                { path: "src/App.tsx", symbols: ["App"], rank: 12 },
                { path: "src/useCoder.ts", symbols: ["useCoder"], rank: 10 },
              ],
            },
            {
              name: "electron",
              fileCount: 22,
              symbolCount: 90,
              hot: [
                { path: "electron/runner.js", symbols: ["createRunner"], rank: 20 },
              ],
            },
          ],
          dependencies: ["react", "electron"],
        };
      },
      async lintAgentConfig(input: {
        projectId: string;
      }): Promise<AgentConfigDoctorReport> {
        const project = projects.find((p) => p.id === input.projectId);
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);
        const considered = memoryEntries.filter(
          (e) =>
            e.type === "convention" ||
            e.type === "strategy" ||
            e.type === "knowledge",
        );
        return {
          projectId: project.id,
          files: [],
          score: 0,
          grade: "F",
          memory: {
            considered: considered.length,
            covered: 0,
            missing: considered.map((e) => ({
              id: e.id,
              type: e.type,
              title: e.title,
            })),
          },
          issues: [
            {
              severity: "error",
              message: "No AGENTS.md / CLAUDE.md (or sibling) in this repo",
            },
          ],
          recommendations: [
            "Generate AGENTS.md from shared memory so every agent reads the same conventions",
          ],
        };
      },
      async previewAgentConfig(input: {
        projectId: string;
        targets?: string[];
      }): Promise<AgentConfigPreview> {
        const project = projects.find((p) => p.id === input.projectId);
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);
        const lines = [
          `# ${project.name}`,
          "",
          "Standing instructions generated from Solenta shared memory.",
          "",
          "<!-- generated-by: solenta-config-doctor -->",
          "",
        ];
        for (const e of memoryEntries) {
          if (e.type !== "convention" && e.type !== "strategy") continue;
          lines.push(`### ${e.title}`, "", e.body, "");
        }
        const targets = input.targets?.length ? input.targets : ["AGENTS.md"];
        return {
          projectId: project.id,
          files: targets.map((p) => ({
            path: p,
            content: lines.join("\n"),
            exists: false,
          })),
        };
      },
      async writeAgentConfig(): Promise<AgentConfigWriteResult> {
        throw new Error("Config doctor writes are not available in browser dev");
      },
    },
    spaces: {
      async list() {
        return spaces.map((s) => ({ ...s }));
      },
      async add(input: { name: string }) {
        const name = String(input?.name ?? "").trim();
        if (!name) throw new Error("Name cannot be empty");
        const created = { id: id("space"), name };
        spaces.push(created);
        return { ...created };
      },
      async update(input: { id: string; name: string }) {
        const found = spaces.find((s) => s.id === input.id);
        if (!found) throw new Error(`Unknown space: ${input.id}`);
        const name = String(input?.name ?? "").trim();
        if (!name) throw new Error("Name cannot be empty");
        found.name = name;
        return { ...found };
      },
      async remove(input: { id: string }) {
        const spaceId = String(input?.id ?? "");
        if (!spaces.some((s) => s.id === spaceId)) {
          throw new Error(`Unknown space: ${spaceId}`);
        }
        spaces = spaces.filter((s) => s.id !== spaceId);
        for (const p of projects) {
          if (p.spaceId === spaceId) delete p.spaceId;
        }
      },
    },
    threads: {
      async list() {
        return threads.map((t) => ({ ...t }));
      },
      /** Team-view rows: newest assistant line per thread. */
      async summaries() {
        return threads.map((t) => {
          const msgs = details.get(t.id)?.messages ?? [];
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
            runStartedAt: t.runStartedAt ?? null,
            stoppedAt: t.stoppedAt ?? null,
            awaitingInput: t.awaitingInput === true,
            stalledAt: t.stalledAt ?? null,
            lastActivity: last
              ? {
                  text: last.text.split(/\r?\n/, 1)[0].trim(),
                  at: last.createdAt || t.updatedAt,
                }
              : null,
          };
        });
      },
      /**
       * Seeded crew so `npm run dev:browser` has a task list to render
       * (issue #277). Read-only here — the real store owns mutations.
       */
      async crewTasks(input: { threadId: string }): Promise<{
        rootThreadId: string;
        tasks: CrewTaskView[];
      }> {
        const known = threads.some((t) => t.id === input.threadId);
        return {
          rootThreadId: mockData.activeThreadId,
          tasks: known ? SEED_CREW_TASKS.map((t) => ({ ...t })) : [],
        };
      },
      /**
       * Full-content search: title + notes + message text, case-insensitive
       * substring, newest activity first, max 50. Includes archived. 0–1
       * char → [].
       */
      async search(input: { query: string }): Promise<ThreadInfo[]> {
        const q = input.query.trim().toLowerCase();
        if (q.length < 2) return [];

        const seen = new Set<string>();
        const hits: ThreadInfo[] = [];

        for (const t of threads) {
          if (seen.has(t.id)) continue;
          let match = t.title.toLowerCase().includes(q);
          if (!match) {
            match = (t.notes || "").toLowerCase().includes(q);
          }
          if (!match) {
            const detail = details.get(t.id);
            if (detail) {
              match = detail.messages.some((m) =>
                m.text.toLowerCase().includes(q),
              );
            }
          }
          if (!match) continue;
          seen.add(t.id);
          hits.push({ ...t });
        }

        hits.sort((a, b) => b.updatedAt - a.updatedAt);
        return hits.slice(0, 50);
      },
      async create(input) {
        const t = newThread({
          projectId: input.projectId,
          title: input.title || "New Thread",
          baseBranch: input.baseBranch?.trim() || null,
          // Lazy worktree: only the intent is recorded, the fake worktree
          // materializes at first run. An orchestrator holds neither — its
          // worker does.
          pendingWorktree:
            input.ask !== true &&
            input.orchestrate !== true &&
            input.worktree === true,
          pendingFork: input.ask !== true && input.orchestrate === true,
          ask: input.ask === true,
          issueNumber: input.issueNumber ?? null,
          ...(input.teach === true
            ? { teach: { autonomy: "hint" as const, reviewsPassed: 0 } }
            : {}),
        });
        return registerThread(t);
      },
      async fork(input) {
        const sourceDetail = details.get(input.threadId);
        if (!sourceDetail) throw new Error(`Unknown thread: ${input.threadId}`);
        const source = sourceDetail.thread;
        const providerChanging =
          input.provider != null && String(input.provider) !== source.provider;
        const created = newThread({
          projectId: source.projectId,
          title: `Fork: ${source.title || "New Thread"}`,
          provider: input.provider ? String(input.provider) : source.provider,
          // A model belongs to the provider that offered it.
          model: input.model
            ? String(input.model).trim()
            : providerChanging
              ? null
              : source.model,
          permissionMode: source.permissionMode,
          teach: source.teach ?? null,
          ask: source.ask === true,
          handoffFrom: source.id,
        });
        return registerThread(created);
      },
      /**
       * Edit-and-resubmit rewind (issue #254). Fixture twin of
       * services.rewindThread: truncate at the target user message, clear the
       * session, arm the one-shot context replay. Dev threads have no
       * worktree, so restoreFiles never resolves a checkpoint here.
       */
      async rewind(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Unknown thread: ${input.threadId}`);
        if (detail.thread.status === "working") {
          throw new Error("Cannot rewind while a run is active");
        }
        if (!String(input.prompt ?? "").trim()) {
          throw new Error("Prompt cannot be empty");
        }
        const at = detail.messages.findIndex((m) => m.id === input.messageId);
        if (at < 0 || detail.messages[at]!.role !== "user") {
          throw new Error(`Not a user message: ${input.messageId}`);
        }
        const dropped = detail.messages.slice(at);
        const droppedRuns = new Set(
          dropped.map((m) => m.runId).filter((r): r is string => !!r),
        );
        detail.messages = detail.messages.slice(0, at);
        detail.workLog = detail.workLog.filter(
          (w) => !w.runId || !droppedRuns.has(w.runId),
        );
        const thread = patchThread(input.threadId, {
          sessionId: null,
          replayContext: true,
        });
        return { thread, droppedMessages: dropped.length, restoredSha: null };
      },
      async get(threadId) {
        const d = details.get(threadId);
        if (!d) throw new Error(`Thread not found: ${threadId}`);
        const row = threads.find((t) => t.id === threadId);
        // Selecting IS visiting; visiting is not activity, so updatedAt stays.
        const visitedAt = now();
        if (row) {
          row.lastVisitedAt = visitedAt;
          d.thread = { ...row };
          syncThreadRow(row);
        } else {
          d.thread = { ...d.thread, lastVisitedAt: visitedAt };
        }
        return cloneDetail(d);
      },
      async peek(threadId) {
        const d = details.get(threadId);
        if (!d) throw new Error(`Thread not found: ${threadId}`);
        return cloneDetail(d);
      },
      async setPermissionMode(input) {
        return patchThread(input.threadId, {
          permissionMode: input.mode,
          updatedAt: now(),
        });
      },
      async respondPermission() {
        // Dev threads never spawn a real CLI, so nothing is ever pending.
        throw new Error("No active agent run for this thread");
      },
      async clearQuestion(input) {
        // Persisted, unlike a permission prompt — so this one is real even
        // in the dev provider (issue #647).
        patchThread(input.threadId, { pendingQuestion: null });
      },
      // Bookkeeping setters below leave updatedAt alone: visiting, pinning and
      // settling are not activity. The rules they used to mirror (invalid
      // override, settle-while-working, pin/settle mutual exclusion, past
      // snooze times, unsupported effort levels) live in electron/services.js.
      async setArchived(input) {
        return patchThread(input.threadId, { archived: input.archived });
      },
      async setSettled(input: {
        threadId: string;
        override: "settled" | "active" | null;
      }) {
        return patchThread(input.threadId, {
          settledOverride: input.override,
          settledAt: input.override != null ? now() : null,
          ...(input.override === "settled"
            ? { snoozedUntil: null, snoozedAt: null, pinnedAt: null }
            : {}),
        });
      },
      async setPinned(input: { threadId: string; pinned: boolean }) {
        return patchThread(input.threadId, {
          pinnedAt: input.pinned ? now() : null,
        });
      },
      async setQueued(input: {
        threadId: string;
        prompt: string | null;
        attachments?: AttachmentInfo[];
        replace?: boolean;
      }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        let queued: ThreadInfo["queued"] = null;
        if (input.prompt !== null && input.replace === true) {
          queued = { prompt: input.prompt };
          if (input.attachments?.length) queued.attachments = input.attachments;
        } else if (input.prompt !== null) {
          const prev = detail.thread.queued;
          const files = [
            ...(prev?.attachments ?? []),
            ...(input.attachments ?? []),
          ];
          queued = {
            prompt: prev ? `${prev.prompt}\n\n${input.prompt}` : input.prompt,
            attachments: files.length ? files : undefined,
          };
        }
        return patchThread(input.threadId, { queued });
      },
      async setSnoozed(input: { threadId: string; until: number | null }) {
        return patchThread(input.threadId, {
          snoozedUntil: input.until ?? null,
          snoozedAt: input.until == null ? null : now(),
        });
      },
      async setMuted(input: { threadId: string; muted: boolean }) {
        return patchThread(input.threadId, { muted: input.muted });
      },
      async setCrossThreadInbound(input: {
        threadId: string;
        policy: "accept" | "queue-only" | "refuse";
      }) {
        return patchThread(input.threadId, {
          crossThreadInbound:
            input.policy === "queue-only" || input.policy === "refuse"
              ? input.policy
              : undefined,
        });
      },
      async setQuotaWaitAutoResume(input: {
        threadId: string;
        enabled: boolean | null;
      }) {
        return patchThread(input.threadId, {
          quotaWaitAutoResume: input.enabled,
        });
      },
      async setNotes(input: { threadId: string; notes: string }) {
        return patchThread(input.threadId, {
          notes: String(input.notes ?? "").trim().slice(0, 2000),
        });
      },
      async setBaseBranch(input: {
        threadId: string;
        baseBranch?: string | null;
      }) {
        return patchThread(input.threadId, {
          baseBranch: input.baseBranch
            ? String(input.baseBranch).trim() || null
            : null,
        });
      },
      async resolveSuggestion(input: {
        threadId: string;
        suggestionId: string;
        status: "started" | "filed" | "dismissed";
        startedThreadId?: string;
        issueNumber?: number;
      }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        return patchThread(input.threadId, {
          suggestions: (detail.thread.suggestions ?? []).map((s) =>
            s.id === input.suggestionId
              ? {
                  ...s,
                  status: input.status,
                  ...(input.startedThreadId
                    ? { startedThreadId: input.startedThreadId }
                    : {}),
                  ...(input.issueNumber != null
                    ? { issueNumber: input.issueNumber }
                    : {}),
                }
              : s,
          ),
        });
      },
      async setFeltEstimate(input: {
        threadId: string;
        savedMs: number | null;
      }) {
        const at = Date.now();
        return patchThread(input.threadId, {
          feltEstimate:
            input.savedMs == null
              ? { kind: "declined" as const, at }
              : {
                  kind: "saved" as const,
                  savedMs: Math.max(0, Number(input.savedMs)),
                  at,
                },
        });
      },
      // Spec mode (issue #269). The demo has no agent to write artifacts, so
      // a fixture stage lands already submitted — that is the state worth
      // seeing in the browser twin.
      async startSpec(input: { threadId: string }) {
        const existing = threads.find((t) => t.id === input.threadId);
        if (existing?.spec) return { ...existing };
        return patchThread(input.threadId, {
          spec: { slug: "spec", stage: "requirements", awaitingApproval: true },
        });
      },
      async stopSpec(input: { threadId: string }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        if (!detail.thread.spec) return { ...detail.thread };
        const thread = { ...detail.thread };
        delete thread.spec;
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
      },
      async reviewSpec(input: {
        threadId: string;
        decision: "approve" | "revise";
        feedback?: string;
      }) {
        const spec = threads.find((t) => t.id === input.threadId)?.spec;
        if (!spec) throw new Error("Thread is not in spec mode");
        const order = SPEC_ARTIFACTS;
        const next = order[order.indexOf(spec.stage as SpecArtifact) + 1];
        const stage =
          input.decision === "approve" ? (next ?? "build") : spec.stage;
        return patchThread(input.threadId, {
          spec: { ...spec, stage, awaitingApproval: stage !== "build" },
        });
      },
      async specArtifact(input: { threadId: string; stage: SpecArtifact }) {
        const slug =
          threads.find((t) => t.id === input.threadId)?.spec?.slug ?? "spec";
        return {
          path: `${SPEC_DIR}/${slug}/${input.stage}.md`,
          text: DEV_SPEC_ARTIFACTS[input.stage],
        };
      },
      async dispatchSpec(input: { threadId: string }) {
        const existing = threads.find((t) => t.id === input.threadId);
        if (!existing) throw new Error(`Thread not found: ${input.threadId}`);
        if (!existing.spec) throw new Error("Thread is not in spec mode");
        if (existing.spec.stage !== "build") {
          throw new Error("Dispatch is available after tasks.md is approved");
        }
        return { thread: { ...existing }, dispatched: [] };
      },
      async convergeSpec(input: { threadId: string }) {
        const existing = threads.find((t) => t.id === input.threadId);
        if (!existing) throw new Error(`Thread not found: ${input.threadId}`);
        if (!existing.spec) throw new Error("Thread is not in spec mode");
        if (existing.spec.stage !== "build") {
          throw new Error("Converge is available after tasks.md is approved");
        }
        return { ...existing };
      },
      async startTeach(input: { threadId: string }) {
        const existing = threads.find((t) => t.id === input.threadId);
        if (existing?.teach) return { ...existing };
        return patchThread(input.threadId, {
          teach: { autonomy: "hint", reviewsPassed: 0 },
          ...(existing &&
          existing.permissionMode !== "default" &&
          existing.permissionMode !== "plan"
            ? { permissionMode: "default" as const }
            : {}),
        });
      },
      async stopTeach(input: { threadId: string }) {
        return patchThread(input.threadId, { teach: null });
      },
      async startAsk(input: { threadId: string }) {
        const existing = threads.find((t) => t.id === input.threadId);
        if (existing?.ask) return { ...existing };
        return patchThread(input.threadId, {
          ask: true,
          pendingWorktree: false,
          teach: null,
        });
      },
      async stopAsk(input: { threadId: string; worktree?: boolean }) {
        return patchThread(input.threadId, {
          ask: false,
          ...(input.worktree ? { pendingWorktree: true } : {}),
        });
      },
      async btw(input: { threadId: string; question: string }) {
        const existing = details.get(input.threadId)?.thread;
        if (!existing) throw new Error(`Thread not found: ${input.threadId}`);
        const question = String(input.question || "").trim();
        if (!question) throw new Error("Side question is empty");
        const card = {
          id: id("btw"),
          question,
          status: "running" as const,
          createdAt: now(),
        };
        const running = patchThread(input.threadId, {
          btw: [...(existing.btw ?? []), card],
        });
        setTimeout(() => {
          const live = details.get(input.threadId)?.thread;
          if (!live) return;
          const cards = (live.btw ?? []).map((c) =>
            c.id === card.id
              ? {
                  ...c,
                  status: "done" as const,
                  answer: `(dev) ${c.question}`,
                  source: "retrieval" as const,
                }
              : c,
          );
          if (!cards.some((c) => c.id === card.id)) return;
          patchThread(input.threadId, { btw: cards });
        }, 400);
        return running;
      },
      async dismissBtw(input: { threadId: string; id: string }) {
        const existing = details.get(input.threadId)?.thread;
        if (!existing) throw new Error(`Thread not found: ${input.threadId}`);
        const remaining = (existing.btw ?? []).filter((c) => c.id !== input.id);
        return patchThread(input.threadId, {
          btw: remaining.length ? remaining : undefined,
        });
      },
      async promoteBtw(input: { threadId: string; id: string }) {
        const existing = details.get(input.threadId)?.thread;
        if (!existing) throw new Error(`Thread not found: ${input.threadId}`);
        const card = (existing.btw ?? []).find((c) => c.id === input.id);
        if (!card) throw new Error(`Unknown side question: ${input.id}`);
        const remaining = (existing.btw ?? []).filter((c) => c.id !== input.id);
        const prev = existing.queued;
        return patchThread(input.threadId, {
          btw: remaining.length ? remaining : undefined,
          queued: {
            prompt: prev ? `${prev.prompt}\n\n${card.question}` : card.question,
            attachments: prev?.attachments,
          },
        });
      },
      async requestTeachReview(input: { threadId: string }) {
        const existing = threads.find((t) => t.id === input.threadId);
        if (!existing?.teach) throw new Error("Thread is not in teach mode");
        return { ...existing };
      },
      async rename(input: { threadId: string; title: string }) {
        const title = String(input.title ?? "").trim().slice(0, TITLE_MAX);
        if (!title) throw new Error("Thread title cannot be empty");
        if (!details.get(input.threadId)) {
          throw new Error(`Unknown thread: ${input.threadId}`);
        }
        return patchThread(input.threadId, { title });
      },
      async setReasoningEffort(input: {
        threadId: string;
        effort: ReasoningEffort | null;
      }) {
        return patchThread(input.threadId, { reasoningEffort: input.effort });
      },
      async setWebSearch(input: {
        threadId: string;
        webSearch: boolean;
      }) {
        return patchThread(input.threadId, {
          webSearch: input.webSearch === true,
        });
      },
      async setVerifyCommand(input: {
        threadId: string;
        command: string | null;
      }) {
        const command = String(input.command ?? "").trim().slice(0, 500);
        return patchThread(input.threadId, {
          verifyCommand: command || null,
        });
      },
      async runVerify(input: { threadId: string }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const command = detail.thread.verifyCommand;
        if (!command) throw new Error("No verify command set for this thread");
        // Fixture: alternate pass/fail so both evidence states are reachable
        // in the browser demo. The real spawn lives in electron/verify.js.
        const ok = (detail.thread.verify?.attempt ?? 0) % 2 === 0;
        const result: VerifyResult = {
          runId: "manual",
          command,
          ok,
          exitCode: ok ? 0 : 1,
          timedOut: false,
          log: ok
            ? "Test files 12 passed (12)\nTests 148 passed (148)"
            : "FAIL src/threadSettle.test.ts > settles a merged PR\nExpected true, got false\n\n1 failed | 147 passed",
          sha: "a1b2c3d",
          durationMs: 4200,
          at: now(),
          attempt: (detail.thread.verify?.attempt ?? 0) + 1,
        };
        patchThread(input.threadId, { verify: result });
        return result;
      },
      async runCommand(input: { threadId: string; actionId?: string }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const project = projects.find((p) => p.id === detail.thread.projectId);
        const actionId = input.actionId || "setup";
        let name = "setup";
        let command = project?.setupCommand || "";
        if (actionId !== "setup") {
          const row = (project?.quickActions ?? []).find((a) => a.id === actionId);
          if (!row) throw new Error("Unknown quick action");
          name = row.name;
          command = row.command;
        } else if (!command) {
          throw new Error("No setup command set for this project");
        }
        const result: CommandRunResult = {
          name,
          command,
          ok: true,
          exitCode: 0,
          timedOut: false,
          log: "ok",
          durationMs: 12,
          at: now(),
        };
        detail.messages.push({
          id: id("evt"),
          role: "event",
          text: `[${name}] ok in 0.0s`,
          createdAt: now(),
        });
        return result;
      },
      async setProvider(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const thread = detail.thread;

        // Fixture: assign what the picker sends. The rules (unknown provider,
        // run-active refusal, session drop, effort reset) live in
        // electron/services.js setProvider and are exercised by npm run dev.
        const patch: Partial<ThreadInfo> = {};
        if (Object.prototype.hasOwnProperty.call(input, "provider")) {
          patch.provider = String(input.provider);
          if (patch.provider !== thread.provider) {
            patch.sessionId = null;
            patch.model = null;
            patch.reasoningEffort = null;
          }
        }
        if (Object.prototype.hasOwnProperty.call(input, "model")) {
          patch.model = input.model ? String(input.model).trim() : null;
        }

        const next: ThreadInfo = { ...thread, ...patch };
        detail.thread = next;
        details.set(input.threadId, detail);
        syncThreadRow(next);
        emitDetail(detail);
        return { ...next };
      },
      async delete(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        if (
          detail.thread.status === "working" ||
          runTimers.has(input.threadId)
        ) {
          throw new Error("Cannot delete thread while a run is active");
        }
        if (detail.thread.worktreePath) {
          throw new Error(
            "Thread still has a worktree. Merge or delete it in the Git tab first.",
          );
        }
        clearRunTimer(input.threadId);
        runStates.delete(input.threadId);
        clearedDiff.delete(input.threadId);
        details.delete(input.threadId);
        threads = threads.filter((t) => t.id !== input.threadId);
        emitThreads();
      },
    },
    runs: {
      async start(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);

        if (
          detail.thread.status === "working" ||
          runTimers.has(input.threadId)
        ) {
          throw new Error("A run is already active on this thread");
        }

        assertUnderBudget();

        const prompt = input.prompt.trim();
        const t = now();
        const runId = id("run");
        const kind: RunState["kind"] = isSimulate(detail.thread)
          ? "simulate"
          : "session";
        const run: RunState = {
          runId,
          announced: new Set(),
          settled: new Set(),
          assistantMsgId: null,
          sessionStep: 0,
          kind,
          workflowStep: 0,
          costBaseline: detail.usage?.costUsd ?? 0,
        };
        runStates.set(input.threadId, run);

        detail.messages.push({
          id: id("msg"),
          role: "user",
          text: prompt,
          createdAt: t,
          runId,
        });

        let thread = { ...detail.thread };
        // A forked thread carries its source transcript on the first turn.
        // electron/services.js buildHandoffPrefix builds the real digest; dev
        // never spawns a CLI, so only the work-log line is visible.
        if (thread.handoffFrom && !thread.sessionId) {
          detail.workLog.push({
            id: id("wl"),
            runId,
            label: "Hand-off context injected",
            done: true,
            timestamp: t,
          });
        }

        // A worktree the demo asked for appears at first run.
        if (thread.pendingWorktree && !thread.worktreePath) {
          thread = { ...thread, ...fakeWorktree(thread) };
        }

        if (thread.title === "New Thread") {
          const firstLine =
            prompt.split("\n")[0]?.slice(0, TITLE_MAX) || "New Thread";
          thread = { ...thread, title: firstLine };
        }

        // Persist a session id after the first turn so follow-ups resume.
        if (!thread.sessionId) {
          thread = { ...thread, sessionId: id("sess") };
        }

        // Real activity clears a stale "settled" pin.
        // An explicit "active" pin survives.
        thread = {
          ...thread,
          status: "working",
          updatedAt: t,
          runStartedAt: t,
          stoppedAt: null,
          ...(thread.settledOverride === "settled"
            ? { settledOverride: null, settledAt: null }
            : {}),
        };
        detail.thread = thread;

        if (kind === "simulate") {
          detail.workflow = createFreshWorkflow();
          detail.workflow = advanceWorkflow(detail.workflow);
          syncWorkLogForWorkflow(detail, run, t);
          detail.messages.push({
            id: id("evt"),
            role: "event",
            text: `Kicked off ${detail.workflow.total} subagents`,
            createdAt: t + 1,
            runId,
          });
          streamAssistant(detail, run, t + 2);
        } else {
          detail.workflow = null;
          // First session tick immediately so the UI isn't empty for 700ms.
          tickSessionRun(detail, run, t + 1);
        }

        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        startRunTimer(input.threadId);
        return { runId };
      },
      async startWorkflow(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);

        if (
          detail.thread.status === "working" ||
          runTimers.has(input.threadId)
        ) {
          throw new Error("A run is already active on this thread");
        }

        assertUnderBudget();

        const templateId = input.templateId?.trim() || "standard";
        const template = templates.find((t) => t.id === templateId);
        if (!template) {
          throw new Error(`Unknown workflow template: ${templateId}`);
        }

        // Backend validates phase providers at start (naming the unavailable one).
        for (const phase of template.phases) {
          const prov = DEV_PROVIDERS.find((p) => p.id === phase.provider);
          if (!prov) {
            throw new Error(
              `Provider "${phase.provider}" is not available`,
            );
          }
          if (!prov.available) {
            throw new Error(
              `Provider "${phase.provider}" is not available`,
            );
          }
        }

        const prompt = input.prompt.trim();
        const t = now();
        const runId = id("run");
        const run: RunState = {
          runId,
          announced: new Set(),
          settled: new Set(),
          assistantMsgId: null,
          sessionStep: 0,
          kind: "workflow",
          workflowStep: 0,
          phaseInstructions: template.phases.map((p) => p.instruction),
          costBaseline: detail.usage?.costUsd ?? 0,
        };
        runStates.set(input.threadId, run);

        detail.messages.push({
          id: id("msg"),
          role: "user",
          text: prompt,
          createdAt: t,
          runId,
        });

        let thread = { ...detail.thread };
        if (thread.pendingWorktree && !thread.worktreePath) {
          thread = { ...thread, ...fakeWorktree(thread) };
        }
        if (thread.title === "New Thread") {
          const firstLine =
            prompt.split("\n")[0]?.slice(0, TITLE_MAX) || "New Thread";
          thread = { ...thread, title: firstLine };
        }

        if (!thread.sessionId) {
          thread = { ...thread, sessionId: id("sess") };
        }

        // Real activity clears a stale "settled" pin.
        // An explicit "active" pin survives.
        thread = {
          ...thread,
          status: "working",
          updatedAt: t,
          runStartedAt: t,
          stoppedAt: null,
          ...(thread.settledOverride === "settled"
            ? { settledOverride: null, settledAt: null }
            : {}),
        };
        detail.thread = thread;

        detail.workflow = createWorkflowFromTemplate(template);
        syncWorkLogForWorkflow(detail, run, t);
        detail.messages.push({
          id: id("evt"),
          role: "event",
          text: buildKickoffText(detail.workflow, template.phases),
          createdAt: t + 1,
          runId,
        });

        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        startRunTimer(input.threadId);
        return { runId };
      },
      async resumeQuotaWait(input: { threadId: string }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        if (detail.thread.status !== "quota-wait") {
          throw new Error("Thread is not waiting on a provider quota reset");
        }
        return this.start({ threadId: input.threadId, prompt: "continue" });
      },
      async stop(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);

        clearRunTimer(input.threadId);

        const t = now();
        const run = runStates.get(input.threadId);
        settleRunSpend(detail, run);
        // Mark any in-flight tools done so cards settle.
        for (const m of detail.messages) {
          if (m.role === "tool" && m.tool && !m.tool.done && m.runId === run?.runId) {
            m.tool.done = true;
            m.tool.isError = true;
            m.tool.output = m.tool.output ?? "Stopped";
          }
        }
        if (detail.workflow) {
          const phases = detail.workflow.phases.map((p) => ({
            ...p,
            agents: p.agents.map((a) =>
              a.status === "running"
                ? { ...a, status: "failed" as const }
                : a,
            ),
          }));
          detail.workflow = recomputeWorkflow(phases, {
            ...detail.workflow,
            complete: false,
          });
        }
        const thread: ThreadInfo = {
          ...detail.thread,
          status: "idle",
          updatedAt: t,
          runStartedAt: null,
          stoppedAt: t,
        };
        detail.thread = thread;
        detail.messages.push({
          id: id("evt"),
          role: "event",
          text: "Run stopped",
          createdAt: t,
          runId: run?.runId,
        });
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
      },
      async distill() {
        return {
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
        };
      },
    },
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
      async status(_projectId) {
        return {
          isRepo: true,
          branch: "main",
          dirty: false,
        };
      },
      async listBranches(_input) {
        return { defaultBranch: "main", branches: ["main"] };
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
        if (!project) return { ok: true, prs: [] };
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
        return { ok: true, prs };
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
        // Fixture: drop the newer checkpoints and stamp the transcript. The
        // guards and the real `git reset --hard` are in electron/worktrees.js.
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Unknown thread: ${input.threadId}`);
        const list = checkpointsByThread.get(input.threadId) || [];
        const want = String(input.sha || "").trim();
        const idx = list.findIndex((c) => c.sha.startsWith(want));
        if (idx < 0) throw new Error(`Unknown checkpoint: ${input.sha}`);
        checkpointsByThread.set(input.threadId, list.slice(idx));
        detail.messages.push({
          id: id("msg"),
          role: "event",
          text: `Restored checkpoint turn ${list[idx]!.turn} (${list[idx]!.sha.slice(0, 7)})`,
          createdAt: now(),
        });
        details.set(input.threadId, detail);
        emitDetail(detail);
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
      async list(input: { threadId: string; query?: string }) {
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
        return { files: all.filter((f) => !q || f.toLowerCase().includes(q)) };
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
