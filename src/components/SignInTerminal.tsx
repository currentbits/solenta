import { useRef } from "react";
import { SIGNIN_TERMINAL_ID } from "../shared/ipc";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import { TerminalPane, type TerminalApi, type XtermLoader } from "./TerminalPane";
import styles from "./SignInTerminal.module.css";

/**
 * Sign in with no thread open (#1501): the provider's login command in a
 * dedicated home-directory shell. With a thread open, App shows the
 * thread's own Terminal pane instead.
 */
export function SignInTerminal({
  providerName,
  install = false,
  nonce,
  api,
  load,
  onClose,
}: {
  providerName: string;
  /** The install command is typed but not run: the user presses Enter. */
  install?: boolean;
  nonce: number;
  api: TerminalApi;
  load?: XtermLoader;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useEscapeClose(true, onClose);
  useModalFocus(true, sheetRef);
  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={`${install ? "Install" : "Sign in to"} ${providerName}`}
        tabIndex={-1}
        data-signin-terminal=""
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>
            {install ? "Install" : "Sign in to"} {providerName}
          </h2>
          <button type="button" className={styles.done} onClick={onClose}>
            Done
          </button>
        </header>
        <p className={styles.hint}>
          {install
            ? "Review the command below, then press Enter to run it."
            : "Follow the prompts below."}{" "}
          Solenta checks again when you close this.
        </p>
        <div className={styles.term}>
          <TerminalPane
            threadId={SIGNIN_TERMINAL_ID}
            api={api}
            load={load}
            reveal={{ nonce, termId: "signin", threadId: SIGNIN_TERMINAL_ID }}
          />
        </div>
      </div>
    </div>
  );
}
