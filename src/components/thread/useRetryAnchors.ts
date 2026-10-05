import { useMemo } from "react";
import type { ThreadDetail } from "../../shared/ipc";
import {
  failedWorkflowRetryAgentId,
  isWorkflowLastRun,
  retryActionTitle,
  retryAnchorEventId,
  retryTarget,
} from "../../retryTurn";

/** Retry turn target plus the failure event cards that carry an action. */
export function useRetryAnchors(detail: ThreadDetail | null) {
  /** Prompt Retry turn will re-send, plus the event card that carries it. */
  const retrySend = useMemo(
    () => (detail ? retryTarget(detail.messages) : null),
    [detail],
  );
  const retryEventId = useMemo(
    () =>
      detail
        ? retryAnchorEventId(
            detail.thread.status,
            detail.messages,
            detail.workflow,
          )
        : null,
    [detail],
  );
  const workflowRetryAgentId = useMemo(() => {
    if (!detail || !isWorkflowLastRun(detail.messages, detail.workflow)) {
      return null;
    }
    return failedWorkflowRetryAgentId(
      detail.workflow,
      detail.thread.status,
    );
  }, [detail]);
  const overflowEventId = useMemo(() => {
    if (
      !detail ||
      detail.thread.status !== "failed" ||
      detail.thread.lastErrorKind !== "context-overflow"
    ) {
      return null;
    }
    const last = detail.messages[detail.messages.length - 1];
    return last?.role === "event" && !last.thinking ? last.id : null;
  }, [detail]);
  const upgradeEventId = useMemo(() => {
    if (
      !detail ||
      detail.thread.status !== "failed" ||
      detail.thread.lastErrorKind !== "cli-upgrade"
    ) {
      return null;
    }
    const last = detail.messages[detail.messages.length - 1];
    return last?.role === "event" && !last.thinking ? last.id : null;
  }, [detail]);
  // Writer-lock (#953): hide Retry so it cannot resume the same locked
  // session. No replacement button; wait, then send. /fork is the hatch
  // (#554 eject-to-terminal is unimplemented).
  const writerLockEventId = useMemo(() => {
    if (
      !detail ||
      detail.thread.status !== "failed" ||
      detail.thread.lastErrorKind !== "writer-lock"
    ) {
      return null;
    }
    const last = detail.messages[detail.messages.length - 1];
    return last?.role === "event" && !last.thinking ? last.id : null;
  }, [detail]);
  const retryTitle = useMemo(
    () => (retrySend ? retryActionTitle(retrySend) : ""),
    [retrySend],
  );
  return {
    retrySend,
    retryEventId,
    workflowRetryAgentId,
    overflowEventId,
    upgradeEventId,
    writerLockEventId,
    retryTitle,
  };
}
