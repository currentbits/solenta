import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalState } from "../shared/ipc";
import styles from "./TerminalPane.module.css";

/** Output poll interval while a session is alive. */
const POLL_MS = 250;
/** Scrollback kept in the DOM. Main caps its own buffer at 200k. */
const TEXT_LIMIT = 200_000;

export type TerminalApi = {
  open: (threadId: string) => Promise<TerminalState>;
  write: (
    threadId: string,
    data: string,
    since: number,
  ) => Promise<TerminalState>;
  read: (threadId: string, since: number) => Promise<TerminalState>;
  close: (threadId: string) => Promise<TerminalState>;
};

/**
 * Shell pane for a thread's worktree (#147).
 *
 * ponytail: polled, not pushed. The main process already keeps the
 * scrollback and a cursor, so a 250 ms read is a handful of lines of client
 * against a whole new push channel through preload, wireClient and the web
 * bridge. Same call shape survives if that trade ever flips.
 */
export function TerminalPane({
  threadId,
  api,
}: {
  threadId: string | null;
  api: TerminalApi;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState("");
  const [session, setSession] = useState<TerminalState | null>(null);
  const [draft, setDraft] = useState("");
  const cursorRef = useRef(0);
  const outRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef(-1);

  const applyState = useCallback((state: TerminalState) => {
    cursorRef.current = state.cursor;
    setSession(state);
    setPending(state.pending);
    setText((prev) => {
      const next = state.reset ? state.text : prev + state.text;
      return next.length > TEXT_LIMIT ? next.slice(-TEXT_LIMIT) : next;
    });
  }, []);

  // Open on mount and whenever the pane moves to another thread. Reset the
  // cursor first so a stale offset from the previous thread cannot slice a
  // fresh buffer.
  useEffect(() => {
    if (!threadId) return;
    let live = true;
    cursorRef.current = 0;
    setText("");
    setPending("");
    setSession(null);
    stickRef.current = true;
    void api
      .open(threadId)
      .then((state) => {
        if (live) applyState(state);
      })
      .catch(() => {
        if (live) setText("Could not start a shell for this thread.\n");
      });
    return () => {
      live = false;
    };
  }, [threadId, api, applyState]);

  const running = session?.running ?? false;

  useEffect(() => {
    if (!threadId || !running) return;
    let live = true;
    const timer = setInterval(() => {
      void api
        .read(threadId, cursorRef.current)
        .then((state) => {
          if (live) applyState(state);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [threadId, running, api, applyState]);

  // Stay pinned to the newest output unless the reader scrolled away.
  useEffect(() => {
    const el = outRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, pending]);

  const submit = useCallback(() => {
    if (!threadId) return;
    const line = draft;
    setDraft("");
    historyPosRef.current = -1;
    if (line.trim()) {
      historyRef.current = [
        ...historyRef.current.filter((h) => h !== line),
        line,
      ].slice(-100);
    }
    stickRef.current = true;
    void api
      .write(threadId, line, cursorRef.current)
      .then(applyState)
      .catch(() => {});
  }, [threadId, draft, api, applyState]);

  const restart = useCallback(() => {
    if (!threadId) return;
    void api
      .close(threadId)
      .then(() => api.open(threadId))
      .then((state) => {
        cursorRef.current = 0;
        setText("");
        stickRef.current = true;
        applyState({ ...state, reset: true });
      })
      .catch(() => {});
  }, [threadId, api, applyState]);

  const onHistory = useCallback(
    (delta: number) => {
      const history = historyRef.current;
      if (!history.length) return;
      const pos = historyPosRef.current;
      const next =
        pos < 0
          ? delta < 0
            ? history.length - 1
            : -1
          : Math.min(history.length, Math.max(-1, pos + (delta < 0 ? -1 : 1)));
      historyPosRef.current = next >= history.length ? -1 : next;
      setDraft(historyPosRef.current < 0 ? "" : history[historyPosRef.current]);
    },
    [],
  );

  if (!threadId) {
    return (
      <div className={styles.pane} data-terminal-pane="">
        <p className={styles.hint}>Select a thread to open a shell.</p>
      </div>
    );
  }

  return (
    <div className={styles.pane} data-terminal-pane="">
      <div className={styles.bar}>
        <span className={styles.cwd} title={session?.cwd ?? ""}>
          {session?.cwd ?? "…"}
        </span>
        <span className={styles.state} data-running={running ? "true" : "false"}>
          {running ? session?.shell : "not running"}
        </span>
        <button
          type="button"
          className={styles.restart}
          data-terminal-restart=""
          onClick={restart}
        >
          Restart
        </button>
      </div>
      <pre
        className={styles.out}
        data-terminal-output=""
        ref={outRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text}
        {pending}
      </pre>
      <div className={styles.form}>
        <span className={styles.prompt} aria-hidden>
          $
        </span>
        <input
          className={styles.input}
          data-terminal-input=""
          aria-label="Terminal command"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={running ? "" : "Shell is not running — Restart"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              onHistory(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onHistory(1);
            }
          }}
        />
      </div>
    </div>
  );
}
