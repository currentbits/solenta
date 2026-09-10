import { useRef } from "react";
import { useModalFocus } from "../useModalFocus";
import styles from "./BuildMismatchScreen.module.css";

type BuildMismatchScreenProps = {
  onRestart: () => void;
};

/**
 * Hard stop when the renderer bundle and main/preload SHAs disagree.
 * The rest of the app must not mount underneath — a banner over a live
 * UI is how a stale renderer keeps talking to a new main.
 *
 * Tab is trapped (ProviderQuota pairing: ref + tabIndex=-1 + useModalFocus).
 * Do not add useEscapeClose — Escape must not dismiss; the only exit is Restart.
 */
export function BuildMismatchScreen({ onRestart }: BuildMismatchScreenProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, dialogRef);
  return (
    <div
      ref={dialogRef}
      className={styles.screen}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="build-mismatch-title"
      aria-describedby="build-mismatch-copy"
      tabIndex={-1}
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
        onClick={onRestart}
      >
        Restart
      </button>
    </div>
  );
}
