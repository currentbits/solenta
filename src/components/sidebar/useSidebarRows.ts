import { useMemo } from "react";
import type { ProjectInfo, ThreadInfo } from "../../shared/ipc";
import {
  buildFlatSidebar,
  nestWorkerFamilies,
  visibleFamilyRows,
  workerIdsByRoot,
} from "../../sidebarGroups";
import {
  groupThreadsByProject,
  groupThreadsByStatus,
  groupThreadsByTag,
  type GroupBy,
} from "../../sidebarFilters";
import type { buildWaitStates } from "../../waiting";

type SettleOpts = Parameters<typeof buildFlatSidebar>[1];

/**
 * The list's row model: the flat shelves, the grouped views, and each
 * shelf's visible rows and worker families for the current expansion.
 */
export function useSidebarRows({
  displayThreads,
  settleOpts,
  groupBy,
  projects,
  waitStates,
  liveById,
  workerOpen,
  keepThreadIds,
  searching,
  searchResults,
}: {
  displayThreads: ThreadInfo[];
  settleOpts: SettleOpts;
  groupBy: GroupBy;
  projects: ProjectInfo[];
  waitStates: ReturnType<typeof buildWaitStates>;
  liveById: Map<string, ThreadInfo>;
  workerOpen: Set<string>;
  keepThreadIds: (string | null | undefined)[];
  searching: boolean;
  searchResults: ThreadInfo[] | null;
}) {
  const flat = useMemo(
    () => buildFlatSidebar(displayThreads, settleOpts),
    [displayThreads, settleOpts],
  );

  // Grouped views have no Working shelf: busy rows stay in their groups.
  const attentionThreads = useMemo(
    () => [...flat.pinned, ...flat.active, ...flat.working],
    [flat.pinned, flat.active, flat.working],
  );
  const projectGroups = useMemo(
    () =>
      groupBy === "project"
        ? groupThreadsByProject(projects, attentionThreads)
        : [],
    [groupBy, projects, attentionThreads],
  );
  const statusGroups = useMemo(
    () =>
      groupBy === "status"
        ? groupThreadsByStatus(attentionThreads, waitStates).map((g) => ({
            ...g,
            threads: nestWorkerFamilies(g.threads, liveById),
          }))
        : [],
    [groupBy, attentionThreads, waitStates, liveById],
  );
  const tagGroups = useMemo(
    () =>
      groupBy === "tag"
        ? groupThreadsByTag(attentionThreads).map((g) => ({
            ...g,
            threads: nestWorkerFamilies(g.threads, liveById),
          }))
        : [],
    [groupBy, attentionThreads, liveById],
  );
  const searchHitIds = useMemo(() => {
    if (!searching || searchResults == null) return undefined;
    return new Set(searchResults.map((t) => t.id));
  }, [searching, searchResults]);

  const familyOpts = useMemo(
    () => ({
      expandedRootIds: workerOpen,
      keepIds: keepThreadIds,
      keepWorkerIds: searchHitIds,
      byIdFull: liveById,
    }),
    [workerOpen, keepThreadIds, searchHitIds, liveById],
  );

  const visiblePinned = useMemo(
    () => visibleFamilyRows(flat.pinned, familyOpts),
    [flat.pinned, familyOpts],
  );
  const visibleActive = useMemo(
    () => visibleFamilyRows(flat.active, familyOpts),
    [flat.active, familyOpts],
  );
  const pinnedFamilies = useMemo(
    () => workerIdsByRoot(flat.pinned, liveById),
    [flat.pinned, liveById],
  );
  const activeFamilies = useMemo(
    () => workerIdsByRoot(flat.active, liveById),
    [flat.active, liveById],
  );
  const visibleWorking = useMemo(
    () => visibleFamilyRows(flat.working, familyOpts),
    [flat.working, familyOpts],
  );
  const workingFamilies = useMemo(
    () => workerIdsByRoot(flat.working, liveById),
    [flat.working, liveById],
  );
  const searchFamilies = useMemo(
    () => workerIdsByRoot(displayThreads, liveById),
    [displayThreads, liveById],
  );
  return {
    flat,
    projectGroups,
    statusGroups,
    tagGroups,
    familyOpts,
    visiblePinned,
    visibleActive,
    pinnedFamilies,
    activeFamilies,
    visibleWorking,
    workingFamilies,
    searchFamilies,
  };
}
