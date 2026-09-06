import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelativeAge } from "../format";
import type { CliSessionCandidate, ThreadInfo } from "../shared/ipc";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import chrome from "./SettingsModal.module.css";
import styles from "./ImportCliSessionModal.module.css";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ImportCliSessionModalProps {
  projectId: string;
  onClose: () => void;
  listCliSessions: (input?: {
    provider?: "grok";
  }) => Promise<CliSessionCandidate[]>;
  importCliSession: (input: {
    sessionId: string;
    projectId: string;
    provider?: "grok";
  }) => Promise<ThreadInfo>;
  onImported: (thread: ThreadInfo) => void;
}

/**
 * Pick a Grok CLI session from GROK_HOME/sessions and import it as a
 * Solenta thread in the current project. Home stays on the main process.
 */
export function ImportCliSessionModal({
  projectId,
  onClose,
  listCliSessions,
  importCliSession,
  onImported,
}: ImportCliSessionModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<CliSessionCandidate[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const pending = pendingId != null;
  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  useEscapeClose(!pending, handleClose);
  useModalFocus(true, dialogRef);

  const load = useCallback(async () => {
    setListError(null);
    setImportError(null);
    setSessions(null);
    try {
      const listed = await listCliSessions({ provider: "grok" });
      setSessions(listed);
    } catch (err) {
      setSessions([]);
      setListError(errorMessage(err));
    }
  }, [listCliSessions]);

  useEffect(() => {
    void load();
  }, [load]);

  const importOne = async (sessionId: string) => {
    if (pending) return;
    setPendingId(sessionId);
    setImportError(null);
    try {
      const thread = await importCliSession({
        sessionId,
        projectId,
        provider: "grok",
      });
      onImported(thread);
    } catch (err) {
      setImportError(errorMessage(err));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div
      className={chrome.backdrop}
      role="presentation"
      data-import-cli-session-modal=""
      onClick={handleClose}
    >
      <div
        ref={dialogRef}
        className={chrome.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-cli-session-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={chrome.header}>
          <h2 id="import-cli-session-title" className={chrome.title}>
            Import Grok session
          </h2>
          <button
            type="button"
            className={chrome.close}
            onClick={handleClose}
            disabled={pending}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className={chrome.body}>
          <p className={chrome.note}>
            Choose a Grok CLI session to import into this project.
          </p>
          {sessions == null && !listError ? (
            <p className={chrome.browseEmpty}>Loading sessions…</p>
          ) : listError ? (
            <>
              <p
                className={chrome.fieldError}
                role="alert"
                data-cli-session-error=""
              >
                {listError}
              </p>
              <button
                type="button"
                className={chrome.btn}
                data-cli-session-retry=""
                onClick={() => void load()}
              >
                Retry
              </button>
            </>
          ) : sessions && sessions.length === 0 ? (
            <p className={chrome.browseEmpty} data-cli-session-empty="">
              No Grok CLI sessions found
            </p>
          ) : (
            <ul className={`${chrome.browseList} ${styles.list}`}>
              {(sessions || []).map((session) => (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    className={`${chrome.browseRow} ${styles.row}`}
                    data-cli-session={session.sessionId}
                    disabled={pending}
                    aria-busy={
                      pendingId === session.sessionId ? true : undefined
                    }
                    title={session.sessionId}
                    onClick={() => void importOne(session.sessionId)}
                  >
                    <span className={styles.id}>{session.sessionId}</span>
                    <span className={styles.age}>
                      {formatRelativeAge(session.mtimeMs, now)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {importError && (
            <p
              className={chrome.fieldError}
              role="alert"
              data-cli-session-error=""
            >
              {importError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
