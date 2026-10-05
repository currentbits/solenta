import { useEffect, useRef, useState } from "react";
import type { ThreadDetail } from "../../shared/ipc";

/** items[] when persisted (#809); else split prompt once (legacy rows). */
function queuedThoughts(
  prompt: string | null | undefined,
  items?: string[] | null,
): string[] {
  if (items && items.length) return items;
  if (prompt == null) return [];
  return prompt.split("\n\n");
}

/** Queued follow-up strip: reorder/remove writes and inline edit (#364). */
export function useQueuedEdit({
  detail,
  queuedPrompt,
  queuedItemsProp,
  onEditQueued,
  onCancelQueued,
}: {
  detail: ThreadDetail | null;
  queuedPrompt: string | null;
  queuedItemsProp: string[] | null;
  onEditQueued?: (prompt: string, items?: string[]) => void | Promise<void>;
  onCancelQueued?: () => void;
}) {
  /** Inline edit of a queued follow-up item (issue #364 / #780). */
  const [editingQueued, setEditingQueued] = useState<number | null>(null);
  const [queuedEditDraft, setQueuedEditDraft] = useState("");
  const [queuedEditSaving, setQueuedEditSaving] = useState(false);
  const [queuedEditError, setQueuedEditError] = useState<string | null>(null);
  const queuedEditSavingRef = useRef(false);
  const queuedWriteInFlight = useRef(false);
  const queuedWriteGen = useRef(0);
  const [queuedWritePending, setQueuedWritePending] = useState(false);
  const [queuedWriteError, setQueuedWriteError] = useState<string | null>(null);
  // The edit is bound to the blob it was seeded from: a thread switch or a
  // drained/cancelled queue ends it. Bump writeGen so a late reject cannot
  // lock or error a different thread's strip (#1144).
  useEffect(() => {
    setEditingQueued(null);
    queuedEditSavingRef.current = false;
    setQueuedEditSaving(false);
    setQueuedEditError(null);
    queuedWriteGen.current += 1;
    queuedWriteInFlight.current = false;
    setQueuedWritePending(false);
    setQueuedWriteError(null);
  }, [detail?.thread.id, queuedPrompt == null]);

  const queuedItems = queuedThoughts(queuedPrompt, queuedItemsProp);

  const writeQueuedItems = (items: string[]) => {
    if (queuedWriteInFlight.current || queuedEditSavingRef.current) return;
    if (items.length === 0) {
      onCancelQueued?.();
      return;
    }
    const next = items.join("\n\n");
    if (next === queuedPrompt || !onEditQueued) return;
    queuedWriteInFlight.current = true;
    const gen = queuedWriteGen.current;
    setQueuedWritePending(true);
    setQueuedWriteError(null);
    void Promise.resolve(onEditQueued(next, items))
      .then(() => {
        if (gen !== queuedWriteGen.current) return;
        setQueuedWriteError(null);
      })
      .catch((err: unknown) => {
        if (gen !== queuedWriteGen.current) return;
        setQueuedWriteError(
          err instanceof Error && err.message ? err.message : String(err),
        );
      })
      .finally(() => {
        if (gen !== queuedWriteGen.current) return;
        queuedWriteInFlight.current = false;
        setQueuedWritePending(false);
      });
  };

  const closeQueuedEdit = () => {
    if (queuedEditSavingRef.current) return;
    setEditingQueued(null);
    setQueuedEditError(null);
  };

  const persistQueuedEdit = async (prompt: string, items?: string[]) => {
    if (!onEditQueued) {
      setEditingQueued(null);
      setQueuedEditError(null);
      return;
    }
    if (queuedEditSavingRef.current || queuedWriteInFlight.current) return;
    queuedEditSavingRef.current = true;
    setQueuedEditSaving(true);
    setQueuedEditError(null);
    try {
      await onEditQueued(prompt, items);
      setEditingQueued(null);
      setQueuedEditError(null);
    } catch (err) {
      setQueuedEditError(
        err instanceof Error && err.message ? err.message : String(err),
      );
    } finally {
      queuedEditSavingRef.current = false;
      setQueuedEditSaving(false);
    }
  };

  // Empty save means cancel: editing must never blank the queue (#364).
  // Close the editor only after the write lands so a rejected persist
  // keeps the revised draft (#926).
  const saveQueuedEdit = () => {
    if (queuedEditSavingRef.current || queuedWriteInFlight.current) return;
    const text = queuedEditDraft.trim();
    const index = editingQueued;
    if (!text || queuedPrompt == null || index == null) {
      closeQueuedEdit();
      return;
    }
    if (queuedItems.length <= 1) {
      if (text === queuedPrompt) {
        closeQueuedEdit();
        return;
      }
      void persistQueuedEdit(text);
      return;
    }
    if (text === queuedItems[index]) {
      closeQueuedEdit();
      return;
    }
    const next = queuedItems.slice();
    next[index] = text;
    void persistQueuedEdit(next.join("\n\n"), next);
  };
  return {
    editingQueued,
    setEditingQueued,
    queuedEditDraft,
    setQueuedEditDraft,
    queuedEditSaving,
    queuedEditError,
    setQueuedEditError,
    queuedWritePending,
    queuedWriteError,
    queuedItems,
    writeQueuedItems,
    closeQueuedEdit,
    saveQueuedEdit,
  };
}
