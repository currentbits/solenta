import type { Dispatch, SetStateAction } from "react";
import styles from "../Sidebar.module.css";

/**
 * Bulk-selection toolbar (2+ rows selected), or the feedback-only bar left
 * after a batch action.
 */
export function BatchBar({
  multiSelected,
  batchFeedback,
  runBatchArchive,
  runBatchSettle,
  clearMulti,
  setBatchFeedback,
}: {
  multiSelected: Set<string>;
  batchFeedback: string | null;
  runBatchArchive: () => Promise<void>;
  runBatchSettle: () => Promise<void>;
  clearMulti: () => void;
  setBatchFeedback: Dispatch<SetStateAction<string | null>>;
}) {
  return (
    <>
      {multiSelected.size >= 2 && (
        <div className={styles.batchBar} data-batch-bar="">
          <span className={styles.batchCount} data-batch-count="">
            {multiSelected.size} selected
          </span>
          {batchFeedback && (
            <span className={styles.batchFeedback} data-batch-feedback="">
              {batchFeedback}
            </span>
          )}
          <button
            type="button"
            className={styles.batchBtn}
            data-batch-archive=""
            onClick={() => void runBatchArchive()}
          >
            Archive
          </button>
          <button
            type="button"
            className={styles.batchBtn}
            data-batch-settle=""
            onClick={() => void runBatchSettle()}
          >
            Settle
          </button>
          <button
            type="button"
            className={styles.batchBtn}
            data-batch-clear=""
            onClick={clearMulti}
          >
            Clear
          </button>
        </div>
      )}
      {batchFeedback && multiSelected.size < 2 && (
        <div
          className={styles.batchBar}
          data-batch-bar=""
          data-batch-feedback-only=""
        >
          <span className={styles.batchFeedback} data-batch-feedback="">
            {batchFeedback}
          </span>
          <button
            type="button"
            className={styles.batchBtn}
            data-batch-clear=""
            onClick={() => setBatchFeedback(null)}
          >
            Clear
          </button>
        </div>
      )}
    </>
  );
}
