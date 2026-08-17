import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  McpServerInfo,
  SkillInfo,
  SkillTarget,
  SkillWrite,
} from "../shared/ipc";
import styles from "./SkillsTab.module.css";

const MCP_NAME_RE = /^[a-z0-9-]+$/;

/** App-owned servers, registered by the main process; never editable here. */
const BUILTIN_MCPS = [
  { name: "coder-memory", blurb: "Shared memory across agents" },
  { name: "coder-threads", blurb: "Thread orchestration tools" },
] as const;

const RESERVED_MCP_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_MCPS.map((s) => s.name),
);

const TARGET_LABEL: Record<SkillTarget, string> = {
  claude: "Claude",
  agents: "Agents",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
  kimi: "Kimi",
};

export interface SkillsTabProps {
  /** Selected project's checkout path; project skills are read-only. */
  projectPath: string | null;
  settings: AppSettings | null;
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  listSkills: (input?: { projectPath?: string }) => Promise<SkillInfo[]>;
  addSkill: (
    input: SkillWrite,
  ) => Promise<{ name: string; installedIn: SkillTarget[] }>;
  removeSkill: (input: { name: string }) => Promise<void>;
  syncSkills: () => Promise<{ copied: number; skills: string[] }>;
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error && err.message ? err.message : String(err);
  // Electron wraps invoke rejections; strip the transport noise.
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** SKILL.md bytes → a compact "~1.2k tokens" estimate (≈ 4 bytes/token). */
export function formatSkillTokens(bytes: number): string {
  const tokens = bytes / 4;
  if (tokens >= 1000) {
    const k = tokens / 1000;
    const text = k >= 10 ? k.toFixed(0) : k.toFixed(1);
    return `~${text}k tokens`;
  }
  const n = Math.round(tokens);
  return `~${n} token${n === 1 ? "" : "s"}`;
}

function formatTargetList(targets: SkillTarget[]): string {
  return targets.map((t) => TARGET_LABEL[t]).join(", ");
}

function coverageTitle(skill: SkillInfo): string {
  const installed = formatTargetList(skill.installedIn) || "none";
  if (skill.missingFrom.length === 0) {
    return `Installed in ${installed}`;
  }
  return `Installed in ${installed}. Missing from ${formatTargetList(skill.missingFrom)}`;
}

function coverageLabel(skill: SkillInfo): string {
  const total = skill.installedIn.length + skill.missingFrom.length;
  return `${skill.installedIn.length}/${total}`;
}

function copiedMessage(copied: number): string {
  return copied === 1 ? "Copied 1 skill" : `Copied ${copied} skills`;
}

export function SkillsTab({
  projectPath,
  settings,
  saveSettings,
  listSkills,
  addSkill,
  removeSkill,
  syncSkills,
}: SkillsTabProps) {
  const mcpServers = settings?.mcpServers ?? [];

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpToken, setMcpToken] = useState("");

