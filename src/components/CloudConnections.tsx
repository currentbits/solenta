import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudComputer, CloudStatus, CloudUnlinkResult, CoderApi, WebDeviceScope } from "../shared/ipc";
import type { SavedHost } from "../remoteHosts";
import styles from "./SettingsModal.module.css";

export type CloudConnectionsApi = Pick<CoderApi["app"], "cloudStatus" | "cloudLogin" | "cloudLogout" | "cloudComputers" | "cloudConnect" | "cloudLink" | "cloudUnlink">;
type Access = "full" | "read" | "steer" | "saved";
const scopesFor: Record<Exclude<Access, "saved">, WebDeviceScope[]> = { full: ["full"], read: ["read"], steer: ["read", "steer"] };
const states: Record<CloudComputer["status"], string> = { pending: "Setting up", connecting: "Connecting", online: "Online", offline: "Offline", "setup-error": "Setup needs attention", revoked: "Unlinked; cleanup pending" };
function savedAccess(scopes?: WebDeviceScope[]): Access {
  if (!scopes) return "full";
  return (Object.keys(scopesFor) as Exclude<Access, "saved">[]).find(key => JSON.stringify(scopesFor[key]) === JSON.stringify(scopes)) ?? "saved";
}

export function CloudConnections({ api, hosts, onHosts }: { api: CloudConnectionsApi; hosts: SavedHost[]; onHosts: (hosts: SavedHost[]) => void }) {
  const [status, setStatus] = useState<CloudStatus | null>(null), [computers, setComputers] = useState<CloudComputer[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [access, setAccess] = useState<Record<string, Access>>({});
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    const next = await api.cloudStatus();
    if (!alive.current) return;
    setStatus(next);
    if (next.account.error || next.error) setError(next.account.error ?? next.error!);
    if (!next.account.configured || !next.account.signedIn) { setComputers([]); return; }
    const rows = await api.cloudComputers();
    if (alive.current) setComputers(rows);
  }, [api]);
  useEffect(() => {
    alive.current = true;
    const load = () => { void refresh().catch(err => { if (alive.current) setError(err instanceof Error ? err.message : String(err)); }); };
    load();
    const timer = setInterval(load, 15_000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);
  async function run(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await work(); await refresh(); }
    catch (err) { if (alive.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function unlink(computerId: string) {
    const result: CloudUnlinkResult = await api.cloudUnlink({ computerId });
    setNotice(result.revocationPending ? "Cloud access is disabled here; account unlink is pending. Retry when connected."
      : result.hostRevocationPending || result.cleanupPending ? "Account access revoked. Host confirmation or resource cleanup is pending."
      : "Computer unlinked. Its work and direct connections remain.");
  }
  const own = status?.host;
  return <div className={styles.section} data-cloud-connections="">
    <h3 className={styles.sectionLabel}>Cloud</h3>
    {!status ? <p className={styles.fieldNote}>Checking cloud access…</p> : !status.account.configured ? <p className={styles.fieldNote}>Cloud access is not configured in this build.</p> : <>
      <p className={styles.fieldNote}>Sign in with GitHub on each computer, then connect without SSH. Agents, credentials and work stay on their execution computer.</p>
      <div className={styles.fieldRow}>
        {!status.account.signedIn ? <button className={styles.btnPrimary} type="button" data-cloud-sign-in="" disabled={busy || Boolean(status.account.error)} onClick={() => void run(() => api.cloudLogin())}>Sign in with GitHub</button>
          : <><span className={styles.fieldNote}>Signed in{status.account.storage === "session" ? " for this session" : ""}</span>
            <button className={styles.btn} type="button" data-cloud-sign-out="" disabled={busy} onClick={() => void run(async () => {
              const result = await api.cloudLogout();
              if (result.revocationPending) setNotice("Signed out here. The account provider could not confirm token revocation.");
            })}>Sign out</button>
            <button className={styles.btn} type="button" data-cloud-refresh="" disabled={busy} onClick={() => void run(refresh)}>Refresh</button></>}
        {status.account.error && <button className={styles.btn} type="button" disabled={busy} onClick={() => void run(() => api.cloudLogout())}>Clear saved login</button>}
      </div>
      {own && <div className={styles.section}>
        <h4 className={styles.sectionLabel}>This computer</h4>
        <p className={styles.fieldNote}>Cloud access lets devices on your account use agents, terminals and files as this computer&apos;s OS user.</p>
        {!own.supported ? <p className={styles.fieldNote}>Cloud hosting supports macOS and Linux. You can still connect to other computers.</p>
          : own.enabled ? <><p className={styles.fieldNote}>Cloud access enabled · {own.state === "running" ? "Connector running" : own.state}{!status.account.signedIn ? ". Signing out does not unlink this host." : ""}</p>
            <button className={styles.btn} type="button" data-cloud-disable="" disabled={busy} onClick={() => void run(() => unlink(own.computerId))}>Disable cloud access here</button></>
          : <button className={styles.btn} type="button" data-cloud-enable="" disabled={busy || !status.account.signedIn || status.account.storage === "session"} onClick={() => void run(() => api.cloudLink())}>Enable cloud access</button>}
        {status.account.storage === "session" && <p className={styles.fieldNote}>Hosting needs persistent secure storage. Client sign-in can remain session-only.</p>}
        {(own.revocationPending || own.cleanupPending) && <p className={styles.fieldNote}>{own.revocationPending ? "Account unlink is pending." : "Resource cleanup is pending."} <button className={styles.btn} type="button" disabled={busy} onClick={() => void run(() => unlink(own.computerId))}>Retry unlink</button></p>}
        {own.error && <p className={styles.fieldError}>{own.error}</p>}
      </div>}
      {status.account.signedIn && <div className={styles.section}>
        <h4 className={styles.sectionLabel}>Your other computers</h4>
        {!computers.some(row => row.computerId !== own?.computerId) && <p className={styles.fieldNote}>No other computers linked. Enable cloud access in Solenta there, or run solenta-connect link in an installed server.</p>}
        {computers.filter(row => row.computerId !== own?.computerId).map(computer => {
          const saved = hosts.find(row => row.cloud?.accountId === status.account.accountId && row.cloud?.computerId === computer.computerId);
          const choice = access[computer.computerId] ?? savedAccess(saved?.cloud?.scopes);
          const scopes = choice === "saved" ? saved?.cloud?.scopes ?? ["read"] : scopesFor[choice];
          const platform = computer.descriptor?.platform;
          const os = platform ? ({ darwin: "macOS", linux: "Linux", win32: "Windows" } as Record<string, string>)[platform] : null;
          return <div className={styles.section} key={computer.computerId} data-cloud-computer={computer.computerId}>
            <p>{computer.label} · {states[computer.status]}</p>
            <p className={styles.fieldNote}>{[os, computer.descriptor?.runtimeKind, computer.descriptor?.version].filter(Boolean).join(" · ")}{computer.lastSeen ? ` · Last reached ${new Date(computer.lastSeen).toLocaleString()}` : " · Not reached yet"}</p>
            <label className={styles.field}><span className={styles.fieldLabel}>Access from this device</span>
              <select className={styles.input} data-cloud-access={computer.computerId} disabled={busy} value={choice} onChange={event => setAccess(prev => ({ ...prev, [computer.computerId]: event.target.value as Access }))}>
                <option value="full">Full access</option><option value="steer">Steer threads</option><option value="read">Read only</option>{choice === "saved" && <option value="saved">Saved permissions</option>}
              </select></label>
            <div className={styles.fieldRow}>
              <button className={styles.btnPrimary} type="button" data-cloud-connect={computer.computerId} disabled={busy || computer.status === "revoked"} onClick={() => void run(async () => {
                const result = await api.cloudConnect({ computerId: computer.computerId, label: computer.label, scopes });
                if (!result.cloud || result.computerId !== computer.computerId || result.cloud.computerId !== computer.computerId || result.cloud.accountId !== status.account.accountId) throw new Error("Cloud computer identity was not confirmed.");
                const profile: SavedHost = { id: `cloud:${result.cloud.accountId}:${computer.computerId}`, host: result.host, remotePort: result.remotePort, label: computer.label,
                  computerId: result.computerId, descriptor: result.descriptor, cloud: { accountId: result.cloud.accountId, computerId: result.cloud.computerId, scopes: result.cloud.scopes }, tokenSaved: false, inSidebar: saved?.inSidebar ?? true };
                onHosts([...hosts.filter(row => row.id !== profile.id), profile]);
              })}>Connect</button>
              <button className={styles.btn} type="button" data-cloud-unlink={computer.computerId} disabled={busy} onClick={() => void run(() => unlink(computer.computerId))}>{computer.status === "revoked" ? "Retry cleanup" : "Unlink computer"}</button>
              {saved && <><label className={styles.fieldRow}><input type="checkbox" checked={saved.inSidebar === true} onChange={event => onHosts(hosts.map(row => row.id === saved.id ? { ...row, inSidebar: event.target.checked } : row))} />Show in sidebar</label>
                <button className={styles.btn} type="button" onClick={() => onHosts(hosts.filter(row => row.id !== saved.id))}>Forget saved route</button></>}
            </div>
          </div>;
        })}
      </div>}
    </>}
    {busy && <p className={styles.fieldNote} role="status">Working…</p>}
    {notice && <p className={styles.fieldNote} role="status">{notice}</p>}
    {error && <p className={styles.fieldError} role="alert">{error}</p>}
  </div>;
}
