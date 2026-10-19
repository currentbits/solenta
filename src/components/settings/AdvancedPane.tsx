import { useEffect, useState, type RefObject } from "react";
import { resolveCoderApi } from "../../coderApi";
import type {
  AppSettings,
  CoderApi,
  GovernanceAuditEntry,
  OtelSettings,
} from "../../shared/ipc";
import styles from "../SettingsModal.module.css";
import type { SettingsDraftKey, SettingsModalProps } from "../SettingsModal";
import { VibeKanbanSection } from "../VibeKanbanSection";

/** ponytail: one `key: value` per line; a row editor if this grows past a handful of headers. */
export function formatOtelHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([k]) => k)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export function parseOtelHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function AdvancedPane({
  settings,
  saving,
  error,
  setError,
  otelEndpoint,
  setOtelEndpoint,
  otelHeadersText,
  setOtelHeadersText,
  otelClaudeMetrics,
  setOtelClaudeMetrics,
  dirtyDrafts,
  persistOtel,
  onSaveSettings,
}: {
  settings: AppSettings | null;
  saving: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  otelEndpoint: string;
  setOtelEndpoint: (text: string) => void;
  otelHeadersText: string;
  setOtelHeadersText: (text: string) => void;
  otelClaudeMetrics: boolean;
  setOtelClaudeMetrics: (on: boolean) => void;
  dirtyDrafts: RefObject<Set<SettingsDraftKey>>;
  persistOtel: (next: OtelSettings) => Promise<boolean>;
  onSaveSettings: SettingsModalProps["onSaveSettings"];
}) {
  const otelFromDrafts = (): OtelSettings => ({
    endpoint: otelEndpoint.trim() === "" ? null : otelEndpoint.trim(),
    headers: parseOtelHeaders(otelHeadersText),
    claudeMetrics: otelClaudeMetrics,
  });

  const onBlurOtelEndpoint = () => {
    const current = settings?.otel?.endpoint ?? null;
    const next = otelEndpoint.trim() === "" ? null : otelEndpoint.trim();
    if (next === current && error == null) return;
    void persistOtel(otelFromDrafts());
  };

  const onBlurOtelHeaders = () => {
    const current = formatOtelHeaders(settings?.otel?.headers ?? {});
    const next = formatOtelHeaders(parseOtelHeaders(otelHeadersText));
    if (next === current && error == null) return;
    void persistOtel(otelFromDrafts());
  };

  return (
    <>
      <section className={styles.section}>
        <h3 className={styles.sectionLabel}>Guardrails</h3>
        <div className={styles.field}>
          <label className={styles.fieldRow}>
            <input
              type="checkbox"
              data-guardrails-enabled=""
              checked={settings?.guardrailsEnabled !== false}
              disabled={saving || settings == null}
              aria-describedby="guardrails-note"
              onChange={(e) => {
                setError(null);
                void onSaveSettings({ guardrailsEnabled: e.target.checked }).catch((err) => {
                  setError(
                    err instanceof Error && err.message
                      ? err.message
                      : "Failed to save settings",
                  );
                });
              }}
            />
            <span>Solenta guardrails</span>
          </label>
          <p className={styles.note} id="guardrails-note">
            Check agent tools for risky commands and protected files, scan
            incoming content for prompt injection, and check outgoing changes
            for secrets. Turning this off disables these checks across all
            projects. Provider permission settings still apply. Restart active
            agent runs to apply changes everywhere.
          </p>
        </div>
      </section>

      <section className={styles.section} data-otel-settings="">
        <h3 className={styles.sectionLabel}>OpenTelemetry</h3>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="otel-endpoint">
            OTLP endpoint
          </label>
          <input
            id="otel-endpoint"
            className={styles.input}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:4318"
            value={otelEndpoint}
            disabled={saving || settings == null}
            data-otel-endpoint=""
            onChange={(e) => {
              dirtyDrafts.current.add("otel");
              setOtelEndpoint(e.target.value);
              setError(null);
            }}
            onBlur={() => onBlurOtelEndpoint()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void persistOtel(otelFromDrafts());
              }
            }}
          />
          <p className={styles.note}>
            Empty turns export off entirely. Spans POST to
            {" "}
            <span className={styles.monoNote}>&lt;endpoint&gt;/v1/traces</span>
            .
          </p>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="otel-headers">
            Export headers
          </label>
          <textarea
            id="otel-headers"
            className={styles.textarea}
            rows={3}
            spellCheck={false}
            placeholder="Authorization: Bearer ..."
            value={otelHeadersText}
            disabled={saving || settings == null}
            data-otel-headers=""
            onChange={(e) => {
              dirtyDrafts.current.add("otel");
              setOtelHeadersText(e.target.value);
              setError(null);
            }}
            onBlur={() => onBlurOtelHeaders()}
          />
          <p className={styles.note}>
            One <span className={styles.monoNote}>key: value</span> per
            line. Used as extra headers on every OTLP POST (collector
            auth).
          </p>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldRow}>
            <input
              type="checkbox"
              data-otel-claude-metrics=""
              checked={otelClaudeMetrics}
              disabled={saving || settings == null}
              onChange={(e) => {
                const claudeMetrics = e.target.checked;
                setOtelClaudeMetrics(claudeMetrics);
                setError(null);
                void persistOtel({
                  ...otelFromDrafts(),
                  claudeMetrics,
                });
              }}
            />
            <span>Also export Claude Code&apos;s native metrics</span>
          </label>
          <p className={styles.note}>
            Does nothing unless an endpoint is set. Points Claude Code
            at the same collector so its native metrics land beside our
            spans.
          </p>
        </div>
      </section>

      <GovernanceAuditSection />

      <VibeKanbanSection active />
    </>
  );
}

