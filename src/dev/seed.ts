/** Seed data for the browser-dev fixture: projects, threads, transcripts, providers. */
import type {
  ChatMessage,
  DiffResult,
  PermissionMode,
  ProjectInfo,
  ProviderInfo,
  SessionUsage,
  SpecArtifact,
  ThreadDetail,
  ThreadInfo,
  CrewTaskView,
  WorkLogItem,
} from "../shared/ipc";
import { mockData } from "../mockData.ts";
import { seedWorkflowMidRun, createFreshWorkflow } from "./runs.ts";
import { toIso, TRAILER, now, id } from "./util.ts";

/** Stand-in artifact bodies for the browser twin (issue #269). */
export const DEV_SPEC_ARTIFACTS: Record<SpecArtifact, string> = {
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

export const TRAILER_PROVIDERS = [
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
export function devProvider(
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
      // Mirrors the real catalog's Fast trait (#1529).
      ...(m === "claude-opus-5" ? { fast: true } : {}),
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

export const DEV_PROVIDERS: ProviderInfo[] = [
  {
    ...devProvider("claude", "Claude Code", ["claude-opus-5", "claude-sonnet-5"]),
    supportsSteer: true,
    supportsAgents: true,
    auth: "signedIn",
  },
  {
    ...devProvider("codex", "Codex", ["gpt-5.3-codex", "gpt-5.3"]),
    supportsSearch: true,
    // Shows the signed-out picker line and Settings > Agents Sign in (#1501).
    auth: "signedOut",
  },
  {
    ...devProvider("kimi", "Kimi", ["kimi-k3-thinking"]),
    permissionModes: ["bypassPermissions"],
    auth: "unknown",
  },
  {
    ...devProvider("grok", "Grok", ["grok-4.6"], TRAILER),
    permissionModes: ["plan", "bypassPermissions"],
  },
  {
    ...devProvider("opencode", "OpenCode", ["opencode/grok-code"]),
    permissionModes: ["default", "bypassPermissions"],
    auth: "signedIn",
  },
  { ...devProvider("muse", "Muse Code", ["muse-spark-1.3"]), auth: "unknown" },
];

/** Browser-dev fixture for the Agents-tab crew list (issue #277). */
export const SEED_CREW_NOW = /* @__PURE__ */ Date.now();
export const SEED_CREW_TASKS: CrewTaskView[] = [
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

export function ageToMs(age: string): number {
  const m = /^(\d+)([mhd])$/.exec(age);
  if (!m) return 3 * 60 * 60 * 1000;
  const n = Number(m[1]);
  if (m[2] === "m") return n * 60 * 1000;
  if (m[2] === "h") return n * 60 * 60 * 1000;
  return n * 24 * 60 * 60 * 1000;
}

export function workingMinutes(label?: string): number {
  if (!label) return 2;
  const m = /(\d+)\s*m/.exec(label);
  return m ? Number(m[1]) : 2;
}

export function seedProjects(): ProjectInfo[] {
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

export function seedThreads(projects: ProjectInfo[]): ThreadInfo[] {
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
      ejected: false,
      // One seeded scratch pad so the browser demo shows #194 once the UI lands.
      notes:
        card.id === "thread-4"
          ? "Merge after #42 lands - waiting on the API rename."
          : "",
      tags: [],
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

export function seedDetail(thread: ThreadInfo): ThreadDetail {
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
    // A shared-memory recall, so the dev renderer shows a memory moment (#1429).
    {
      id: "tool-memory-seed",
      role: "tool",
      text: "memory_search: per-device provider settings",
      createdAt: t0 - 120_000,
      runId,
      tool: {
        id: "tc-memory-seed",
        name: "mcp__coder-memory__memory_search",
        input: JSON.stringify({ query: "per-device provider settings" }),
        output: JSON.stringify(
          [
            ["Provider overrides live in electron/store.js, not the renderer", "codex", 2 * 24],
            ["Per-device keys must survive a store migration (#613)", "claude", 5 * 24],
            ["Settings tests need core/dist built first", "grok", 8 * 24],
          ].map(([title, agent, hoursAgo], i) => ({
            id: `mem-demo-${i}`,
            title,
            agent,
            created_at: toIso(t0 - Number(hoursAgo) * 3_600_000),
          })),
        ),
        done: true,
        isError: false,
      },
    },
    {
      id: "tool-read-seed",
      role: "tool",
      text: "Read: src/settings/providerStore.ts",
      createdAt: t0 - 110_000,
      runId,
      tool: {
        id: "tc-read-seed",
        name: "Read",
        input: "src/settings/providerStore.ts",
        output: "export const providerStore = createStore();",
        done: true,
        isError: false,
      },
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

export function fakeDiff(thread: ThreadInfo): DiffResult {
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

export const EMPTY_DIFF: DiffResult = { files: [], patch: "", truncated: false };
