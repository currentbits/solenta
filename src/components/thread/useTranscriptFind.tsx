import { useEffect, useLayoutEffect, useMemo, type RefObject } from "react";
import {
  findTranscriptHits,
  stepIndex,
  type TranscriptHit,
} from "../../findInView";
import { nearestScrollTop, offsetTopWithin } from "../../scrollNearest";
import type { ThreadDetail } from "../../shared/ipc";
import { FindBar, useFindSession, useFindShortcut } from "../FindBar";
import type { DisplayEntry } from "../../toolGroups";

export function useTranscriptFind(
  detail: ThreadDetail | null,
  threadId: string | null,
) {
  const session = useFindSession();
  useFindShortcut("transcript", session.openFind);
  useEffect(() => {
    session.closeFind();
    // Reset when the open thread changes; closeFind is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const hits = useMemo(
    () =>
      session.open && detail
        ? findTranscriptHits(
            {
              messages: detail.messages,
              plan: detail.thread.plan,
              planSteps: detail.thread.planSteps,
            },
            session.query,
          )
        : [],
    [session.open, session.query, detail],
  );
  const current = hits[session.index] ?? null;

  const step = (dir: 1 | -1) => {
    session.setIndex((i) => stepIndex(i, hits.length, dir));
  };

  const bar = session.open ? (
    <FindBar
      surface="transcript"
      query={session.query}
      current={hits.length ? session.index : 0}
      total={hits.length}
      inputRef={session.inputRef}
      onQuery={session.updateQuery}
      onNext={() => step(1)}
      onPrev={() => step(-1)}
      onClose={session.closeFind}
    />
  ) : null;

  return {
    open: session.open,
    query: session.query,
    hits,
    current,
    bar,
  };
}

export function revealTranscriptHit(
  current: TranscriptHit | null,
  detail: ThreadDetail | null,
  displayTimeline: DisplayEntry[],
  setters: {
    setJumpMessageId: (id: string | null) => void;
    setRevealPlan: (open: boolean) => void;
    setCollapsedRuns: (
      fn: (prev: ReadonlySet<string>) => ReadonlySet<string>,
    ) => void;
    expandFocusFor: (messageId: string) => void;
    setExpandedGroups: (
      fn: (prev: ReadonlySet<string>) => ReadonlySet<string>,
    ) => void;
  },
): void {
  if (!current) return;
  if (current.kind === "plan") {
    setters.setRevealPlan(true);
    setters.setJumpMessageId(null);
    return;
  }
  setters.setRevealPlan(false);
  setters.setJumpMessageId(current.id);
  const msg = detail?.messages.find((m) => m.id === current.id);
  if (msg?.runId) {
    const runId = msg.runId;
    setters.setCollapsedRuns((prev) => {
      if (!prev.has(runId)) return prev;
      const next = new Set(prev);
      next.delete(runId);
      return next;
    });
  }
  const group = displayTimeline.find(
    (entry) =>
      entry.kind === "group" &&
      entry.group.messages.some((m) => m.id === current.id),
  );
  if (group && group.kind === "group") {
    setters.setExpandedGroups((prev) => {
      if (prev.has(group.group.id)) return prev;
      const next = new Set(prev);
      next.add(group.group.id);
      return next;
    });
  }
  setters.expandFocusFor(current.id);
}

export function useScrollFindHit(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  current: TranscriptHit | null,
  deps: unknown[],
) {
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll("[data-find-current]")) {
      el.removeAttribute("data-find-current");
    }
    if (!open || !current) return;
    const sel =
      current.kind === "plan"
        ? "[data-plan-card]"
        : `[data-message-id="${cssAttr(current.id)}"], [data-msg="${cssAttr(current.id)}"]`;
    const child = root.querySelector(sel);
    if (!(child instanceof HTMLElement)) return;
    child.setAttribute("data-find-current", "");
    const next = nearestScrollTop(
      { scrollTop: root.scrollTop, clientHeight: root.clientHeight },
      {
        offsetTop: offsetTopWithin(root, child),
        offsetHeight: child.offsetHeight,
      },
    );
    if (next !== root.scrollTop) root.scrollTop = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current, ...deps]);
}

function cssAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
