import { useEffect, useState, type RefObject } from "react";
import styles from "./TurnRail.module.css";

/** One user prompt on the rail (#487). `index` is its timeline position. */
export interface RailTurn {
  id: string;
  label: string;
  index: number;
}

/** Below this many prompts the rail stays hidden; `/jump` still opens. */
export const RAIL_MIN_TURNS = 8;

/** First line of a prompt, past any quoted reply-context block. */
export function turnLabel(text: string): string {
  const body = text.replace(/<reply-context\b[\s\S]*?<\/reply-context>/g, "");
  const line = body.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/\s+/g, " ").trim() || "Untitled prompt";
}

/**
 * Jump-to-turn rail: one tick per user prompt, expanding into labels on
 * hover/focus. `query` non-null is `/jump` mode: an open, filtered list.
 */
export function TurnRail({
  turns,
  bodyRef,
  start,
  query,
  onQueryChange,
  onJump,
}: {
  turns: RailTurn[];
  bodyRef: RefObject<HTMLDivElement | null>;
  /** First mounted timeline index; earlier turns are above the viewport. */
  start: number;
  query: string | null;
  onQueryChange: (query: string | null) => void;
  onJump: (id: string) => void;
}) {
  const open = query !== null;
  const visible = open || turns.length >= RAIL_MIN_TURNS;
  const [current, setCurrent] = useState<string | null>(null);

  // Scrollspy: the last prompt above the top third of the pane (or the
  // pane bottom once scrolled to the end) is the current turn.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !visible) return;
    const ids = new Set(turns.map((t) => t.id));
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = body.getBoundingClientRect();
      const atEnd =
        body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
      const line = atEnd ? rect.bottom : rect.top + rect.height / 3;
      const tops = new Map<string, number>();
      for (const el of body.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const id = el.dataset.messageId;
        if (id && ids.has(id)) tops.set(id, el.getBoundingClientRect().top);
      }
      let id = turns[0]?.id ?? null;
      for (const t of turns) {
        const top = tops.get(t.id);
        if (t.index < start || (top !== undefined && top <= line)) id = t.id;
        else if (top !== undefined) break;
      }
      setCurrent(id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      body.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [bodyRef, turns, start, visible]);

  // Labels mount only while expanded: hundreds of hidden prompt texts stay
  // out of the DOM, and a collapsed tick is just "Prompt N".
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const expanded = open || hovered || focused;

  if (!visible) return null;
  const needle = query?.trim().toLowerCase() ?? "";
  const shown = needle
    ? turns.filter((t) => t.label.toLowerCase().includes(needle))
    : turns;
  const jump = (id: string) => {
    setHovered(false);
    setFocused(false);
    onJump(id);
  };
  return (
    <nav
      className={styles.rail}
      aria-label="Jump to prompt"
      data-turn-rail=""
      data-expanded={expanded ? "" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setFocused(false);
        if (open) onQueryChange(null);
      }}
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.stopPropagation();
          onQueryChange(null);
        }
      }}
    >
      {open && (
        <input
          className={styles.filter}
          data-turn-filter=""
          aria-label="Filter prompts"
          placeholder="Filter prompts"
          autoFocus
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0]) {
              e.preventDefault();
              jump(shown[0].id);
            }
          }}
        />
      )}
      <ol className={styles.list}>
        {shown.map((t, i) => (
          <li key={t.id}>
            <button
              type="button"
              className={styles.tick}
              data-turn-tick={t.id}
              aria-label={expanded ? undefined : `Prompt ${i + 1}`}
              aria-current={t.id === current ? "location" : undefined}
              onClick={(e) => {
                // A focused tick would hold the outline open over the text.
                e.currentTarget.blur();
                jump(t.id);
              }}
            >
              {expanded && <span className={styles.label}>{t.label}</span>}
            </button>
          </li>
        ))}
        {open && shown.length === 0 && (
          <li className={styles.empty}>No matching prompts</li>
        )}
      </ol>
    </nav>
  );
}
