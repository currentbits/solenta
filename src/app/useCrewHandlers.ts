import { useCallback } from "react";
import type { UseCoderResult } from "../useCoder";

/** Lead-thread crew actions for the Agents panel: integrate, verify, land. */
export function useCrewHandlers({
  selectedThreadId,
  visibleDetail,
  integrateWorker,
  runVerify,
  crewIntegration,
  createPr,
  mergeWorktree,
}: {
  selectedThreadId: UseCoderResult["selectedThreadId"];
  visibleDetail: UseCoderResult["detail"];
  integrateWorker: UseCoderResult["integrateWorker"];
  runVerify: UseCoderResult["runVerify"];
  crewIntegration: UseCoderResult["crewIntegration"];
  createPr: UseCoderResult["createPr"];
  mergeWorktree: UseCoderResult["mergeWorktree"];
}) {
  const integrateSelectedWorker = useCallback(
    async (workerThreadId: string) => {
      if (selectedThreadId) await integrateWorker(selectedThreadId, workerThreadId);
    },
    [selectedThreadId, integrateWorker],
  );
  const verifySelectedLead = useCallback(async () => {
    if (selectedThreadId) await runVerify(selectedThreadId);
  }, [selectedThreadId, runVerify]);
  const leadTitle = visibleDetail?.thread.title;
  const landSelectedLead = useCallback(async () => {
    if (!selectedThreadId) return;
    const view = await crewIntegration(selectedThreadId);
    if (view.finalAction === "pr") {
      await createPr({ title: leadTitle || "Lead integration" });
      return;
    }
    await mergeWorktree();
  }, [selectedThreadId, crewIntegration, createPr, mergeWorktree, leadTitle]);

  return {
    integrateSelectedWorker,
    verifySelectedLead,
    landSelectedLead,
  };
}
