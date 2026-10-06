/** Git, PR, worktree and checkpoint fakes for the browser-dev fixture. */
import type {
  CoderApi,
  RunStatInfo,
  ConflictForecast,
  DiffResult,
  CheckoutPrResult,
  PrCommentResult,
  PrDetail,
  PrDetailResult,
  PrTemplateResult,
  MergeMethod,
  PrCheckInfo,
  PrInfo,
  ThreadInfo,
} from "../shared/ipc";
import type { DevCtx } from "./context.ts";
import { fakeDiff, EMPTY_DIFF } from "./seed.ts";
import { now, id } from "./util.ts";

export const WORKTREE_DELAY_MS = 450;
export const PUSH_DELAY_MS = 350;

export function createGit(ctx: DevCtx): Pick<CoderApi, "git" | "mergeQueue"> {
  const { details, clearedDiff, prByThread, checkpointsByThread, emitDetail, syncThreadRow, patchThread, newThread, registerThread, fakeWorktree } = ctx;
  /** Directories already reclaimed by the #316 GC demo stubs. */
  const gcRemoved = new Set<string>();
  /** Synthetic PR numbers for harness creates (avoid colliding with seeds). */
  let nextPrNumber = 900;

  return {
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
        const project = ctx.projects.find((p) => p.id === detail.thread.projectId);
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
      async mergeOptions(_input: { threadId: string } | { projectPath: string }) {
        return {
          ok: true as const,
          methods: ["squash", "merge", "rebase"] as MergeMethod[],
          defaultMethod: "squash" as const,
        };
      },
      async listPrs(projectPath: string) {
        const project = ctx.projects.find((p) => p.path === projectPath);
        if (!project) return { ok: true, prs: [], complete: true, limit: 50 };
        const prs = ctx.threads
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
        const project = ctx.projects.find((p) => p.id === input.projectId);
        if (!project) return { ok: false as const, reason: "Unknown project" };
        const existing = ctx.threads.find(
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
        const t = ctx.threads.find((x) => x.prNumber === input.prNumber);
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
        const project = ctx.projects.find((p) => p.id === detail.thread.projectId);
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
        const ids = ctx.threads
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
        const first = ctx.projects[0];
        const second = ctx.projects[1] ?? first;
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
            threadId: ctx.threads[0]?.id ?? null,
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
        const scan = await ctx.api().git.gcScan();
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
      async suggestPrText(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        return {
          title: `feat: ${detail.thread.title}`,
          body: "## Summary\n\n- Generated in dev mode.",
        };
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
  };
}
