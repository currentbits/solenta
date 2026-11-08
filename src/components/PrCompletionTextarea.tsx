import { useEffect, useId, useRef, useState } from "react";
import type { TextareaHTMLAttributes } from "react";
import type { CoderApi } from "../shared/ipc";
import styles from "./PrCompletionTextarea.module.css";

type Token = { start: number; end: number; kind: "@" | "#" | "!"; query: string };
export function prCompletionToken(value: string, start: number, end: number): Token | null {
  if (start !== end) return null;
  const before = value.slice(0, start);
  // Markdown fences and inline code, URLs and email addresses are literal text.
  if ((before.match(/^\s*(```|~~~)/gm)?.length || 0) % 2) return null;
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if ((line.match(/`/g)?.length || 0) % 2) return null;
  const match = /(?:^|[\s(])([@#!])([\w.-]*)$/.exec(before);
  if (!match) return null;
  return { start: start - match[2].length - 1, end: start + (value.slice(start).match(/^[\w.-]*/)?.[0].length || 0), kind: match[1] as Token["kind"], query: match[2] };
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  projectPath: string;
  repo?: string;
  scope: string;
  lookup?: CoderApi["git"]["prCompletions"];
};
export function PrCompletionTextarea({ projectPath, repo, scope, lookup, value, onChange, ...props }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const [token, setToken] = useState<Token | null>(null);
  const [items, setItems] = useState<Array<{ value: string; label: string }>>([]);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [focused, setFocused] = useState(false);
  const request = useRef(0);
  const draftValue = useRef(value);
  const lastSelection = useRef("");
  const read = (element: HTMLTextAreaElement) => {
    const selection = `${element.value}\0${element.selectionStart}:${element.selectionEnd}`;
    if (lastSelection.current === selection) return;
    lastSelection.current = selection;
    draftValue.current = element.value;
    request.current++;
    setItems([]);
    setPage(1);
    setToken(prCompletionToken(element.value, element.selectionStart, element.selectionEnd));
  };
  useEffect(() => {
    if (draftValue.current !== value) { draftValue.current = value; request.current++; setToken(null); setItems([]); }
  }, [value]);
  useEffect(() => { setToken(null); setItems([]); request.current++; }, [projectPath, repo, scope]);
  useEffect(() => {
    const version = ++request.current;
    if (!token || !focused) return;
    setStatus("Loading suggestions…");
    setSelected(0);
    const timer = setTimeout(async () => {
      const search = lookup ?? window.coder?.git.prCompletions;
      try {
        if (!search) throw new Error("Suggestions unavailable");
        const result = await search({ projectPath, repo, kind: token.kind, query: token.query, page });
        if (version !== request.current) return;
        if (!result.ok) throw new Error(result.reason);
        setItems(result.items);
        setMore(result.hasMore);
        setStatus(result.items.length ? "" : "No matches");
      } catch (error) {
        if (version === request.current) { setItems([]); setMore(false); setStatus(error instanceof Error ? error.message : "Search failed"); }
      }
    }, 250);
    return () => { clearTimeout(timer); request.current++; };
  }, [token, focused, projectPath, repo, scope, lookup, page]);
  const choose = (index: number) => {
    const element = ref.current;
    const row = items[index];
    if (!element || !token || !row) return;
    const separator = /^\s/.test(value.slice(token.end)) ? "" : " ";
    const next = value.slice(0, token.start) + row.value + separator + value.slice(token.end);
    const caret = token.start + row.value.length + (separator.length || 1);
    // Use the controlled input's existing change path, without triggering form submission.
    onChange({ target: { value: next }, currentTarget: { value: next } } as React.ChangeEvent<HTMLTextAreaElement>);
    setToken(null); request.current++;
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(caret, caret); });
  };
  const visible = focused && token != null;
  return <div className={styles.root}>
    <textarea {...props} ref={ref} value={value} aria-controls={visible ? id : undefined}
      aria-expanded={visible} aria-autocomplete="list" aria-activedescendant={visible && items.length ? `${id}-${selected}` : undefined}
      onChange={event => { onChange(event); read(event.currentTarget); }}
      onSelect={event => read(event.currentTarget)}
      onFocus={event => { lastSelection.current = ""; setFocused(true); read(event.currentTarget); }}
      onBlur={() => { setFocused(false); request.current++; }}
      onKeyDown={event => {
        if (!visible) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setToken(null); request.current++; }
        else if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        else if (event.key === "PageDown" && more) { event.preventDefault(); event.stopPropagation(); setItems([]); setPage(p => p + 1); }
        else if (["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
          if (!items.length) return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === "ArrowDown" || event.key === "ArrowUp") setSelected(index => items.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0);
          else choose(selected);
        }
      }} />
    {visible && <div className={styles.menu} id={id} role="listbox" aria-label="Repository suggestions">
      {status && <div className={styles.status} role="status">{status}</div>}
      {items.map((row, index) => <div id={`${id}-${index}`} key={row.value} role="option" className={styles.option} aria-selected={selected === index}
        onMouseDown={event => { event.preventDefault(); choose(index); }}>{row.value} {row.label}</div>)}
      {more && <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { setItems([]); setPage(p => p + 1); }}>More suggestions (Page Down)</button>}
    </div>}
  </div>;
}
