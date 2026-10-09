import { useState } from "react";
import type { AppSettings, ModelPrice } from "../../shared/ipc";
import styles from "../SettingsModal.module.css";

type Row = {
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
};

const PRICE_FIELDS = [
  { key: "input", label: "Input", required: true },
  { key: "output", label: "Output", required: true },
  { key: "cacheRead", label: "Cache read", required: false },
  { key: "cacheWrite", label: "Cache write", required: false },
] as const;

function toRows(prices: Record<string, ModelPrice> | undefined): Row[] {
  return Object.entries(prices ?? {}).map(([model, p]) => ({
    model,
    input: String(p.input),
    output: String(p.output),
    cacheRead: p.cacheRead == null ? "" : String(p.cacheRead),
    cacheWrite: p.cacheWrite == null ? "" : String(p.cacheWrite),
  }));
}

/** Rows → the settings map, or the first problem a user can fix. */
export function parseModelPriceRows(
  rows: readonly Row[],
): { prices: Record<string, ModelPrice> } | { error: string } {
  const prices: Record<string, ModelPrice> = {};
  for (const row of rows) {
    const model = row.model.trim();
    if (!model) return { error: "Each price needs a model id" };
    if (prices[model]) return { error: `${model} is listed twice` };
    const price: Partial<Record<keyof ModelPrice, number>> = {};
    for (const field of PRICE_FIELDS) {
      const text = row[field.key].trim();
      if (text === "") {
        if (field.required) return { error: `${model}: ${field.label} price is required` };
        continue;
      }
      const n = Number(text);
      if (!Number.isFinite(n) || n < 0) {
        return { error: `${model}: ${field.label} price must be a non-negative number` };
      }
      price[field.key] = n;
    }
    prices[model] = price as ModelPrice;
  }
  return { prices };
}

export function ModelPricesEditor({
  settings,
  onSaveSettings,
}: {
  settings: AppSettings | null;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(settings?.modelPrices));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const edit = (i: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((row, j) => (j === i ? { ...row, ...patch } : row)));
    setError(null);
  };

  const save = async () => {
    const parsed = parseModelPriceRows(rows);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    try {
      const saved = await onSaveSettings({ modelPrices: parsed.prices });
      setRows(toRows(saved.modelPrices ?? parsed.prices));
      setError(null);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to save prices");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.field} data-model-prices="">
      <span className={styles.fieldLabel}>Model prices (USD per million tokens)</span>
      {rows.map((row, i) => (
        <div key={i} className={styles.fieldRow} data-model-price-row={i}>
          <input
            className={styles.input}
            aria-label="Model id"
            placeholder="model id, e.g. gpt-5.4"
            value={row.model}
            disabled={saving}
            style={{ flex: 2 }}
            data-model-price-field="model"
            onChange={(e) => edit(i, { model: e.target.value })}
          />
          {PRICE_FIELDS.map((field) => (
            <input
              key={field.key}
              className={styles.input}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              aria-label={`${field.label} price for ${row.model || "model"}`}
              placeholder={field.required ? field.label : `${field.label} (= input)`}
              value={row[field.key]}
              disabled={saving}
              data-model-price-field={field.key}
              onChange={(e) => edit(i, { [field.key]: e.target.value })}
            />
          ))}
          <button
            type="button"
            className={styles.btn}
            aria-label={`Clear price for ${row.model || "model"}`}
            title="Clear this override"
            disabled={saving}
            data-model-price-remove=""
            onClick={() => {
              setRows((prev) => prev.filter((_, j) => j !== i));
              setError(null);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <div className={styles.fieldRow}>
        <button
          type="button"
          className={styles.btn}
          disabled={saving}
          data-model-price-add=""
          onClick={() =>
            setRows((prev) => [
              ...prev,
              { model: "", input: "", output: "", cacheRead: "", cacheWrite: "" },
            ])
          }
        >
          Add model
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          data-model-price-save=""
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save prices"}
        </button>
      </div>
      {error ? (
        <p className={styles.note} role="alert" data-model-price-error="">
          {error}
        </p>
      ) : null}
      <p className={styles.note}>
        Prices usage that a provider reports in tokens but not in dollars
        (shown as unmetered on Usage), matched by exact model id. A
        provider's own cost, such as Claude's, is never replaced. Blank
        cache prices bill at the input price. Affects the Usage report
        only, not the budget caps above.
      </p>
    </div>
  );
}
