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
  | "opencode"
  | "kimi"
  | "muse";

const COPY: Record<
  CliImportProvider,
  { title: string; note: string; empty: string }
> = {
  codex: {
    title: "Import Codex session",
    note: "Choose a Codex CLI session to import into this project. Re-importing updates the existing thread without creating a duplicate.",
    empty: "No Codex CLI sessions found",
  },
  grok: {
    title: "Import Grok session",
    note: "Choose a Grok CLI session to import into this project. Re-importing updates the existing thread without creating a duplicate.",
    empty: "No Grok CLI sessions found",
  },
  claude: {
    title: "Import Claude session",
    note: "Choose a Claude Code session to import into this project. Re-importing updates the existing thread without creating a duplicate.",
    empty: "No Claude CLI sessions found",
  },
  cursor: {
    title: "Import Cursor session",
    note: "Choose a Cursor CLI session to import into this project. Re-importing updates the existing thread without creating a duplicate.",
    empty: "No Cursor CLI sessions found",
  },
  opencode: {
    title: "Import OpenCode session",
    note: "Choose an OpenCode CLI session to import into this project. Re-importing updates the existing thread without creating a duplicate.",
    empty: "No OpenCode CLI sessions found",
  },
  kimi: {
    title: "Import Kimi session",
    note: "Choose a Kimi CLI session to import into this project.",
    empty: "No Kimi CLI sessions found",
  },
  muse: {
    title: "Import Muse session",
    note: "Choose a Muse CLI session to import into this project.",
    empty: "No Muse CLI sessions found",
  },
};

interface ImportCliSessionModalProps {
  projectId: string;
  provider: CliImportProvider;
  onClose: () => void;
  /** Existing threads, used to mark already-imported sessionIds. */
  threads?: ThreadInfo[];
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

function importedSessionIds(
  threads: ThreadInfo[] | undefined,
  provider: CliImportProvider,
): Set<string> {
  const ids = new Set<string>();
  for (const t of threads || []) {
    if (t && t.provider === provider && t.sessionId) ids.add(t.sessionId);
  }
  return ids;
}

/**
 * Pick a Codex, Grok, Claude, Cursor, OpenCode, Kimi, or Muse CLI session from disk
 * and import it as a Solenta thread in the current project. Home stays
 * on the main process. Re-import syncs new turns onto the existing thread.
 */
export function ImportCliSessionModal({
  projectId,
  provider,
  onClose,
  threads,
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
  const alreadyImported = importedSessionIds(threads, provider);
  const remaining = (sessions || []).filter(
    (s) => !alreadyImported.has(s.sessionId),
  );
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

  const importArgs = (sessionId: string) =>
    provider === "codex"
      ? { sessionId, projectId }
      : { sessionId, projectId, provider };

  const importOne = async (sessionId: string) => {
    if (pending) return;
    setPendingId(sessionId);
    setImportError(null);
    try {
      const thread = await importCliSession(importArgs(sessionId));
      onImported(thread);
    } catch (err) {
      setImportError(errorMessage(err));
    } finally {
      setPendingId(null);
    }
  };

  const importRemaining = async () => {
    if (pending || remaining.length === 0) return;
    setPendingId("remaining");
    setImportError(null);
    let last: ThreadInfo | null = null;
    try {
      for (const session of remaining) {
        last = await importCliSession(importArgs(session.sessionId));
      }
      if (last) onImported(last);
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
            <>
              <ul className={`${chrome.browseList} ${styles.list}`}>
                {(sessions || []).map((session) => {
                  const imported = alreadyImported.has(session.sessionId);
                  return (
                    <li key={session.sessionId}>
                      <button
                        type="button"
                        className={`${chrome.browseRow} ${styles.row}`}
                        data-cli-session={session.sessionId}
                        data-cli-session-imported={
                          imported ? "" : undefined
                        }
                        disabled={pending}
                        aria-busy={
                          pendingId === session.sessionId ? true : undefined
                        }
                        title={session.sessionId}
                        onClick={() => void importOne(session.sessionId)}
                      >
                        <span className={styles.id}>{session.sessionId}</span>
                        <span className={styles.meta}>
                          {imported ? (
                            <span className={styles.imported}>Imported</span>
                          ) : null}
                          <span className={styles.age}>
                            {formatRelativeAge(session.mtimeMs, now)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {remaining.length > 1 ||
              (remaining.length > 0 && alreadyImported.size > 0) ? (
                <button
                  type="button"
                  className={chrome.btn}
                  data-cli-session-import-remaining=""
                  disabled={pending}
                  onClick={() => void importRemaining()}
                >
                  {alreadyImported.size > 0
                    ? `Import remaining (${remaining.length})`
                    : `Import all (${remaining.length})`}
                </button>
              ) : null}
            </>
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
