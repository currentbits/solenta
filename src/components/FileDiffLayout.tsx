import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  DIFF_FILE_WIDTH_DEFAULT,
  DIFF_FILE_WIDTH_MAX,
  DIFF_FILE_WIDTH_MIN,
  setDiffFileWidth,
  useDiffFileWidth,
} from "../uiPrefs";
import styles from "./FileDiffLayout.module.css";

const STACK_WIDTH = 560;
const DIFF_MIN_WIDTH = 320;
const HANDLE_WIDTH = 6;

/** File browser and diff share a width preference, but fit each pane independently. */
export function FileDiffLayout({
  files,
  children,
  fileClassName = "",
  diffClassName = "",
  fileRef,
  diffRef,
}: {
  files: ReactNode;
  children: ReactNode;
  fileClassName?: string;
  diffClassName?: string;
  fileRef?: Ref<HTMLDivElement>;
  diffRef?: Ref<HTMLDivElement>;
}) {
  const preferred = useDiffFileWidth();
  const [preview, setPreview] = useState<number | null>(null);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const [narrowWindow, setNarrowWindow] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<((commit: boolean) => void) | null>(null);
  const filesId = useId();
  const stacked = narrowWindow || (paneWidth != null && paneWidth <= STACK_WIDTH);
  const maximum = paneWidth == null ? DIFF_FILE_WIDTH_MAX : Math.max(
    DIFF_FILE_WIDTH_MIN,
    Math.min(DIFF_FILE_WIDTH_MAX, Math.floor(paneWidth - DIFF_MIN_WIDTH - HANDLE_WIDTH)),
  );
  const width = Math.min(preview ?? preferred, maximum);

  useLayoutEffect(() => {
    const root = rootRef.current!;
    const measure = () => {
      const next = root.getBoundingClientRect().width;
      if (next > 0) setPaneWidth(next);
      setNarrowWindow(window.innerWidth <= 720);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      dragRef.current?.(false);
    };
  }, []);

  useLayoutEffect(() => {
    // A layout change invalidates the drag's starting coordinates and bounds.
    dragRef.current?.(false);
    if (stacked && document.activeElement === separatorRef.current) {
      const files = document.getElementById(filesId);
      const target = files?.querySelector<HTMLElement>("button, a, input, select, textarea") ?? files;
      target?.focus({ preventScroll: true });
    }
  }, [stacked, maximum, filesId]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || stacked || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const { pointerId, clientX } = event;
    const startWidth = width;
    let next = width;
    let moved = false;
    const surface = document.body;
    const { cursor, userSelect } = surface.style;
    surface.style.cursor = "col-resize";
    surface.style.userSelect = "none";
    handle.focus({ preventScroll: true });
    try { handle.setPointerCapture(pointerId); } catch { /* DOM without capture. */ }
    const clamp = (x: number) => Math.min(maximum, Math.max(DIFF_FILE_WIDTH_MIN, Math.round(startWidth + x - clientX)));
    const finish = (commit: boolean) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", key, true);
      handle.removeEventListener("lostpointercapture", cancel);
      try { handle.releasePointerCapture(pointerId); } catch { /* Already released. */ }
      surface.style.cursor = cursor;
      surface.style.userSelect = userSelect;
      setPreview(null);
      if (commit && moved && !(preferred > maximum && next === maximum)) {
        setDiffFileWidth(next);
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      moved ||= Math.abs(e.clientX - clientX) >= 1;
      next = clamp(e.clientX);
      if (moved) setPreview(next);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      move(e);
      finish(true);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finish(false);
    };
    const blur = () => finish(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    dragRef.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key, true);
    handle.addEventListener("lostpointercapture", cancel);
  };

  return (
    <div className={styles.root} ref={rootRef} data-file-diff-layout="">
      <div className={styles.grid} data-stacked={stacked || undefined}
        style={{ "--diff-file-width": `${width}px` } as CSSProperties}>
        <div id={filesId} className={`${styles.files} ${fileClassName}`} ref={fileRef} tabIndex={-1}>
          {files}
        </div>
        <div className={styles.separator} ref={separatorRef} role="separator" aria-label="Resize file column"
          aria-orientation="vertical" aria-controls={filesId}
          aria-valuemin={DIFF_FILE_WIDTH_MIN} aria-valuemax={maximum} aria-valuenow={width}
          aria-valuetext={`${width} pixels`} aria-hidden={stacked || undefined}
          tabIndex={stacked ? -1 : 0} data-file-column-resize=""
          title="Arrow keys resize. Shift is a coarse step. Enter or double-click resets."
          onPointerDown={onPointerDown}
          onDoubleClick={() => { if (!stacked && !dragRef.current) setDiffFileWidth(DIFF_FILE_WIDTH_DEFAULT); }}
          onKeyDown={(e) => {
            if (stacked || dragRef.current || e.altKey || e.metaKey || e.ctrlKey) return;
            let next: number;
            if (e.key === "Enter") {
              e.preventDefault();
              setDiffFileWidth(DIFF_FILE_WIDTH_DEFAULT);
              return;
            }
            if (e.key === "Home") next = DIFF_FILE_WIDTH_MIN;
            else if (e.key === "End") next = maximum;
            else if (e.key === "ArrowLeft") next = width - (e.shiftKey ? 32 : 8);
            else if (e.key === "ArrowRight") next = width + (e.shiftKey ? 32 : 8);
            else return;
            e.preventDefault();
            // A growth key at the fit cap must not erase a wider saved preference.
            if (e.key === "ArrowRight" && preferred > maximum) return;
            setDiffFileWidth(Math.min(maximum, Math.max(DIFF_FILE_WIDTH_MIN, next)));
          }}
        />
        <div className={`${styles.diff} ${diffClassName}`} ref={diffRef}>{children}</div>
      </div>
    </div>
  );
}
