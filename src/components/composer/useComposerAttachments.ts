import { useCallback, useEffect, useState } from "react";
import type { AttachmentInfo } from "../../shared/ipc";
import { copyListRecord, keptAttachments } from "../../composerSession";
import { keepList } from "./keepList";

/** Pending attachment chips for the current thread. */
export function useComposerAttachments({
  threadId,
  canAttachImages,
  incomingAttachments,
  incomingAttachmentThreadId,
  onIncomingAttachmentsConsumed,
}: {
  threadId: string;
  canAttachImages: boolean;
  incomingAttachments?: AttachmentInfo[];
  incomingAttachmentThreadId?: string | null;
  onIncomingAttachmentsConsumed?: () => void;
}) {
  /**
   * Pending attachments keyed by thread, mirroring draftsRef: chips must
   * not leak across a thread switch. Cleared together with the draft on a
   * successful action.
   */
  const [attachmentsByThread, setAttachmentsState] = useState(() =>
    copyListRecord(keptAttachments),
  );
  const setAttachmentsByThread = useCallback(
    keepList(keptAttachments, setAttachmentsState),
    [],
  );
  const attachments = attachmentsByThread[threadId] ?? [];
  const addAttachments = useCallback(
    (items: AttachmentInfo[]) => {
      const accepted = canAttachImages
        ? items
        : items.filter((a) => a.kind !== "image");
      if (!accepted.length) return;
      setAttachmentsByThread((prev) => {
        const existing = prev[threadId] ?? [];
        const seen = new Set(existing.map((a) => a.path));
        const fresh = accepted.filter((a) => !seen.has(a.path));
        return fresh.length
          ? { ...prev, [threadId]: [...existing, ...fresh] }
          : prev;
      });
    },
    [threadId, canAttachImages],
  );
  useEffect(() => {
    if (canAttachImages) return;
    setAttachmentsByThread((prev) => {
      const existing = prev[threadId] ?? [];
      const next = existing.filter((a) => a.kind !== "image");
      if (next.length === existing.length) return prev;
      return { ...prev, [threadId]: next };
    });
  }, [canAttachImages, threadId]);
  useEffect(() => {
    if (!incomingAttachments?.length) return;
    if (
      incomingAttachmentThreadId &&
      incomingAttachmentThreadId !== threadId
    ) {
      onIncomingAttachmentsConsumed?.();
      return;
    }
    addAttachments(incomingAttachments);
    onIncomingAttachmentsConsumed?.();
  }, [
    incomingAttachments,
    incomingAttachmentThreadId,
    threadId,
    addAttachments,
    onIncomingAttachmentsConsumed,
  ]);
  const removeAttachment = useCallback(
    (path: string) =>
      setAttachmentsByThread((prev) => ({
        ...prev,
        [threadId]: (prev[threadId] ?? []).filter((a) => a.path !== path),
      })),
    [threadId],
  );
  const clearAttachments = useCallback(
    () =>
      setAttachmentsByThread((prev) =>
        (prev[threadId] ?? []).length ? { ...prev, [threadId]: [] } : prev,
      ),
    [threadId],
  );
  return { attachments, addAttachments, removeAttachment, clearAttachments };
}
