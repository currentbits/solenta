import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { CoderApi, ProjectInfo } from "../shared/ipc";
import type { AppView, DrawerId } from "../App";
import type { RepeatDraft } from "../repeatThread";
import { validProjectId, type ViewReturnState } from "../viewReturn";

/** Switches App views and restores a report's return state (#942). */
export function useViewNavigation({
  api,
  viewRef,
  returnToRef,
  projectsRef,
  selectedThreadProjectIdRef,
  setView,
  setDrawer,
  setReturnTo,
  setViewRestore,
  setRepeatDraft,
  setKanbanProjectId,
  setPlanboardProjectId,
  setActivityProjectId,
}: {
  api: CoderApi;
  viewRef: RefObject<AppView>;
  returnToRef: RefObject<ViewReturnState | null>;
  projectsRef: RefObject<ProjectInfo[]>;
  selectedThreadProjectIdRef: RefObject<string | null>;
  setView: Dispatch<SetStateAction<AppView>>;
  setDrawer: Dispatch<SetStateAction<DrawerId | null>>;
  setReturnTo: Dispatch<SetStateAction<ViewReturnState | null>>;
  setViewRestore: Dispatch<SetStateAction<ViewReturnState | null>>;
  setRepeatDraft: Dispatch<SetStateAction<RepeatDraft | null>>;
  setKanbanProjectId: Dispatch<SetStateAction<string | null>>;
  setPlanboardProjectId: Dispatch<SetStateAction<string | null>>;
  setActivityProjectId: Dispatch<SetStateAction<string | null>>;
}) {
  const consumeReturn = useCallback((viewName: ViewReturnState["view"]) => {
    const dest = returnToRef.current;
    const returning =
      viewRef.current === "thread" && dest?.view === viewName;
    if (!returning) {
      setViewRestore(null);
      setReturnTo(null);
      return null;
    }
    setViewRestore(dest);
    setReturnTo(null);
    return dest;
  }, []);

  const openThreads = useCallback(() => {
    setView("thread");
    setDrawer(null);
  }, []);
  const openKanban = useCallback((pid?: string | null) => {
    const dest = consumeReturn("kanban");
    if (dest) {
      setKanbanProjectId(
        validProjectId(dest.projectId, projectsRef.current),
      );
    } else {
      setKanbanProjectId(pid ?? null);
    }
    setView("kanban");
    setDrawer(null);
  }, [consumeReturn]);
  const openPlanboard = useCallback(
    (pid?: string | null) => {
      const dest = consumeReturn("planboard");
      if (dest) {
        setPlanboardProjectId(
          validProjectId(dest.projectId, projectsRef.current) ??
            selectedThreadProjectIdRef.current,
        );
      } else {
        setPlanboardProjectId(pid ?? selectedThreadProjectIdRef.current);
      }
      setView("planboard");
      setDrawer(null);
    },
    [consumeReturn],
  );
  const openPrs = useCallback(() => {
    consumeReturn("prs");
    setView("prs");
    setDrawer(null);
  }, [consumeReturn]);
  const openAutomations = useCallback(() => {
    setRepeatDraft(null);
    setReturnTo(null);
    setViewRestore(null);
    setView("automations");
    setDrawer(null);
  }, []);
  const openActivity = useCallback((pid?: string | null) => {
    const dest = consumeReturn("activity");
    if (dest) {
      setActivityProjectId(
        validProjectId(dest.projectId, projectsRef.current),
      );
    } else {
      setActivityProjectId(pid ?? null);
    }
    setView("activity");
    setDrawer(null);
  }, [consumeReturn]);
  const openUsage = useCallback(() => {
    setReturnTo(null);
    setViewRestore(null);
    setView("usage");
    setDrawer(null);
  }, []);
  const openFleet = useCallback(() => {
    setReturnTo(null);
    setViewRestore(null);
    setView("fleet");
    setDrawer(null);
  }, []);
  const openInsights = useCallback(() => {
    consumeReturn("insights");
    setView("insights");
    setDrawer(null);
  }, [consumeReturn]);
  const loadFailureModes = useCallback(
    () => api.insights.failureModes(),
    [api],
  );
  // ponytail: collect the widest range once; summarizeFleet slices client-side
  const loadFleetEvidence = useCallback(
    () => api.fleet.evidence({ days: 90 }),
    [api],
  );
  const openDigest = useCallback(() => {
    consumeReturn("digest");
    setView("digest");
    setDrawer(null);
  }, [consumeReturn]);
  const handleReturnToView = useCallback(() => {
    const dest = returnToRef.current;
    if (!dest) return;
    if (dest.view === "planboard") openPlanboard();
    else if (dest.view === "kanban") openKanban();
    else if (dest.view === "activity") openActivity();
    else if (dest.view === "digest") openDigest();
    else if (dest.view === "prs") openPrs();
    else if (dest.view === "insights") openInsights();
  }, [
    openPlanboard,
    openKanban,
    openActivity,
    openDigest,
    openPrs,
    openInsights,
  ]);

  return {
    openThreads,
    openKanban,
    openPlanboard,
    openPrs,
    openAutomations,
    openActivity,
    openUsage,
    openFleet,
    openInsights,
    loadFailureModes,
    loadFleetEvidence,
    openDigest,
    handleReturnToView,
  };
}
