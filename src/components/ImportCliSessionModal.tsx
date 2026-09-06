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

export type CliImportProvider =
  | "codex"
  | "grok"
  | "claude"
  | "cursor"
  | "opencode";

const COPY: Record<
  CliImportProvider,
  { title: string; note: string; empty: string }
> = {
  codex: {
    title: "Import Codex session",
    note: "Choose a Codex CLI session to import into this project.",
    empty: "No Codex CLI sessions found",
  },
  grok: {
    title: "Import Grok session",
    note: "Choose a Grok CLI session to import into this project.",
    empty: "No Grok CLI sessions found",
  },
  claude: {
    title: "Import Claude session",
    note: "Choose a Claude Code session to import into this project.",
    empty: "No Claude CLI sessions found",
  },
  cursor: {
    title: "Import Cursor session",
    note: "Choose a Cursor CLI session to import into this project.",
    empty: "No Cursor CLI sessions found",
  },
  opencode: {
    title: "Import OpenCode session",
    note: "Choose an OpenCode CLI session to import into this project.",
    empty: "No OpenCode CLI sessions found",
  },
};

interface ImportCliSessionModalProps {
  projectId: string;
  provider: CliImportProvider;
  onClose: () => void;
  listCliSessions: (input?: {
    provider?: CliImportProvider;
  }) => Promise<CliSessionCandidate[]>;
  importCliSession: (input: {
    sessionId: string;
    projectId: string;
    provider?: CliImportProvider;
  }) => Promise<ThreadInfo>;
  onImported: (thread: ThreadInfo) => void;
}

/**
 * Pick a Codex, Grok, Claude, Cursor, or OpenCode CLI session from disk
 * and import it as a Solenta thread in the current project. Home stays
 * on the main process.
 */
export function ImportCliSessionModal({
  projectId,
  provider,
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
  const copy = COPY[provider];

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
      const listed =
        provider === "codex"
          ? await listCliSessions()
          : await listCliSessions({ provider });
      setSessions(listed);
    } catch (err) {
      setSessions([]);
      setListError(errorMessage(err));
    }
  }, [listCliSessions, provider]);

  useEffect(() => {
    void load();
  }, [load]);

  const importOne = async (sessionId: string) => {
    if (pending) return;
    setPendingId(sessionId);
    setImportError(null);
    try {
      const thread =
        provider === "codex"
          ? await importCliSession({ sessionId, projectId })
          : await importCliSession({
              sessionId,
              projectId,
              provider,
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
            {copy.title}
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
          <p className={chrome.note}>{copy.note}</p>
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
              {copy.empty}
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
