/**
 * In-memory CoderApi for plain Vite browser dev (no Electron preload).
 * Seeded from mockData so the built SPA remains demoable.
 *
 * Real provider sessions (provider !== "simulate"): streams text + tool cards,
 * accumulates SessionUsage, no workflow. Simulate provider keeps the old
 * multi-agent workflow tick for the seeded mid-run demo.
 */
import type {
  ActivityItem,
  AgentView,
  AppSettings,
  AppStatus,
  AutomationInfo,
  UpdateStatus,
  AutomationWrite,
  ChatMessage,
  CheckpointInfo,
  CoderApi,
  RunStatInfo,
  DiffResult,
  DevServerState,
  FetchIssueResult,
  LocalServerInfo,
  MemoryEntryInfo,
  McpServerInfo,
  PermissionMode,
  PrCheckInfo,
  PrInfo,
  ProjectInfo,
  ProviderInfo,
  ReasoningEffort,
  SessionUsage,
  SkillInfo,
  SkillWrite,
  ThreadDetail,
  ThreadInfo,
  WorkLogItem,
  WorkflowPhaseSpec,
  WorkflowTemplateInfo,
  WorkflowView,
} from "./shared/ipc";
import { buildActivity } from "./activity.ts";
import { mockData } from "./mockData.ts";

const MEMORY_EXCERPT_LEN = 160;
const MEMORY_NOT_FOUND = "Memory entry not found";

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
  };
}

