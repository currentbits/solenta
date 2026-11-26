import { useEffect, useRef, useState } from "react";
import styles from "./StarPromptToast.module.css";

const DELAY_MS = 20 * 60_000;
const TICK_MS = 5_000;

export function StarPromptToast({ enabled, blocked, claim }: {
  enabled: boolean;
  blocked: boolean;
  claim: () => Promise<boolean>;
}) {
  const [visible, setVisible] = useState(false);
  const elapsed = useRef(0);
  const attempted = useRef(false);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  useEffect(() => {
    if (!enabled || attempted.current) return;
    let live = true;
    let last = performance.now();
    let wasForeground = document.visibilityState === "visible" && document.hasFocus();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const foreground = document.visibilityState === "visible" && document.hasFocus();
      // Ignore background time and long gaps caused by sleep or suspension.
      if (foreground && wasForeground && now - last <= TICK_MS * 2) elapsed.current += now - last;
      last = now;
      wasForeground = foreground;
      if (!foreground || elapsed.current < DELAY_MS || blockedRef.current || document.querySelector('[role="dialog"], dialog[open]')) return;
      attempted.current = true;
      window.clearInterval(timer);
      void claim().then((claimed) => {
        if (live && claimed) setVisible(true);
      }).catch(() => {});
    }, TICK_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [enabled, claim]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), 30_000);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!visible || blocked) return null;
  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span>Enjoying Solenta? A star on GitHub helps us grow.</span>
      <a className={styles.action} href="https://github.com/currentbits/solenta" target="_blank" rel="noopener noreferrer" onClick={() => setVisible(false)}>
        <span aria-hidden="true">☆</span> Star on GitHub
      </a>
      <button className={styles.dismiss} type="button" aria-label="Dismiss star request" onClick={() => setVisible(false)}>×</button>
    </div>
  );
}
