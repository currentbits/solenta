/**
 * Drag-drop helpers for composer attachments (issue #469).
 *
 * Finder folders often never appear as usable File objects on
 * `dataTransfer.files`. Chromium still exposes them on `items` via
 * `webkitGetAsEntry()` + `getAsFile()`, and Electron's
 * `webUtils.getPathForFile` can then recover the absolute path.
 *
 * Web mode has no absolute path. Directory entries are walked with
 * `createReader` (not the webkitdirectory input) and persisted as a
 * kind=folder chip through attachments.saveFolder (#1175).
 */

export const DROP_REJECT_MESSAGE =
  "Couldn't attach that. Drop files or folders.";

export const DROP_OVERLAY_MESSAGE = "Drop files or folders";

export type DroppedFolderFile = { relativePath: string; dataUrl: string };
export type DroppedFolder = { name: string; files: DroppedFolderFile[] };

export type CapturedDropItem = {
  file: File | null;
  entry: FileSystemEntryLike | null;
};

type FileSystemEntryLike = {
  isDirectory: boolean;
  isFile: boolean;
  name: string;
  createReader?: () => {
    readEntries: (
      success: (entries: FileSystemEntryLike[]) => void,
      error?: (err: unknown) => void,
    ) => void;
  };
  file?: (
    success: (file: File) => void,
    error?: (err: unknown) => void,
  ) => void;
};

type DataTransferItemLike = {
  kind: string;
  getAsFile: () => File | null;
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

function readBlobAsDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function readAllEntries(
  dir: FileSystemEntryLike,
): Promise<FileSystemEntryLike[]> {
  const createReader = dir.createReader;
  if (typeof createReader !== "function") return Promise.resolve([]);
  const reader = createReader.call(dir);
  const all: FileSystemEntryLike[] = [];
  return new Promise((resolve, reject) => {
    const batch = () => {
      reader.readEntries(
        (entries) => {
          if (!entries.length) {
            resolve(all);
            return;
          }
          all.push(...entries);
          batch();
        },
        reject,
      );
    };
    batch();
  });
}

function entryFile(entry: FileSystemEntryLike): Promise<File | null> {
  const getFile = entry.file;
  if (typeof getFile !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      getFile.call(
        entry,
        (file) => resolve(file ?? null),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

async function walkDirectory(
  dir: FileSystemEntryLike,
  prefix = "",
): Promise<DroppedFolderFile[]> {
  const out: DroppedFolderFile[] = [];
  const entries = await readAllEntries(dir);
  for (const entry of entries) {
    if (!entry || entry.name === "." || entry.name === "..") continue;
    if (entry.isDirectory && typeof entry.createReader === "function") {
      out.push(...(await walkDirectory(entry, `${prefix}${entry.name}/`)));
      continue;
    }
    if (!entry.isFile) continue;
    const file = await entryFile(entry);
    if (!file) continue;
    const dataUrl = await readBlobAsDataUrl(file);
    if (dataUrl) out.push({ relativePath: `${prefix}${entry.name}`, dataUrl });
  }
  return out;
}

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

/**
 * Call webkitGetAsEntry during the drop event. DataTransfer is invalid
 * after the handler returns; the entry objects stay usable for walking.
 */
export function captureDropItems(
  dt: DataTransfer | null | undefined,
): CapturedDropItem[] {
  if (!dt?.items || dt.items.length === 0) return [];
  const out: CapturedDropItem[] = [];
  for (let i = 0; i < dt.items.length; i++) {
    const item = dt.items[i] as DataTransferItemLike | undefined;
    if (!item || item.kind !== "file") continue;
    let entry: FileSystemEntryLike | null = null;
    try {
      entry = item.webkitGetAsEntry?.() ?? null;
    } catch {
      entry = null;
    }
    out.push({ file: item.getAsFile(), entry });
  }
  return out;
}

export async function foldersFromCapturedItems(
  items: CapturedDropItem[],
): Promise<DroppedFolder[]> {
  const out: DroppedFolder[] = [];
  for (const item of items) {
    const entry = item.entry;
    if (!entry?.isDirectory) continue;
    try {
      const files = await walkDirectory(entry);
      out.push({ name: entry.name, files });
    } catch {
      // A reader error must not drop sibling files from the same payload.
    }
  }
  return out;
}

export async function foldersFromDataTransfer(
  dt: DataTransfer | null | undefined,
): Promise<DroppedFolder[]> {
  return foldersFromCapturedItems(captureDropItems(dt));
}
