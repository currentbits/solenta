/**
 * Drag-drop helpers for composer attachments (issue #469).
 *
 * Finder folders often never appear as usable File objects on
 * `dataTransfer.files`. Chromium still exposes them on `items` via
 * `webkitGetAsEntry()` + `getAsFile()`, and Electron's
 * `webUtils.getPathForFile` can then recover the absolute path.
 */

export const DROP_REJECT_MESSAGE =
  "Couldn't attach that. Drop files or folders.";

export const DROP_OVERLAY_MESSAGE = "Drop files or folders";

type FileSystemEntryLike = {
  isDirectory: boolean;
  isFile: boolean;
  name: string;
};

type DataTransferItemLike = {
  kind: string;
  getAsFile: () => File | null;
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

/**
 * True when the drag payload looks like files from the OS (Finder, Explorer),
 * not an in-app drag (sidebar projects) or text.
 */
export function isFileDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types ?? []);
  if (types.includes("Files")) return true;
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      if (dt.items[i]?.kind === "file") return true;
    }
  }
  return (dt.files?.length ?? 0) > 0;
}

/**
 * Collect File objects from a drop. Prefer DataTransferItemList so a dropped
 * directory still has a File that `droppedFilePath` can resolve.
 */
export function filesFromDataTransfer(
  dt: DataTransfer | null | undefined,
): File[] {
  if (!dt) return [];
  const fromItems = filesFromItems(dt.items);
  if (fromItems.length) return fromItems;
  return Array.from(dt.files ?? []);
}

function filesFromItems(
  items: DataTransferItemList | null | undefined,
): File[] {
  if (!items || items.length === 0) return [];
  const out: File[] = [];
  const seen = new Set<File>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as DataTransferItemLike | undefined;
    if (!item || item.kind !== "file") continue;
    // Touch the entry so directory items are realized; the File (and thus
    // the absolute path) still comes from getAsFile + droppedFilePath.
    item.webkitGetAsEntry?.();
    const file = item.getAsFile();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}
