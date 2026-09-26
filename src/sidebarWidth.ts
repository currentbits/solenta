/**
 * Desktop task-sidebar width. A local chrome preference, not a settings
 * field. The narrow drawer keeps its own CSS width and never reads this.
 *
 * The stored value stays inside [MIN, MAX]. The column on screen can be
 * narrower when the agents panel and viewport cannot also leave the
 * transcript TRANSCRIPT_MIN_WIDTH, and that squeeze is not written back.
 * Collapsed agents use the rail, so a >900px window still fits the max
 * sidebar. The clamp only bites while the agents panel is open.
 */

export const SIDEBAR_WIDTH_KEY = "coder.sidebar.width";
export const SIDEBAR_WIDTH_DEFAULT = 300;
export const SIDEBAR_WIDTH_MIN = 280;
export const SIDEBAR_WIDTH_MAX = 480;
/** CSS px kept for the transcript before the sidebar yields. */
export const TRANSCRIPT_MIN_WIDTH = 360;
export const AGENTS_PANEL_WIDTH = 380;
export const AGENTS_RAIL_WIDTH = 32;
export const SIDEBAR_WIDTH_STEP = 8;
export const SIDEBAR_WIDTH_STEP_COARSE = 32;

const STORED_WIDTH = /^(?:0|[1-9]\d*)$/;

export type SidebarWidthStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(
    SIDEBAR_WIDTH_MAX,
    Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)),
  );
}

/** In-range integer preference, or null when the stored value is unusable. */
export function parseSidebarWidth(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || !STORED_WIDTH.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  if (value < SIDEBAR_WIDTH_MIN || value > SIDEBAR_WIDTH_MAX) return null;
  return value;
}

export function loadSidebarWidth(
  storage: SidebarWidthStorage | null | undefined,
): number {
  if (!storage) return SIDEBAR_WIDTH_DEFAULT;
  try {
    return (
      parseSidebarWidth(storage.getItem(SIDEBAR_WIDTH_KEY)) ??
      SIDEBAR_WIDTH_DEFAULT
    );
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

export function saveSidebarWidth(
  width: number,
  storage: SidebarWidthStorage | null | undefined,
): void {
  if (!storage) return;
  const parsed = parseSidebarWidth(String(Math.round(width)));
  if (parsed == null) return;
  try {
    storage.setItem(SIDEBAR_WIDTH_KEY, String(parsed));
  } catch {
    // Quota or private mode: the in-memory width still applies.
  }
}

export function browserSidebarStorage(): SidebarWidthStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function initialSidebarWidth(): number {
  return loadSidebarWidth(browserSidebarStorage());
}

/** Widest sidebar that still leaves the transcript its minimum. */
export function sidebarFitCap(viewportWidth: number, agentsOpen: boolean): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return SIDEBAR_WIDTH_MAX;
  }
  const agents = agentsOpen ? AGENTS_PANEL_WIDTH : AGENTS_RAIL_WIDTH;
  const room = Math.floor(viewportWidth - agents - TRANSCRIPT_MIN_WIDTH);
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, room));
}

/**
 * Next stored preference.
 * `delta` steps from the visible width. Positive growth stops at the fit
 * cap so a keypress cannot store a width the separator will not show.
 * A preference that is already wider than the cap stays put.
 * `absolute` is the pointer's width from the sidebar's left edge. Callers
 * pass the preference from drag start, not the last preview.
 */
export function nextSidebarPreference(
  preferred: number,
  deltaOrTarget: number,
  fitCap: number,
  mode: "delta" | "absolute",
): number {
  const current = clampSidebarWidth(preferred);
  const cap = clampSidebarWidth(fitCap);
  const visible = Math.min(current, cap);
  if (mode === "delta") {
    if (!Number.isFinite(deltaOrTarget) || deltaOrTarget === 0) return current;
    if (deltaOrTarget > 0) {
      if (current > cap) return current;
      return Math.min(cap, clampSidebarWidth(visible + deltaOrTarget));
    }
    return clampSidebarWidth(visible + deltaOrTarget);
  }
  if (!Number.isFinite(deltaOrTarget)) return current;
  const capped = Math.min(clampSidebarWidth(deltaOrTarget), cap);
  if (capped >= cap && current > cap) return current;
  return capped;
}

export type SidebarDragBinding = {
  finish(commit: boolean): void;
};

/**
 * Pointer session for the sidebar separator. Commits on pointerup after
 * movement. Escape, blur, pointercancel, lost capture, and finish(false)
 * restore the preference from pointerdown. Capture release after pointerup
 * must not cancel a commit.
 */
export function bindSidebarDrag(input: {
  pointerId: number;
  handle: HTMLElement;
  originX: number;
  sidebarLeft: number;
  startPreferred: number;
  fitCap: () => number;
  onPreview: (preferred: number) => void;
  onCommit: (preferred: number) => void;
  onCancel: () => void;
}): SidebarDragBinding {
  const {
    pointerId,
    handle,
    originX,
    sidebarLeft,
    startPreferred,
    fitCap,
    onPreview,
    onCommit,
    onCancel,
  } = input;
  let last = startPreferred;
  let moved = false;
  let upSeen = false;
  let settled = false;
  const restoreSurface = lockDragSurface();

  const widthAt = (clientX: number) => {
    if (!Number.isFinite(clientX)) return last;
    return nextSidebarPreference(
      startPreferred,
      clientX - sidebarLeft,
      fitCap(),
      "absolute",
    );
  };

  const finish = (commit: boolean) => {
    if (settled) return;
    settled = true;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancelPointer);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("keydown", onKey, true);
    handle.removeEventListener("lostpointercapture", onLost);
    try {
      if (handle.hasPointerCapture?.(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
    } catch {
      // Already released, or this DOM has no capture.
    }
    restoreSurface();
    if (commit && moved) onCommit(last);
    else onCancel();
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (Math.abs(event.clientX - originX) >= 1) moved = true;
    last = widthAt(event.clientX);
    if (moved) onPreview(last);
  };

  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    upSeen = true;
    if (Math.abs(event.clientX - originX) >= 1) moved = true;
    last = widthAt(event.clientX);
    finish(true);
  };

  const onCancelPointer = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    finish(false);
  };

  const onLost = (event: PointerEvent) => {
    if (event.pointerId !== pointerId || upSeen) return;
    finish(false);
  };

  const onBlur = () => finish(false);

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancelPointer);
  window.addEventListener("blur", onBlur);
  window.addEventListener("keydown", onKey, true);
  handle.addEventListener("lostpointercapture", onLost);

  return { finish };
}

function lockDragSurface(): () => void {
  const root = document.documentElement;
  const body = document.body;
  const previous = {
    rootCursor: root.style.cursor,
    rootSelect: root.style.userSelect,
    bodyCursor: body.style.cursor,
    bodySelect: body.style.userSelect,
  };
  root.style.cursor = "col-resize";
  root.style.userSelect = "none";
  body.style.cursor = "col-resize";
  body.style.userSelect = "none";
  return () => {
    root.style.cursor = previous.rootCursor;
    root.style.userSelect = previous.rootSelect;
    body.style.cursor = previous.bodyCursor;
    body.style.userSelect = previous.bodySelect;
  };
}
