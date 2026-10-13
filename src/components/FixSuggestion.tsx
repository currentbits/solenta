import {
  FAILURE_LABEL,
  fixPrompt,
  type Failure,
  type FixAction,
  type FixHandler,
} from "../fixSuggest";
import styles from "./FixSuggestion.module.css";

/**
 * Unprompted fix offer at the failure site (#253). Every button resolves
 * the card; the prompt is built at click time so it carries the output that
 * arrived after the failing line.
 */
export function FixSuggestion({
  failure,
  source,
  threadId,
  output,
  onFix,
  onDone,
}: {
  failure: Failure;
  /** "terminal" / "dev server", used in the prompt. */
  source: string;
  threadId: string;
  /** Plain recent output, read when a button is clicked. */
  output: () => string;
  onFix: FixHandler;
  onDone: () => void;
}) {
  const act = (action: FixAction) => {
    onFix(action, threadId, fixPrompt(failure, source, output()));
    onDone();
  };
  return (
    <div className={styles.card} role="status" data-fix-suggestion={failure.kind}>
      <span className={styles.label}>{FAILURE_LABEL[failure.kind]}</span>
      <code className={styles.line} title={failure.line}>
        {failure.line}
      </code>
      <button
        type="button"
        className={`${styles.button} ${styles.primary}`}
        data-fix-run=""
        title="Ask this thread's agent to fix it"
        onClick={() => act("run")}
      >
        Fix it
      </button>
      <button
        type="button"
        className={styles.button}
        data-fix-draft=""
        title="Put the fix prompt in the composer to edit first"
        onClick={() => act("draft")}
      >
        Edit prompt
      </button>
      <button
        type="button"
        className={styles.button}
        data-fix-fork=""
        title="Fix it in a new thread"
        onClick={() => act("fork")}
      >
        Fork
      </button>
      <button
        type="button"
        className={styles.button}
        data-fix-dismiss=""
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDone}
      >
        ×
      </button>
    </div>
  );
}
