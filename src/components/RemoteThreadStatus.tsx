import { useState } from "react";
import type { SidebarHostStatus } from "../shared/ipc";
import styles from "./RemoteThreadStatus.module.css";

export type ThreadComputer = Pick<SidebarHostStatus, "key" | "label" | "status" | "error">;

/** Ownership stays visible, including when the transcript cannot be loaded. */
export function RemoteThreadStatus({ computer, stale, onReconnect, onConnections }: {
  computer: ThreadComputer;
  stale?: boolean;
  onReconnect?: () => Promise<void>;
  onConnections?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unavailable = computer.status !== "online" || stale;
  const retry = async () => {
    if (!onReconnect || pending) return;
    setPending(true);
    setError(null);
    try { await onReconnect(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPending(false); }
  };
  return <section className={styles.status} data-thread-computer={computer.key}
    data-unavailable={unavailable || undefined} aria-label="Thread computer">
    <div className={styles.copy} role="status">
      <span><strong>{computer.label}</strong> · {computer.status === "connecting" ? "Connecting…"
        : computer.status === "offline" ? "Disconnected" : stale ? "Could not refresh thread" : "Connected"}</span>
      {unavailable && <span className={styles.hint}>Your draft stays here and remains editable. Reconnect and refresh this thread before sending.</span>}
      {(error || computer.error) && unavailable && <span className={styles.hint}>{error || computer.error}</span>}
    </div>
    {unavailable && onReconnect && <button type="button" className={styles.action}
      data-thread-reconnect="" disabled={pending || computer.status === "connecting"}
      onClick={() => void retry()}>{pending ? "Retrying…" : computer.status === "online" ? "Retry loading" : "Reconnect"}</button>}
    {onConnections && <button type="button" className={styles.action}
      data-thread-connections="" onClick={onConnections}>Connections</button>}
  </section>;
}