function seedMemoryEntries(t0: number): MemoryRow[] {
  const hours = (h: number) => toIso(t0 - h * 60 * 60 * 1000);
  return [
    {
      id: "mem-seed-1",
      type: "convention",
      title: "Never use em dashes in UI copy",
      body: "Global preference: do not use em dashes in user-facing strings. Prefer periods, commas, colons, parentheses, or a plain hyphen.",
      project: null,
      importance: 5,
      createdAt: hours(48),
      updatedAt: hours(6),
    },
    {
      id: "mem-seed-2",
      type: "knowledge",
      title: "Worktree dirty reject marker",
      body: "Git removeWorktree rejections that list dirty paths are prefixed with WORKTREE_DIRTY: so the Git tab can strip Electron invoke wrappers and show only the file list.",
      project: "coder",
      importance: 4,
      createdAt: hours(36),
      updatedAt: hours(12),
    },
    {
      id: "mem-seed-3",
      type: "task",
      title: "Add Memory tab to renderer",
      body: "Right panel third tab with search, recent list, expand-to-full get, and store form. Dev stub always running.",
      project: "coder",
      importance: 3,
      createdAt: hours(4),
      updatedAt: hours(1),
    },
    {
      id: "mem-seed-4",
      type: "knowledge",
      title: "Session usage only after first turn",
      body: "ThreadDetail.usage stays null until the provider reports tokens. Session card shows \"No usage yet\" in that state.",
      project: "acme/nebula",
      importance: 3,
      createdAt: hours(72),
      updatedAt: hours(24),
    },
    {
      id: "mem-seed-5",
      type: "run",
      title: "Simulate workflow mid-run seed",
      body: "The active simulate thread boots with a half-settled workflow so Agents tab demos live phase chips without starting a run.",
      project: "coder",
      importance: 1,
      createdAt: hours(10),
      updatedAt: hours(8),
    },
    {
      id: "mem-seed-6",
      type: "convention",
      title: "selectedRef guard after await",
      body: "Any useCoder action that applies results to state after an await must check selectedRef.current still matches the thread id captured before the call.",
      project: null,
      importance: 5,
      createdAt: hours(20),
      updatedAt: hours(2),
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

/** Mirrors electron/providers.js registry for browser/dev demos. */
const DEV_PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ],
    modelInfo: [
      {
        id: "claude-fable-5",
        label: "Fable",
        description: "Fast everyday coding and chat",
        vendor: "Anthropic",
        recommended: true,
      },
      {
        id: "claude-opus-5",
        label: "Opus 5",
        description: "Deepest reasoning for hard problems",
        vendor: "Anthropic",
      },
      {
        id: "claude-sonnet-5",
        label: "Sonnet 5",
        description: "Best for everyday complex tasks",
        vendor: "Anthropic",
      },
      {
        id: "claude-haiku-4-5",
        label: "Haiku 4.5",
        description: "Lightweight and cheap for simple turns",
        vendor: "Anthropic",
      },
    ],
    // claude --effort: low, medium, high, xhigh, max (all five).
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "codex",
    name: "Codex",
    available: true,
    supportsResume: true,
    models: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini"],
    modelInfo: [
      {
        id: "gpt-5.6-terra",
        label: "GPT-5.6-Terra",
        description: "Balanced agentic coding model for everyday work.",
        vendor: "OpenAI",
      },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6-Luna",
        description: "Fast and affordable agentic coding model.",
        vendor: "OpenAI",
      },
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        description: "Frontier model for complex coding, research, and real-world work.",
        vendor: "OpenAI",
        recommended: true,
      },
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4-Mini",
        description: "Small, fast, and cost-efficient model for simpler coding tasks.",
        vendor: "OpenAI",
      },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "grok",
    name: "Grok",
    available: TRAILER ? true : false,
    supportsResume: false,
    models: ["grok-4.5"],
    modelInfo: [
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        description: "xAI coding agent with tool use",
        vendor: "xAI",
        recommended: true,
      },
    ],
    efforts: ["low", "medium", "high"],
  },
  {
    // Synced from electron/providers.js; dev had NO kimi entry at all, so the
    // dev picker showed a different provider list than the packaged app.
    id: "kimi",
    name: "Kimi Code",
    available: true,
    supportsResume: true,
    // Ids are config.toml alias keys: `-m k3` fails config.invalid,
    // `-m kimi-code/k3` runs (verified against the real CLI).
    models: [
      "kimi-code/k3",
      "kimi-code/k3-256k",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
    ],
    modelInfo: [
      {
        id: "kimi-code/k3",
        label: "K3",
        description: "Default Kimi coding model (1M context)",
        vendor: "Moonshot",
        recommended: true,
      },
      {
        id: "kimi-code/k3-256k",
        label: "K3-256k",
        description: "K3 with a 256k context window",
        vendor: "Moonshot",
      },
      {
        id: "kimi-code/kimi-for-coding",
        label: "K2.7 Coding",
        description: "Coding-tuned Kimi (K2.7)",
        vendor: "Moonshot",
      },
      {
        id: "kimi-code/kimi-for-coding-highspeed",
        label: "K2.7 Coding Highspeed",
        description: "Faster coding-tuned Kimi (K2.7)",
        vendor: "Moonshot",
      },
    ],
    // Per-model support_efforts in kimi's config.toml (k3 family).
    efforts: ["low", "high", "max"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    available: true,
    supportsResume: false,
    models: ["opencode/big-pickle", "opencode/deepseek-v4-flash-free", "opencode/laguna-s-2.1-free", "opencode/ling-3.0-tiny-free", "opencode/longcat-2.0-free", "opencode/mimo-v2.5-free", "opencode/nemotron-3-ultra-free", "opencode/north-mini-code-free"],
    modelInfo: [
      {
        id: "opencode/big-pickle",
        label: "Big Pickle",
        description: "Reasoning model for deliberate analysis, multi-step problem solving, and tool use",
        vendor: "OpenCode",
      },
      {
        id: "opencode/deepseek-v4-flash-free",
        label: "DeepSeek V4 Flash Free",
        description: "Official DeepSeek V4 Flash release with enhanced agentic capabilities and integrated DSpark speculative decoding",
        vendor: "DeepSeek",
      },
      {
        id: "opencode/laguna-s-2.1-free",
        label: "Laguna S 2.1 Free",
        description: "Agentic coding model from Poolside in the XS size class for local deployment",
        vendor: "Poolside",
      },
      {
        id: "opencode/ling-3.0-tiny-free",
        label: "Ling-3.0-tiny Free",
        description: "Compact MoE model for responsive agents, instruction following, and multi-turn conversations",
        vendor: "InclusionAI",
      },
      {
        id: "opencode/longcat-2.0-free",
        label: "LongCat-2.0 Free",
        description: "Meituan LongCat-2.0, a reasoning model with tool calling and a 1M-token context window",
        vendor: "Meituan",
      },
      {
        id: "opencode/mimo-v2.5-free",
        label: "MiMo V2.5 Free",
        description: "MiMo omni model for text, image, video, audio, and agents",
        vendor: "Xiaomi",
      },
      {
        id: "opencode/nemotron-3-ultra-free",
        label: "Nemotron 3 Ultra Free",
        description: "Largest Nemotron 3 model for maximum open-weight reasoning and agent accuracy",
        vendor: "NVIDIA",
      },
      {
        id: "opencode/north-mini-code-free",
        label: "North Mini Code Free",
        description: "Cohere coding model for practical software engineering and agentic edits",
        vendor: "Cohere",
        recommended: true,
      },
    ],
    efforts: [],
  },
];

const KNOWN_PROVIDER_IDS = new Set(DEV_PROVIDERS.map((p) => p.id));

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
/** Mirrors electron/services.js HANDOFF_ASSISTANT_MAX. */
const HANDOFF_ASSISTANT_MAX = 2000;

/**
 * Mirrors electron/worktrees.js maybeRenameWorktreeBranch: a creation-time
 * worktree starts on the placeholder branch coder/new-thread-<id6>; when the
 * first prompt promotes the title, the branch follows. No real git in dev
 * mode, so this is a pure rename of the thread record.
 */
function renamePlaceholderBranch(thread: ThreadInfo): ThreadInfo {
  if (!thread.worktreePath || !thread.branch) return thread;
  const shortId = thread.id.slice(0, 6);
  if (thread.branch !== `coder/new-thread-${shortId}`) return thread;
  const slug =
    thread.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "thread";
  const next = `coder/${slug}-${shortId}`;
  return next === thread.branch ? thread : { ...thread, branch: next };
}

