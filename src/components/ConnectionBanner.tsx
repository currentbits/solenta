import { useEffect, useState, useSyncExternalStore } from "react";
import { WEB_TOKEN_KEY } from "../coderApi";
import { isWebMode } from "../shared/wire";
import { getWireStatus, subscribeWireStatus } from "../wireStatus";
import { WebTokenGate } from "./WebTokenGate";
import styles from "./ConnectionBanner.module.css";

// Short drops heal before anyone notices; only say something past this.
const SHOW_AFTER_MS = 1500;

/**
 * Solenta Web only: says when the page lost its host, and brings the token
 * gate back when the host rejects the saved token (revoked device, new
 * token after a reinstall).
 */
export function ConnectionBanner() {
  const status = useSyncExternalStore(subscribeWireStatus, getWireStatus);
  const down = status.state === "reconnecting" || status.state === "rateLimited";
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!down) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [down]);

  useEffect(() => {
    if (status.state !== "rejected") return;
    try {
      window.localStorage.removeItem(WEB_TOKEN_KEY);
    } catch {
      // storage disabled; the gate still takes a new token for this load
    }
  }, [status.state]);

  if (!isWebMode()) return null;
  if (status.state === "rejected") {
    return (
      <WebTokenGate reason="This device was signed out: the Solenta you were using no longer accepts its token. The device may have been revoked, or Solenta was set up again." />
    );
  }
  if (!visible || !down) return null;
  return (
    <div className={styles.banner} role="status" data-connection-banner={status.state}>
      <span className={styles.dot} aria-hidden="true" />
      <span>
        {status.state === "rateLimited"
          ? "Too many wrong tokens from this address. Solenta will try again shortly."
          : "Connection to Solenta lost. Reconnecting…"}
        {status.queuedSend ? " Your message is waiting and sends once the connection is back." : ""}
      </span>
    </div>
  );
}
