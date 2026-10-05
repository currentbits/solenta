import { useEffect, useState } from "react";
import type { DiffResult, GitSyncInfo, ThreadDetail } from "../../shared/ipc";

/** Header behind-upstream count and the details card's git summary. */
export function useHeaderGitStatus({
  detail,
  detailsOpen,
  gitSyncInfo,
  onFetchDiff,
  syncRefreshNonce,
}: {
  detail: ThreadDetail | null;
  detailsOpen: boolean;
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  onFetchDiff: () => Promise<DiffResult>;
  syncRefreshNonce: number;
}) {
  /** Header attention (#1411): the branch is behind its upstream. Local read,
   *  no fetch; refreshed when the thread opens and when a run settles. */
  const [headerBehind, setHeaderBehind] = useState(0);
  const attentionThreadId = detail?.thread.id ?? null;
  const attentionStatus = detail?.thread.status;
  useEffect(() => {
    if (!attentionThreadId || !gitSyncInfo || attentionStatus === "working") {
      if (!attentionThreadId) setHeaderBehind(0);
      return;
    }
    let live = true;
    gitSyncInfo(attentionThreadId).then(
      (info) => {
        if (live) setHeaderBehind(info.hasUpstream ? info.behind ?? 0 : 0);
      },
      () => {
        if (live) setHeaderBehind(0);
      },
    );
    return () => {
      live = false;
    };
  }, [attentionThreadId, attentionStatus, gitSyncInfo, syncRefreshNonce]);
  const [detailsGit, setDetailsGit] = useState<{
    changed: number;
    sync: GitSyncInfo | null;
  } | null>(null);
  const detailsThreadId = detail?.thread.id ?? null;
  useEffect(() => {
    if (!detailsOpen || !detailsThreadId) return;
    let live = true;
    void (async () => {
      let changed = 0;
      try {
        changed = (await onFetchDiff()).files.length;
      } catch {
        changed = 0;
      }
      let sync: GitSyncInfo | null = null;
      if (gitSyncInfo) {
        try {
          sync = await gitSyncInfo(detailsThreadId);
        } catch {
          sync = null;
        }
      }
      if (live) setDetailsGit({ changed, sync });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsOpen, detailsThreadId, syncRefreshNonce]);
  return { headerBehind, detailsGit };
}
