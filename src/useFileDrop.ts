import { useEffect, useRef, useState, type RefObject } from "react";
import {
  captureDropItems,
  filesFromDataTransfer,
  foldersFromCapturedItems,
  isFileDrag,
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
  },
): boolean {
  const [dragging, setDragging] = useState(false);
  const onFilesRef = useRef(opts.onFiles);
  onFilesRef.current = opts.onFiles;
  const onDraggingRef = useRef(opts.onDraggingChange);
  onDraggingRef.current = opts.onDraggingChange;

  useEffect(() => {
    const el = targetRef.current;
    if (!el || !opts.enabled) return;

    const setHover = (next: boolean) => {
      setDragging(next);
      onDraggingRef.current?.(next);
    };

    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      setHover(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      const next = e.relatedTarget;
      if (next instanceof Node && el.contains(next)) return;
      setHover(false);
    };
    const onDrop = (e: DragEvent) => {
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
