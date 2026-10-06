import { useCallback, useEffect, useState } from "react";
import { resolveCoderApi } from "../coderApi";
import { formatRelativeAge } from "../format";
import type {
  CoderApi,
  WebAccessStatus,
  WebDeviceCreated,
  WebDeviceInfo,
} from "../shared/ipc";
import styles from "./SettingsModal.module.css";

/**
 * Solenta Web in Settings (#1512 I2): the server switch, per-device tokens
 * with a pairing QR, and the optional Tailscale Serve helper. Desktop only;
 * the Connections pane is hidden in web mode.
 */

function resolveWeb(): CoderApi["web"] | null {
  try {
    const existing = (window as unknown as { coder?: CoderApi }).coder;
    const api = existing ?? resolveCoderApi();
    return typeof api.web?.status === "function" ? api.web : null;
  } catch {
    return null;
  }
}

function message(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function seenLabel(d: WebDeviceInfo): string {
  if (d.lastSeenAt == null) return "Not used yet";
  const r = formatRelativeAge(d.lastSeenAt);
  return r === "now" ? "Seen just now" : `Seen ${r} ago`;
}

/** The address a new device should open: tailnet HTTPS, then LAN, then local. */
export function pairingBases(status: WebAccessStatus): string[] {
  const out: string[] = [];
  if (status.tailscale.serving && status.tailscale.url) out.push(status.tailscale.url);
  for (const u of status.urls) if (u.kind === "lan") out.push(u.url);
  for (const u of status.urls) if (u.kind === "local") out.push(u.url);
  return out;
}

export function pairingLink(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/?token=${encodeURIComponent(token)}`;
}

/** Rendered locally from the link; nothing leaves the machine. */
function useQrDataUrl(text: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!text) {
      setUrl(null);
      return;
    }
    let live = true;
    void import("qrcode-generator").then((mod) => {
      if (!live) return;
      const qr = mod.default(0, "M");
      qr.addData(text);
      qr.make();
      const svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
      setUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    });
    return () => {
      live = false;
    };
  }, [text]);
  return url;
}

export function WebAccessSection({ active }: { active: boolean }) {
  const [status, setStatus] = useState<WebAccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<WebDeviceCreated | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const web = resolveWeb();
    if (!web) return;
    try {
      setStatus(await web.status());
    } catch (err) {
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const run = async (fn: (web: CoderApi["web"]) => Promise<void>) => {
    const web = resolveWeb();
    if (!web || busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn(web);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const bases = status ? pairingBases(status) : [];
  const chosen = base && bases.includes(base) ? base : (bases[0] ?? null);
  const link = created && chosen ? pairingLink(chosen, created.token) : null;
  const qr = useQrDataUrl(link);

  if (!status) {
    return error ? (
      <p className={styles.fieldError} role="alert">
        {error}
      </p>
    ) : null;
  }

  const ts = status.tailscale;

  return (
    <section className={styles.section} data-web-access="">
      <p className={styles.sectionLabel}>Solenta Web</p>
      <div className={styles.memoryRow} data-web-state={status.running ? "on" : "off"}>
        <span className={styles.memoryDot} data-on={status.running ? "true" : undefined} aria-hidden />
        {status.running ? (
          <span>
            Listening on{" "}
            {status.urls.map((u, i) => (
              <span key={u.url}>
                {i > 0 ? ", " : ""}
                <code data-web-url={u.kind}>{u.url}</code>
              </span>
            ))}
          </span>
        ) : (
          <span>Off. Turn it on to use Solenta from a browser or your phone.</span>
        )}
      </div>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-web-enabled=""
          checked={status.running}
          disabled={busy}
          onChange={(e) => {
            const enabled = e.target.checked;
            void run(async (web) => {
              setStatus(await web.setEnabled({ enabled, lan: status.lan }));
            });
          }}
        />
        <span>Serve Solenta Web</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-web-lan=""
          checked={status.lan}
          disabled={busy}
          onChange={(e) => {
            const lan = e.target.checked;
            void run(async (web) => {
              setStatus(await web.setEnabled({ enabled: status.running, lan }));
            });
          }}
        />
        <span>Allow devices on my network</span>
      </label>
      <p className={styles.note}>
        Off, only this computer can connect. On, anyone on your network can
        reach the sign-in page over plain HTTP, and each device still needs
        its own token. Use Tailscale below for HTTPS.
      </p>

      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}

      <p className={styles.fieldLabel}>Devices</p>
      {created ? (
        <div className={styles.pairingReveal} data-web-reveal="">
          <p className={styles.pairingName}>Pair {created.device.name}</p>
          <p className={styles.note}>
            Scan with the device's camera, or open the link on it. This token
            is shown once.
          </p>
          {bases.length > 1 ? (
            <select
              className={styles.input}
              aria-label="Address for this device"
              data-web-pair-base=""
              value={chosen ?? ""}
              onChange={(e) => setBase(e.target.value)}
            >
              {bases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          ) : null}
          {!status.running ? (
            <p className={styles.note}>Turn on Solenta Web to get a link and QR code.</p>
          ) : null}
          {qr ? (
            <img className={styles.webQr} src={qr} alt={`QR code to pair ${created.device.name}`} data-web-qr="" />
          ) : null}
          <pre className={styles.pairingPre} data-web-pair-link="">
            {link ?? created.token}
          </pre>
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                void navigator.clipboard.writeText(link ?? created.token).then(
                  () => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                  },
                  () => {},
                );
              }}
            >
              {copied ? "Copied" : link ? "Copy link" : "Copy token"}
            </button>
            <button type="button" className={styles.btn} data-web-reveal-done="" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
      <div className={styles.fieldRow}>
        <input
          className={styles.input}
          data-web-device-name=""
          aria-label="Device name"
          placeholder="Phone"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          data-web-add-device=""
          disabled={busy || !name.trim()}
          onClick={() =>
            void run(async (web) => {
              const result = await web.addDevice({ name: name.trim() });
              setCreated(result);
              setName("");
              setStatus(await web.status());
            })
          }
        >
          Add device
        </button>
      </div>
      {status.devices.length > 0 ? (
        <div className={styles.pairingList} data-web-devices="">
          {status.devices.map((d) => (
            <div key={d.id} className={styles.pairingRow} data-web-device={d.id}>
              <div className={styles.pairingRowBody}>
                <p className={styles.pairingName}>{d.name}</p>
                <p className={styles.note}>
                  {seenLabel(d)}
                  {d.legacy ? " · the token from before devices" : ""}
                </p>
              </div>
              <button
                type="button"
                className={styles.btn}
                data-web-revoke={d.id}
                aria-label={`Revoke ${d.name}`}
                disabled={busy}
                onClick={() =>
                  void run(async (web) => {
                    await web.revokeDevice({ id: d.id });
                    if (created?.device.id === d.id) setCreated(null);
                    setStatus(await web.status());
                  })
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.note}>No devices yet. Revoking one signs it out at once.</p>
      )}

      {ts.installed ? (
        <div className={styles.field} data-web-tailscale={ts.serving ? "serving" : ts.loggedIn ? "ready" : "offline"}>
          <p className={styles.fieldLabel}>Tailscale</p>
          {!ts.loggedIn ? (
            <p className={styles.note}>Tailscale is installed but not running or not logged in.</p>
          ) : ts.serving && ts.url ? (
            <div className={styles.fieldRow}>
              <code data-web-tailscale-url="">{ts.url}</code>
              <button
                type="button"
                className={styles.btn}
                data-web-tailscale-stop=""
                disabled={busy}
                onClick={() =>
                  void run(async (web) => {
                    await web.setTailscale({ on: false });
                    setStatus(await web.status());
                  })
                }
              >
                Stop
              </button>
            </div>
          ) : (
            <div className={styles.fieldRow}>
              <button
                type="button"
                className={styles.btn}
                data-web-tailscale-start=""
                disabled={busy || !status.running}
                onClick={() =>
                  void run(async (web) => {
                    await web.setTailscale({ on: true });
                    setStatus(await web.status());
                  })
                }
              >
                Expose over Tailscale (HTTPS)
              </button>
            </div>
          )}
          <p className={styles.note}>
            This runs Tailscale Serve, which makes Solenta Web reachable over
            HTTPS from every device on your tailnet{ts.host ? ` at ${ts.host}` : ""},
            including anyone you share this machine with. Each device still
            needs its own token.
          </p>
        </div>
      ) : null}
    </section>
  );
}
