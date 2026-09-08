import { useEffect } from "react";

/** How often the lead UI stamps a claimed lane while it is on screen. */
export const LANE_HEARTBEAT_MS = 15_000;

type LaneBeat = {
  n: number;
  port: number;
  claimedAt: number;
  lastBeat: number;
};

type HeartbeatProject = {
  id: string;
  remoteHost?: string;
};

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
  }) => Promise<LaneBeat | null>;
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

/**
 * App-level beat for every claimed merge-queue lane across every local
 * project (#1114). Renders nothing. Survives leaving the Environment Git
 * tab and switching the selected project. Remote projects are skipped.
 * Recycle stays off this surface.
 */
export function ClaimedLanesHeartbeat({
  projects,
  listLanes,
  heartbeatLane,
}: {
  projects: HeartbeatProject[];
  listLanes: (input: { projectId: string }) => Promise<{ threadId: string }[]>;
  heartbeatLane: (input: {
    threadId: string;
  }) => Promise<LaneBeat | null>;
}) {
  const localIds = projects
    .filter((p) => p.id && !p.remoteHost)
    .map((p) => p.id)
    .join("\0");
  useEffect(() => {
    const ids = localIds ? localIds.split("\0") : [];
    if (ids.length === 0) return;
    let cancelled = false;
    const beat = () => {
      for (const projectId of ids) {
        void listLanes({ projectId })
          .then((lanes) => {
            if (cancelled) return;
            for (const row of lanes) {
              void heartbeatLane({ threadId: row.threadId }).catch(() => {
                // never break the lead UI for a lane stamp
              });
            }
          })
          .catch(() => {
            // never break the lead UI for a lane list
          });
      }
    };
    beat();
    const id = setInterval(beat, LANE_HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [localIds, listLanes, heartbeatLane]);
  return null;
}
