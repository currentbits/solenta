import { useId, useState } from "react";
import type { CoderApi, McpProposal } from "../shared/ipc";
import styles from "./SkillsTab.module.css";

export function McpProposalCard({ threadId, proposal, onResolve }: {
  threadId: string;
  proposal: McpProposal;
  onResolve?: CoderApi["mcp"]["resolveProposal"];
}) {
  const detailsId = useId();
  const [reviewToken, setReviewToken] = useState<string | null>(null);
  const reviewing = reviewToken === proposal.reviewToken;
  const [trusted, setTrusted] = useState(false);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<McpProposal | null>(null);
  const status = resolved?.status ?? proposal.status;
  const config = proposal.config;
  const adding = proposal.action === "add";
  const local = adding && config.transport === "stdio";
  const fields = adding ? [
    ...(config.envNames ?? []).map((name) => ({ key: `env:${name}`, label: `Environment ${name}` })),
    ...(config.headerNames ?? []).map((name) => ({ key: `header:${name}`, label: `Header ${name}` })),
  ] : [];
  const canApprove = (!local || trusted) && fields.every((field) => secrets[field.key]);

  const resolve = async (resolution: "approved" | "dismissed") => {
    if (!onResolve || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await onResolve({ threadId, proposalId: proposal.id, resolution,
        ...(resolution === "approved" ? { reviewToken: reviewToken ?? undefined, trustLocal: trusted, secrets } : {}) });
      setResolved(result); setSecrets({}); setReviewToken(null);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").slice(0, 500) : "Could not resolve connector proposal");
    } finally { setBusy(false); }
  };

  return (
    <section className={styles.preview} aria-label={`${config.name} MCP proposal`}>
      <div className={styles.previewSource}>
        <strong className={styles.rowName}>{adding ? "Add" : "Remove"} {config.name}</strong>
        <span className={styles.kind}>MCP proposal</span>
      </div>
      {status === "pending" ? <>
        <p className={styles.rowDetail}>No changes yet. Review this connection before approving it.</p>
        <button type="button" className={styles.ghostBtn} aria-expanded={reviewing} aria-controls={detailsId}
          disabled={busy} onClick={() => { setReviewToken(reviewing ? null : proposal.reviewToken); setSecrets({}); setTrusted(false); }}>
          {reviewing ? "Hide connection details" : "Review connection"}
        </button>
        {reviewing ? <div id={detailsId} className={styles.manualForm}>
          <p className={styles.rowDetail}>This changes connectors for new agent sessions on this computer, in all projects.</p>
          {adding ? <>
            <div className={styles.rowDetail}>Transport: {config.transport}</div>
            {local ? <>
              <div className={styles.formLabel}>Command</div>
              <pre className={styles.instructionCode}>{config.command}</pre>
              <div className={styles.formLabel}>Arguments (one JSON array)</div>
              <pre className={styles.instructionCode}>{JSON.stringify(config.args ?? [], null, 2)}</pre>
              <div className={styles.rowDetail}>Working directory: {config.cwd ?? "Provider default"}</div>
            </> : <pre className={styles.instructionCode}>{config.url}</pre>}
            {fields.length ? <p className={styles.rowDetail}>Enter credentials here; values stay out of the chat. For headers, enter the complete value, including Bearer when required.</p> : null}
            {fields.map((field) => <label key={field.key} className={styles.formLabel}>
              {field.label}
              <input type="password" className={styles.searchInput} autoComplete="off" value={secrets[field.key] ?? ""}
                disabled={busy || !onResolve} onChange={(event) => setSecrets({ ...secrets, [field.key]: event.target.value })} />
            </label>)}
            {local ? <label className={styles.checkLabel}>
              <input type="checkbox" checked={trusted} disabled={busy || !onResolve} onChange={(event) => setTrusted(event.target.checked)} />
              I reviewed and trust this local command
            </label> : null}
          </> : <p className={styles.rowDetail}>Remove {config.name} from the connector registry. Existing agent sessions may retain its tools until restarted.</p>}
          <button type="button" className={styles.primaryBtn} disabled={busy || !onResolve || !canApprove} onClick={() => void resolve("approved")}>
            {busy ? "Applying…" : adding ? "Approve connector" : "Remove connector"}
          </button>
        </div> : null}
        {!onResolve ? <p className={styles.rowDetail}>Open this chat in the desktop app on the owning computer to approve or dismiss.</p> : null}
        <button type="button" className={styles.ghostBtn} disabled={busy || !onResolve} onClick={() => void resolve("dismissed")}>Dismiss proposal</button>
      </> : <p className={styles.rowDetail} role="status">
        {status === "approved" ? adding ? "Connector approved · available in new agent sessions" : "Connector removed" : status === "dismissed" ? "Proposal dismissed" : "Proposal expired or configuration changed. Request a fresh proposal."}
      </p>}
      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
    </section>
  );
}
