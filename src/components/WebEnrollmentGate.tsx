import { useEffect, useState } from "react";
import { webNavigation } from "../coderApi";
import { redeemCapturedEnrollment, type WebEnrollment } from "../webEnrollment";
import styles from "./SettingsModal.module.css";

export function WebEnrollmentGate({ enrollment }: { enrollment: WebEnrollment }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void redeemCapturedEnrollment(enrollment).then(() => { if (live) webNavigation.reload(); }).catch(err => {
      if (live) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { live = false; };
  }, [enrollment]);
  return <div className={styles.backdrop} data-web-enrollment-gate="">
    <section className={styles.modal} role="dialog" aria-modal="true" aria-label="Browser enrollment">
      <header className={styles.header}><h2 className={styles.title}>{error ? "Browser enrollment failed" : "Connecting this browser"}</h2></header>
      <div className={styles.body}>
        {error ? <><p className={styles.fieldError} role="alert">{error}</p><p className={styles.note}>Create a new browser enrollment link in the host's Settings &gt; Connections &gt; Browser access. A link can be used once within five minutes.</p></>
          : <p className={styles.note} role="status">Checking the computer and enrolling this browser…</p>}
      </div>
    </section>
  </div>;
}