  const [skillBusy, setSkillBusy] = useState(false);
  const [skillFormError, setSkillFormError] = useState<string | null>(null);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  /** Inline remove confirm: row key of the skill asking. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reloadSkills = useCallback(async () => {
    setSkillsLoading(true);
    try {
      const list = await listSkills(
        projectPath ? { projectPath } : undefined,
      );
      if (!mountedRef.current) return;
      setSkills(list);
      setSkillsError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setSkills([]);
      setSkillsError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSkillsLoading(false);
    }
  }, [listSkills, projectPath]);

  useEffect(() => {
    void reloadSkills();
  }, [reloadSkills]);

  const saveMcpServers = async (next: McpServerInfo[]) => {
    setMcpBusy(true);
    setMcpError(null);
    try {
      await saveSettings({ mcpServers: next });
    } catch (err) {
      if (mountedRef.current) setMcpError(errorMessage(err));
    } finally {
      if (mountedRef.current) setMcpBusy(false);
    }
  };

  const handleAddMcp = async () => {
    setMcpError(null);
    const name = mcpName.trim();
    const url = mcpUrl.trim();
    const token = mcpToken.trim();
    if (!MCP_NAME_RE.test(name)) {
      setMcpError("Name must be lowercase letters, digits, dashes");
      return;
    }
    if (RESERVED_MCP_NAMES.has(name)) {
      setMcpError(`"${name}" is a built-in server name`);
      return;
    }
    if (mcpServers.some((s) => s.name === name)) {
      setMcpError(`A server named "${name}" already exists`);
      return;
    }
    if (!isHttpUrl(url)) {
      setMcpError("URL must start with http:// or https://");
      return;
    }
    const entry: McpServerInfo = { name, url, enabled: true };
    if (token) entry.token = token;
    await saveMcpServers([...mcpServers, entry]);
    if (!mountedRef.current) return;
    setMcpName("");
    setMcpUrl("");
    setMcpToken("");
  };

  const handleToggleMcp = async (name: string, enabled: boolean) => {
    await saveMcpServers(
      mcpServers.map((s) => (s.name === name ? { ...s, enabled } : s)),
    );
  };

  const handleRemoveMcp = async (name: string) => {
    await saveMcpServers(mcpServers.filter((s) => s.name !== name));
  };

  const handleAddSkill = async () => {
    setSkillFormError(null);
    const name = skillName.trim();
    const description = skillDescription.trim();
    const body = skillBody.trim();
    if (!MCP_NAME_RE.test(name)) {
      setSkillFormError("Name must be lowercase letters, digits, dashes");
      return;
    }
    if (!description) {
      setSkillFormError("Description is required");
      return;
    }
    if (!body) {
      setSkillFormError("Body is required");
      return;
    }
    setSkillBusy(true);
    try {
      await addSkill({ name, description, body });
      if (!mountedRef.current) return;
      setSkillName("");
      setSkillDescription("");
      setSkillBody("");
      setSyncMessage(null);
      await reloadSkills();
    } catch (err) {
      if (mountedRef.current) setSkillFormError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSkillBusy(false);
    }
  };

  const handleRemoveSkill = async (skill: SkillInfo) => {
    if (skill.source === "project") return;
    setSkillBusy(true);
    try {
      await removeSkill({ name: skill.name });
      if (!mountedRef.current) return;
      setConfirmRemove(null);
      setSyncMessage(null);
      await reloadSkills();
    } catch (err) {
      if (mountedRef.current) setSkillsError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSkillBusy(false);
    }
  };

  const handleSync = async () => {
    setSkillsError(null);
    setSyncMessage(null);
    setSkillBusy(true);
    try {
      const result = await syncSkills();
      if (!mountedRef.current) return;
      await reloadSkills();
      if (!mountedRef.current) return;
      setSyncMessage(copiedMessage(result.copied));
    } catch (err) {
      if (mountedRef.current) setSkillsError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSkillBusy(false);
    }
  };

  const hasDrift = skills.some((s) => s.missingFrom.length > 0);

  return (
    <div className={styles.root}>
      <div className={styles.scroll}>
        <section className={styles.section} aria-label="MCP servers">
          <div className={styles.sectionLabel}>MCP servers</div>
          <ul className={styles.list}>
            {BUILTIN_MCPS.map((s) => (
              <li key={s.name} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>{s.name}</span>
                  <span className={styles.rowDetail}>{s.blurb}</span>
                </div>
                <span className={`${styles.badge} ${styles.badgeBuiltin}`}>
                  Built-in
                </span>
              </li>
            ))}
            {mcpServers.map((s) => (
              <li key={s.name} className={styles.row} data-mcp={s.name}>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>{s.name}</span>
                  <span className={styles.rowDetail} title={s.url}>
                    {s.url}
                  </span>
                </div>
                <label
                  className={styles.toggle}
                  title={s.enabled ? "Disable server" : "Enable server"}
                >
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={mcpBusy}
                    aria-label={`Enable ${s.name}`}
                    onChange={(e) =>
                      void handleToggleMcp(s.name, e.target.checked)
                    }
                  />
                </label>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  disabled={mcpBusy}
                  onClick={() => void handleRemoveMcp(s.name)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void handleAddMcp();
            }}
          >
            <div className={styles.formLabel}>Add MCP server</div>
            <div className={styles.formRow}>
              <input
                type="text"
                className={styles.input}
                placeholder="Name"
                value={mcpName}
                onChange={(e) => setMcpName(e.target.value)}
                aria-label="MCP server name"
              />
              <input
                type="text"
                className={styles.input}
                placeholder="https://example.com/mcp"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
                aria-label="MCP server URL"
              />
            </div>
            <input
              type="text"
              className={styles.input}
              placeholder="Bearer token (optional)"
              value={mcpToken}
              onChange={(e) => setMcpToken(e.target.value)}
              aria-label="MCP bearer token"
            />
            {mcpError && (
              <p className={styles.formError} role="alert">
                {mcpError}
              </p>
            )}
            <button
              type="submit"
              className={styles.primaryBtn}
              disabled={mcpBusy}
            >
              {mcpBusy ? "Saving…" : "Add server"}
            </button>
          </form>
        </section>

        <section className={styles.section} aria-label="Skills">
          <div className={styles.sectionHead}>
            <div className={styles.sectionLabel}>Skills</div>
            <button
              type="button"
              className={styles.ghostBtn}
              disabled={skillBusy || !hasDrift}
              aria-label="Sync missing skills"
              title={
                hasDrift
                  ? "Copy missing skills into every provider"
                  : "Nothing to sync"
              }
              onClick={() => void handleSync()}
            >
              Sync
            </button>
          </div>
          {syncMessage && <p className={styles.syncNote}>{syncMessage}</p>}
          {skillsError && (
            <p className={styles.formError} role="alert">
              {skillsError}
            </p>
          )}
          {skillsLoading && skills.length === 0 ? (
            <p className={styles.empty}>Loading…</p>
          ) : skills.length === 0 && !skillsError ? (
            <p className={styles.empty}>No skills found</p>
          ) : (
            <ul className={styles.list}>
              {skills.map((skill) => {
                const key = `${skill.source}:${skill.name}`;
                const removable = skill.source !== "project";
                const drifted = skill.missingFrom.length > 0;
                return (
                  <li key={key} className={styles.row} data-skill={key}>
                    <div className={styles.rowMain}>
                      <span className={styles.rowName}>{skill.name}</span>
                      {skill.description && (
                        <span className={styles.rowDetail}>
                          {skill.description}
                        </span>
                      )}
                    </div>
                    {removable ? (
                      <span
                        className={styles.coverage}
                        title={coverageTitle(skill)}
                        data-coverage
                      >
                        {coverageLabel(skill)}
                      </span>
                    ) : (
                      <span
                        className={`${styles.badge} ${styles.badgeProject}`}
                      >
                        Project
                      </span>
                    )}
                    <span className={styles.tokens} data-tokens>
                      {formatSkillTokens(skill.bytes)}
                    </span>
                    {drifted && (
                      <span className={styles.drift} data-drift>
                        Drift
                      </span>
                    )}
                    {removable &&
                      (confirmRemove === key ? (
                        <>
                          <span className={styles.confirmHint}>
                            Removes from all providers
                          </span>
                          <button
                            type="button"
                            className={styles.dangerBtn}
                            disabled={skillBusy}
                            onClick={() => void handleRemoveSkill(skill)}
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            className={styles.ghostBtn}
                            disabled={skillBusy}
                            onClick={() => setConfirmRemove(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={styles.ghostBtn}
                          disabled={skillBusy}
                          onClick={() => setConfirmRemove(key)}
                        >
                          Remove
                        </button>
                      ))}
                  </li>
                );
              })}
            </ul>
          )}

          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void handleAddSkill();
            }}
          >
            <div className={styles.formLabel}>Add skill</div>
            <input
              type="text"
              className={styles.input}
              placeholder="Name"
              value={skillName}
              onChange={(e) => setSkillName(e.target.value)}
              aria-label="Skill name"
            />
            <input
              type="text"
              className={styles.input}
              placeholder="One-line description"
              value={skillDescription}
              onChange={(e) => setSkillDescription(e.target.value)}
              aria-label="Skill description"
            />
            <textarea
              className={styles.textarea}
              placeholder="Skill instructions (Markdown)"
              value={skillBody}
              onChange={(e) => setSkillBody(e.target.value)}
              rows={4}
              aria-label="Skill body"
            />
            {skillFormError && (
              <p className={styles.formError} role="alert">
                {skillFormError}
              </p>
            )}
            <button
              type="submit"
              className={styles.primaryBtn}
              disabled={skillBusy}
            >
              {skillBusy ? "Saving…" : "Add skill"}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
