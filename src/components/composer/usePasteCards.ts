import { useCallback, useEffect, useState, type RefObject } from "react";
import { copyListRecord, keptPasteCards } from "../../composerSession";
import type { PasteCard } from "../../pasteCards";
import { keepList } from "./keepList";

/** Large pastes collapsed into cards, per thread. */
export function usePasteCards({
  threadId,
  pasteCardsRef,
  syncOverflow,
  readDraft,
}: {
  threadId: string;
  pasteCardsRef: RefObject<PasteCard[]>;
  syncOverflow: (draft: string) => void;
  readDraft: () => string;
}) {
  const [pasteCardsByThread, setPasteCardsState] = useState(() =>
    copyListRecord(keptPasteCards),
  );
  const setPasteCardsByThread = useCallback(
    keepList(keptPasteCards, setPasteCardsState),
    [],
  );
  const [expandedCardIds, setExpandedCardIds] = useState<
    Record<string, boolean>
  >({});
  const pasteCards = pasteCardsByThread[threadId] ?? [];
  pasteCardsRef.current = pasteCards;
  useEffect(() => {
    syncOverflow(readDraft());
  }, [pasteCards, threadId, syncOverflow, readDraft]);
  const addPasteCard = useCallback(
    (card: PasteCard) => {
      setPasteCardsByThread((prev) => ({
        ...prev,
        [threadId]: [...(prev[threadId] ?? []), card],
      }));
    },
    [threadId],
  );
  const removePasteCard = useCallback(
    (id: string) =>
      setPasteCardsByThread((prev) => ({
        ...prev,
        [threadId]: (prev[threadId] ?? []).filter((c) => c.id !== id),
      })),
    [threadId],
  );
  const clearPasteCards = useCallback(
    () =>
      setPasteCardsByThread((prev) =>
        (prev[threadId] ?? []).length ? { ...prev, [threadId]: [] } : prev,
      ),
    [threadId],
  );
  return {
    pasteCards,
    expandedCardIds,
    setExpandedCardIds,
    addPasteCard,
    removePasteCard,
    clearPasteCards,
  };
}
