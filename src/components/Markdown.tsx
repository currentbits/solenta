import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./Markdown.module.css";

const COPIED_MS = 1500;

/** Pull raw text out of a code element's children (string | array | nested). */
function flattenText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return flattenText(node.props.children);
  }
  return "";
}

/**
 * Fenced code block with a header bar: language label + Copy.
 * Replaces react-markdown's <pre>; the inner <code> element is unwrapped so
 * the block renders one flat <pre> and the `code` override below only ever
 * sees inline code.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  let lang = "";
  let code = "";
  if (isValidElement<{ className?: string; children?: ReactNode }>(children)) {
    const match = /language-([\w-]+)/.exec(children.props.className ?? "");
    if (match) lang = match[1];
    code = flattenText(children.props.children);
  } else {
    code = flattenText(children);
  }
  code = code.replace(/\n$/, "");

  const [copied, setCopied] = useState(false);

  const copy = async () => {
    // jsdom and insecure contexts have no clipboard; keep the button inert.
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Permission denied; leave the label unchanged.
    }
  };

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>{lang || "code"}</span>
        <button type="button" className={styles.codeCopy} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className={styles.codePre}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * Assistant-message markdown. react-markdown renders to React elements (no
 * dangerouslySetInnerHTML), so raw HTML in agent output is dropped, not
 * executed.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className={styles.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: (props) => <CodeBlock>{props.children}</CodeBlock>,
          code: (props) => (
            <code className={styles.inlineCode}>{props.children}</code>
          ),
          a: (props) => (
            <a href={props.href} target="_blank" rel="noreferrer">
              {props.children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