/**
 * One-time hand-off CLI prefix. Strings match electron/services.js
 * buildHandoffPrefix exactly (services-level helper + dev twin pattern).
 */
export function buildHandoffPrefix(
  thread: { handoffFrom?: string | null; sessionId?: string | null } | null,
  getMessages: (
    sourceId: string,
  ) => Array<{ role?: string; text?: string }> | null | undefined,
): string {
  if (!thread || thread.handoffFrom == null || thread.handoffFrom === "") {
    return "";
  }
  if (thread.sessionId != null && thread.sessionId !== "") {
    return "";
  }
  let msgs: Array<{ role?: string; text?: string }> | null | undefined;
  try {
    msgs = getMessages(String(thread.handoffFrom));
  } catch {
    return "";
  }
  if (!Array.isArray(msgs) || msgs.length === 0) return "";
  let lastAssistant: string | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "assistant" && m.text != null && String(m.text)) {
      lastAssistant = String(m.text);
      break;
    }
  }
  if (!lastAssistant) return "";
  const body =
    lastAssistant.length > HANDOFF_ASSISTANT_MAX
      ? lastAssistant.slice(0, HANDOFF_ASSISTANT_MAX)
      : lastAssistant;
  return (
    "[Hand-off context from a previous thread]\n" +
    body +
    "\n[End context]\n\n"
  );
}

const SETTINGS_BUDGET_ERROR =
  "Daily budget must be a positive number or null";

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

/**
 * Validate a workflow template before save.
 * Error copy mirrors electron/services.js validateWorkflowTemplate VERBATIM
 * so the Manage modal shows the same messages in dev and prod.
 */
function validateTemplate(
  input: TemplateSaveInput,
  providers: ProviderInfo[],
): { name: string; phases: WorkflowPhaseSpec[] } {
  const name = input.name != null ? String(input.name).trim() : "";
  if (!name) {
    throw new Error("Template name is required");
  }

  const phases = input.phases;
  if (!Array.isArray(phases)) {
    throw new Error("Template phases must be an array");
  }
  if (phases.length < 1 || phases.length > 6) {
    throw new Error("Template must have between 1 and 6 phases");
  }

  const providerById = new Map(providers.map((p) => [p.id, p]));
  const cleaned: WorkflowPhaseSpec[] = [];

  for (let i = 0; i < phases.length; i++) {
    const raw = phases[i];
    if (!raw || typeof raw !== "object") {
      throw new Error(`Phase ${i + 1}: invalid phase object`);
    }
    const phaseName = raw.name != null ? String(raw.name).trim() : "";
    if (!phaseName) {
      throw new Error(`Phase ${i + 1}: name is required`);
    }
    if (phaseName.length > 24) {
      throw new Error(
        `Phase "${phaseName}": name must be at most 24 characters`,
      );
    }

    const agentCount = raw.agentCount;
    if (
      typeof agentCount !== "number" ||
      !Number.isInteger(agentCount) ||
      agentCount < 1 ||
      agentCount > 4
    ) {
      throw new Error(
        `Phase "${phaseName}": agentCount must be an integer from 1 to 4`,
      );
    }

    const instruction =
      raw.instruction != null ? String(raw.instruction).trim() : "";
    if (!instruction) {
      throw new Error(`Phase "${phaseName}": instruction is required`);
    }
    if (String(raw.instruction).length > 2000) {
      throw new Error(
        `Phase "${phaseName}": instruction must be at most 2000 characters`,
      );
    }

    const providerId =
      raw.provider != null ? String(raw.provider).trim() : "";
    if (!providerId) {
      throw new Error(`Phase "${phaseName}": provider is required`);
    }
    const entry = providerById.get(providerId);
    // simulate is a dev-only harness; never a selectable workflow provider.
    if (!entry || providerId === "simulate") {
      throw new Error(
        `Phase "${phaseName}": unknown provider "${providerId}"`,
      );
    }

    const model =
      raw.model == null || raw.model === "" ? null : String(raw.model);
    if (
      model != null &&
      Array.isArray(entry.models) &&
      entry.models.length > 0 &&
      !entry.models.includes(model)
    ) {
      throw new Error(
        `Phase "${phaseName}": model "${model}" is not in provider ${providerId}'s model list`,
      );
    }

    cleaned.push({
      name: phaseName,
      agentCount,
      instruction,
      provider: providerId,
      model,
    });
  }

  return { name, phases: cleaned };
}

