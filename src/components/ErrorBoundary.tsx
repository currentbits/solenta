import { Component, type ErrorInfo, type ReactNode } from "react";
import styles from "./ErrorBoundary.module.css";

type ErrorBoundaryProps = {
  /** Pane label shown in the fallback, e.g. "Sidebar" -> "Sidebar crashed". */
  pane: string;
  children: ReactNode;
  /** Test seam; defaults to a full window reload. */
  onReload?: () => void;
};

type ErrorBoundaryState = {
  error: Error | null;
  /** React's componentStack from componentDidCatch's ErrorInfo. */
  componentStack: string | null;
  copied: boolean;
};

const COPIED_MS = 1500;

/**
 * Plain-text crash report for "Copy error report": everything a bug report
 * needs and nothing the reporter has to retype. App version reads the
 * compile-time build sha (App.tsx's own __BUILD_SHA__ seam; undeclared
 * under node tests, hence the typeof guard) since a class component this
 * high in the tree has no async app:status to hand it instead.
 */
export function formatErrorReport({
  pane,
  error,
  componentStack,
  appVersion,
  platform,
}: {
  pane: string;
  error: Error;
  componentStack: string | null;
  appVersion: string | null;
  platform: string;
}): string {
  return [
    `Solenta ${appVersion ?? "unknown version"}`,
    `Platform: ${platform}`,
    `Pane: ${pane}`,
    "",
    error.message || String(error),
    "",
    error.stack || "No stack available",
    "",
    "Component stack:",
    componentStack || "(none)",
  ].join("\n");
}

function currentPlatform(): string {
  if (typeof navigator === "undefined") return "unknown";
  return navigator.platform || navigator.userAgent || "unknown";
}

function currentAppVersion(): string | null {
  // Vite replaces __BUILD_SHA__; node tests leave it undeclared.
  return typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : null;
}

/**
 * One boundary per main pane (sidebar / thread view / agents panel), so a
 * render crash degrades that pane to a fallback with a reload affordance
 * instead of unmounting the whole window to a blank screen.
 *
 * "Try again" re-renders the children; if the underlying state still throws,
 * the boundary simply catches again. "Reload app" is the sure way out.
 * "Copy error report" (#1773) hands a bug report the message, stack and
 * componentStack to paste into an issue, without the reporter transcribing
 * a screen.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, componentStack: null, copied: false };
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error(
      `[ErrorBoundary] ${this.props.pane} crashed:`,
      error,
      info.componentStack,
    );
  }

  componentWillUnmount(): void {
    if (this.copiedTimer != null) clearTimeout(this.copiedTimer);
  }

  private copyReport = (): void => {
    const { error, componentStack } = this.state;
    if (!error || typeof navigator === "undefined" || !navigator.clipboard) return;
    const report = formatErrorReport({
      pane: this.props.pane,
      error,
      componentStack,
      appVersion: currentAppVersion(),
      platform: currentPlatform(),
    });
    navigator.clipboard
      .writeText(report)
      .then(() => {
        this.setState({ copied: true });
        if (this.copiedTimer != null) clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => this.setState({ copied: false }), COPIED_MS);
      })
      .catch(() => {
        // Permission denied; leave the label unchanged.
      });
  };

  render(): ReactNode {
    const { error, componentStack, copied } = this.state;
    if (error == null) return this.props.children;
    return (
      <div className={styles.fallback} role="alert">
        <div className={styles.title}>{this.props.pane} crashed</div>
        <div className={styles.message}>{error.message || String(error)}</div>
        <details className={styles.details}>
          <summary>Stack trace</summary>
          <pre className={styles.stack}>
            {error.stack || "No stack available"}
            {componentStack ? `\n\nComponent stack:\n${componentStack}` : ""}
          </pre>
        </details>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.retry}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
          <button
            type="button"
            className={styles.reload}
            onClick={() =>
              (this.props.onReload ?? (() => window.location.reload()))()
            }
          >
            Reload app
          </button>
          <button type="button" className={styles.copy} onClick={this.copyReport}>
            {copied ? "Copied" : "Copy error report"}
          </button>
        </div>
      </div>
    );
  }
}
