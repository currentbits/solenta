import { useEffect, useRef, useState } from "react";
import type { CoderApi } from "../shared/ipc";
import styles from "./SettingsModal.module.css";

type ConnectionInput = Parameters<CoderApi["app"]["openRemoteConnection"]>[0];
const tunnelGuide = "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/";
const steps = ["Run the host", "Set up your tunnel", "Pair and test"];

export function ConnectionSetupWizard({ onConnect, onClose, busy, error }: {
  onConnect: (input: ConnectionInput) => Promise<boolean>;
  onClose: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [step, setStep] = useState(0);
  const [port, setPort] = useState("4620");
  const [runtime, setRuntime] = useState<"desktop" | "server">("desktop");
  const [address, setAddress] = useState("");
  const [credential, setCredential] = useState("");
  const [remember, setRemember] = useState(true);
  const [validation, setValidation] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [step, connected]);

  function go(next: number) {
    setValidation(null);
    setStep(next);
  }
  function next() {
    if (step === 0 && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      setValidation("Enter the host's Solenta port, from 1 to 65535.");
      return;
    }
    if (step === 1) {
      try {
        const url = new URL(address.trim());
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
        setAddress(url.origin);
      } catch {
        setValidation("Enter only your public HTTPS address, without a path, login or device token.");
        return;
      }
    }
    go(step + 1);
  }
  async function connect() {
    setValidation(null);
    let token = credential.trim(), computerId: string | undefined;
    if (token.includes("://")) {
      try {
        const link = new URL(token);
        if (link.protocol !== "http:" && link.protocol !== "https:") throw new Error();
        const fragment = new URLSearchParams(link.hash.slice(1));
        token = (fragment.get("token") || link.searchParams.get("token") || "").trim();
        computerId = fragment.get("computerId") || link.searchParams.get("computerId") || undefined;
      } catch { token = ""; }
    }
    if (!token) {
      setValidation("Paste a device token or device link from the host. A browser enrollment link cannot be used here.");
      return;
    }
    if (await onConnect({ host: "", url: address, token, remember, ...(computerId ? { computerId } : {}) })) {
      setCredential("");
      setConnected(true);
    }
  }

  return <section className={`${styles.section} ${styles.computerSection}`} aria-label="Remote connection setup" data-connection-wizard="" aria-busy={busy}>
    <h3 ref={heading} tabIndex={-1} className={styles.sectionLabel} aria-live="polite">{connected ? "Computer connected" : `Step ${step + 1} of 3: ${steps[step]}`}</h3>
    {connected ? <>
      <p role="status">The host accepted your device and the connection is saved. Its projects and threads are available in the sidebar.</p>
      <p className={styles.fieldNote}>Keep the host and its tunnel running. Revoke this device under Browser access on the host to remove access.</p>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onClose}>Done</button>
    </> : <>
      {step === 0 && <>
        <p>Start on the computer where your agents and projects will run. You need access to that computer once to set it up.</p>
        <label className={styles.field}><span className={styles.fieldLabel}>Host installation</span><select className={styles.input} data-setup-runtime="" value={runtime} onChange={event => setRuntime(event.target.value === "server" ? "server" : "desktop")}><option value="desktop">Solenta desktop app</option><option value="server">Standalone server</option></select></label>
        {runtime === "desktop" && <p className={styles.fieldNote}>In its Solenta app, open Settings &gt; Connections &gt; Browser access and turn on Serve Solenta Web. Use the port shown there.</p>}
        <label className={styles.field}><span className={styles.fieldLabel}>Host Solenta port</span><input className={styles.input} data-setup-port="" type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} /></label>
        {runtime === "server" && <div className={styles.fieldNote}>
          <p>Install the standalone Solenta server archive on the host, then run this from its extracted folder:</p>
          <pre>bin/solenta-server --host 127.0.0.1 --port {/^\d+$/.test(port) ? port : "PORT"}</pre>
          <p>The server prints a device link and token when it starts. Keep them private for the pairing step.</p>
        </div>}
        <p className={styles.fieldNote}>If the host is already running, keep its current port. This wizard does not start a second server.</p>
      </>}
      {step === 1 && <>
        <p>Use a Cloudflare account and domain you control. Solenta does not create an account or tunnel on your behalf.</p>
        <ol className={styles.connectionSteps}>
          <li>Open Cloudflare&apos;s dashboard and create a tunnel under Networking &gt; Tunnels.</li>
          <li>Install and run its connector on the host using the command Cloudflare provides. Keep that command private.</li>
          <li>Add a Published application route for a hostname such as solenta.example.com. Leave Path empty and use <code>http://127.0.0.1:{port}</code> as its service URL.</li>
          <li>Wait for the tunnel to become Healthy, then enter its public HTTPS address below.</li>
        </ol>
        <a href={tunnelGuide} target="_blank" rel="noopener noreferrer">Cloudflare tunnel setup guide</a>
        <label className={styles.field}><span className={styles.fieldLabel}>Your public HTTPS address</span><input className={styles.input} data-setup-address="" type="url" value={address} onChange={event => setAddress(event.target.value)} placeholder="https://solenta.example.com" autoComplete="off" spellCheck={false} /></label>
        <p className={styles.fieldNote}>Already have an HTTPS tunnel? Use its address. Traffic goes through your tunnel provider, which terminates HTTPS. It does not pass through Solenta&apos;s servers.</p>
      </>}
      {step === 2 && <>
        <p>{runtime === "desktop" ? "On the host, open Settings > Connections > Browser access. Under Devices, add a device with Full access and copy its device link." : "Copy the device link or token printed when the standalone server started. This token gives Full access; keep it private."}</p>
        <p className={styles.fieldNote}>Paste that link here, even if it shows a local address. We use its device token with your public tunnel address. Keep the link private.</p>
        <label className={styles.field}><span className={styles.fieldLabel}>Device link or token</span><input className={styles.input} data-setup-credential="" type="password" value={credential} onChange={event => setCredential(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} /></label>
        <label className={styles.fieldRow}><input type="checkbox" data-setup-remember="" checked={remember} onChange={event => setRemember(event.target.checked)} disabled={busy} />Remember this device token in the system keychain</label>
        <p className={styles.fieldNote}>Testing checks the host&apos;s identity and device access, then saves the connection. No Solenta account or GitHub login is required.</p>
        <p className={styles.fieldNote}>If it fails, check the host and connector are running, the service port matches, and the device has not been revoked. An extra proxy sign-in page can prevent the app from connecting.</p>
      </>}
      {(validation || (step === 2 && error)) && <p className={styles.fieldError} role="alert">{validation || error}</p>}
      {busy && <p className={styles.fieldNote} role="status">Checking the host and device access…</p>}
      <div className={styles.fieldRow}>
        <button type="button" className={styles.btn} disabled={busy} onClick={onClose}>Cancel setup</button>
        {step > 0 && <button type="button" className={styles.btn} data-setup-back="" disabled={busy} onClick={() => go(step - 1)}>Back</button>}
        {step < 2 ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-setup-next="" onClick={next}>Next</button>
          : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-setup-connect="" disabled={busy || !credential.trim()} onClick={() => void connect()}>Test and connect</button>}
      </div>
    </>}
  </section>;
}
