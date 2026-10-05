import type { Dispatch, SetStateAction } from "react";
import { pasteCardLabel, type PasteCard } from "../../pasteCards";
import styles from "../Composer.module.css";

/** Collapsed large pastes; each card expands to show its text. */
export function PasteCardList({
  pasteCards,
  expandedCardIds,
  setExpandedCardIds,
  removePasteCard,
}: {
  pasteCards: PasteCard[];
  expandedCardIds: Record<string, boolean>;
  setExpandedCardIds: Dispatch<SetStateAction<Record<string, boolean>>>;
  removePasteCard: (id: string) => void;
}) {
  return (
    <div className={styles.pasteCardList} aria-label="Pasted context">
      {pasteCards.map((card) => {
        const open = Boolean(expandedCardIds[card.id]);
        return (
          <div
            key={card.id}
            className={styles.pasteCard}
            data-paste-card={card.id}
            data-compressed={card.compressed ? "" : undefined}
          >
            <div className={styles.pasteCardHead}>
              <button
                type="button"
                className={styles.pasteCardToggle}
                aria-expanded={open}
                onClick={() =>
                  setExpandedCardIds((prev) => ({
                    ...prev,
                    [card.id]: !prev[card.id],
                  }))
                }
              >
                <span>{pasteCardLabel(card)}</span>
                <span className={styles.pasteCardChars}>
                  {card.chars.toLocaleString("en-US")} chars
                </span>
              </button>
              <button
                type="button"
                className={styles.attachmentRemove}
                aria-label="Remove paste"
                title="Remove paste"
                onClick={() => removePasteCard(card.id)}
              >
                ×
              </button>
            </div>
            {open && (
              <pre className={styles.pasteCardBody}>{card.text}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
