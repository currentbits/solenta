import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { findSurfaceForEvent } from "../findInView";
import styles from "./FindBar.module.css";

export function useFindSession() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const openFind = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setOpen(false);
    setQuery("");
    setIndex(0);
  }, []);

  const updateQuery = useCallback((next: string) => {
    setQuery(next);
    setIndex(0);
  }, []);

  return { open, query, index, setIndex, inputRef, openFind, closeFind, updateQuery };
}

export function useFindShortcut(
  surface: "transcript" | "diff",
  onOpen: () => void,
  rootRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (
        document.querySelector('[role="dialog"]') &&
        !(e.target instanceof Element && e.target.closest("[data-find-bar]"))
      ) {
        return;
      }
      if (findSurfaceForEvent(e) !== surface) return;
      if (
        surface === "diff" &&
        rootRef?.current &&
        e.target instanceof Node &&
        !rootRef.current.contains(e.target)
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onOpen();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [surface, onOpen, rootRef]);
}

export function FindBar({
  surface,
  query,
  current,
  total,
  inputRef,
  onQuery,
  onNext,
  onPrev,
  onClose,
}: {
  surface: "transcript" | "diff";
  query: string;
  current: number;
  total: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onQuery: (value: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const count =
    !query.trim() ? "" : total === 0 ? "No matches" : `${current + 1}/${total}`;

  return (
    <div
      className={styles.bar}
      data-find-bar={surface}
      role="search"
      aria-label={surface === "diff" ? "Find in diffs" : "Find in thread"}
    >
      <input
        ref={inputRef}
        className={styles.input}
        data-find-input=""
        type="search"
        value={query}
        placeholder={surface === "diff" ? "Find in diffs" : "Find in thread"}
        aria-label={surface === "diff" ? "Find in diffs" : "Find in thread"}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          }
        }}
      />
      <span className={styles.count} data-find-count="">
        {count}
      </span>
      <button type="button" className={styles.btn} aria-label="Previous match" onClick={onPrev}>
        ↑
      </button>
      <button type="button" className={styles.btn} aria-label="Next match" onClick={onNext}>
        ↓
      </button>
      <button type="button" className={styles.btn} aria-label="Close find" data-find-close="" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
