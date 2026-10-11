import { useCallback, useEffect, useState } from "react";
import { resolveCoderApi } from "../coderApi";
import type {
  CoderApi,
  OauthConsentInfo,
  PairingCapability,
  ProjectInfo,
} from "../shared/ipc";
import styles from "./SettingsModal.module.css";

export function OauthConsentDialog({ projects = [] }: { projects?: ProjectInfo[] }) {
  const [pending, setPending] = useState<OauthConsentInfo | null>(null);
  const [steer, setSteer] = useState(false);
  const [readAll, setReadAll] = useState(false);
  const [allProjects, setAllProjects] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const api = (): CoderApi | null => {
    try {
      const existing = (window as unknown as { coder?: CoderApi }).coder;
      if (existing && typeof existing.pairing?.listConsents === "function") return existing;
      const resolved = resolveCoderApi();
      return typeof resolved.pairing?.listConsents === "function" ? resolved : null;
    } catch {
      return null;
    }
  };

  const load = useCallback(async () => {
    const coder = api();
    if (!coder) return;
    try {
      const rows = await coder.pairing.listConsents();
      setPending(rows[0] ?? null);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void load();
    const coder = api();
    if (!coder?.on) return;
    try {
      return coder.on("pairing:consent", (next) => {
        setPending(next);
        setError(null);
      });
    } catch {
      return undefined;
    }
  }, [load]);

  if (!pending) return null;

  const decide = async (approve: boolean) => {
    const coder = api();
    if (!coder) return;
    setBusy(true);
    setError(null);
    try {
      if (approve) {
        const capabilities: PairingCapability[] = ["read", "launch"];
        if (steer) capabilities.push("steer");
        if (readAll) capabilities.push("read_all");
        await coder.pairing.approveConsent({
          id: pending.id,
          capabilities,
          projectIds: allProjects ? null : selectedIds,
        });
      } else {
        await coder.pairing.denyConsent({ id: pending.id });
      }
      setPending(null);
      await load();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop} data-oauth-consent="" role="presentation">
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="oauth-consent-title"
      >
        <div className={styles.header}>
          <h2 id="oauth-consent-title" className={styles.title}>
            Allow {pending.clientName}?
          </h2>
        </div>
        <div className={styles.pairingReveal}>
        <div className={styles.section}>
          <p className={styles.note}>
            This hosted agent wants to connect to Solenta over MCP. It will
            only see the tools you grant, and you can revoke it later.
          </p>
          {error ? (
            <p className={styles.fieldError} role="alert">
              {error}
            </p>
          ) : null}
          <label className={styles.fieldRow}>
            <input
              type="checkbox"
              data-oauth-all-projects=""
              checked={allProjects}
              disabled={busy}
              onChange={(e) => setAllProjects(e.target.checked)}
            />
            <span>All projects</span>
          </label>
          {!allProjects
            ? projects.map((p) => (
                <label key={p.id} className={styles.fieldRow}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(p.id)}
                    disabled={busy}
                    onChange={(e) => {
                      setSelectedIds((cur) =>
                        e.target.checked ? cur.concat(p.id) : cur.filter((id) => id !== p.id),
                      );
                    }}
                  />
                  <span>{p.name}</span>
                </label>
              ))
            : null}
          <label className={styles.fieldRow}>
            <input
              type="checkbox"
              data-oauth-steer=""
              checked={steer}
              disabled={busy}
              onChange={(e) => setSteer(e.target.checked)}
            />
            <span>Allow follow-ups and stop (steer)</span>
          </label>
          <label className={styles.fieldRow}>
            <input
              type="checkbox"
              data-oauth-read-all=""
              checked={readAll}
              disabled={busy}
              onChange={(e) => setReadAll(e.target.checked)}
            />
            <span>Read every task in the allowed projects</span>
          </label>
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={styles.btn}
              data-oauth-deny=""
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Deny
            </button>
            <button
              type="button"
              className={styles.btnPrimary}
              data-oauth-approve=""
              disabled={busy || (!allProjects && selectedIds.length === 0)}
              onClick={() => void decide(true)}
            >
              Allow
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
