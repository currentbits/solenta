import {
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ThreadDetail } from "../../shared/ipc";
import type { TimelineEntry } from "../../timeline";
import { nearestScrollTop, offsetTopWithin } from "../../scrollNearest";
import { extendWindowStart } from "../../transcriptWindow";

const STICK_BOTTOM_PX = 80;

/**
 * Transcript stick-to-bottom (#607, #408): pin before paint on thread switch
 * and new permission cards, keep pinned through post-paint growth, restore
 * scroll after Show earlier, and track the user's scroll position.
 * `stickToBottom`/`forceStick` stay owned by ThreadView, which also resets
 * them on thread switch and pin jumps.
 */
export function useStickToBottom({
  bodyRef,
  stickToBottom,
  forceStick,
  detail,
  timeline,
  isWorking,
  start,
  revealTargetId,
  setWindowStart,
}: {
  bodyRef: RefObject<HTMLDivElement | null>;
  stickToBottom: RefObject<boolean>;
  forceStick: RefObject<boolean>;
  detail: ThreadDetail | null;
  timeline: TimelineEntry[];
  isWorking: boolean;
  start: number;
  revealTargetId: string | null;
  setWindowStart: Dispatch<SetStateAction<number>>;
}) {
  const pinning = useRef(false);
  const prevLayoutThreadId = useRef<string | null>(null);
  const seenThread = useRef(false);
  const prevPermReq = useRef<string | null>(null);
  const pendingPrepend = useRef<number | null>(null);
  const pinIfStuck = () => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= 0) return;
    pinning.current = true;
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    const landed =
      el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_PX;
    if (el.scrollTop !== before && landed) {
      forceStick.current = false;
    }
    requestAnimationFrame(() => {
      pinning.current = false;
    });
  };
  const pinIfStuckRef = useRef(pinIfStuck);
  pinIfStuckRef.current = pinIfStuck;

  const showEarlier = () => {
    stickToBottom.current = false;
    forceStick.current = false;
    const el = bodyRef.current;
    pendingPrepend.current = el ? el.scrollHeight : 0;
    setWindowStart((s) => extendWindowStart(s));
  };

  const prevStart = useRef(start);
  useLayoutEffect(() => {
    const grewUp = start < prevStart.current;
    prevStart.current = start;
    const prev = pendingPrepend.current;
    if (prev == null) {
      // Entries mounted above a pinned view (the tail-first switch filling
      // in): stay at the bottom before paint.
      if (grewUp) pinIfStuck();
      return;
    }
    pendingPrepend.current = null;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop += el.scrollHeight - prev;
  }, [start]);

  /**
   * Pin before paint so a remounted body (thread switch) and a newly
   * inserted permission card never flash at the wrong scrollTop. Plain
   * appends skip this: reading scrollHeight here forces a synchronous
   * layout on every streamed push (#1475), and #408's ResizeObserver pins
   * them once the browser has laid out anyway.
   */
  useLayoutEffect(() => {
    const id = detail?.thread.id ?? null;
    const opened = id !== prevLayoutThreadId.current;
    if (opened) {
      const switching =
        prevLayoutThreadId.current !== null &&
        id !== null &&
        prevLayoutThreadId.current !== id;
      const recovering =
        prevLayoutThreadId.current === null &&
        id !== null &&
        seenThread.current;
      prevLayoutThreadId.current = id;
      if (id) seenThread.current = true;
      if (switching || recovering) {
        stickToBottom.current = true;
        forceStick.current = true;
      } else if (id) {
        stickToBottom.current = true;
      }
    }
    const req = detail?.pendingPermission?.requestId ?? null;
    if (req && req !== prevPermReq.current) {
      stickToBottom.current = true;
      forceStick.current = true;
    }
    prevPermReq.current = req;
    if (opened || forceStick.current) pinIfStuck();
  }, [
    timeline,
    isWorking,
    detail?.messages,
    detail?.workLog,
    detail?.pendingPermission,
    detail?.thread.id,
  ]);

  useLayoutEffect(() => {
    if (!revealTargetId) return;
    const container = bodyRef.current;
    if (!container) return;
    const child = container.querySelector(
      `[data-message-id="${revealTargetId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`,
    );
    if (!(child instanceof HTMLElement)) return;
    stickToBottom.current = false;
    forceStick.current = false;
    const next = nearestScrollTop(
      { scrollTop: container.scrollTop, clientHeight: container.clientHeight },
      {
        offsetTop: offsetTopWithin(container, child),
        offsetHeight: child.offsetHeight,
      },
    );
    if (next !== container.scrollTop) container.scrollTop = next;
  }, [revealTargetId, start, timeline.length]);

  /**
   * Content can grow after paint with no React state change (images, syntax
   * highlight, webfonts). Observe the scroll body and its children so a
   * pinned view stays pinned. Re-attach when the timeline replaces children.
   */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const onResize = () => pinIfStuckRef.current();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    for (const child of el.children) {
      ro.observe(child);
    }
    return () => ro.disconnect();
  }, [timeline, start, detail?.pendingPermission, isWorking]);

  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el || pinning.current) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (forceStick.current) {
      if (distance <= STICK_BOTTOM_PX) {
        forceStick.current = false;
        stickToBottom.current = true;
        return;
      }
      pinIfStuck();
      return;
    }
    stickToBottom.current = distance <= STICK_BOTTOM_PX;
  };
  return { showEarlier, onBodyScroll };
}
