import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  AppSettings,
  AttachmentInfo,
  CoderApi,
  ProjectInfo,
  ThreadDetail,
  ThreadInfo,
} from "../shared/ipc";
import type { CoderError } from "../useCoder";
import { errorMessage } from "./errorMessage";
import { parseBtwCommand } from "../btw";
import { parseFeedbackCommand } from "../feedback";

/** Thread create/fork and run start/rewind for the selected thread. */
export function useCoderRuns({
  api,
  projects,
  settings,
  selectedProjectId,
  selectedThreadId,
  setSelectedThreadId,
  setDetail,
  setError,
  selectedRef,
  threadsRef,
  applyThreads,
}: {
  api: CoderApi;
  projects: ProjectInfo[];
  settings: AppSettings | null;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  setSelectedThreadId: Dispatch<SetStateAction<string | null>>;
  setDetail: Dispatch<SetStateAction<ThreadDetail | null>>;
  setError: Dispatch<SetStateAction<CoderError | null>>;
  selectedRef: RefObject<string | null>;
  threadsRef: RefObject<ThreadInfo[]>;
  applyThreads: (next: ThreadInfo[]) => void;
}) {
  const createThread = useCallback(
    async (
      title = "New Thread",
      projectId?: string,
      opts?: {
        worktree?: boolean;
        orchestrate?: boolean;
        teach?: boolean;
        ask?: boolean;
        issueNumber?: number | null;
        baseBranch?: string | null;
        inheritProvider?: boolean;
      },
    ) => {
      const pid = projectId ?? selectedProjectId;
      if (!pid) return null;
      // Settings can default new threads into a worktree or into an
      // orchestrator; explicit opts win. Both are local-only, so remote
      // projects always get plain threads. An orchestrator never holds a
      // worktree itself — its worker does — so it wins over `worktree`.
      // Ask (issue #392) wins over both: a Q&A thread must never grow a
      // worktree or fork a worker, even when those defaults are on.
      const project = projects.find((p) => p.id === pid);
      const local = !project?.remoteHost;
      const ask = opts?.ask === true;
      const orchestrate =
        !ask &&
        (opts?.orchestrate ?? (settings?.defaultOrchestrate === true && local));
      const worktree =
        !ask &&
        !orchestrate &&
        (opts?.worktree ?? (settings?.defaultWorktree === true && local));
      // Inherit provider+model from the currently selected thread when present.
      const inheritFrom = selectedRef.current
        ? threadsRef.current.find((x) => x.id === selectedRef.current)
        : undefined;
      let t;
      try {
        t = await api.threads.create({
          projectId: pid,
          title,
          ...(worktree ? { worktree: true } : {}),
          ...(orchestrate ? { orchestrate: true } : {}),
          ...(opts?.teach ? { teach: true } : {}),
          ...(ask ? { ask: true } : {}),
          ...(opts?.issueNumber != null ? { issueNumber: opts.issueNumber } : {}),
          ...(opts?.baseBranch ? { baseBranch: opts.baseBranch } : {}),
        });
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        return null;
      }
      // A project default provider (#1501) beats inheriting from whatever
      // thread happens to be selected; main already applied it at create.
      if (
        opts?.inheritProvider !== false &&
        inheritFrom &&
        !project?.threadDefaults?.provider
      ) {
        const needsProvider = inheritFrom.provider !== t.provider;
        const needsModel = inheritFrom.model !== t.model;
        if (needsProvider || needsModel) {
          t = await api.threads.setProvider({
            threadId: t.id,
            ...(needsProvider ? { provider: inheritFrom.provider } : {}),
            ...(needsModel || needsProvider
              ? { model: inheritFrom.model }
              : {}),
          });
        }
      }
      const next = threadsRef.current.some((x) => x.id === t.id)
        ? threadsRef.current.map((x) => (x.id === t.id ? t : x))
        : [t, ...threadsRef.current];
      applyThreads(next);
      selectedRef.current = t.id;
      setSelectedThreadId(t.id);
      return t;
    },
    [api, selectedProjectId, applyThreads, projects, settings],
  );

  const forkThread = useCallback(
    async (
      threadId: string,
      opts?: {
        provider?: string;
        model?: string | null;
        worktree?: boolean;
        select?: boolean;
      },
    ) => {
      try {
        const input: {
          threadId: string;
          provider?: string;
          model?: string | null;
          worktree?: boolean;
        } = { threadId };
        if (opts && Object.prototype.hasOwnProperty.call(opts, "provider")) {
          input.provider = opts.provider;
        }
        if (opts && Object.prototype.hasOwnProperty.call(opts, "model")) {
          input.model = opts.model;
        }
        if (opts && Object.prototype.hasOwnProperty.call(opts, "worktree")) {
          input.worktree = opts.worktree;
        }
        const t = await api.threads.fork(input);
        // Same selection path as createThread: prepend row, select new id.
        const next = threadsRef.current.some((x) => x.id === t.id)
          ? threadsRef.current.map((x) => (x.id === t.id ? t : x))
          : [t, ...threadsRef.current];
        applyThreads(next);
        if (opts?.select !== false) setSelectedThreadId(t.id);
        setError(null);
        return t;
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        return null;
      }
    },
    [api, applyThreads],
  );

  const startRun = useCallback(
    async (
      prompt: string,
      targetThreadId?: string,
      attachments?: AttachmentInfo[],
      opts?: { fromNotice?: boolean; steer?: boolean; fromQueue?: boolean },
    ) => {
      const threadId = targetThreadId ?? selectedThreadId;
      if (!threadId) return;
      // Feedback (issue #681): goes to us, not to the model. Intercepted here
      // with `/btw` so a busy thread does not queue it as the next prompt.
      const feedbackText = parseFeedbackCommand(prompt);
      if (feedbackText) {
        try {
          // The confirmation message arrives on the `thread:updated` push the
          // handler broadcasts, so there is nothing to merge here.
          await api.app.feedback({ text: feedbackText, threadId });
          setError(null);
        } catch (err) {
          setError({ scope: "run", message: errorMessage(err) });
          throw err;
        }
        return;
      }
      // Side question (issue #471): intercept BEFORE the busy-queue path so
      // `/btw` never becomes the next follow-up and never starts a main turn.
      const btwQuestion = parseBtwCommand(prompt);
      if (btwQuestion) {
        try {
          const updated = await api.threads.btw({
            threadId,
            question: btwQuestion,
          });
          applyThreads(
            threadsRef.current.map((t) =>
              t.id === updated.id ? updated : t,
            ),
          );
          setDetail((prev) =>
            prev && prev.thread.id === updated.id
              ? { ...prev, thread: updated }
              : prev,
          );
          setError(null);
        } catch (err) {
          setError({ scope: "run", message: errorMessage(err) });
          throw err;
        }
        return;
      }
      // Busy thread: hold the prompt instead of bouncing off the backend's
      // "run already active" (issue #92). Append lives in setQueued so two
      // mid-run sends cannot race-replace each other across the IPC hop.
      // Steer (issue #156) injects into the live process instead; if the
      // run just landed, fall back to queueing.
      if (
        threadsRef.current.find((t) => t.id === threadId)?.status === "working"
      ) {
        if (opts?.steer) {
          try {
            await api.runs.steer({ threadId, prompt, attachments });
          } catch (err) {
            const msg = errorMessage(err);
            if (!/no live run/i.test(msg) && !/not accepting input/i.test(msg)) {
              setError({ scope: "run", message: msg });
              throw err;
            }
            try {
              const updated = await api.threads.setQueued({
                threadId,
                prompt,
                attachments,
              });
              applyThreads(
                threadsRef.current.map((t) =>
                  t.id === updated.id ? updated : t,
                ),
              );
              setDetail((prev) =>
                prev && prev.thread.id === updated.id
                  ? { ...prev, thread: updated }
                  : prev,
              );
              setError(null);
            } catch (queueErr) {
              setError({ scope: "run", message: errorMessage(queueErr) });
              throw queueErr;
            }
            return;
          }
          // Steer already landed. A refresh miss must not look like
          // undelivered work: Composer would keep the draft and send again.
          try {
            const d = await api.threads.get(threadId);
            if (selectedRef.current !== threadId) return;
            setDetail(d);
            applyThreads(
              threadsRef.current.map((t) =>
                t.id === d.thread.id ? d.thread : t,
              ),
            );
            setError(null);
          } catch (err) {
            setError({ scope: "run", message: errorMessage(err) });
          }
          return;
        }
        try {
          const updated = await api.threads.setQueued({
            threadId,
            prompt,
            attachments,
          });
          applyThreads(
            threadsRef.current.map((t) =>
              t.id === updated.id ? updated : t,
            ),
          );
          setDetail((prev) =>
            prev && prev.thread.id === updated.id
              ? { ...prev, thread: updated }
              : prev,
          );
          setError(null);
        } catch (err) {
          setError({ scope: "run", message: errorMessage(err) });
        }
        return;
      }
      try {
        await api.runs.start({
          threadId,
          prompt,
          attachments,
          ...(opts?.fromNotice ? { fromNotice: true } : {}),
          ...(opts?.fromQueue ? { fromQueue: true } : {}),
        });
        const d = await api.threads.get(threadId);
        if (selectedRef.current !== threadId) return;
        setDetail(d);
        applyThreads(
          threadsRef.current.map((t) =>
            t.id === d.thread.id ? d.thread : t,
          ),
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const rewindAndResubmit = useCallback(
    async (
      messageId: string,
      prompt: string,
      restoreFiles?: boolean,
      attachments?: AttachmentInfo[],
    ) => {
      const threadId = selectedThreadId;
      if (!threadId) return;
      try {
        await api.threads.rewind({
          threadId,
          messageId,
          prompt,
          restoreFiles,
        });
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
      // Do not refetch between rewind and start: the edited bubble is in
      // the dropped tail, so a reload unmounts the inline editor. Start
      // success reloads via startRun; start reject undoes then reloads.
      try {
        await startRun(prompt, threadId, attachments);
      } catch (err) {
        try {
          await api.threads.rewind({ threadId, undo: true });
        } catch {
          // Keep the start error; undo is best-effort.
        }
        try {
          const d = await api.threads.get(threadId);
          if (selectedRef.current === threadId) {
            setDetail(d);
            applyThreads(
              threadsRef.current.map((t) =>
                t.id === d.thread.id ? d.thread : t,
              ),
            );
          }
        } catch {
          // Banner already set by startRun.
        }
        throw err;
      }
    },
    [api, selectedThreadId, startRun, applyThreads],
  );

  return {
    createThread,
    forkThread,
    startRun,
    rewindAndResubmit,
  };
}
