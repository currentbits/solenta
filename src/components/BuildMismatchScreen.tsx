import styles from "./BuildMismatchScreen.module.css";

type BuildMismatchScreenProps = {
  onRestart: () => void;
};

/**
 * Hard stop when the renderer bundle and main/preload SHAs disagree.
 * The rest of the app must not mount underneath — a banner over a live
 * UI is how a stale renderer keeps talking to a new main.
 */
export function BuildMismatchScreen({ onRestart }: BuildMismatchScreenProps) {
  return (
    <div
      className={styles.screen}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="build-mismatch-title"
      aria-describedby="build-mismatch-copy"
      data-build-mismatch=""
    >
      <h1 id="build-mismatch-title" className={styles.title}>
        Reload required
      </h1>
      <p id="build-mismatch-copy" className={styles.copy}>
        This window is out of date. Restart to load the new build.
      </p>
      <button
        type="button"
        className={styles.restart}
        data-build-mismatch-restart=""
        autoFocus
        onClick={onRestart}
      >
        Restart
      </button>
    </div>
  );
}
