import { useState } from "react";
import type { CoderApi, RemoteAgentInfo, RemoteHostInfo, RemoteComputerDescriptor, RemoteInstallResult, RemoteServerStatus, SidebarHostStatus } from "../shared/ipc";
import { accountLine } from "../providerAccounts";
import { groupSavedComputers, hostKeyOf, loadHosts, pushSidebarHosts, STORAGE_KEY, type SavedHost } from "../remoteHosts";
import styles from "./SettingsModal.module.css";
import { CloudConnections, type CloudConnectionsApi } from "./CloudConnections";

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
export function ConnectionsSection({ onOpen, onForget, onInstall, onManage, onSidebarHosts, sidebarHosts = [], cloudApi }: {
  cloudApi?: CloudConnectionsApi;
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
  const [serviceMode, setServiceMode] = useState<"managed" | "external">("managed");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the last Connect learned about the other computer.
  const [remote, setRemote] = useState<{ host: string; info: RemoteHostInfo; remotePort: number; descriptor?: RemoteComputerDescriptor; localVersion?: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<(RemoteInstallResult & { host: string }) | null>(null);

  const saveHosts = (next: SavedHost[]) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setHosts(next);
    void pushSidebarHosts(onSidebarHosts, next);
  };

  const manage = async (action: "status" | "install" | "start" | "logs" | "recover") => {
    if (!onManage || busy) return;
    setBusy(true);
    setProgress(({ status: "Checking computer over SSH…", install: "Preparing the server runtime and user service…", start: "Starting the managed server…", logs: "Reading recent server logs…", recover: "Recovering the interrupted server update…" })[action]);
    setError(null);
    try {
      const bound = hosts.find(item => item.id === selectedId)?.computerId;
      const info = await onManage({ host: host.trim(), remotePort: Number(remotePort), ...(bound ? { computerId: bound } : {}), ...(action === "install" ? { serviceMode } : {}), action });
      setServerStatus({ host: host.trim(), info });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); setProgress(null); }
  };

  const connect = async () => {
    if (!onOpen || busy) return;
    setBusy(true);
    setProgress("Connecting and checking the computer's identity and agents…");
    setError(null);
    setRemote(null);
    try {
      const saved = hosts.find(h => h.id === selectedId);
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
        ...(result.computerId ? { computerId: result.computerId } : {}),
        ...(result.descriptor ? { descriptor: result.descriptor } : {}),
        ...(result.legacy ? { legacy: true } : {}),
      };
      saveHosts((hosts.some(item => item.id === profile.id) ? hosts.map(item => item.id === profile.id ? profile : item) : [...hosts, profile]).slice(0, 30));
      setSelectedId(profile.id);
      setToken("");
      // A pasted pairing link carries the token: keep only the address.
      if (result.url) setUrl(result.url);
      if (result.remote) setRemote({ host: result.host, info: result.remote, remotePort: result.remotePort, descriptor: result.descriptor, localVersion: result.localVersion });
      if (mode === "ssh" && onManage) {
        try { setServerStatus({ host: result.host, info: await onManage({ host: result.host, remotePort: result.remotePort, ...(result.computerId ? { computerId: result.computerId } : {}), action: "status" }) }); }
        catch { /* Connection is authenticated; a separate status check can be retried. */ }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // The main process deleted the rejected keychain copy.
      if (/rejected the saved token/.test(message)) {
        saveHosts(hosts.map((item) => item.id === selectedId ? { ...item, tokenSaved: false } : item));
      }
    } finally {
      setBusy(false);
      setProgress(null);
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
      const bound = remote?.host === target ? remote.descriptor?.computerId : hosts.find(item => item.id === selectedId)?.computerId;
      const port = remote?.host === target ? remote.remotePort : Number(remotePort);
      if (notInstalled && onManage) {
        setServerStatus({ host: target, info: await onManage({ host: target, remotePort: port, ...(bound ? { computerId: bound } : {}), serviceMode, action: "install" }) });
        await connect();
        return;
      }
      const result = await onInstall({ host: target, ...(port !== 4620 ? { remotePort: port } : {}), ...(bound ? { computerId: bound } : {}) });
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
  const externalRunning = serverStatus?.host === host.trim() && serverStatus.info.mode === "external" && serverStatus.info.running;

  return (
    <section className={`${styles.section} ${styles.computerSection}`} data-connections="">
      <p className={styles.fieldNote}>
        Use another computer&apos;s agents and projects here. Your credentials and work stay on that computer,
        and keep running when you disconnect.
      </p>
      {cloudApi && <CloudConnections api={cloudApi} hosts={hosts} onHosts={saveHosts} />}
      <details className={styles.connectionGuide}><summary>How setup works</summary>
      {mode === "address" ? (
        <ol className={`${styles.fieldNote} ${styles.connectionSteps}`} data-connection-steps="address">
          <li>
            On that computer, open Settings &gt; Connections &gt; Browser access
            and turn on Serve Solenta Web. Then press Expose over
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
      </details>
      {groupSavedComputers(hosts.filter(host => !host.cloud)).map(computer => <div key={computer.key} data-connection-computer={computer.key}>
        {computer.computerId && <>
          <p className={styles.fieldNote}>{computer.label}{computer.routes[0]?.descriptor && <> · {computer.routes[0].descriptor.runtimeKind}{computer.routes[0].descriptor.version ? ` ${computer.routes[0].descriptor.version}` : ""}</>}</p>
          <details className={styles.fieldNote}><summary>Connection details</summary>
            <p>Computer {computer.computerId}
              {computer.routes[0]?.descriptor?.buildSha ? ` · build ${computer.routes[0].descriptor.buildSha}` : ""}
              {computer.routes[0]?.descriptor?.releaseTag ? ` · release ${computer.routes[0].descriptor.releaseTag}` : ""}</p>
          </details>
        </>}
      {computer.routes.map((item) => {
        const live = item.inSidebar ? sidebarHosts.find((h) => h.key === hostKeyOf(item) || h.routes?.some(route => route.key === hostKeyOf(item)) || (item.computerId && h.computerId === item.computerId)) : undefined;
        return (
        <div className={styles.connectionRow} key={item.id}>
          <span>
            {item.label} <small>{hostKeyOf(item)}{item.tokenSaved ? " · token saved" : ""}{live ? ` · ${STATUS_TEXT[live.status]}` : item.inSidebar ? "" : " · disconnected"}</small>
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
            setAllowLegacy(item.legacy === true);
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
      })}</div>)}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Connect over</span>
        <select disabled={busy || installing} className={styles.input} data-connection-mode="" value={mode} onChange={(e) => {
          setMode(e.target.value === "address" ? "address" : "ssh");
          setError(null);
          setRemote(null);
          setServerStatus(null);
        }}>
          <option value="ssh">SSH</option>
          <option value="address">Address (Tailscale or your network)</option>
        </select>
      </label>
      {mode === "address" ? (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Address</span>
            <input disabled={busy || installing} className={styles.input} data-connection-url="" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mini.tailnet.ts.net, or the device link" autoComplete="off" spellCheck={false} />
          </label>
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>SSH host</span>
            <input disabled={busy || installing} className={styles.input} data-connection-host="" value={host} onChange={(e) => { setHost(e.target.value); setRemote(null); setServerStatus(null); }} placeholder="user@host or SSH alias" autoComplete="off" />
          </label>
        </>
      )}
      <details className={styles.connectionAdvanced}>
      <summary>Name and advanced options</summary>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name (optional)</span>
        <input disabled={busy || installing} className={styles.input} data-connection-label="" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Workstation" />
      </label>
      {mode === "ssh" && <label className={styles.field}>
        <span className={styles.fieldLabel}>Solenta port</span>
        <input disabled={busy || installing} className={styles.input} data-connection-port="" type="number" min="1" max="65535" value={remotePort} onChange={(e) => { setRemotePort(e.target.value); setRemote(null); setServerStatus(null); }} />
      </label>}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Device token (optional)</span>
        <input disabled={busy || installing} className={styles.input} data-connection-token="" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder={mode === "ssh" ? "Read securely over SSH" : "From the device link, or one already saved"} />
      </label>
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
      {mode === "ssh" && onManage && !(serverStatus?.host === host.trim() && serverStatus.info.installed) && <label className={styles.field}>
        <span className={styles.fieldLabel}>Prepare as</span>
        <select className={styles.input} data-connection-service-mode="" disabled={busy || installing} value={serviceMode} onChange={e => setServiceMode(e.target.value === "external" ? "external" : "managed")}>
          <option value="managed">User service (systemd or launchd)</option>
          <option value="external">External process (no service manager)</option>
        </select>
        <span className={styles.fieldNote}>{serviceMode === "external"
          ? "An external process has no service supervision or guaranteed restart after logout or reboot. Manage its process on that computer."
          : "Linux uses systemd user services; survival after logout depends on linger. macOS launchd requires a logged-in user session."}</span>
      </label>}
      {mode === "ssh" && onManage && <div className={styles.fieldRow}>
        {!externalRunning && <button type="button" className={styles.btn} data-connection-prepare="" disabled={busy || !host.trim()} onClick={() => void manage("install")}>{serviceMode === "external" ? "Prepare external process" : "Prepare server"}</button>}
      </div>}
      </details>
      {serverStatus && serverStatus.host === host.trim() && mode === "ssh" && <div className={styles.fieldNote} data-connection-server-status="">
        <p>{serverStatus.host}: {serverStatus.info.mode === "external" ? "External runtime" : serverStatus.info.installed ? "Installed" : "Not installed"}, {serverStatus.info.running ? "running" : "stopped"}.{serverStatus.info.mode === "managed" ? ` Managed server${serverStatus.info.manager ? ` (${serverStatus.info.manager})` : ""}.` : ""}</p>
        <p>{serverStatus.info.sessionLimit}</p>
        {serverStatus.info.cleanupWarning && <p role="status">{serverStatus.info.cleanupWarning}</p>}
        {serverStatus.info.recoveryRequired && <p>An interrupted update needs recovery. Review recent logs before continuing. Recovery checks the selected runtime and preserves work accepted after a committed update.</p>}
        {externalRunning && <p>This server is externally managed. Connect to use it; manage its process on that computer.</p>}
        {serverStatus.info.linger != null && <p>Linux linger: {serverStatus.info.linger ? "enabled" : "disabled"}.</p>}
        {serverStatus.info.mode === "managed" && serverStatus.info.installed && <div className={styles.fieldRow}>
          {serverStatus.info.recoveryRequired ? <button className={styles.btn} type="button" disabled={busy} data-connection-recover="" onClick={() => void manage("recover")}>Recover interrupted update</button>
            : !serverStatus.info.running && <button className={styles.btn} type="button" disabled={busy} onClick={() => void manage("start")}>Start server</button>}
          <button className={styles.btn} type="button" disabled={busy} onClick={() => void manage("logs")}>Recent logs</button>
        </div>}
        {serverStatus.info.logs && <pre>{serverStatus.info.logs}</pre>}
      </div>}
      {progress && <p className={styles.fieldNote} role="status">{progress}</p>}
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
          {installed.cleanupWarning && <p role="status">{installed.cleanupWarning}</p>}
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
          {mode === "ssh" && onInstall && remote.descriptor?.runtimeKind === "server" &&
            serverStatus?.host === remote.host && serverStatus.info.mode === "managed" ? (
            <>
              <button type="button" data-connection-update="" className={styles.btn} disabled={installing} onClick={() => void install(remote.host)}>
                {installing ? "Updating…" : "Install matching server release"}
              </button>
              <p>Uses this app&apos;s published release. Nightly builds can differ even when their version numbers match. Active work must finish before installation.</p>
            </>
          ) : remote.info.outdated ? (
            mode === "ssh" && onInstall && remote.descriptor?.runtimeKind === "desktop" && remote.info.platform === "linux" ? (
              <button type="button" data-connection-update="" className={styles.btn} disabled={installing} onClick={() => void install(remote.host)}>
                {installing ? "Updating…" : `Update Solenta on ${remote.host}`}
              </button>
            ) : (
              <p>Check its runtime and service status before updating, or update on that computer using its own supported installer.</p>
            )
          ) : null}
          {remote.descriptor && <p>{remote.descriptor.runtimeKind} runtime.</p>}
          <p>Route: {mode === "address" ? url : `SSH ${remote.host}:${remote.remotePort}`}. Credentials and settings belong to this computer.</p>
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
        {mode === "ssh" && onManage && <button type="button" className={styles.btn} data-connection-check="" disabled={busy || installing || !host.trim()} onClick={() => void manage("status")}>Check computer</button>}
        <button type="button" data-connection-open="" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!onOpen || busy || !(mode === "address" ? url : host).trim()} onClick={() => void connect()}>
          {busy ? "Working…" : "Connect"}
        </button>
        {selectedId && <button type="button" disabled={busy || installing} className={styles.btn} onClick={() => {
          setSelectedId(null);
          setLabel("");
          setHost("");
          setUrl("");
          setRemotePort("4620");
          setToken("");
          setRemember(true);
          setInSidebar(true);
          setError(null);
          setRemote(null);
          setServerStatus(null);
          setAllowLegacy(false);
          setServiceMode("managed");
        }}>Add another computer</button>}
      </div>
    </section>
  );
}
