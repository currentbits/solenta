import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { UseCoderResult } from "../useCoder";
import type { AppView } from "../App";
import type { ThreadStartMode } from "../components/PlanboardView";
import {
  providerPermissionModes,
  snapToHonouredPermissionMode,
} from "../format";

/** Thread starters from outside the composer: CLI import, issue, PR checkout. */
export function useIssueStarters({
  settings,
  providers,
  importCliSession,
  fetchIssue,
  createThread,
  startRun,
  setIssuePlanStatus,
  setProvider,
  setReasoningEffort,
  setPermissionMode,
  checkoutPr,
  setView,
  setRevealThreadId,
}: {
  settings: UseCoderResult["settings"];
  providers: UseCoderResult["providers"];
  importCliSession: UseCoderResult["importCliSession"];
  fetchIssue: UseCoderResult["fetchIssue"];
  createThread: UseCoderResult["createThread"];
  startRun: UseCoderResult["startRun"];
  setIssuePlanStatus: UseCoderResult["setIssuePlanStatus"];
  setProvider: UseCoderResult["setProvider"];
  setReasoningEffort: UseCoderResult["setReasoningEffort"];
  setPermissionMode: UseCoderResult["setPermissionMode"];
  checkoutPr: UseCoderResult["checkoutPr"];
  setView: Dispatch<SetStateAction<AppView>>;
  setRevealThreadId: Dispatch<SetStateAction<string | null>>;
}) {
  const handleImportCliSession = useCallback(
    async (input: {
      sessionId: string;
      projectId: string;
      provider?: "codex" | "grok" | "claude" | "cursor" | "opencode" | "kimi" | "muse";
    }) => {
      const t = await importCliSession(input);
      setRevealThreadId(t.id);
      return t;
    },
    [importCliSession],
  );

  const handleCreateThreadFromIssue = useCallback(
    async (input: {
      projectId: string;
      projectPath: string;
      ref: string;
      mode?: ThreadStartMode;
      agentProfileId?: string;
    }) => {
      let fetched;
      try {
        fetched = await fetchIssue(input.projectPath, input.ref);
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (!fetched.ok) return fetched;
      const issue = fetched.issue;
      let thread;
      try {
        // "default" (and the sidebar's issue button, which sends no mode)
        // follows the app setting; the rest are explicit overrides.
        const opts =
          input.mode === "orchestrator"
            ? { orchestrate: true }
            : input.mode === "worktree"
              ? { worktree: true }
              : input.mode === "plain"
                ? { worktree: false, orchestrate: false }
                : undefined;
        thread = await createThread(issue.title, input.projectId, {
          ...opts,
          // Linear identifiers are not GitHub issue numbers; post-merge
          // reopen scans `GitHub issue #N:` and ThreadInfo.issueNumber.
          ...(issue.source === "linear" ? {} : { issueNumber: issue.number }),
        });
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (!thread) {
        return { ok: false as const, reason: "Could not create thread" };
      }
      if (input.agentProfileId) {
        const profile = (settings?.agentProfiles ?? []).find(
          (p) => p.id === input.agentProfileId,
        );
        if (!profile) {
          return { ok: false as const, reason: "Unknown agent profile" };
        }
        const info = providers.find((p) => p.id === profile.provider);
        if (!info || info.available === false) {
          return {
            ok: false as const,
            reason: `${profile.name} is not installed`,
          };
        }
        try {
          // Same order as Composer.pickProfile: setProvider clears effort
          // on a harness switch, then effort, then permission.
          await setProvider({
            threadId: thread.id,
            provider: profile.provider,
            model: profile.model,
          });
          await setReasoningEffort(profile.reasoningEffort, thread.id);
          await setPermissionMode(
            snapToHonouredPermissionMode(
              providerPermissionModes(info),
              profile.permissionMode,
            ),
            thread.id,
          );
        } catch (err) {
          return {
            ok: false as const,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }
      const body = issue.body || "";
      const heading =
        issue.source === "linear"
          ? `Linear issue ${issue.identifier || issue.number}`
          : `GitHub issue #${issue.number}`;
      const prompt = `${heading}: ${issue.title}\n${issue.url}\n\n${body}`;
      try {
        await startRun(prompt, thread.id);
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      // GitHub plan:* labels do not exist on Linear. Skip the column move.
      if (issue.source === "linear") {
        return { ok: true as const };
      }
      // The run is live either way, so a failed label move is a warning,
      // not a failure: say so instead of pretending the card moved.
      let moved;
      try {
        moved = await setIssuePlanStatus(
          input.projectPath,
          issue.number,
          "doing",
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ok: true as const,
          warning: `plan:doing not set (${reason})`,
        };
      }
      return moved.ok
        ? { ok: true as const }
        : { ok: true as const, warning: `plan:doing not set (${moved.reason})` };
    },
    [
      fetchIssue,
      createThread,
      startRun,
      setIssuePlanStatus,
      settings?.agentProfiles,
      providers,
      setProvider,
      setReasoningEffort,
      setPermissionMode,
    ],
  );

  const handleCheckoutPr = useCallback(
    async (input: { projectId: string; prNumber: number }) => {
      let result;
      try {
        result = await checkoutPr(input);
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (!result.ok) return result;
      setView("thread");
      setRevealThreadId(result.thread.id);
      if (result.created) {
        try {
          await startRun(result.prompt, result.thread.id);
        } catch {
          // Checkout landed; the run error is already in useCoder.error.
        }
      }
      return result;
    },
    [checkoutPr, startRun],
  );

  return {
    handleImportCliSession,
    handleCreateThreadFromIssue,
    handleCheckoutPr,
  };
}
