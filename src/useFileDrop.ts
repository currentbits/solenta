import { useEffect, useRef, useState, type RefObject } from "react";
import {
  captureDropItems,
  filesFromDataTransfer,
  foldersFromCapturedItems,
  isFileDrag,
  isMentionPathDrag,
  isThreadDrag,
  MENTION_PATH_MIME,
  THREAD_DRAG_MIME,
  type DroppedFolder,
} from "./dropFiles";

/**
 * Bind drag-and-drop of OS files to `targetRef`. Returns whether a file
 * drag is hovering so the host can paint an overlay.
 */
export function useFileDrop(
  targetRef: RefObject<HTMLElement | null>,
  opts: {
    enabled: boolean;
    onFiles: (files: File[], folders?: DroppedFolder[]) => void | Promise<void>;
    onDraggingChange?: (dragging: boolean) => void;
    /**
     * Files-pane row drop (#1794): a repo-relative path (trailing slash for
     * a folder), handled as an @mention insert rather than an attachment.
     * Checked before the OS-file path, so a Files-pane drag never falls
     * through to onFiles.
     */
    onMentionPath?: (path: string) => void;
    /**
     * Sidebar thread row drop (#1810): a thread id, handled as a thread
     * context chip rather than an attachment or @mention. Checked before
     * the OS-file path, same as onMentionPath.
     */
    onThreadDrop?: (threadId: string) => void;
  },
): boolean {
  const [dragging, setDragging] = useState(false);
  const onFilesRef = useRef(opts.onFiles);
  onFilesRef.current = opts.onFiles;
  const onDraggingRef = useRef(opts.onDraggingChange);
  onDraggingRef.current = opts.onDraggingChange;
  const onMentionPathRef = useRef(opts.onMentionPath);
  onMentionPathRef.current = opts.onMentionPath;
  const onThreadDropRef = useRef(opts.onThreadDrop);
  onThreadDropRef.current = opts.onThreadDrop;

  useEffect(() => {
    const el = targetRef.current;
    if (!el || !opts.enabled) return;

    const setHover = (next: boolean) => {
      setDragging(next);
      onDraggingRef.current?.(next);
    };

    const onDragEnter = (e: DragEvent) => {
      if (isMentionPathDrag(e.dataTransfer)) {
        e.preventDefault();
        return;
      }
      if (isThreadDrag(e.dataTransfer)) {
        if (!onThreadDropRef.current) return;
        e.preventDefault();
        setHover(true);
        return;
      }
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      setHover(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (isMentionPathDrag(e.dataTransfer)) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        return;
      }
      if (isThreadDrag(e.dataTransfer)) {
        if (!onThreadDropRef.current) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        return;
      }
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (isMentionPathDrag(e.dataTransfer)) return;
      if (isThreadDrag(e.dataTransfer)) {
        if (!onThreadDropRef.current) return;
        const next = e.relatedTarget;
        if (next instanceof Node && el.contains(next)) return;
        setHover(false);
        return;
      }
      if (!isFileDrag(e.dataTransfer)) return;
      const next = e.relatedTarget;
      if (next instanceof Node && el.contains(next)) return;
      setHover(false);
    };
    const onDrop = (e: DragEvent) => {
      if (isMentionPathDrag(e.dataTransfer)) {
        const path = e.dataTransfer?.getData(MENTION_PATH_MIME) ?? "";
        e.preventDefault();
        e.stopPropagation();
        if (path) onMentionPathRef.current?.(path);
        return;
      }
      if (isThreadDrag(e.dataTransfer)) {
        const threadId = e.dataTransfer?.getData(THREAD_DRAG_MIME) ?? "";
        if (!onThreadDropRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        setHover(false);
        if (threadId) onThreadDropRef.current(threadId);
        return;
      }
      const captured = captureDropItems(e.dataTransfer);
      const files = filesFromDataTransfer(e.dataTransfer);
      const hasDir = captured.some((item) => item.entry?.isDirectory);
      if (!files.length && !hasDir) {
        setHover(false);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setHover(false);
      void (async () => {
        const folders = await foldersFromCapturedItems(captured);
        await onFilesRef.current(files, folders);
      })();
    };

    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragenter", onDragEnter);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
      setHover(false);
    };
  }, [targetRef, opts.enabled]);

  return dragging;
}
