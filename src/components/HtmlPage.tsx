import { useEffect, useRef, type ReactNode } from "react";
import {
  HTML_SANDBOX,
  handleMcpAppMessage,
  htmlFitsCap,
  wrapHtmlPage,
} from "../htmlPage";
import styles from "./HtmlPage.module.css";

function safeWrap(html: string): string | null {
  try {
    return wrapHtmlPage(html);
  } catch {
    return null;
  }
}

function downloadPage(srcdoc: string) {
  const a = document.createElement("a");
  a.href = `data:text/html;charset=utf-8,${encodeURIComponent(srcdoc)}`;
  a.download = "visual-reply.html";
  a.rel = "noopener";
  a.click();
}

/**
 * Sandboxed srcdoc page (#1525). `fallback` (the code) shows when the
 * source is over the size cap. `bridge` turns on the MCP Apps host
 * listener for ui:// tool results.
 */
export default function HtmlPage({
  html,
  fallback = null,
  bridge = false,
}: {
  html: string;
  fallback?: ReactNode;
  bridge?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const srcdoc = htmlFitsCap(html) ? safeWrap(html) : null;

  useEffect(() => {
    if (!bridge || !srcdoc) return;
    const onMessage = (event: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win) return;
      handleMcpAppMessage(event, {
        source: win,
        post: (msg) => win.postMessage(msg, "*"),
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [bridge, srcdoc]);

  if (!srcdoc) return fallback;

  return (
    <div className={styles.page} data-html-page="">
      <div className={styles.bar}>
        <span className={styles.hint}>Sandboxed</span>
        <button
          type="button"
          className={styles.open}
          onClick={() => downloadPage(srcdoc)}
        >
          Open in browser
        </button>
      </div>
      <iframe
        ref={frameRef}
        className={styles.frame}
        sandbox={HTML_SANDBOX}
        srcDoc={srcdoc}
        title="Sandboxed HTML page"
        referrerPolicy="no-referrer"
        allow=""
      />
    </div>
  );
}
