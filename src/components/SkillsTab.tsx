import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  McpServerInfo,
  SkillInfo,
  SkillSource,
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

export interface SkillsTabProps {
  /** Selected project's checkout path; project skills are read-only. */
  projectPath: string | null;
  settings: AppSettings | null;
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  listSkills: (input?: { projectPath?: string }) => Promise<SkillInfo[]>;
  addSkill: (input: SkillWrite) => Promise<{ name: string }>;
  removeSkill: (input: {
    target: "claude" | "agents";
    name: string;
  }) => Promise<void>;
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

function sourceBadgeClass(source: SkillSource): string {
  if (source === "claude") return styles.badgeClaude;
  if (source === "agents") return styles.badgeAgents;
  return styles.badgeProject;
}

function sourceLabel(source: SkillSource): string {
  if (source === "claude") return "Claude";
  if (source === "agents") return "Agents";
  return "Project";
}

export function SkillsTab({
  projectPath,
  settings,
  saveSettings,
  listSkills,
  addSkill,
  removeSkill,
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
  const [skillTarget, setSkillTarget] = useState<"claude" | "agents">("claude");
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillBody, setSkillBody] = useState("");
  /** Inline remove confirm: "source:name" of the row asking. */
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
      await addSkill({ target: skillTarget, name, description, body });
      if (!mountedRef.current) return;
      setSkillName("");
      setSkillDescription("");
      setSkillBody("");
      await reloadSkills();
    } catch (err) {
      if (mountedRef.current) setSkillFormError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSkillBusy(false);
    }
  };

  const handleRemoveSkill = async (skill: SkillInfo) => {
    if (skill.source !== "claude" && skill.source !== "agents") return;
    setSkillBusy(true);
    try {
      await removeSkill({ target: skill.source, name: skill.name });
      if (!mountedRef.current) return;
      setConfirmRemove(null);
      await reloadSkills();
    } catch (err) {
      if (mountedRef.current) setSkillsError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSkillBusy(false);
    }
  };

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
          <div className={styles.sectionLabel}>Skills</div>
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
                const removable =
                  skill.source === "claude" || skill.source === "agents";
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
                    <span
                      className={`${styles.badge} ${sourceBadgeClass(skill.source)}`}
                    >
                      {sourceLabel(skill.source)}
                    </span>
                    {removable &&
                      (confirmRemove === key ? (
                        <>
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
            <div className={styles.formRow}>
              <select
                className={styles.select}
                value={skillTarget}
                onChange={(e) =>
                  setSkillTarget(e.target.value as "claude" | "agents")
                }
                aria-label="Skill target"
              >
                <option value="claude">Claude</option>
                <option value="agents">Agents</option>
              </select>
              <input
                type="text"
                className={styles.input}
                placeholder="Name"
                value={skillName}
                onChange={(e) => setSkillName(e.target.value)}
                aria-label="Skill name"
              />
            </div>
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
