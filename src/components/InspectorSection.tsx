import type { ReactNode } from "react";
import styles from "./Inspector.module.css";

/** `data-*` passthrough so callers and tests keep their hooks. */
export type DataAttrs = { [key: `data-${string}`]: string | undefined };

/**
 * One inspector section: title, optional count, optional collapse, optional
 * right-aligned action, children. Renders nothing without children, so an
 * empty section never paints a bare heading.
 *
 * Collapse is a native <details>: no state, keyboard and a11y come free.
 * `defaultOpen` applies on mount and again whenever it changes; a manual
 * toggle sticks in between. `action` is drawn on non-collapsible sections
 * only, because a button inside <summary> would toggle the section.
 */
export function InspectorSection({
  title,
  count,
  collapsible = false,
  defaultOpen = true,
  action,
  children,
  ...data
}: {
  title: string;
  count?: number;
  collapsible?: boolean;
  defaultOpen?: boolean;
  action?: ReactNode;
  children?: ReactNode;
} & DataAttrs) {
  if (children == null || children === false) return null;
  const label = (
    <>
      <span className={styles.title}>{title}</span>
      {count != null ? (
        <span className={styles.count} data-section-count="">
          {count}
        </span>
      ) : null}
    </>
  );
  if (collapsible) {
    return (
      <details
        className={styles.section}
        open={defaultOpen}
        aria-label={title}
        {...data}
      >
        <summary className={styles.head}>
          <svg
            className={styles.chevron}
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3.5 2 6.5 5 3.5 8" />
          </svg>
          {label}
        </summary>
        <div className={styles.body}>{children}</div>
      </details>
    );
  }
  return (
    <section className={styles.section} aria-label={title} {...data}>
      <div className={styles.head}>
        {label}
        {action ? <span className={styles.action}>{action}</span> : null}
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  );
}

/** One-line notice with a › action (memory review queue, skill drift). */
export function InspectorBanner({
  text,
  actionLabel,
  onAction,
  actionProps,
  ...data
}: {
  text?: ReactNode;
  actionLabel: string;
  onAction: () => void;
  actionProps?: DataAttrs & {
    "aria-label"?: string;
    title?: string;
    disabled?: boolean;
  };
} & DataAttrs) {
  return (
    <div className={styles.banner} role="status" {...data}>
      {text != null ? <span className={styles.bannerText}>{text}</span> : null}
      <button
        type="button"
        className={styles.bannerAction}
        onClick={onAction}
        {...actionProps}
      >
        {actionLabel} ›
      </button>
    </div>
  );
}
