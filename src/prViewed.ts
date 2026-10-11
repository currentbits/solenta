/** Per-file review mark stored against the PR head (#1527). */
export interface PrViewedMark {
  blobSha?: string;
  headSha: string;
}

export type PrViewedStatus = "unseen" | "viewed" | "changed";

/**
 * Viewed / Changed / unseen for one file.
 * Same blob (or same head when no blob) stays Viewed; a later head that
 * changed the file flips to Changed.
 */
export function viewedStatus(
  mark: PrViewedMark | undefined,
  current: { blobSha?: string; headSha: string },
): PrViewedStatus {
  if (!mark || !mark.headSha) return "unseen";
  if (mark.blobSha && current.blobSha) {
    return mark.blobSha === current.blobSha ? "viewed" : "changed";
  }
  return mark.headSha === current.headSha ? "viewed" : "changed";
}
