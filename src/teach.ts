import type { PermissionMode, TeachAutonomy, ThreadTeach } from "./shared/ipc";
import { TEACH_REVIEW_THRESHOLDS } from "./shared/ipc";

export const TEACH_AUTONOMY_LABELS: Record<TeachAutonomy, string> = {
  hint: "Hints",
  review: "Review",
  pair: "Pair",
};

/** Passed-review count → autonomy rung. Mirror electron/services.js. */
export function teachAutonomyFor(reviewsPassed: number): TeachAutonomy {
  const n = Number(reviewsPassed) || 0;
  if (n >= TEACH_REVIEW_THRESHOLDS.pair) return "pair";
  if (n >= TEACH_REVIEW_THRESHOLDS.review) return "review";
  return "hint";
}

/**
 * Permission modes allowed at this autonomy rung.
 * hint: ask / plan. review: + accept edits. pair: full access too.
 */
export function teachAllowedPermissionModes(
  autonomy: TeachAutonomy,
): PermissionMode[] {
  if (autonomy === "pair") {
    return ["default", "acceptEdits", "plan", "bypassPermissions"];
  }
  if (autonomy === "review") {
    return ["default", "acceptEdits", "plan"];
  }
  return ["default", "plan"];
}

export function teachPermissionAllowed(
  mode: PermissionMode,
  teach: ThreadTeach | null | undefined,
): boolean {
  if (!teach || !teach.autonomy) return true;
  return teachAllowedPermissionModes(teach.autonomy).includes(mode);
}
