import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { renderMermaid } from "../mermaidEngine";
import styles from "./Markdown.module.css";

/** Test hook: swap the real renderer (jsdom has no SVG layout) for a stub. */
export const mermaidRenderer = { render: renderMermaid };

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

/** `<html data-theme>`, so diagrams re-render on a light/dark switch. */
function useThemeAttr(): string | null {
  return useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.getAttribute("data-theme"),
    () => null,
  );
}

/**
 * A ```mermaid fence drawn as a diagram (#1506). `fallback` (the code) shows
 * while it renders and stays when the source does not parse.
 */
export default function MermaidDiagram({
  code,
  fallback,
}: {
  code: string;
  fallback: ReactNode;
}) {
  const theme = useThemeAttr();
  const key = `${theme}\0${code}`;
  const [state, setState] = useState<{ key: string; svg: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void mermaidRenderer
      .render(code)
      .catch(() => null)
      .then((svg) => {
        if (live) setState({ key, svg });
      });
    return () => {
      live = false;
    };
  }, [key, code]);
  const svg = state && state.key === key ? state.svg : null;
  if (!svg) return fallback;
  return (
    <div
      className={styles.mermaid}
      role="img"
      aria-label="Mermaid diagram"
      data-mermaid=""
      // Sanitised by mermaidEngine (strict mode + DOMPurify SVG profile).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
