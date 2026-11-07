import { useEffect, useState } from "react";
import type { AppSettings, CliProxyUsageSettings } from "../../shared/ipc";
import base from "../SettingsModal.module.css";

export function CliProxyUsageEditor({ settings, disabled, onSave, setError }: {
  settings?: CliProxyUsageSettings;
  disabled: boolean;
  onSave: (patch: Partial<AppSettings>) => Promise<unknown>;
  setError: (error: string | null) => void;
}) {
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [url, setUrl] = useState(settings?.managementUrl ?? "");
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEnabled(settings?.enabled ?? false);
    setUrl(settings?.managementUrl ?? "");
  }, [settings?.enabled, settings?.managementUrl]);
  const save = async (clear = false) => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await onSave({ cliProxyUsage: {
        enabled, managementUrl: url,
        ...(clear ? { managementKey: null } : key.trim() ? { managementKey: key.trim() } : {}),
      } });
      setKey("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save CLIProxy usage settings");
    } finally { setBusy(false); }
  };
  return (
    <section className={base.section} data-cliproxy-usage-settings="">
      <h3 className={base.sectionLabel}>CLIProxy usage</h3>
      <p className={base.note}>Show each CLIProxy Claude account’s session and weekly quotas in Usage › Limits. This read-only connection uses your server’s Management API key.</p>
      <fieldset disabled={disabled || busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}>
        <label className={base.fieldRow}>
          <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setSaved(false); }} />
          Enable CLIProxy usage
        </label>
        <label className={base.field}>
          <span className={base.fieldLabel}>Management URL</span>
          <input className={base.input} type="url" value={url} placeholder="http://localhost:8317/management.html" onChange={(e) => { setUrl(e.target.value); setSaved(false); }} />
        </label>
        <p className={base.note}>Paste the server root or management.html URL. Remote servers require HTTPS. Changing servers requires entering that server’s key.</p>
        <label className={base.field}>
          <span className={base.fieldLabel}>Management key</span>
          <input className={base.input} type="password" autoComplete="new-password" value={key} placeholder={settings?.hasManagementKey ? "Saved key (leave blank to keep)" : "CLIProxy Management API key"} onChange={(e) => { setKey(e.target.value); setSaved(false); }} />
        </label>
        <div className={base.fieldRow}>
          <button className={base.btn} type="button" onClick={() => void save()}>Save CLIProxy usage</button>
          {settings?.hasManagementKey ? <button className={base.btn} type="button" onClick={() => void save(true)}>Clear management key</button> : null}
        </div>
      </fieldset>
      {saved ? <p className={base.note} role="status">Saved. Open Usage › Limits and refresh to load account quotas.</p> : null}
    </section>
  );
}
