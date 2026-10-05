/** Activity, usage, fleet, insights and digest fixtures for the browser-dev fixture. */
import type {
  ActivityItem,
  CoderApi,
  FailureKind,
  FailureMode,
  FleetEvidence,
  DigestResult,
  UsageEntry,
  UsageReport,
  UsageThreadEntry,
  ProviderUsage,
  WorkLogItem,
} from "../shared/ipc";
import { buildActivity } from "../activity.ts";
import type { DevCtx } from "./context.ts";
import { now } from "./util.ts";

export function createUsage(ctx: DevCtx): Pick<CoderApi, "activity" | "usage" | "fleet" | "insights" | "digest"> {
  const { details } = ctx;
  return {
    activity: {
      async list(): Promise<ActivityItem[]> {
        const workLogByThread: Record<string, WorkLogItem[]> = {};
        for (const [id, d] of details) {
          workLogByThread[id] = d.workLog;
        }
        return buildActivity(ctx.threads, workLogByThread, now());
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
        const a = ctx.threads[0];
        const b = ctx.threads[1];
        const c = ctx.threads[2];
        const projectId = a?.projectId ?? "proj-1";
        const slug =
          ctx.projects.find((p) => p.id === projectId)?.slug ?? "acme/nebula";
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
        const rows = ctx.threads.slice(0, 3);
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
          projectId: ctx.projects[0]?.id ?? "p1",
          projectSlug: ctx.projects[0]?.slug ?? "coder",
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
  };
}
