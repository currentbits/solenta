import { useEffect } from "react";
import type { MergeLaneBeat } from "../shared/ipc";

/** How often the lead UI stamps a claimed lane while it is on screen. */
export const LANE_HEARTBEAT_MS = 15_000;

/**
 * Lead-facing beat for a claimed merge-queue lane (#346). Renders nothing.
 * Recycle stays off this surface — a timer without beats would kill live
 * worktrees.
 */
export function LaneHeartbeat({
  threadId,
  claimed,
  heartbeatLane,
}: {
  threadId: string | null;
  claimed: boolean;
  heartbeatLane: (input: {
    threadId: string;
  }) => Promise<MergeLaneBeat | null>;
}) {
  useEffect(() => {
    if (!threadId || !claimed) return;
    const beat = () => {
      void heartbeatLane({ threadId }).catch(() => {
        // never break the lead UI for a lane stamp
      });
    };
    beat();
    const id = setInterval(beat, LANE_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [threadId, claimed, heartbeatLane]);
  return null;
}
