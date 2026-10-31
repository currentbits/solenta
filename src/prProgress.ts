/**
 * createPr progress (issue #1803): fold the "pr:progress" push stream into
 * step-list UI state shared by CreatePrDialog and ChangesPanel's inline
 * Commit & PR button.
 */
import type { PrProgressPush, PrStep } from "./shared/ipc";

/** Pipeline order createPr reports steps in. */
export const PR_STEP_ORDER: readonly PrStep[] = ["commit", "push", "create", "link"];

export type PrStepUiState = "pending" | "active" | "done" | "error" | "skipped";

export type PrSteps = Record<PrStep, { state: PrStepUiState; detail?: string }>;

export function initialPrSteps(): PrSteps {
  return {
    commit: { state: "pending" },
    push: { state: "pending" },
    create: { state: "pending" },
    link: { state: "pending" },
  };
}

const EVENT_STATE: Record<PrProgressPush["state"], PrStepUiState> = {
  start: "active",
  done: "done",
  error: "error",
  skipped: "skipped",
};

/** Fold one "pr:progress" push into the step-list state it renders. */
export function applyPrStep(
  steps: PrSteps,
  event: Pick<PrProgressPush, "step" | "state" | "detail">,
): PrSteps {
  return {
    ...steps,
    [event.step]: { state: EVENT_STATE[event.state], detail: event.detail },
  };
}

/**
 * Caller-minted id for one createPr call's "pr:progress" pushes — same
 * pattern as clone:progress's cloneId (src/sidebarViews.ts newViewId).
 */
export function newPrRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
