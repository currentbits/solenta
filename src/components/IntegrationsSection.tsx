import { useCallback, useEffect, useState } from "react";
import { resolveCoderApi } from "../coderApi";
import type {
  CoderApi,
  PairingCapability,
  PairingCreated,
  PairingInfo,
  PairingList,
  ProjectInfo,
} from "../shared/ipc";
import styles from "./SettingsModal.module.css";

export interface IntegrationsSectionProps {
  active: boolean;
  projects?: ProjectInfo[];
}

const TTL_OPTIONS: { label: string; ttlMs: number | null }[] = [
  { label: "7 days", ttlMs: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", ttlMs: 30 * 24 * 60 * 60 * 1000 },
  { label: "90 days", ttlMs: 90 * 24 * 60 * 60 * 1000 },
  { label: "No expiry", ttlMs: 0 },
];

function resolveApi(): CoderApi | null {
  try {
    const existing = (window as unknown as { coder?: CoderApi }).coder;
    if (existing && typeof existing.pairing?.list === "function") {
      return existing;
    }
    const api = resolveCoderApi();
    return typeof api.pairing?.list === "function" ? api : null;
  } catch {
    return null;
  }
}

function capLabel(cap: PairingCapability): string {
  if (cap === "launch") return "launch";
  if (cap === "steer") return "steer";
  if (cap === "read_all") return "read all tasks";
  return "read";
}

function scopeLabel(p: PairingInfo, projects: ProjectInfo[]): string {
  if (!p.projectIds) return "All projects";
  const names = p.projectIds.map((id) => {
    const hit = projects.find((proj) => proj.id === id);
    return hit?.name || id.slice(0, 8);
  });
  return names.join(", ");
}

function expiryLabel(p: PairingInfo): string {
  if (p.revokedAt) return "Revoked";
  if (p.expired) return "Expired";
  if (p.expiresAt == null) return "No expiry";
  const ms = p.expiresAt - Date.now();
  if (ms <= 0) return "Expired";
  const days = Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
  return days === 1 ? "1 day left" : `${days} days left`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function IntegrationsSection({
  active,
  projects = [],
}: IntegrationsSectionProps) {
  const [list, setList] = useState<PairingList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("Claude Desktop");
  const [allProjects, setAllProjects] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [steer, setSteer] = useState(false);
  const [readAll, setReadAll] = useState(false);
  const [ttlMs, setTtlMs] = useState<number | null>(TTL_OPTIONS[1].ttlMs);
  const [requireApproval, setRequireApproval] = useState(true);
  const [managedWorktree, setManagedWorktree] = useState(true);
  const [created, setCreated] = useState<PairingCreated | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = resolveApi();
    if (!api) {
      setList(null);
      return;
    }
    setError(null);
    try {
      setList(await api.pairing.list());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const flashCopied = (key: string) => {
    setCopied(key);
    window.setTimeout(() => {
      setCopied((cur) => (cur === key ? null : cur));
    }, 1200);
  };

  const onCreate = async () => {
    const api = resolveApi();
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const capabilities: PairingCapability[] = ["read", "launch"];
      if (steer) capabilities.push("steer");
      if (readAll) capabilities.push("read_all");
      const result = await api.pairing.create({
        name,
        projectIds: allProjects ? null : selectedIds,
        capabilities,
        ttlMs,
        requireApproval,
        managedWorktree,
      });
      setCreated(result);
      setName("Claude Desktop");
      await load();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (id: string) => {
    const api = resolveApi();
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.pairing.revoke({ id });
      if (created?.pairing.id === id) setCreated(null);
      await load();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const server = list?.server;
  const running = Boolean(server?.running && server.url);

  return (
    <section className={styles.section} data-integrations="">
      <div className={styles.memoryRow}>
        <span
          className={styles.memoryDot}
          data-on={running ? "true" : undefined}
          aria-hidden
        />
        <span>
          {running
            ? `Listening at ${server?.url}`
            : "Solenta is not serving MCP right now. Keep the app open to pair."}
        </span>
      </div>
      <p className={styles.note}>
        Pair Claude Desktop, Claude Code, or another MCP client so it can
        launch and track Solenta tasks. Tokens are scoped, expiring, and
        revocable. New work starts in a managed worktree and waits for your
        approval unless you turn that off.
      </p>

      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}

      {created ? (
        <div className={styles.pairingReveal} data-pairing-reveal="">
          <p className={styles.fieldLabel}>New pairing token</p>
          <p className={styles.note}>
            Copy this now. Solenta will not show the full token again.
          </p>
          <pre className={styles.pairingPre} data-pairing-token="">
            {created.token}
          </pre>
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                void copyText(created.token).then((ok) => {
                  if (ok) flashCopied("token");
                });
              }}
            >
              {copied === "token" ? "Copied" : "Copy token"}
            </button>
            {created.claudeDesktopJson ? (
              <button
                type="button"
                className={styles.btn}
                data-copy-claude-json=""
                onClick={() => {
                  void copyText(created.claudeDesktopJson || "").then((ok) => {
                    if (ok) flashCopied("json");
                  });
                }}
              >
                {copied === "json" ? "Copied" : "Copy Claude Desktop JSON"}
              </button>
            ) : null}
            {created.pairingPrompt ? (
              <button
                type="button"
                className={styles.btn}
                data-copy-pairing-prompt=""
                onClick={() => {
                  void copyText(created.pairingPrompt || "").then((ok) => {
                    if (ok) flashCopied("prompt");
                  });
                }}
              >
                {copied === "prompt" ? "Copied" : "Copy pairing prompt"}
              </button>
            ) : null}
          </div>
          {created.claudeDesktopJson ? (
            <pre className={styles.pairingPre} data-pairing-json="">
              {created.claudeDesktopJson}
            </pre>
          ) : (
            <p className={styles.note}>
              Open Solenta so the MCP server is listening, then create another
              pairing to get copy-ready config.
            </p>
          )}
        </div>
      ) : null}

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="pairing-name">
          New pairing
        </label>
        <input
          id="pairing-name"
          className={styles.input}
          data-pairing-name=""
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          placeholder="Claude Desktop"
        />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldRow}>
          <input
            type="checkbox"
            data-pairing-all-projects=""
            checked={allProjects}
            disabled={busy}
            onChange={(e) => setAllProjects(e.target.checked)}
          />
          <span>All projects</span>
        </label>
        {!allProjects ? (
          <div className={styles.pairingProjectList} data-pairing-projects="">
            {projects.length === 0 ? (
              <p className={styles.note}>Add a project first.</p>
            ) : (
              projects.map((p) => (
                <label key={p.id} className={styles.fieldRow}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(p.id)}
                    disabled={busy}
                    onChange={(e) => {
                      setSelectedIds((cur) =>
                        e.target.checked
                          ? cur.concat(p.id)
                          : cur.filter((id) => id !== p.id),
                      );
                    }}
                  />
                  <span>{p.name}</span>
                </label>
              ))
            )}
          </div>
        ) : null}
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="pairing-ttl">
          Expires
        </label>
        <select
          id="pairing-ttl"
          className={styles.input}
          data-pairing-ttl=""
          value={ttlMs == null ? "0" : String(ttlMs)}
          disabled={busy}
          onChange={(e) => {
            const n = Number(e.target.value);
            setTtlMs(n === 0 ? 0 : n);
          }}
        >
          {TTL_OPTIONS.map((opt) => (
            <option key={opt.label} value={opt.ttlMs == null ? "0" : String(opt.ttlMs)}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-pairing-approval=""
          checked={requireApproval}
          disabled={busy}
          onChange={(e) => setRequireApproval(e.target.checked)}
        />
        <span>Require approval before a launch starts</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-pairing-worktree=""
          checked={managedWorktree}
          disabled={busy}
          onChange={(e) => setManagedWorktree(e.target.checked)}
        />
        <span>Start new work in a managed git worktree</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-pairing-steer=""
          checked={steer}
          disabled={busy}
          onChange={(e) => setSteer(e.target.checked)}
        />
        <span>Allow follow-ups and stop (steer)</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-pairing-read-all=""
          checked={readAll}
          disabled={busy}
          onChange={(e) => setReadAll(e.target.checked)}
        />
        <span>Read every task in the allowed projects</span>
      </label>
      <div className={styles.fieldRow}>
        <button
          type="button"
          className={styles.btnPrimary}
          data-pairing-create=""
          disabled={busy || !name.trim() || (!allProjects && selectedIds.length === 0)}
          onClick={() => void onCreate()}
        >
          Create pairing
        </button>
      </div>

      {(list?.pairings ?? []).length > 0 ? (
        <div className={styles.pairingList} data-pairing-list="">
          {list?.pairings.map((p) => (
            <div key={p.id} className={styles.pairingRow} data-pairing-row={p.id}>
              <div className={styles.pairingRowBody}>
                <p className={styles.pairingName}>{p.name}</p>
                <p className={styles.note}>
                  {p.tokenPrefix}… · {scopeLabel(p, projects)} ·{" "}
                  {p.capabilities.map(capLabel).join(", ")} · {expiryLabel(p)}
                </p>
              </div>
              <button
                type="button"
                className={styles.btn}
                data-pairing-revoke={p.id}
                disabled={busy}
                onClick={() => void onRevoke(p.id)}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.note}>No pairings yet.</p>
      )}
    </section>
  );
}
