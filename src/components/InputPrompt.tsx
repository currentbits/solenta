import { useId, useState } from "react";
import type { InputValues, PendingPermissionInfo, PermissionDecision } from "../shared/ipc";
import styles from "./ThreadView.module.css";

export function InputPrompt({ pending, onRespond }: {
  pending: PendingPermissionInfo;
  onRespond: (decision: PermissionDecision, values?: InputValues) => void | Promise<void>;
}) {
  const request = pending.inputRequest!;
  const id = useId();
  const [values, setValues] = useState<InputValues>(() => Object.fromEntries(
    request.fields.filter((f) => f.default !== undefined && !f.secret).map((f) => [f.name, f.default!]),
  ));
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  function set(name: string, value: InputValues[string] | undefined) {
    setValues((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });
  }
  async function respond(decision: PermissionDecision) {
    if (sent) return;
    setSent(true);
    setError("");
    try { await onRespond(decision, decision === "allow" ? values : undefined); }
    catch (err) {
      setSent(false);
      setError(err instanceof Error ? err.message : "Could not send response");
    }
  }
  return <form className={styles.permissionCard} aria-labelledby={`${id}-title`} data-input-prompt=""
    onSubmit={(event) => { event.preventDefault(); void respond("allow"); }}>
    <div className={styles.permissionHead} id={`${id}-title`}>{request.message || "Input requested"}</div>
    <p className={styles.questionDesc}>{request.url ? "Requested by" : "Your answers will be sent to"} <strong>{request.source}</strong>.</p>
    {pending.guardrail && <p className={styles.permissionGuardrail}>{pending.guardrail.reason}</p>}
    {request.fields.map((field, i) => {
      const fieldId = `${id}-${i}`;
      const value = values[field.name];
      const attrs = { id: fieldId, name: field.name, disabled: sent,
        required: field.required && value === undefined,
        "aria-describedby": field.description ? `${fieldId}-description` : undefined,
        className: styles.questionOther };
      return <div className={styles.questionBlock} key={field.name}>
        <label htmlFor={fieldId}>{field.title}{field.required ? " *" : " (optional)"}</label>
        {field.description && <div id={`${fieldId}-description`} className={styles.questionDesc}>{field.description}</div>}
        {field.type === "boolean" ? <select {...attrs} value={value === undefined ? "" : String(value)}
          onChange={(e) => set(field.name, e.target.value === "" ? undefined : e.target.value === "true")}>
          <option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option>
        </select> : field.type === "array" ? <select {...attrs} multiple value={Array.isArray(value) ? value : []}
          onChange={(e) => set(field.name, Array.from(e.target.selectedOptions, (o) => o.value))}>
          {field.options?.map((o, oi) => <option key={oi} value={o.value}>{o.label}</option>)}
        </select> : field.options && !field.custom && !field.secret ? <select {...attrs}
          value={value === undefined ? "" : String(field.options.findIndex((o) => o.value === value))}
          onChange={(e) => set(field.name, e.target.value === "" ? undefined : field.options![Number(e.target.value)].value)}>
          <option value="">Choose…</option>
          {field.options.map((o, oi) => <option key={oi} value={oi}>{o.label}{o.description ? `: ${o.description}` : ""}</option>)}
        </select> : <>
          <input {...attrs} value={value === undefined ? "" : String(value)}
            type={field.secret ? "password" : field.type === "integer" || field.type === "number" ? "number"
              : field.format === "email" ? "email" : field.format === "date" ? "date" : "text"}
            autoComplete="off" spellCheck={!field.secret} list={field.options && !field.secret ? `${fieldId}-options` : undefined}
            min={field.minimum} max={field.maximum} step={field.type === "number" ? "any" : undefined}
            minLength={field.minLength} maxLength={field.maxLength}
            placeholder={field.format === "date-time" ? "2026-01-01T12:00:00Z" : undefined}
            onChange={(e) => set(field.name, field.type === "number" || field.type === "integer"
              ? e.target.value === "" ? undefined : e.target.valueAsNumber
              : e.target.value === "" && !field.required ? undefined : e.target.value)} />
          {field.options && !field.secret && <datalist id={`${fieldId}-options`}>
            {field.options.map((o, oi) => <option key={oi} value={o.value}>{o.description || o.label}</option>)}
          </datalist>}
        </>}
      </div>;
    })}
    {request.url && <p className={styles.inputUrl}>{request.url}</p>}
    {error && <p role="alert">{error}</p>}
    <div className={styles.permissionActions}>
      {request.url ? <a href={request.url} target="_blank" rel="noopener noreferrer" className={styles.permissionAllow}
        aria-disabled={sent} onClick={(event) => { if (sent) event.preventDefault(); else void respond("allow"); }}>
        Open {new URL(request.url).host}
      </a> : <button type="submit" className={styles.permissionAllow} disabled={sent}>Send answers</button>}
      <button type="button" className={styles.permissionDeny} disabled={sent} onClick={() => void respond("deny")}>Decline</button>
      <button type="button" className={styles.permissionDeny} disabled={sent} onClick={() => void respond("cancel")}>Cancel</button>
    </div>
  </form>;
}
