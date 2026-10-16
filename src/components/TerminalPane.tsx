import { useCallback, useEffect, useRef, useState } from "react";
import type { CoderApi, TerminalDataPush, TerminalState } from "../shared/ipc";
import { detectFailure, failureKey, plainText, type Failure, type FixHandler } from "../fixSuggest";
import { FixSuggestion } from "./FixSuggestion";
import styles from "./TerminalPane.module.css";

/** Terminals side by side in one pane. More than this is unreadable. */
const MAX_SPLITS = 4;
/** Plain output kept for fix suggestions (#253): detection window + prompt excerpt. */
const FIX_TAIL_CHARS = 16_000;

export type TerminalApi = CoderApi["terminal"] & {
  onData: (cb: (push: TerminalDataPush) => void) => () => void;
};

/** The slice of xterm.js the pane drives. Tests pass a fake (jsdom has no layout). */
export interface XtermLike {
  cols: number;
  rows: number;
  options: { theme?: Record<string, string> };
  open(el: HTMLElement): void;
  write(data: string): void;
  reset(): void;
  focus(): void;
  dispose(): void;
  fit(): void;
  hasSelection(): boolean;
  getSelection(): string;
  /** Wipe the display, keeping the prompt line. The shell is untouched. */
  clear(): void;
  /** Select and scroll to the next match above (back) or below the last one. */
  find(query: string, back: boolean): boolean;
  onSelectionChange(cb: () => void): { dispose(): void };
  onData(cb: (data: string) => void): { dispose(): void };
  onResize(cb: (size: { cols: number; rows: number }) => void): { dispose(): void };
  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void;
}

export type XtermLoader = () => Promise<() => XtermLike>;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Terminal colours from the app's tokens, so light/dark themes carry over. */
function themeFromCss(): Record<string, string> {
  const theme: Record<string, string> = {
    background: cssVar("--bg"),
    foreground: cssVar("--text"),
    cursor: cssVar("--accent-edge") || cssVar("--accent"),
    selectionBackground: cssVar("--accent-soft"),
    red: cssVar("--danger"),
    brightRed: cssVar("--danger-fg"),
    green: cssVar("--success-fg"),
    yellow: cssVar("--warning-fg"),
  };
  for (const k of Object.keys(theme)) if (!theme[k]) delete theme[k];
  return theme;
}

/**
 * xterm.js is ~300 KB, so it loads with the first Terminal pane rather
 * than with the app.
 */
