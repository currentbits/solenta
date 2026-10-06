/** Thread operations for the browser-dev fixture: CRUD, trash, rewind, notes, spec. */
import type {
  AttachmentInfo,
  CoderApi,
  VerifyResult,
  CommandRunResult,
  ReasoningEffort,
  SpecArtifact,
  ThreadDetail,
  ThreadInfo,
  ThreadMessagePin,
  ThreadSummariesInput,
  TrashedThreadInfo,
  CrewTaskView,
  CrewIntegration,
} from "../shared/ipc";
import { SPEC_ARTIFACTS, SPEC_DIR } from "../shared/ipc";
import { normalizeMessagePins } from "../messagePins";
import { mockData } from "../mockData.ts";
import type { DevCtx } from "./context.ts";
import { DEV_SPEC_ARTIFACTS, SEED_CREW_TASKS } from "./seed.ts";
import { TITLE_MAX, now, id, cloneDetail } from "./util.ts";

export function createThreads(ctx: DevCtx): Pick<CoderApi, "threads"> {
  const { details, rewindRestore, runTimers, runStates, clearedDiff, emitThreads, emitDetail, syncThreadRow, patchThread, newThread, registerThread, clearRunTimer } = ctx;
  const trashed = new Map<
    string,
    TrashedThreadInfo & { thread: ThreadInfo; detail?: ThreadDetail }
  >();
  const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  return {
    threads: {
      async list() {
        return ctx.threads.map((t) => ({ ...t }));
      },
      /** Team-view rows: newest assistant line per thread. */
      async summaries(input?: ThreadSummariesInput) {
        return ctx.threads
          .filter((t) => !input?.projectId || t.projectId === input.projectId)
          .filter((t) => !input?.threadIds || input.threadIds.includes(t.id))
          .map((t) => {
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
            orchWorker: t.orchWorker === true,
            projectId: t.projectId,
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
        const known = ctx.threads.some((t) => t.id === input.threadId);
        return {
          rootThreadId: mockData.activeThreadId,
          tasks: known ? SEED_CREW_TASKS.map((t) => ({ ...t })) : [],
        };
      },
      async crewIntegration(input: { threadId: string }): Promise<CrewIntegration> {
        const lead = ctx.threads.find((t) => t.id === input.threadId);
        const workers = ctx.threads.filter((t) => t.handoffFrom === input.threadId);
        return {
          leadThreadId: input.threadId,
          leadBranch: lead?.branch ?? null,
          leadWorktreePath: lead?.worktreePath ?? null,
          missingLeadWorktree: !lead?.worktreePath,
          finalTarget: lead?.baseBranch || "main",
          finalAction: "merge",
          combinedFiles: [],
          leadHeadSha: null,
          leadVerify: lead?.verify ?? null,
          verifyStale: false,
          landed: lead?.prState === "MERGED",
          workers: workers.map((w) => ({
            workerId: w.id,
            title: w.title,
            taskId: null,
            sourceSha: w.leadSnapshotSha ?? null,
            sourceBranch: w.leadSnapshotBranch ?? null,
            sourceDirty: w.leadSnapshotDirty === true,
            changedFiles: [],
            verify: w.verify ?? null,
            destination: lead?.branch || "lead worktree",
            state: w.status === "working" ? "running" : "ready",
            blocked: false,
            needs: [],
            archived: w.archived === true,
            worktreePath: w.worktreePath ?? null,
            missingReason: null,
          })),
          receipts: lead?.integrationReceipts ?? [],
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

        for (const t of ctx.threads) {
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
      async listCliSessions(_input?: {
        provider?: "codex" | "grok" | "claude" | "cursor" | "opencode" | "kimi" | "muse";
      }) {
        return [];
      },
      async importCliSession(input) {
        const provider =
          input.provider === "grok" ||
          input.provider === "claude" ||
          input.provider === "cursor" ||
          input.provider === "opencode" ||
          input.provider === "kimi" ||
          input.provider === "muse"
            ? input.provider
            : "codex";
        const title =
          provider === "grok"
            ? "Imported Grok session"
            : provider === "claude"
              ? "Imported Claude session"
              : provider === "cursor"
                ? "Imported Cursor session"
                : provider === "opencode"
                  ? "Imported OpenCode session"
                  : provider === "kimi"
                    ? "Imported Kimi session"
                    : provider === "muse"
                      ? "Imported Muse session"
                      : "Imported Codex session";
        return registerThread(
          newThread({
            projectId: input.projectId,
            title,
            provider,
            sessionId: input.sessionId,
          }),
        );
      },
      async fork(input) {
        const sourceDetail = details.get(input.threadId);
        if (!sourceDetail) throw new Error(`Unknown thread: ${input.threadId}`);
        const source = sourceDetail.thread;
        const providerChanging =
          input.provider != null && String(input.provider) !== source.provider;
        let forkBase = String(source.title || "New Thread").trim();
        while (/^fork:\s*/i.test(forkBase)) {
          forkBase = forkBase.replace(/^fork:\s*/i, "").trim();
        }
        const created = newThread({
          projectId: source.projectId,
          title: `Fork: ${forkBase || "New Thread"}`,
          provider: input.provider ? String(input.provider) : source.provider,
          // A model belongs to the provider that offered it.
          model: input.model
            ? String(input.model).trim()
            : providerChanging
              ? null
              : source.model,
          permissionMode:
            input.leavePlan && source.permissionMode === "plan"
              ? "default"
              : source.permissionMode,
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
        if (input.undo === true) {
          const snap = rewindRestore.get(input.threadId);
          if (snap) {
            detail.messages = snap.messages.slice();
            detail.workLog = snap.workLog.slice();
            const restored = patchThread(input.threadId, snap.thread);
            rewindRestore.delete(input.threadId);
            return { thread: restored, droppedMessages: 0, restoredSha: null };
          }
          return { thread: detail.thread, droppedMessages: 0, restoredSha: null };
        }
        if (!String(input.prompt ?? "").trim()) {
          throw new Error("Prompt cannot be empty");
        }
        const at = detail.messages.findIndex((m) => m.id === input.messageId);
        if (at < 0 || detail.messages[at]!.role !== "user") {
          throw new Error(`Not a user message: ${input.messageId}`);
        }
        rewindRestore.set(input.threadId, {
          messages: detail.messages.slice(),
          workLog: detail.workLog.slice(),
          thread: { ...detail.thread },
        });
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
        const row = ctx.threads.find((t) => t.id === threadId);
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
      async savePlan(input) {
        if (!details.has(input.threadId)) {
          throw new Error(`Unknown thread: ${input.threadId}`);
        }
        return { path: "docs/plans/dev-plan.md" };
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
        items?: string[];
      }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        let queued: ThreadInfo["queued"] = null;
        if (input.prompt !== null && input.replace === true) {
          const items =
            input.items && input.items.length
              ? input.items.map(String)
              : [input.prompt];
          queued = { prompt: items.join("\n\n"), items };
          if (input.attachments?.length) queued.attachments = input.attachments;
        } else if (input.prompt !== null) {
          const prev = detail.thread.queued;
          const files = [
            ...(prev?.attachments ?? []),
            ...(input.attachments ?? []),
          ];
          const prevItems = prev?.items
            ? prev.items.map(String)
            : prev?.prompt != null
              ? prev.prompt.split("\n\n")
              : [];
          const items = [...prevItems, input.prompt];
          queued = {
            prompt: items.join("\n\n"),
            items,
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
      async setTags(input: { threadId: string; tags: string[] }) {
        const seen = new Set<string>();
        const clean: string[] = [];
        for (const raw of input.tags ?? []) {
          const tag = String(raw ?? "").trim().toLowerCase().slice(0, 24);
          if (!tag || seen.has(tag)) continue;
          seen.add(tag);
          clean.push(tag);
          if (clean.length >= 12) break;
        }
        return patchThread(input.threadId, { tags: clean });
      },
      async setThreadProject(input: { threadId: string; projectId: string }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const thread = detail.thread;
        if (thread.projectId === input.projectId) return { ...thread };
        if (thread.worktreePath) {
          throw new Error("Cannot move a thread that has a worktree");
        }
        if (thread.orchWorker || thread.leadSnapshotSha) {
          throw new Error("Cannot move a crew worker");
        }
        if (thread.status === "working" || thread.status === "quota-wait") {
          throw new Error("Cannot move a thread while a run is active");
        }
        return patchThread(input.threadId, {
          projectId: input.projectId,
          sessionId: null,
          replayContext: true,
          branch: null,
          baseBranch: null,
          prNumber: null,
          prUrl: null,
          prState: null,
        });
      },
      async setMuted(input: { threadId: string; muted: boolean }) {
        return patchThread(input.threadId, { muted: input.muted });
      },
      async setEjected(input: { threadId: string; ejected: boolean }) {
        return patchThread(input.threadId, { ejected: input.ejected === true });
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
      async setPrWatch(input: { threadId: string; enabled: boolean }) {
        return patchThread(input.threadId, {
          prWatch: input.enabled,
          prWatchState: null,
        });
      },
      async setNotes(input: { threadId: string; notes: string }) {
        return patchThread(input.threadId, {
          notes: String(input.notes ?? "").trim().slice(0, 2000),
        });
      },
      async setMessagePins(input: {
        threadId: string;
        pins: ThreadMessagePin[];
      }) {
        return patchThread(input.threadId, {
          messagePins: normalizeMessagePins(input.pins),
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
      async setPendingWorktree(input: {
        threadId: string;
        worktree: boolean;
        fromOrigin?: boolean;
      }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        if (detail.thread.worktreePath) {
          throw new Error("This thread already has a worktree");
        }
        if (detail.messages.some((m) => m.role === "user")) {
          throw new Error("The workspace is locked after the first message");
        }
        return patchThread(input.threadId, {
          pendingWorktree: input.worktree === true,
          ...(typeof input.fromOrigin === "boolean"
            ? { worktreeFromOrigin: input.fromOrigin }
            : {}),
        });
      },
      async refreshWorkerSnapshot(input: { threadId: string }) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        if (detail.thread.status === "working") {
          throw new Error("Cannot refresh a running worker. Wait until it is idle.");
        }
        if (!detail.thread.orchWorker) {
          throw new Error("Refresh is only for orchestration workers.");
        }
        return patchThread(input.threadId, {
          leadSnapshotSha: "refreshed0000000000000000000000000000000",
          leadSnapshotDirty: false,
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
        const existing = ctx.threads.find((t) => t.id === input.threadId);
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
        const spec = ctx.threads.find((t) => t.id === input.threadId)?.spec;
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
          ctx.threads.find((t) => t.id === input.threadId)?.spec?.slug ?? "spec";
        return {
          path: `${SPEC_DIR}/${slug}/${input.stage}.md`,
          text: DEV_SPEC_ARTIFACTS[input.stage],
        };
      },
      async dispatchSpec(input: { threadId: string }) {
        const existing = ctx.threads.find((t) => t.id === input.threadId);
        if (!existing) throw new Error(`Thread not found: ${input.threadId}`);
        if (!existing.spec) throw new Error("Thread is not in spec mode");
        if (existing.spec.stage !== "build") {
          throw new Error("Dispatch is available after tasks.md is approved");
        }
        return { thread: { ...existing }, dispatched: [] };
      },
      async convergeSpec(input: { threadId: string }) {
        const existing = ctx.threads.find((t) => t.id === input.threadId);
        if (!existing) throw new Error(`Thread not found: ${input.threadId}`);
        if (!existing.spec) throw new Error("Thread is not in spec mode");
        if (existing.spec.stage !== "build") {
          throw new Error("Converge is available after tasks.md is approved");
        }
        return { ...existing };
      },
      async startTeach(input: { threadId: string }) {
        const existing = ctx.threads.find((t) => t.id === input.threadId);
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
        const existing = ctx.threads.find((t) => t.id === input.threadId);
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
        const prevItems = prev?.items
          ? prev.items.map(String)
          : prev?.prompt != null
            ? prev.prompt.split("\n\n")
            : [];
        const items = [...prevItems, card.question];
        return patchThread(input.threadId, {
          btw: remaining.length ? remaining : undefined,
          queued: {
            prompt: items.join("\n\n"),
            items,
            attachments: prev?.attachments,
          },
        });
      },
      async requestTeachReview(input: { threadId: string }) {
        const existing = ctx.threads.find((t) => t.id === input.threadId);
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
        const project = ctx.projects.find((p) => p.id === detail.thread.projectId);
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
        const now = Date.now();
        const proj = ctx.projects.find((p) => p.id === detail.thread.projectId);
        trashed.set(input.threadId, {
          id: input.threadId,
          title: detail.thread.title,
          projectId: detail.thread.projectId,
          projectSlug: proj?.slug ?? null,
          projectMissing: !proj,
          trashedAt: now,
          expiresAt: now + TRASH_TTL_MS,
          thread: detail.thread,
          detail,
        });
        details.delete(input.threadId);
        ctx.threads = ctx.threads.filter((t) => t.id !== input.threadId);
        emitThreads();
      },
      async restore(input) {
        const row = trashed.get(input.threadId);
        if (!row) throw new Error("Thread is not in Recently deleted");
        if (row.projectMissing) {
          throw new Error("Cannot restore: project is no longer available");
        }
        ctx.threads = [row.thread, ...ctx.threads];
        if (row.detail) details.set(input.threadId, row.detail);
        trashed.delete(input.threadId);
        emitThreads();
        return { ...row.thread };
      },
      async purge(input) {
        const live = details.get(input.threadId);
        const row = trashed.get(input.threadId);
        if (!live && !row) throw new Error(`Thread not found: ${input.threadId}`);
        if (live?.thread.worktreePath || row?.thread.worktreePath) {
          throw new Error(
            "Thread still has a worktree. Merge or delete it in the Git tab first.",
          );
        }
        clearRunTimer(input.threadId);
        runStates.delete(input.threadId);
        clearedDiff.delete(input.threadId);
        details.delete(input.threadId);
        trashed.delete(input.threadId);
        ctx.threads = ctx.threads.filter((t) => t.id !== input.threadId);
        emitThreads();
      },
      async listTrashed() {
        return [...trashed.values()].map(
          ({ thread: _thread, detail: _detail, ...row }) => row,
        );
      },
    },
  };
}
