import type { AttachmentInfo } from "../shared/ipc";

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Same extensions native classifyPaths treats as kind=image. */
const WEB_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
]);

function isWebImageFile(file: File): boolean {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (ext) return WEB_IMAGE_EXTS.has(ext);
  return file.type.toLowerCase().startsWith("image/");
}

export async function filesToAttachments(
  files: File[],
  save: {
    image: (dataUrl: string) => Promise<AttachmentInfo | null>;
    file: (name: string, dataUrl: string) => Promise<AttachmentInfo | null>;
  },
): Promise<AttachmentInfo[]> {
  const out: AttachmentInfo[] = [];
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    if (!dataUrl) continue;
    const attachment = isWebImageFile(file)
      ? await save.image(dataUrl)
      : await save.file(file.name, dataUrl);
    if (attachment) out.push(attachment);
  }
  return out;
}

/**
 * Web file picker. No accept and no webkitdirectory: folders are a
 * separate chip (showDirectoryPicker / saveFolder). No `accept=image/*`
 * so Spark can attach text files (#1173). Composer still drops kind=image
 * on text-only models.
 */
export function pickWebFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => finish([]));
    input.click();
  });
}

type WebFolderFile = { relativePath: string; dataUrl: string };

type WebDirEntry = {
  kind: string;
  getFile?: () => Promise<File>;
  entries?: () => AsyncIterableIterator<[string, WebDirEntry]>;
};

type WebDirHandle = {
  name: string;
  entries: () => AsyncIterableIterator<[string, WebDirEntry]>;
};

async function readDirectoryHandle(
  handle: WebDirHandle,
  prefix = "",
): Promise<WebFolderFile[]> {
  const out: WebFolderFile[] = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === "file" && entry.getFile) {
      const file = await entry.getFile();
      const dataUrl = await readFileAsDataUrl(file);
      if (dataUrl) out.push({ relativePath: `${prefix}${name}`, dataUrl });
      continue;
    }
    if (entry.kind === "directory" && typeof entry.entries === "function") {
      const nestedEntries = entry.entries.bind(entry);
      out.push(
        ...(await readDirectoryHandle(
          { name, entries: nestedEntries },
          `${prefix}${name}/`,
        )),
      );
    }
  }
  return out;
}

export async function pickWebFolder(): Promise<{
  name: string;
  files: WebFolderFile[];
} | null> {
  const picker = (
    window as Window & { showDirectoryPicker?: () => Promise<WebDirHandle> }
  ).showDirectoryPicker;
  if (typeof picker !== "function") return null;
  try {
    const handle = await picker();
    return { name: handle.name, files: await readDirectoryHandle(handle) };
  } catch {
    return null;
  }
}
