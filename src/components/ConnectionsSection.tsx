import { useState } from "react";
import type { CoderApi, RemoteAgentInfo, RemoteHostInfo, RemoteInstallResult, RemoteServerStatus, SidebarHostStatus } from "../shared/ipc";
import { accountLine } from "../providerAccounts";
import { hostKeyOf, loadHosts, pushSidebarHosts, STORAGE_KEY, type SavedHost } from "../remoteHosts";
import styles from "./SettingsModal.module.css";

type OpenConnection = CoderApi["app"]["openRemoteConnection"];
type ForgetConnection = CoderApi["app"]["forgetRemoteConnection"];
type InstallSolenta = CoderApi["app"]["installRemoteSolenta"];
type SetSidebarHosts = CoderApi["app"]["setSidebarHosts"];

const STATUS_TEXT: Record<SidebarHostStatus["status"], string> = {
  connecting: "connecting…",
  online: "connected",
  offline: "offline",
};

function agentState(a: RemoteAgentInfo): string {
  if (!a.available) return "Not installed";
  if (a.auth === "signedOut") return "Signed out";
  if (a.auth === "signedIn") return accountLine(a) ?? "Ready";
  return "Installed";
}
export function ConnectionsSection({ onOpen, onForget, onInstall, onManage, onSidebarHosts, sidebarHosts = [] }: {
  onOpen?: OpenConnection;
  onManage?: CoderApi["app"]["manageRemoteServer"];
  onForget?: ForgetConnection;
  onInstall?: InstallSolenta;
  onSidebarHosts?: SetSidebarHosts;
  /** Live state of the hosts shown in the sidebar (hosts:changed). */
  sidebarHosts?: SidebarHostStatus[];
}) {
  const [hosts, setHosts] = useState(loadHosts);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  // SSH host, or a direct route by address and device token (#1824).
  const [mode, setMode] = useState<"ssh" | "address">("ssh");
  const [host, setHost] = useState("");
  const [url, setUrl] = useState("");
  const [remotePort, setRemotePort] = useState("4620");
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(true);
  const [inSidebar, setInSidebar] = useState(true);
  const [serverStatus, setServerStatus] = useState<{ host: string; info: RemoteServerStatus } | null>(null);
  const [allowLegacy, setAllowLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the last Connect learned about the other computer.
  const [remote, setRemote] = useState<{ host: string; info: RemoteHostInfo; localVersion?: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<(RemoteInstallResult & { host: string }) | null>(null);

  const saveHosts = (next: SavedHost[]) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setHosts(next);
    void pushSidebarHosts(onSidebarHosts, next);
  };

  const manage = async (action: "status" | "install" | "start" | "logs") => {
    if (!onManage || busy) return;
    setBusy(true);
    setError(null);
    try {
      const info = await onManage({ host: host.trim(), remotePort: Number(remotePort), action });
      setServerStatus({ host: host.trim(), info });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const connect = async () => {
    if (!onOpen || busy) return;
    setBusy(true);
    setError(null);
    setRemote(null);
    try {
      const saved = hosts.find(h => h.id === selectedId) as (SavedHost & { computerId?: string }) | undefined;
      const identity = { ...(saved?.computerId ? { computerId: saved.computerId } : {}), ...(allowLegacy ? { allowLegacy: true } : {}) };
      const result = await onOpen(mode === "address"
        ? { ...identity, host: "", url: url.trim(), label: label.trim(), token: token.trim(), remember }
        : {
          ...identity,
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
        ...(result.url ? { url: result.url } : {}),
        tokenSaved: result.tokenSaved,
        inSidebar,
        ...((result as typeof result & { computerId?: string }).computerId ? { computerId: (result as typeof result & { computerId?: string }).computerId } : {}),
        ...((result as typeof result & { descriptor?: unknown }).descriptor ? { descriptor: (result as typeof result & { descriptor?: unknown }).descriptor } : {}),
      };
      saveHosts([profile, ...hosts.filter((item) => item.id !== profile.id)].slice(0, 30));
      setSelectedId(profile.id);
      setToken("");
      // A pasted pairing link carries the token: keep only the address.
      if (result.url) setUrl(result.url);
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
        Add a computer to work with its agents and projects from this window.
        That computer owns its credentials, settings, files and running work.
        Disconnecting this window leaves its work running. Connect also opens its own window.
      </p>
      {mode === "address" ? (
        <ol className={`${styles.fieldNote} ${styles.connectionSteps}`} data-connection-steps="address">
          <li>
            On that computer, open Settings &gt; Connections &gt; Let other
            devices in and turn on Serve Solenta Web. Then press Expose over
            Tailscale (HTTPS), or turn on Allow devices on my network.
          </li>
          <li>Under Devices there, add a device with Full access and copy its link.</li>
          <li>
            Paste the link as the Address here and press Connect. That computer
            must already run Solenta Web or the standalone server. An address connection does not install or start it.
          </li>
        </ol>
      ) : (
      <ol className={`${styles.fieldNote} ${styles.connectionSteps}`} data-connection-steps="">
        <li>Enable SSH on the other computer: Remote Login on a Mac, or sshd on Linux.</li>
        <li>Enter its SSH host or alias and check the computer. Prepare server installs the standalone Node runtime on supported Mac and Linux hosts; it needs no desktop app.</li>
        <li>Connect, then choose that computer in Settings to configure its providers and profiles. Install Git and agent CLIs there, and sign in there before running work.</li>
      </ol>
      )}
      {hosts.map((item) => {
        const live = item.inSidebar ? sidebarHosts.find((h) => h.key === hostKeyOf(item)) : undefined;
        return (
        <div className={styles.connectionRow} key={item.id}>
          <span>
            {item.label} <small>{hostKeyOf(item)}{item.tokenSaved ? " · token saved" : ""}{live ? ` · ${STATUS_TEXT[live.status]}` : ""}</small>
            {live?.status === "offline" && live.error ? <small className={styles.fieldError} data-connection-host-error=""> {live.error}</small> : null}
          </span>
          <label className={styles.fieldRow}>
            <input
              type="checkbox"
              data-connection-sidebar={item.id}
              checked={item.inSidebar === true}
              onChange={(e) => saveHosts(hosts.map((other) => other.id === item.id ? { ...other, inSidebar: e.target.checked } : other))}
            />
            <span>Show in sidebar</span>
          </label>
          <button type="button" className={styles.btn} onClick={() => {
            setSelectedId(item.id);
            setLabel(item.label);
            setMode(item.url ? "address" : "ssh");
            setUrl(item.url ?? "");
            setHost(item.url ? "" : item.host);
            setRemotePort(String(item.remotePort));
            setToken("");
            setRemember(true);
            setInSidebar(item.inSidebar === true);
            setError(null);
            setRemote(null);
            setServerStatus(null);
            setAllowLegacy(false);
          }}>Use</button>
          {item.inSidebar && <button type="button" className={styles.btn} onClick={() => saveHosts(hosts.map(other => other.id === item.id ? { ...other, inSidebar: false } : other))}>Disconnect</button>}
          {item.inSidebar && live?.status === "offline" && <button type="button" className={styles.btn} onClick={() => void pushSidebarHosts(onSidebarHosts, hosts)}>Retry</button>}
          <button type="button" className={styles.btn} aria-label={`Forget ${item.label}`} onClick={() => {
            void (async () => {
              try {
                await onForget?.({ host: item.host, remotePort: item.remotePort, ...(item.url ? { url: item.url } : {}) });
                saveHosts(hosts.filter((other) => other.id !== item.id));
                if (selectedId === item.id) setSelectedId(null);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            })();
          }}>Forget</button>
        </div>
        );
      })}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input className={styles.input} data-connection-label="" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Workstation" />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Connect over</span>
        <select className={styles.input} data-connection-mode="" value={mode} onChange={(e) => {
          setMode(e.target.value === "address" ? "address" : "ssh");
          setError(null);
        }}>
          <option value="ssh">SSH</option>
          <option value="address">Address (Tailscale or your network)</option>
        </select>
      </label>
      {mode === "address" ? (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Address</span>
            <input className={styles.input} data-connection-url="" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mini.tailnet.ts.net, or the device link" autoComplete="off" spellCheck={false} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Device token</span>
            <input className={styles.input} data-connection-token="" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Blank if the link has it, or one is saved" />
          </label>
        </>
      ) : (
        <>
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
        </>
      )}
      <label className={styles.fieldRow}>
        <input type="checkbox" data-connection-remember="" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Remember token on this computer (encrypted with the system keychain)</span>
      </label>
      <label className={styles.fieldRow}>
        <input type="checkbox" data-connection-in-sidebar="" checked={inSidebar} onChange={(e) => setInSidebar(e.target.checked)} />
        <span>Show its projects and threads in this window&apos;s sidebar</span>
      </label>
      <p className={styles.fieldNote}>Saved tokens stay encrypted on this computer. Forget removes the saved route and token; it does not stop or uninstall the remote server.</p>
      <label className={styles.fieldRow}>
        <input type="checkbox" data-connection-legacy="" checked={allowLegacy} onChange={e => setAllowLegacy(e.target.checked)} />
        <span>Allow an older server without computer identity (only for an unbound route I trust)</span>
      </label>
      {mode === "ssh" && onManage && <div className={styles.fieldRow}>
        <button type="button" className={styles.btn} data-connection-check="" disabled={busy || !host.trim()} onClick={() => void manage("status")}>Check computer</button>
        <button type="button" className={styles.btn} data-connection-prepare="" disabled={busy || !host.trim()} onClick={() => void manage("install")}>Prepare server</button>
      </div>}
      {serverStatus && serverStatus.host === host.trim() && mode === "ssh" && <div className={styles.fieldNote} data-connection-server-status="">
        <p>{serverStatus.host}: {serverStatus.info.installed ? "Installed" : "Not installed"}, {serverStatus.info.running ? "running" : "stopped"}. {serverStatus.info.mode} server{serverStatus.info.manager ? ` (${serverStatus.info.manager})` : ""}.</p>
        <p>{serverStatus.info.sessionLimit}</p>
        {serverStatus.info.linger != null && <p>Linux linger: {serverStatus.info.linger ? "enabled" : "disabled"}.</p>}
        {serverStatus.info.mode === "managed" && serverStatus.info.installed && <div className={styles.fieldRow}>
          {!serverStatus.info.running && <button className={styles.btn} type="button" disabled={busy} onClick={() => void manage("start")}>Start server</button>}
          <button className={styles.btn} type="button" disabled={busy} onClick={() => void manage("logs")}>Recent logs</button>
        </div>}
        {serverStatus.info.logs && <pre>{serverStatus.info.logs}</pre>}
      </div>}
      {error && <p className={styles.fieldError} role="alert">{error}</p>}
      {notInstalled && onInstall ? (
        <div className={styles.fieldRow}>
          <button type="button" data-connection-install="" className={styles.btn} disabled={installing} onClick={() => void install(host.trim())}>
            {installing ? "Installing…" : `Install Solenta on ${host.trim()}`}
          </button>
          <span className={styles.fieldNote}>Checks the runtime and installs the matching release, verified against its checksum.</span>
        </div>
      ) : null}
      {installed ? (
        <div className={styles.fieldNote} data-connection-installed="">
          <p>Installed Solenta {installed.tag} on {installed.host}.</p>
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
          <p>Route: {mode === "address" ? url : `SSH ${remote.host}:${remotePort}`}. Credentials and settings belong to this computer.</p>
          <p>Agents on {remote.host}:</p>
          <ul className={styles.connectionSteps} data-connection-agents="">
            {remote.info.agents.map((a) => (
              <li key={a.id} data-connection-agent={a.id} data-auth-state={a.auth ?? (a.available ? "unknown" : "missing")}>
                {a.name}: {agentState(a)}
              </li>
            ))}
          </ul>
          {remote.info.agents.some((a) => a.available && a.auth === "signedOut") ? (
            <p>To install or sign in, open Settings &gt; Providers in its window. The sign-in runs on that computer.</p>
          ) : null}
        </div>
      ) : null}
      <div className={styles.fieldRow}>
        <button type="button" data-connection-open="" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!onOpen || busy || !(mode === "address" ? url : host).trim()} onClick={() => void connect()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <button type="button" className={styles.btn} onClick={() => {
          setSelectedId(null);
          setLabel("");
          setHost("");
          setUrl("");
          setRemotePort("4620");
          setToken("");
          setRemember(true);
          setInSidebar(true);
          setError(null);
        }}>Add computer</button>
      </div>
    </section>
  );
}
