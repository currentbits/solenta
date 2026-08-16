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
};

/**
 * One boundary per main pane (sidebar / thread view / agents panel), so a
 * render crash degrades that pane to a fallback with a reload affordance
 * instead of unmounting the whole window to a blank screen.
 *
 * "Try again" re-renders the children; if the underlying state still throws,
 * the boundary simply catches again. "Reload app" is the sure way out.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[ErrorBoundary] ${this.props.pane} crashed:`,
      error,
      info.componentStack,
    );
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error == null) return this.props.children;
    return (
      <div className={styles.fallback} role="alert">
        <div className={styles.title}>{this.props.pane} crashed</div>
        <div className={styles.message}>{error.message || String(error)}</div>
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
        </div>
      </div>
    );
  }
}
