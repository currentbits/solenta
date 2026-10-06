import type { AttachmentInfo, ThreadInfo } from "./shared/ipc";

type Queued = NonNullable<ThreadInfo["queued"]>;

/**
 * Files per queued item, index for index (#1512). Twin of electron/queued.js:
 * a row without aligned itemAttachments has all its files on the first item.
 */
export function queuedItemFiles(
  q: Pick<Queued, "itemAttachments" | "attachments"> | null | undefined,
  count: number,
): AttachmentInfo[][] {
  const per = q?.itemAttachments;
  if (per && per.length === count) return per.map((f) => f ?? []);
  return Array.from({ length: count }, (_, i) => (i === 0 ? (q?.attachments ?? []) : []));
}

/** A queue row from items + their files, with the joined prompt and flat attachments. */
export function queuedRow(items: string[], files: AttachmentInfo[][]): Queued {
  const row: Queued = { prompt: items.join("\n\n"), items, itemAttachments: files };
  const flat = files.flat();
  if (flat.length) row.attachments = flat;
  return row;
}