type ListenerMap = {
  "threads:changed": Set<(threads: ThreadInfo[]) => void>;
  "thread:updated": Set<(detail: ThreadDetail) => void>;
};

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
      worktreePath: null,
      handoffFrom: null,
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
  let threads = seedThreads(projects);
  const details = new Map<string, ThreadDetail>();
  const runTimers = new Map<string, ReturnType<typeof setInterval>>();
  const runStates = new Map<string, RunState>();
  /** Threads whose worktree was merged/removed; fakeDiff stays empty until re-setup. */
  const clearedDiff = new Set<string>();
  /** User-defined + builtin workflow templates (in-memory). */
  let templates: WorkflowTemplateInfo[] = [cloneTemplate(STANDARD_TEMPLATE)];
  /** Scheduled agent runs. */
  let automationsList: AutomationInfo[] = [];
  /** Aggregated cost of finished fake runs this session (stands in for "today"). */
  let spendTodayUsd = 0;
  let dailyBudgetUsd: number | null = null;
  /** Default 3 = AUTO_SETTLE_AFTER_DAYS; null disables. */
  let autoSettleAfterDays: number | null = 3;
  /** User MCP servers (Skills tab), in-memory. */
  let mcpServers: McpServerInfo[] = [];
  /** Default new threads into a fake worktree (Settings toggle). */
  let defaultWorktree = false;
  /** In-memory skills (Skills tab); dev twin of the on-disk SKILL.md scan. */
  let skillsList: SkillInfo[] = [
    {
      name: "review-pr",
      description: "Review a pull request end to end",
      source: "claude",
    },
    {
      name: "write-tests",
      description: "Add tests for the current change",
      source: "agents",
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
   * In-memory checkpoints per thread (dev twin of worktree git log).
   * Appended on successful run complete when the thread has a fake worktreePath.
   * Newest-first list order matches electron listCheckpoints.
   */
  const checkpointsByThread = new Map<string, CheckpointInfo[]>();

  /** Mirror electron maybeCreateCheckpoint — best-effort, worktree-only. */
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
      // Successful turn + fake worktree → in-memory checkpoint (electron twin).
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
      async applyUpdate(): Promise<void> {},
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
              : input.type === "run"
                ? 1
                : 3,
          createdAt: ts,
          updatedAt: ts,
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
    },
    settings: {
      async get(): Promise<AppSettings> {
        return {
          dailyBudgetUsd,
          autoSettleAfterDays,
          mcpServers: mcpServers.map((s) => ({ ...s })),
          defaultWorktree,
        };
      },
      async set(patch: Partial<AppSettings>): Promise<AppSettings> {
        dailyBudgetUsd = parseBudgetPatch(patch);
        autoSettleAfterDays = parseSettleDaysPatch(patch);
        if (Object.prototype.hasOwnProperty.call(patch, "mcpServers")) {
          if (!Array.isArray(patch.mcpServers)) {
            throw new Error("mcpServers must be an array");
          }
          mcpServers = patch.mcpServers.map((s) => ({ ...s }));
        }
        if (Object.prototype.hasOwnProperty.call(patch, "defaultWorktree")) {
          if (typeof patch.defaultWorktree !== "boolean") {
            throw new Error("defaultWorktree must be a boolean");
          }
          defaultWorktree = patch.defaultWorktree;
        }
        return {
          dailyBudgetUsd,
          autoSettleAfterDays,
          mcpServers: mcpServers.map((s) => ({ ...s })),
          defaultWorktree,
        };
      },
    },
    skills: {
      async list(input?: { projectPath?: string }): Promise<SkillInfo[]> {
        const out = skillsList.map((s) => ({ ...s }));
        if (input?.projectPath) {
          out.push({
            name: "project-conventions",
            description: "Project-local review rules",
            source: "project",
          });
        }
        return out;
      },
      async add(input: SkillWrite): Promise<{ name: string }> {
        if (!/^[a-z0-9-]+$/.test(input.name)) {
          throw new Error("Skill name must be lowercase letters, digits, dashes");
        }
        skillsList = [
          ...skillsList.filter(
            (s) => !(s.name === input.name && s.source === input.target),
          ),
          {
            name: input.name,
            description: input.description,
            source: input.target,
          },
        ];
        return { name: input.name };
      },
      async remove(input: {
        target: "claude" | "agents";
        name: string;
      }): Promise<void> {
        skillsList = skillsList.filter(
          (s) => !(s.name === input.name && s.source === input.target),
        );
      },
    },
    providers: {
      async list() {
        return DEV_PROVIDERS.map((p) => ({
          ...p,
          models: [...p.models],
        }));
      },
    },
    workflows: {
      async list() {
        return templates.map(cloneTemplate);
      },
      async save(input) {
        const cleaned = validateTemplate(input, DEV_PROVIDERS);
        const existing =
          input.id != null
            ? templates.find((t) => t.id === input.id)
            : undefined;

        // Saving a builtin always creates a copy (never mutates the builtin).
        // Name: append " (copy)" when the submitted name equals the builtin name
        // (matches electron/store.js saveTemplate).
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
      /** Mirrors services.updateProject: empty host clears the remote fields. */
      async update(input: {
        projectId: string;
        name?: string;
        remoteHost?: string;
        remotePath?: string;
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
        return { ...project };
      },
      /**
       * t3-style remove project entry + thread history. Repo on disk untouched.
       * Guard order and strings match electron/services.js removeProject.
       */
      async remove(input: { projectId: string }) {
        const projectId = String(input.projectId ?? "");
        const project = projects.find((p) => p.id === projectId);
        if (!project) {
          throw new Error(`Unknown project: ${projectId}`);
        }
        const projectThreads = threads.filter((t) => t.projectId === projectId);

        // All guards before any deletion (same order as production).
        for (const t of projectThreads) {
          if (t.status === "working" || runTimers.has(t.id)) {
            throw new Error("Cannot remove a project while a run is active");
          }
        }
        for (const t of projectThreads) {
          if (t.worktreePath) {
            // Match electron/services.js THREAD_STILL_HAS_WORKTREE exactly.
            throw new Error(
              "Thread still has a worktree. Merge or delete it in the Git tab first.",
            );
          }
        }

        for (const t of projectThreads) {
          clearRunTimer(t.id);
          runStates.delete(t.id);
          clearedDiff.delete(t.id);
          details.delete(t.id);
        }
        threads = threads.filter((t) => t.projectId !== projectId);
        projects = projects.filter((p) => p.id !== projectId);
        emitThreads();
      },
    },
    threads: {
      async list() {
        return threads.map((t) => ({ ...t }));
      },
      /** Mirror electron services.threadSummaries (team view). */
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
       * Full-content search: title + message text, case-insensitive substring,
       * newest activity first, max 50. Includes archived. 0–1 char → [].
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
        const t0 = now();
        const rawTitle = input.title || "New Thread";
        const t: ThreadInfo = {
          id: id("thread"),
          projectId: input.projectId,
          // Match electron createThread truncateThreadTitle (TITLE_MAX).
          title:
            rawTitle.length > TITLE_MAX
              ? rawTitle.slice(0, TITLE_MAX)
              : rawTitle,
          branch: null,
          prNumber: null,
          prUrl: null,
          status: "idle",
          createdAt: t0,
          updatedAt: t0,
          runStartedAt: null,
          archived: false,
          settledOverride: null,
          settledAt: null,
          prState: null,
          // Match electron createThread: just-created is not unread.
          lastVisitedAt: t0,
          pinnedAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          provider: "claude",
          model: null,
          sessionId: null,
          permissionMode: "default",
          reasoningEffort: null,
          worktreePath: null,
          handoffFrom: null,
        };
        // Mirror the electron threads:create worktree flag: lazy (t3-style).
        // Only the intent is recorded; the fake worktree + branch materialize
        // at first run (see runs.start), so never-run threads stay clean.
        if (input.worktree === true) {
          t.pendingWorktree = true;
        }
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
      },
      async fork(input) {
        // Mirror electron/services.js forkThread rules and error strings.
        const sourceDetail = details.get(input.threadId);
        if (!sourceDetail) {
          throw new Error(`Unknown thread: ${input.threadId}`);
        }
        const source = sourceDetail.thread;

        const providerProvided = Object.prototype.hasOwnProperty.call(
          input,
          "provider",
        );
        const modelProvided = Object.prototype.hasOwnProperty.call(
          input,
          "model",
        );

        let nextProvider = source.provider;
        if (providerProvided) {
          const pid = String(input.provider || "");
          const known =
            KNOWN_PROVIDER_IDS.has(pid) || pid === "simulate";
          if (!known) {
            throw new Error(`Unknown provider: ${input.provider}`);
          }
          nextProvider = pid;
        }

        const providerChanging =
          providerProvided &&
          String(nextProvider) !== String(source.provider);

        const resolveModel = (
          providerId: string,
          raw: string | null | undefined,
        ): string | null => {
          if (raw == null || raw === "") return null;
          const trimmed = String(raw).trim();
          if (!trimmed) {
            throw new Error("Model must be a non-empty string");
          }
          void providerId;
          if (trimmed.length > 100) {
            throw new Error("Model must be at most 100 characters");
          }
          return trimmed;
        };

        let nextModel = source.model;
        if (providerChanging) {
          nextModel = modelProvided
            ? resolveModel(nextProvider, input.model)
            : null;
        } else if (modelProvided) {
          nextModel = resolveModel(nextProvider, input.model);
        }

        const sourceTitle =
          source.title != null && source.title !== ""
            ? source.title
            : "New Thread";
        const rawTitle = `Fork: ${sourceTitle}`;
        const t0 = now();
        const created: ThreadInfo = {
          id: id("thread"),
          projectId: source.projectId,
          title:
            rawTitle.length > TITLE_MAX
              ? rawTitle.slice(0, TITLE_MAX)
              : rawTitle,
          branch: null,
          prNumber: null,
          prUrl: null,
          status: "idle",
          createdAt: t0,
          updatedAt: t0,
          runStartedAt: null,
          archived: false,
          settledOverride: null,
          settledAt: null,
          prState: null,
          lastVisitedAt: t0,
          pinnedAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          provider: nextProvider,
          model: nextModel,
          sessionId: null,
          permissionMode: source.permissionMode,
          reasoningEffort: null,
          worktreePath: null,
          handoffFrom: source.id,
        };
        threads = [created, ...threads];
        details.set(created.id, {
          thread: created,
          messages: [],
          workLog: [],
          workflow: null,
          usage: null,
        });
        emitThreads();
        return { ...created };
      },
      async get(threadId) {
        const d = details.get(threadId);
        if (!d) throw new Error(`Thread not found: ${threadId}`);
        const row = threads.find((t) => t.id === threadId);
        // Selecting IS visiting (matches electron threads:get). Do not bump
        // updatedAt — visiting is not activity.
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
      async setPermissionMode(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const thread: ThreadInfo = {
          ...detail.thread,
          permissionMode: input.mode,
          updatedAt: now(),
        };
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
      },
      async respondPermission() {
        // Dev threads never spawn a real CLI, so nothing is ever pending.
        throw new Error("No active agent run for this thread");
      },
      async setArchived(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        // Archive bookkeeping is not "activity"; leave updatedAt alone.
        const thread: ThreadInfo = {
          ...detail.thread,
          archived: input.archived,
        };
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
      },
      async setSettled(input: {
        threadId: string;
        override: "settled" | "active" | null;
      }) {
        // Match electron/services.js setSettled exactly (same error strings).
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Unknown thread: ${input.threadId}`);
        const override = input.override;
        if (override !== "settled" && override !== "active" && override !== null) {
          throw new Error(
            `Invalid settle override: ${JSON.stringify(override)}. Expected "settled", "active", or null`,
          );
        }
        if (override === "settled" && detail.thread.status === "working") {
          throw new Error("Cannot settle a thread while a run is active");
        }
        // Settling is bookkeeping; leave updatedAt alone.
        // Mutual exclusion with pin: settle clears pin (mirror of setPinned).
        const thread: ThreadInfo = {
          ...detail.thread,
          settledOverride: override,
          settledAt: override != null ? now() : null,
          ...(override === "settled" ? { pinnedAt: null } : {}),
        };
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
      },
      async setPinned(input: { threadId: string; pinned: boolean }) {
        // Match electron/services.js setPinned (same mutual-exclusion rules).
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Unknown thread: ${input.threadId}`);
        let thread: ThreadInfo;
        if (input.pinned) {
          thread = {
            ...detail.thread,
            pinnedAt: now(),
            ...(detail.thread.settledOverride === "settled"
              ? { settledOverride: null, settledAt: null }
              : {}),
          };
        } else {
          thread = { ...detail.thread, pinnedAt: null };
        }
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
      },
      async setSnoozed(input: { threadId: string; until: number | null }) {
        // Match electron/services.js setSnoozed (same error strings).
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Unknown thread: ${input.threadId}`);
        let thread: ThreadInfo;
        if (input.until === null || input.until === undefined) {
          thread = {
            ...detail.thread,
            snoozedUntil: null,
            snoozedAt: null,
          };
        } else {
          const t = Number(input.until);
          if (!Number.isFinite(t) || !(t > Date.now())) {
            throw new Error(`Snooze time ${input.until} is not in the future`);
          }
          thread = {
            ...detail.thread,
            snoozedUntil: t,
            snoozedAt: now(),
          };
        }
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
      },
      async setReasoningEffort(input: {
        threadId: string;
        effort: ReasoningEffort | null;
      }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const providerId = detail.thread.provider;
        const entry = DEV_PROVIDERS.find((p) => p.id === providerId);
        const efforts = entry?.efforts ?? [];
        if (input.effort != null) {
          if (efforts.length === 0) {
            throw new Error(
              `Provider ${providerId} does not support reasoning effort`,
            );
          }
          if (!efforts.includes(input.effort)) {
            throw new Error(
              `Provider ${providerId} does not support effort "${input.effort}"`,
            );
          }
        }
        // Effort bookkeeping is not "activity"; leave updatedAt alone.
        const thread: ThreadInfo = {
          ...detail.thread,
          reasoningEffort: input.effort,
        };
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
      },
      async setProvider(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const thread = detail.thread;

        const providerProvided = Object.prototype.hasOwnProperty.call(
          input,
          "provider",
        );
        const modelProvided = Object.prototype.hasOwnProperty.call(
          input,
          "model",
        );

        if (!providerProvided && !modelProvided) {
          return { ...thread };
        }

        const nextProvider = providerProvided
          ? String(input.provider)
          : thread.provider;

        if (providerProvided) {
          const known =
            KNOWN_PROVIDER_IDS.has(nextProvider) || nextProvider === "simulate";
          if (!known) {
            throw new Error(`Unknown provider: ${input.provider}`);
          }
        }

        const providerChanging =
          providerProvided && String(input.provider) !== String(thread.provider);


        /**
         * Normalize/validate a model for the target provider.
         * - null / "" → null (provider default)
         * - non-empty models list → must be a list member
         * - empty models list → any non-empty trimmed string ≤ 100 chars
         */
        const resolveModel = (
          providerId: string,
          raw: string | null | undefined,
        ): string | null => {
          // Match electron/services.js normalizeModelForProvider: trim first.
          if (raw == null || raw === "") return null;
          const trimmed = String(raw).trim();
          if (!trimmed) {
            throw new Error("Model must be a non-empty string");
          }
          const entry = DEV_PROVIDERS.find((p) => p.id === providerId);
          // Mirrors services.normalizeModelForProvider: the published list is
          // a suggestion, not an allowlist, so an id the snapshot does not
          // know is still accepted and reaches the CLI.
          void entry;
          if (trimmed.length > 100) {
            throw new Error("Model must be at most 100 characters");
          }
          return trimmed;
        };

        // Provider/model bookkeeping is not "activity"; leave updatedAt alone.
        const patch: Partial<ThreadInfo> = {};
        if (providerProvided) patch.provider = String(input.provider);

        if (
          providerChanging &&
          (thread.status === "working" || runTimers.has(input.threadId))
        ) {
          // Match electron/services.js setProvider exactly.
          throw new Error("Cannot switch provider while a run is active");
        }

        if (providerChanging && thread.sessionId) {
          // Match electron/services.js setProvider exactly: switching harness
          // drops the session (not portable across CLIs); next send starts fresh.
          patch.sessionId = null;
        }

        if (providerChanging) {
          // Drop the old provider's model unless this call supplies one that
          // validates for the NEW provider (including free-form custom ids).
          const incoming =
            modelProvided && input.model != null && input.model !== ""
              ? resolveModel(nextProvider, input.model)
              : null;
          patch.model = incoming;
          // Same as production: a level the new provider cannot honour would
          // be shown by the picker and never reach the CLI. Without this the
          // dev harness reproduces the very bug the shipped path fixed, which
          // would convince the next person the fix did not land.
          patch.reasoningEffort = null;
        } else if (modelProvided) {
          patch.model = resolveModel(nextProvider, input.model);
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
          // Match electron/services.js deleteThread exactly.
          throw new Error("Cannot delete thread while a run is active");
        }
        if (detail.thread.worktreePath) {
          // Match electron/services.js deleteThread exactly.
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

        // Transcript stores the RAW prompt (match electron/runner.js). The
        // hand-off prefix is CLI-only; compute it for the dispatch path and
        // keep it off the stored user message.
        detail.messages.push({
          id: id("msg"),
          role: "user",
          text: prompt,
          createdAt: t,
          runId,
        });

        let thread = { ...detail.thread };
        // Build prefix while sessionId is still null (first turn only).
        // Helper is tested directly; wiring keeps the same prefix rules as
        // electron without stashing a dead dispatchPrompt field (r49 A-n1).
        const handoffPrefix = buildHandoffPrefix(thread, (sourceId) => {
          const src = details.get(sourceId);
          return src ? src.messages : null;
        });
        if (handoffPrefix) {
          detail.workLog.push({
            id: id("wl"),
            runId,
            label: "Hand-off context injected",
            done: true,
            timestamp: t,
          });
        }

        // Mirror electron materializePendingWorktree: the worktree + branch
        // (slugged from the pre-promotion title) appear at first run.
        if (thread.pendingWorktree && !thread.worktreePath) {
          const shortId = thread.id.slice(0, 6);
          const slug =
            thread.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 40) || "thread";
          const project = projects.find((p) => p.id === thread.projectId);
          thread = {
            ...thread,
            pendingWorktree: false,
            branch: `coder/${slug}-${shortId}`,
            worktreePath: `${project?.path ?? "/Users/demo/project"}/.coder/worktrees/${thread.id}`,
          };
        }

        if (thread.title === "New Thread") {
          const firstLine =
            prompt.split("\n")[0]?.slice(0, TITLE_MAX) || "New Thread";
          thread = { ...thread, title: firstLine };
          thread = renamePlaceholderBranch(thread);
        }

        // Persist a session id after the first turn so follow-ups resume.
        if (!thread.sessionId) {
          thread = { ...thread, sessionId: id("sess") };
        }

        // Real activity clears a stale "settled" pin (match electron/runner.js).
        // An explicit "active" pin survives.
        thread = {
          ...thread,
          status: "working",
          updatedAt: t,
          runStartedAt: t,
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
        // Same lazy-worktree materialization as runs.start (workflows are
        // first runs too).
        if (thread.pendingWorktree && !thread.worktreePath) {
          const shortId = thread.id.slice(0, 6);
          const slug =
            thread.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 40) || "thread";
          const project = projects.find((p) => p.id === thread.projectId);
          thread = {
            ...thread,
            pendingWorktree: false,
            branch: `coder/${slug}-${shortId}`,
            worktreePath: `${project?.path ?? "/Users/demo/project"}/.coder/worktrees/${thread.id}`,
          };
        }
        if (thread.title === "New Thread") {
          const firstLine =
            prompt.split("\n")[0]?.slice(0, TITLE_MAX) || "New Thread";
          thread = { ...thread, title: firstLine };
          thread = renamePlaceholderBranch(thread);
        }

        if (!thread.sessionId) {
          thread = { ...thread, sessionId: id("sess") };
        }

        // Real activity clears a stale "settled" pin (match electron/workflow.js).
        // An explicit "active" pin survives.
        thread = {
          ...thread,
          status: "working",
          updatedAt: t,
          runStartedAt: t,
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
    git: {
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
      async createPr(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const branch = detail.thread.branch;
        if (!branch) {
          throw new Error(
            "No branch to open a PR from. Set up a worktree or check out a branch first.",
          );
        }
        const title = input.title?.trim() ?? "";
        if (!title) {
          throw new Error("PR title is required");
        }

        const existing = prByThread.get(input.threadId);
        if (existing) {
          // Keep prState in sync with the live PR (match electron/worktrees.js).
          const thread: ThreadInfo = {
            ...detail.thread,
            prNumber: existing.number,
            prUrl: existing.url,
            prState: existing.state,
          };
          detail.thread = thread;
          details.set(input.threadId, detail);
          syncThreadRow(thread);
          emitDetail(detail);
          return {
            number: existing.number,
            url: existing.url,
            state: existing.state,
            branch: existing.branch || branch,
            created: false,
          };
        }

        const project = projects.find((p) => p.id === detail.thread.projectId);
        const slug = project?.slug ?? "owner/repo";
        const number = nextPrNumber++;
        const url = `https://github.com/${slug}/pull/${number}`;
        const info: PrInfo = {
          number,
          url,
          state: "OPEN",
          branch,
          created: true,
        };
        prByThread.set(input.threadId, { ...info, created: false });

        const thread: ThreadInfo = {
          ...detail.thread,
          prNumber: number,
          prUrl: url,
          prState: info.state,
          updatedAt: now(),
        };
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return info;
      },
      async prStatus(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const existing = prByThread.get(input.threadId);
        if (!existing) return null;
        // Persist last-known PR state (match electron/worktrees.js prStatus).
        const thread: ThreadInfo = {
          ...detail.thread,
          prNumber: existing.number,
          prUrl: existing.url,
          prState: existing.state,
        };
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return {
          number: existing.number,
          url: existing.url,
          state: existing.state,
          branch: existing.branch || detail.thread.branch || "",
          created: false,
        };
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
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const existing = prByThread.get(input.threadId);
        if (!existing) {
          throw new Error("No pull request found for this branch");
        }
        if (existing.state !== "OPEN") {
          throw new Error(
            `Pull request #${existing.number} is not open`,
          );
        }
        const merged: PrInfo = { ...existing, state: "MERGED", created: false };
        prByThread.set(input.threadId, merged);
        const thread: ThreadInfo = {
          ...detail.thread,
          prNumber: merged.number,
          prUrl: merged.url,
          prState: merged.state,
          updatedAt: now(),
        };
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return {
          number: merged.number,
          url: merged.url,
          state: merged.state,
          branch: merged.branch || detail.thread.branch || "",
          created: false,
        };
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
        // Guard order matches electron/worktrees.js restoreCheckpoint.
        const detail = details.get(input.threadId);
        if (!detail) {
          throw new Error(`Unknown thread: ${input.threadId}`);
        }
        if (
          detail.thread.status === "working" ||
          runTimers.has(input.threadId)
        ) {
          throw new Error(
            "Cannot restore a checkpoint while a run is active",
          );
        }
        if (!detail.thread.worktreePath) {
          throw new Error(
            `Thread ${input.threadId} has no worktree; call setupWorktree first`,
          );
        }
        const list = checkpointsByThread.get(input.threadId) || [];
        const want = String(input.sha || "").trim();
        const idx = list.findIndex(
          (c) =>
            c.sha === want ||
            c.sha.startsWith(want) ||
            want.startsWith(c.sha),
        );
        if (idx < 0) {
          throw new Error(`Unknown checkpoint: ${input.sha}`);
        }
        const match = list[idx]!;
        // Mirror electron HEAD-reachable truncation: restoring turn k drops
        // every newer checkpoint so the next commit reuses turn k+1, not
        // stale length+1 (fakeCoder / git log after reset --hard).
        checkpointsByThread.set(input.threadId, list.slice(idx));
        // Dev has no real files to reset; stamp an event on the transcript.
        detail.messages.push({
          id: id("msg"),
          role: "event",
          text: `Restored checkpoint turn ${match.turn} (${match.sha.slice(0, 7)})`,
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
      async setupWorktree(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);

        await new Promise((r) => setTimeout(r, WORKTREE_DELAY_MS));

        const short =
          detail.thread.branch?.replace(/^.*\//, "") ||
          detail.thread.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 24) ||
          "local-run";
        const branch = detail.thread.branch ?? `feat/${short}`;
        const project = projects.find((p) => p.id === detail.thread.projectId);
        const worktreePath = `${project?.path ?? "/Users/demo/project"}/.coder/worktrees/${short}`;

        clearedDiff.delete(input.threadId);

        const thread: ThreadInfo = {
          ...detail.thread,
          branch,
          worktreePath,
          updatedAt: now(),
        };
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
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
    issues: {
      async fetch(input: {
        projectPath: string;
        ref: string;
      }): Promise<FetchIssueResult> {
        const raw = String(input.ref || "").trim();
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
    },
    servers: {
      async list(_input: { threadId: string }): Promise<LocalServerInfo[]> {
        return [];
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
