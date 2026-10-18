import { useState } from "react";
import type { CoderApi, RemoteAgentInfo, RemoteHostInfo, RemoteInstallResult } from "../shared/ipc";
import { accountLine } from "../providerAccounts";
import styles from "./SettingsModal.module.css";

type OpenConnection = CoderApi["app"]["openRemoteConnection"];
type ForgetConnection = CoderApi["app"]["forgetRemoteConnection"];
type InstallSolenta = CoderApi["app"]["installRemoteSolenta"];

function agentState(a: RemoteAgentInfo): string {
  if (!a.available) return "Not installed";
  if (a.auth === "signedOut") return "Signed out";
  if (a.auth === "signedIn") return accountLine(a) ?? "Ready";
  return "Installed";
}
type SavedHost = {
  id: string;
  label: string;
  host: string;
  remotePort: number;
  /** Hint only: the encrypted token itself lives in the main process. */
  tokenSaved?: boolean;
};
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

export function ConnectionsSection({ onOpen, onForget, onInstall }: {
  onOpen?: OpenConnection;
  onForget?: ForgetConnection;
  onInstall?: InstallSolenta;
}) {
  const [hosts, setHosts] = useState(loadHosts);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [remotePort, setRemotePort] = useState("4620");
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the last Connect learned about the other computer.
  const [remote, setRemote] = useState<{ host: string; info: RemoteHostInfo; localVersion?: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<(RemoteInstallResult & { host: string }) | null>(null);

  const saveHosts = (next: SavedHost[]) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setHosts(next);
  };

  const connect = async () => {
    if (!onOpen || busy) return;
    setBusy(true);
    setError(null);
    setRemote(null);
    try {
      const result = await onOpen({
        host: host.trim(),
        label: label.trim() || host.trim(),
        remotePort: Number(remotePort),
        token: token.trim(),
        remember,
      });
      const profile: SavedHost = {
        id: selectedId || crypto.randomUUID(),
        label: label.trim() || result.host,
        host: result.host,
        remotePort: result.remotePort,
        tokenSaved: result.tokenSaved,
      };
      saveHosts([profile, ...hosts.filter((item) => item.id !== profile.id)].slice(0, 30));
      setSelectedId(profile.id);
      setToken("");
      if (result.remote) setRemote({ host: result.host, info: result.remote, localVersion: result.localVersion });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // The main process deleted the rejected keychain copy.
      if (/rejected the saved token/.test(message)) {
        saveHosts(hosts.map((item) => item.id === selectedId ? { ...item, tokenSaved: false } : item));
      }
    } finally {
      setBusy(false);
    }
  };

  // Install or update over SSH, then connect straight away when nothing is
  // missing on the other computer.
  const install = async (target: string) => {
    if (!onInstall || installing) return;
    setInstalling(true);
    setError(null);
    setInstalled(null);
    try {
      const result = await onInstall({ host: target });
      setInstalled({ ...result, host: target });
      setRemote(null);
      if (!result.aptCommand && result.missingLibraries.length === 0 && !result.restartNeeded) {
        await connect();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };
  const notInstalled = error != null && /Solenta is not installed on/.test(error);

  return (
    <section className={styles.section} data-connections="">
      <p className={styles.fieldNote}>
        Open the Solenta running on another computer in its own window. Its
        projects, agents, and worktrees stay on that computer.
      </p>
      <ol className={`${styles.fieldNote} ${styles.connectionSteps}`} data-connection-steps="">
        <li>Install Solenta on that computer: the Mac app, or the Linux tarball in ~/solenta.</li>
        <li>
          Check that <code>ssh {host.trim() || "user@host"}</code> works in a
          terminal here without a password prompt (an SSH key or agent, and
          the host key already accepted).
        </li>
        <li>
          Enter the SSH host and press Connect. Solenta starts there if it is
          not running (without a window on a Linux server) and its token is
          read over SSH, so leave Token blank.
        </li>
      </ol>
      {hosts.map((item) => (
        <div className={styles.connectionRow} key={item.id}>
          <span>{item.label} <small>{item.host}:{item.remotePort}{item.tokenSaved ? " · token saved" : ""}</small></span>
          <button type="button" className={styles.btn} onClick={() => {
            setSelectedId(item.id);
            setLabel(item.label);
            setHost(item.host);
            setRemotePort(String(item.remotePort));
            setToken("");
            setRemember(true);
            setError(null);
          }}>Use</button>
          <button type="button" className={styles.btn} aria-label={`Forget ${item.label}`} onClick={() => {
            void (async () => {
              try {
                await onForget?.({ host: item.host, remotePort: item.remotePort });
                saveHosts(hosts.filter((other) => other.id !== item.id));
                if (selectedId === item.id) setSelectedId(null);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            })();
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
        <span className={styles.fieldLabel}>Token (optional)</span>
        <input className={styles.input} data-connection-token="" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Leave blank to read it over SSH" />
      </label>
      <label className={styles.fieldRow}>
        <input type="checkbox" data-connection-remember="" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Remember token on this computer (encrypted with the system keychain)</span>
      </label>
      {error && <p className={styles.fieldError} role="alert">{error}</p>}
      {notInstalled && onInstall ? (
        <div className={styles.fieldRow}>
          <button type="button" data-connection-install="" className={styles.btn} disabled={installing} onClick={() => void install(host.trim())}>
            {installing ? "Installing…" : `Install Solenta on ${host.trim()}`}
          </button>
          <span className={styles.fieldNote}>Linux: downloads this version into ~/solenta there, checked against the release checksum.</span>
        </div>
      ) : null}
      {installed ? (
        <div className={styles.fieldNote} data-connection-installed="">
          <p>Installed Solenta {installed.tag} in ~/solenta on {installed.host}.</p>
          {installed.missingLibraries.length > 0 ? (
            <p data-connection-missing-libs="">
              It is missing libraries it needs ({installed.missingLibraries.join(", ")}).
              {installed.aptCommand ? <> Run this on {installed.host}, then press Connect: <code>{installed.aptCommand}</code></> : " Install them on that computer, then press Connect."}
            </p>
          ) : null}
          {installed.restartNeeded ? <p>Solenta is open on that computer with the old version; restart it there to use the new one.</p> : null}
        </div>
      ) : null}
      {remote ? (
        <div className={styles.fieldNote} data-connection-remote="">
          <p>
            {remote.host} runs Solenta {remote.info.version}
            {remote.info.outdated && remote.localVersion ? `, older than ${remote.localVersion} on this computer.` : "."}
          </p>
          {remote.info.outdated ? (
            remote.info.platform === "linux" && onInstall ? (
              <button type="button" data-connection-update="" className={styles.btn} disabled={installing} onClick={() => void install(remote.host)}>
                {installing ? "Updating…" : `Update Solenta on ${remote.host}`}
              </button>
            ) : (
              <p>Update it on that computer from Settings there.</p>
            )
          ) : null}
          <p>Agents on {remote.host}:</p>
          <ul className={styles.connectionSteps} data-connection-agents="">
            {remote.info.agents.map((a) => (
              <li key={a.id} data-connection-agent={a.id} data-auth-state={a.auth ?? (a.available ? "unknown" : "missing")}>
                {a.name}: {agentState(a)}
              </li>
            ))}
          </ul>
          {remote.info.agents.some((a) => a.available && a.auth === "signedOut") ? (
            <p>To sign in, open Settings &gt; Agents in its window. The sign-in runs on that computer.</p>
          ) : null}
        </div>
      ) : null}
      <div className={styles.fieldRow}>
        <button type="button" data-connection-open="" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!onOpen || busy || !host.trim()} onClick={() => void connect()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <button type="button" className={styles.btn} onClick={() => {
          setSelectedId(null);
          setLabel("");
          setHost("");
          setRemotePort("4620");
          setToken("");
          setRemember(true);
          setError(null);
        }}>New host</button>
      </div>
    </section>
  );
}