function governanceApi(): CoderApi["governance"] | null {
  try {
    const api = resolveCoderApi();
    return typeof api.governance?.listAudit === "function" ? api.governance : null;
  } catch {
    return null;
  }
}

/** Read-only tail of the HMAC-chained governance audit (#262). */
function GovernanceAuditSection() {
  const [rows, setRows] = useState<GovernanceAuditEntry[] | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = governanceApi();
    if (!api) return;
    let live = true;
    api
      .listAudit({ limit: 50 })
      .then((next) => live && setRows(next))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, []);

  const verify = async () => {
    const api = governanceApi();
    if (!api) return;
    setBusy(true);
    try {
      const r = await api.verifyAudit();
      setVerdict(
        r.ok
          ? `Chain OK (${r.entries} ${r.entries === 1 ? "entry" : "entries"})`
          : r.seq != null
            ? `Chain broken at #${r.seq}: ${r.reason}`
            : r.reason,
      );
    } catch (err) {
      setVerdict(err instanceof Error && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} data-governance-audit="">
      <h3 className={styles.sectionLabel}>Governance audit</h3>
      <p className={styles.note}>
        Last 50 governed Claude tool-call decisions (built-in guardrails and
        profile rules), newest first. HMAC-chained; Verify walks the whole log.
      </p>
      {rows != null && rows.length === 0 && (
        <p className={styles.note}>No governed tool calls yet.</p>
      )}
      {rows?.map((row) => (
        <div key={row.seq} className={styles.memoryRow} data-audit-row={row.seq}>
          <span className={styles.monoNote}>
            {new Date(row.ts).toLocaleString()} · {row.threadId.slice(0, 8)} ·{" "}
            {row.toolName} · {row.decision} · {row.layer}
          </span>
        </div>
      ))}
      <div className={styles.fieldRow}>
        <button
          type="button"
          className={styles.btn}
          data-audit-verify=""
          disabled={busy}
          onClick={() => void verify()}
        >
          Verify chain
        </button>
        {verdict && (
          <span className={styles.note} data-audit-verdict="">
            {verdict}
          </span>
        )}
      </div>
    </section>
  );
}
