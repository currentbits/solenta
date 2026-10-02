import { useState } from "react";
import type { CoderApi } from "../shared/ipc";
import styles from "./SettingsModal.module.css";

type OpenConnection = CoderApi["app"]["openRemoteConnection"];
type SavedHost = { id: string; label: string; host: string; remotePort: number };
const STORAGE_KEY = "coder.remoteConnections";

function loadHosts(): SavedHost[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is SavedHost =>
      item && typeof item.id === "string" &&
      typeof item.label === "string" && typeof item.host === "string" &&
      Number.isInteger(item.remotePort) && item.remotePort > 0 &&
      item.remotePort <= 65535,
    ).slice(0, 30);
  } catch {
    return [];
  }
}

export function ConnectionsSection({ onOpen }: { onOpen?: OpenConnection }) {
  const [hosts, setHosts] = useState(loadHosts);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [remotePort, setRemotePort] = useState("4620");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveHosts = (next: SavedHost[]) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setHosts(next);
  };

  const connect = async () => {
    if (!onOpen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onOpen({
        host: host.trim(),
        label: label.trim() || host.trim(),
        remotePort: Number(remotePort),
        token: token.trim(),
      });
      const profile: SavedHost = {
        id: selectedId || crypto.randomUUID(),
        label: label.trim() || result.host,
        host: result.host,
        remotePort: result.remotePort,
      };
      saveHosts([profile, ...hosts.filter((item) => item.id !== profile.id)].slice(0, 30));
      setSelectedId(profile.id);
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} data-connections="">
      <p className={styles.fieldNote}>
        Connect to a Solenta Web host through SSH. The host keeps its projects,
        agents, and worktrees. The web token is used for this connection only.
      </p>
      {hosts.map((item) => (
        <div className={styles.connectionRow} key={item.id}>
          <span>{item.label} <small>{item.host}:{item.remotePort}</small></span>
          <button type="button" className={styles.btn} onClick={() => {
            setSelectedId(item.id);
            setLabel(item.label);
            setHost(item.host);
            setRemotePort(String(item.remotePort));
            setToken("");
            setError(null);
          }}>Use</button>
          <button type="button" className={styles.btn} aria-label={`Forget ${item.label}`} onClick={() => {
            try {
              saveHosts(hosts.filter((other) => other.id !== item.id));
              if (selectedId === item.id) setSelectedId(null);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}>Forget</button>
        </div>
      ))}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input className={styles.input} data-connection-label="" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Workstation" />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>SSH host</span>
        <input className={styles.input} data-connection-host="" value={host} onChange={(e) => setHost(e.target.value)} placeholder="user@host or SSH alias" autoComplete="off" />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Solenta Web port on host</span>
        <input className={styles.input} data-connection-port="" type="number" min="1" max="65535" value={remotePort} onChange={(e) => setRemotePort(e.target.value)} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Web token</span>
        <input className={styles.input} data-connection-token="" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Token printed by --serve-web" />
      </label>
      {error && <p className={styles.fieldError} role="alert">{error}</p>}
      <div className={styles.fieldRow}>
        <button type="button" data-connection-open="" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!onOpen || busy || !host.trim() || !token.trim()} onClick={() => void connect()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <button type="button" className={styles.btn} onClick={() => {
          setSelectedId(null);
          setLabel("");
          setHost("");
          setRemotePort("4620");
          setToken("");
          setError(null);
        }}>New host</button>
      </div>
    </section>
  );
}
