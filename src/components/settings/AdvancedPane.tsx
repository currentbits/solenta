import type { RefObject } from "react";
import type { AppSettings, OtelSettings } from "../../shared/ipc";
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

      <VibeKanbanSection active />
    </>
  );
}
