import { useCallback, useEffect, useState } from "react";
import { resolveCoderApi } from "../coderApi";
import type { CoderApi, PeerLink } from "../shared/ipc";
import styles from "./SettingsModal.module.css";

function resolveApp(): CoderApi["app"] | null {
  try {
    const api = resolveCoderApi();
    return typeof api.app?.listPeers === "function" ? api.app : null;
  } catch {
    return null;
  }
}

/**
 * Linked computers (#1832): other Solentas this one's agents can fork workers
 * onto, whether this is the desktop app or a headless server (here in its
 * web UI). Unlike a Connection, a link is not shown in the sidebar.
 */
export function LinkedComputersSection({ active }: { active: boolean }) {
  const [app] = useState(resolveApp);
  const [peers, setPeers] = useState<PeerLink[]>([]);
  const [link, setLink] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !app) return;
    void app.listPeers().then(setPeers, () => {});
  }, [active, app]);

  const add = useCallback(async () => {
    if (!app) return;
    setBusy(true);
    setError(null);
    try {
      setPeers(await app.linkPeer({ link: link.trim(), label: label.trim() || undefined }));
      setLink("");
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [app, link, label]);

  if (!app) return null;
  return (
    <section className={styles.section} data-linked-computers="">
      <p className={styles.sectionLabel}>Linked computers</p>
      <p className={styles.fieldNote}>
        Agents running on this Solenta can start workers on a linked computer
        and are woken when they finish. On that computer: Settings → Connections →
        Let other devices in, add a device with Full access, and paste its link here.
      </p>
      {peers.length ? (
        <ul className={styles.connectionSteps} data-linked-list="">
          {peers.map((p) => (
            <li key={p.key} data-linked-peer={p.key}>
              <strong>{p.label}</strong> <small>{p.url}</small>{" "}
              <button
                type="button"
                className={styles.btn}
                data-linked-unlink={p.key}
                onClick={() => void app.unlinkPeer({ key: p.key }).then(setPeers, (err) => setError(String(err?.message ?? err)))}
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <label className={styles.field}>
        <span>Device link</span>
        <input className={styles.input} data-linked-link="" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://mac.tailnet.ts.net/?token=…" autoComplete="off" spellCheck={false} />
      </label>
      <label className={styles.field}>
        <span>Name</span>
        <input className={styles.input} data-linked-label="" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Workstation" />
      </label>
      {error ? <p className={styles.fieldError} data-linked-error="">{error}</p> : null}
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-linked-add="" disabled={busy || !link.trim()} onClick={() => void add()}>
        {busy ? "Linking…" : "Link"}
      </button>
    </section>
  );
}
