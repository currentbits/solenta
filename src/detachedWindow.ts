/**
 * Detached thread windows (#519). main.js opens a window per thread with
 * `?thread=<id>`; that window renders only the thread, while the main window
 * stays the fleet overview. Both get the same pushes, so they stay in sync.
 *
 * Reads the bridge off window like contextMenu.ts: desktop-only, so the
 * sidebar card can call it without a prop chain through Sidebar.
 */
import type { CoderApi, ThreadInfo } from "./shared/ipc";

/** Thread this window is locked to, or null in the main window. */
export function detachedThreadId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("thread") || null;
}

function bridge(): CoderApi["windows"] {
  if (typeof window === "undefined") return undefined;
  return (window as { coder?: Pick<CoderApi, "windows"> }).coder?.windows;
}

/** Detaching only exists on desktop, and only from the main window. */
export function canDetachThread(): boolean {
  return typeof bridge()?.detachThread === "function" && !detachedThreadId();
}

export function detachThread(threadId: string): void {
  void bridge()?.detachThread(threadId).catch(() => {});
}

/** A sidebar card was dragged and dropped outside the window. */
export function droppedOutsideWindow(e: {
  clientX: number;
  clientY: number;
  dataTransfer: { dropEffect: string } | null;
}): boolean {
  if (e.dataTransfer && e.dataTransfer.dropEffect !== "none") return false;
  return (
    e.clientX < 0 ||
    e.clientY < 0 ||
    e.clientX > window.innerWidth ||
    e.clientY > window.innerHeight
  );
}

/** Window title: the thread, prefixed with a dot while it waits on the user. */
export function detachedWindowTitle(
  thread:
    | Pick<ThreadInfo, "title" | "awaitingInput" | "pendingQuestion" | "pendingSecret">
    | undefined,
): string {
  if (!thread) return "Solenta";
  const waiting = Boolean(
    thread.awaitingInput || thread.pendingQuestion || thread.pendingSecret,
  );
  return `${waiting ? "● " : ""}${thread.title || "Thread"}`;
}