export const loadXterm: XtermLoader = async () => {
  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  return () => {
    const term = new Terminal({
      fontFamily: cssVar("--mono") || "monospace",
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // window.open goes through the app's link policy (external browser).
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank")));
    let last: Match | null = null;
    // ponytail: per-row scan of the retained buffer; matches across a soft
    // wrap or after wide (CJK) chars are missed/offset. @xterm/addon-search
    // handles both if that ever matters.
    const find = (query: string, back: boolean) => {
      const buf = term.buffer.active;
      const lines = Array.from({ length: buf.length }, (_, y) => buf.getLine(y)?.translateToString() ?? "");
      last = findMatch(lines, query, last, back);
      if (!last) {
        term.clearSelection();
        return false;
      }
      term.select(last.x, last.y, query.length);
      term.scrollToLine(Math.max(0, last.y - (term.rows >> 1)));
      return true;
    };
    return Object.assign(term, { fit: () => fit.fit(), find }) as unknown as XtermLike;
  };
};

export interface Match {
  y: number;
  x: number;
}

/**
 * Case-insensitive match of `query` in buffer rows, the first one above
 * (back) or below `from`, wrapping around. No `from` starts at the bottom
 * going up, at the top going down.
 */
export function findMatch(
  lines: string[],
  query: string,
  from: Match | null,
  back: boolean,
): Match | null {
  const q = query.toLowerCase();
  if (!q) return null;
  const hits: Match[] = [];
  lines.forEach((line, y) => {
    const l = line.toLowerCase();
    for (let x = l.indexOf(q); x >= 0; x = l.indexOf(q, x + 1)) hits.push({ y, x });
  });
  if (!hits.length) return null;
  const before = (h: Match) => !from || h.y < from.y || (h.y === from.y && h.x < from.x);
  const after = (h: Match) => !from || h.y > from.y || (h.y === from.y && h.x > from.x);
  if (back) return [...hits].reverse().find(before) ?? hits[hits.length - 1]!;
  return hits.find(after) ?? hits[0]!;
}

const SELECT_FIRST = "Select output in the terminal first";

/** ⌘C / Ctrl+Shift+C copy a selection; without one the key goes to the shell. */
function copyKeys(term: XtermLike) {
  return (e: KeyboardEvent) => {
    const combo = e.metaKey || (e.ctrlKey && e.shiftKey);
    if (e.type === "keydown" && combo && e.key.toLowerCase() === "c" && term.hasSelection()) {
      void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    return true;
  };
}

function safeFit(term: XtermLike) {
  try {
    term.fit();
  } catch {
    // hidden pane: no size to fit to yet
  }
}

function TerminalView({
  threadId,
  termId,
  api,
  load,
  onClose,
  onSplit,
  onFix,
  onAddToPrompt,
}: {
  threadId: string;
  termId: string;
  api: TerminalApi;
  load: XtermLoader;
  onClose?: () => void;
  onSplit?: () => void;
  onFix?: FixHandler;
  onAddToPrompt?: (threadId: string, text: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XtermLike | null>(null);
  const [session, setSession] = useState<TerminalState | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState(false);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  // One live region for "No matches", "Copied", "Added to composer". It
  // floats: a reflowed bar resizes xterm, which drops the selection.
  const [status, setStatus] = useState("");
  // Restart = close, then a fresh mount of the effect below.
  const [epoch, setEpoch] = useState(0);
  // Fix suggestions (#253) scan live pushes only: replayed scrollback is
  // old news. Dismissed/acted failures stay quiet for this view's lifetime.
  const [failure, setFailure] = useState<Failure | null>(null);
  const tailRef = useRef("");
  const handledRef = useRef(new Set<string>());
  const scanRef = useRef(Boolean(onFix));
  scanRef.current = Boolean(onFix);

  useEffect(() => {
    let live = true;
    let term: XtermLike | null = null;
    // Absolute offset into the session's output; -1 until open() lands.
    let cursor = -1;
    let reading = false;
    const subs: { dispose(): void }[] = [];
    setSession(null);
    setFailed(false);
    setSelected(false);

    const apply = (s: TerminalState) => {
      if (!live || !term) return;
      if (s.reset) {
        term.reset();
        term.write(s.text);
      } else if (s.cursor > cursor) {
        term.write(s.text.slice(Math.max(0, s.text.length - (s.cursor - cursor))));
      } else {
        return;
      }
      cursor = s.cursor;
      setSession(s);
      setRunning(s.running);
    };

    // A push past our cursor means one was missed (e.g. while open() was in
    // flight); the main process still has it, so re-read from the cursor.
    const resync = () => {
      if (reading) return;
      reading = true;
      void api
        .read({ threadId, termId, since: cursor })
        .then(apply)
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    };

    const offPush = api.onData((p) => {
      if (!live || p.threadId !== threadId || p.termId !== termId || cursor < 0) return;
      setRunning(p.running);
      if (p.cursor <= cursor || !term) return;
      if (p.from > cursor) return resync();
      const data = p.data.slice(cursor - p.from);
      term.write(data);
      cursor = p.cursor;
      if (!scanRef.current) return;
      const fresh = plainText(data);
      tailRef.current = (tailRef.current + fresh).slice(-FIX_TAIL_CHARS);
      // A little overlap catches a failing line split across two pushes.
      const found = detectFailure(tailRef.current.slice(-(fresh.length + 300)));
      if (found && !handledRef.current.has(failureKey(found))) {
        setFailure((cur) => (cur && failureKey(cur) === failureKey(found) ? cur : found));
      }
    });

    void load()
      .then((create) => {
        if (!live || !hostRef.current) return;
        const t = create();
        term = termRef.current = t;
        t.open(hostRef.current);
        safeFit(t);
        t.attachCustomKeyEventHandler(copyKeys(t));
        subs.push(
          t.onData((data) => {
            void api.write({ threadId, termId, data }).catch(() => {});
          }),
          t.onResize(({ cols, rows }) => {
            void api.resize({ threadId, termId, cols, rows }).catch(() => {});
          }),
          t.onSelectionChange(() => {
            if (!live) return;
            setSelected(t.hasSelection());
            setStatus("");
          }),
        );
        return api.open({ threadId, termId, cols: t.cols, rows: t.rows }).then((s) => {
          apply({ ...s, reset: true });
          if (live) t.focus();
        });
      })
      .catch(() => {
        if (live) setFailed(true);
      });

    let frame = 0;
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => term && safeFit(term));
          });
    if (ro && hostRef.current) ro.observe(hostRef.current);
    const themeWatch = new MutationObserver(() => {
      if (term) term.options.theme = themeFromCss();
    });
    themeWatch.observe(document.documentElement, { attributeFilter: ["data-theme"] });

    return () => {
      live = false;
      offPush();
      ro?.disconnect();
      themeWatch.disconnect();
      cancelAnimationFrame(frame);
      for (const s of subs) s.dispose();
      term?.dispose();
    };
  }, [threadId, termId, api, load, epoch]);

  const restart = useCallback(() => {
    void api
      .close({ threadId, termId })
      .catch(() => {})
      .then(() => setEpoch((e) => e + 1));
  }, [api, threadId, termId]);

  const resolveFailure = useCallback(() => {
    setFailure((cur) => {
      if (cur) handledRef.current.add(failureKey(cur));
      return null;
    });
  }, []);

  // Close session (#1512): end the shell, keep its scrollback on screen.
  const end = useCallback(() => {
    void api.close({ threadId, termId, keep: true }).catch(() => {});
  }, [api, threadId, termId]);

  // Move to worktree (#1512): main restarts the shell in the thread's
  // current root with the old scrollback above a separator; remount re-attaches.
  const move = useCallback(() => {
    const t = termRef.current;
    void api
      .open({ threadId, termId, cols: t?.cols, rows: t?.rows, move: true })
      .catch(() => {})
      .then(() => setEpoch((e) => e + 1));
  }, [api, threadId, termId]);

  // Display only (#1185): the shell, its running command and the main
  // process's scrollback are untouched, so new output lands once.
  const clear = useCallback(() => {
    termRef.current?.clear();
    termRef.current?.focus();
  }, []);

  const find = useCallback(
    (back: boolean) => {
      const t = termRef.current;
      if (!t || !query) return;
      const hit = t.find(query, back);
      setStatus(hit ? "" : "No matches");
    },
    [query],
  );

  const closeFind = useCallback(() => {
    setFinding(false);
    setStatus("");
    termRef.current?.focus();
  }, []);

  const copy = useCallback(() => {
    const t = termRef.current;
    if (!t?.hasSelection()) return;
    void navigator.clipboard
      ?.writeText(t.getSelection())
      .then(() => setStatus("Copied"))
      .catch(() => {});
  }, []);

  // Selection only, never the whole buffer; lands as a context chip beside
  // the draft, for review before the user sends.
  const send = useCallback(() => {
    const text = termRef.current?.getSelection() ?? "";
    if (!onAddToPrompt || !text.trim()) return;
    onAddToPrompt(threadId, text);
    setStatus("Added to composer");
  }, [onAddToPrompt, threadId]);

  return (
    <div className={styles.view} data-terminal-view={termId}>
      <div className={styles.bar}>
        <span className={styles.cwd} title={session?.cwd ?? ""}>
          {session?.cwd || "…"}
        </span>
        <span className={styles.state} data-running={running ? "true" : "false"}>
          {running ? session?.shell : session ? "not running" : ""}
        </span>
        <button
          type="button"
          className={styles.button}
          data-terminal-find=""
          aria-expanded={finding}
          title="Find in output"
          onClick={() => (finding ? closeFind() : setFinding(true))}
        >
          Find
        </button>
        <button
          type="button"
          className={styles.button}
          data-terminal-clear=""
          title="Clear the display. The shell keeps running."
          onClick={clear}
        >
          Clear
        </button>
        <button
          type="button"
          className={styles.button}
          data-terminal-copy=""
          aria-label="Copy selection"
          title={selected ? "Copy selection" : SELECT_FIRST}
          disabled={!selected}
          onClick={copy}
        >
          Copy
        </button>
        {onAddToPrompt && (
          <button
            type="button"
            className={styles.button}
            data-terminal-send=""
            aria-label="Send selection to composer"
            title={selected ? "Add the selection to this thread's composer" : SELECT_FIRST}
            disabled={!selected}
            onClick={send}
          >
            To composer
          </button>
        )}
        <button
          type="button"
          className={styles.button}
          data-terminal-restart=""
          onClick={restart}
        >
          Restart
        </button>
        {running && (
          <button
            type="button"
            className={styles.button}
            data-terminal-end=""
            title="End this shell without starting a new one"
            onClick={end}
          >
            Close session
          </button>
        )}
        {onSplit && (
          <button
            type="button"
            className={styles.button}
            data-terminal-split=""
            title="Split terminal"
            onClick={onSplit}
          >
            Split
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className={styles.button}
            data-terminal-close=""
            aria-label="Close terminal"
            title="Close terminal"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>
      {finding && (
        <div className={styles.find} role="search" data-terminal-findbar="">
          <input
            className={styles.findInput}
            aria-label="Find in terminal output"
            placeholder="Find"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setStatus("");
            }}
            onKeyDown={(e) => {
              // Enter searches up, newest output first; Shift+Enter goes down.
              if (e.key === "Enter") {
                e.preventDefault();
                find(!e.shiftKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeFind();
              }
            }}
          />
          <button
            type="button"
            className={styles.button}
            data-terminal-find-prev=""
            aria-label="Previous match"
            title="Previous match (Enter)"
            onClick={() => find(true)}
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.button}
            data-terminal-find-next=""
            aria-label="Next match"
            title="Next match (Shift+Enter)"
            onClick={() => find(false)}
          >
            ↓
          </button>
          <button
            type="button"
            className={styles.button}
            data-terminal-find-close=""
            aria-label="Close find"
            title="Close find (Escape)"
            onClick={closeFind}
          >
            ×
          </button>
        </div>
      )}
      {session?.staleRoot && (
        <p className={styles.notice} data-terminal-stale="">
          This shell started in {session.cwd}, which this thread has left.{" "}
          <button
            type="button"
            className={styles.button}
            data-terminal-move=""
            onClick={move}
          >
            Move to worktree
          </button>
        </p>
      )}
      {session && !session.pty && running && (
        <p className={styles.notice} data-terminal-basic="">
          Basic shell: no PTY on this system, so full-screen programs and Ctrl-C do not
          work.
        </p>
      )}
      {failed && (
        <p className={styles.notice} data-terminal-failed="">
          Could not start a shell for this thread.
        </p>
      )}
      {failure && onFix && (
        <FixSuggestion
          failure={failure}
          source="terminal"
          threadId={threadId}
          output={() => tailRef.current}
          onFix={onFix}
          onDone={resolveFailure}
        />
      )}
      <span className={styles.status} role="status" data-terminal-status="">
        {status}
      </span>
      <div
        className={styles.screen}
        ref={hostRef}
        role="region"
        aria-label={`Terminal ${termId}`}
        data-terminal-output=""
      />
    </div>
  );
}

/**
 * Shell pane for a thread's worktree (#147, #1493): real PTYs rendered with
 * xterm.js, side-by-side splits, scrollback that survives a restart.
 */
export function TerminalPane({
  threadId,
  api,
  load = loadXterm,
  reveal = null,
  onFix,
  onAddToPrompt,
}: {
  threadId: string | null;
  api: TerminalApi;
  load?: XtermLoader;
  /** Offer fixes for failures in the output (#253). Absent = no offers. */
  onFix?: FixHandler;
  /** Hand a selection to this thread's composer (#1185). Absent = no button. */
  onAddToPrompt?: (threadId: string, text: string) => void;
  /**
   * A shell the main process just (re)started, e.g. Sign in's (#1501). Each
   * new nonce adds the split and remounts it onto the fresh session. Only
   * applies to its own thread.
   */
  reveal?: { nonce: number; termId: string; threadId: string } | null;
}) {
  const [ids, setIds] = useState<string[] | null>(null);
  const shown = reveal && reveal.threadId === threadId ? reveal : null;
  const loaded = ids !== null;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // Re-run once the list lands: a freshly opened pane gets the reveal first.
  useEffect(() => {
    if (!shown || !loaded) return;
    setIds((cur) => (cur && !cur.includes(shown.termId) ? [...cur, shown.termId] : cur));
  }, [shown?.nonce, shown?.termId, loaded]);

  useEffect(() => {
    if (!threadId) return;
    let live = true;
    setIds(null);
    void api
      .list({ threadId })
      .catch(() => [] as string[])
      .then((found) => {
        // Nothing yet but a reveal on the way: open just that shell.
        if (live) setIds(found.length ? found : [shownRef.current?.termId ?? "1"]);
      });
    return () => {
      live = false;
    };
  }, [threadId, api]);

  const split = useCallback(() => {
    setIds((cur) => {
      if (!cur || cur.length >= MAX_SPLITS) return cur;
      const next = Math.max(0, ...cur.map(Number).filter(Number.isFinite)) + 1;
      return [...cur, String(next)];
    });
  }, []);

  const closeTerm = useCallback(
    (termId: string) => {
      if (!threadId) return;
      void api.close({ threadId, termId }).catch(() => {});
      setIds((cur) => (cur ? cur.filter((id) => id !== termId) : cur));
    },
    [api, threadId],
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
      <div className={styles.splits}>
        {(ids ?? []).map((id, i) => (
          <TerminalView
            key={`${threadId}:${id}:${shown?.termId === id ? shown.nonce : 0}`}
            threadId={threadId}
            termId={id}
            api={api}
            load={load}
            onClose={ids && ids.length > 1 ? () => closeTerm(id) : undefined}
            onSplit={
              ids && i === ids.length - 1 && ids.length < MAX_SPLITS ? split : undefined
            }
            onFix={onFix}
            onAddToPrompt={onAddToPrompt}
          />
        ))}
      </div>
    </div>
  );
}
