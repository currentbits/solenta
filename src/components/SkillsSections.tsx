import type {
  McpCatalogEntry,
  McpImportPreview,
  McpPreviewServer,
  McpServerDefinition,
  SkillCatalogEntry,
  SkillImportPreview,
  SkillInstallResult,
  SkillInfo,
  SkillPluginExtra,
  SkillTarget,
} from "../shared/ipc";
import styles from "./SkillsTab.module.css";

const TARGET_LABEL: Record<SkillTarget, string> = {
  claude: "Claude",
  agents: "Agents",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
  kimi: "Kimi",
  cursor: "Cursor",
  muse: "Muse Code",
};

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

export function coverageTitle(skill: SkillInfo): string {
  const installed = formatTargetList(skill.installedIn) || "none";
  if (skill.missingFrom.length === 0) {
    return `Installed in ${installed}`;
  }
  return `Installed in ${installed}. Missing from ${formatTargetList(skill.missingFrom)}`;
}

export function coverageLabel(skill: SkillInfo): string {
  const total = skill.installedIn.length + skill.missingFrom.length;
  return `${skill.installedIn.length}/${total}`;
}

export function matchCatalogSkill(
  entry: SkillCatalogEntry,
  skills: SkillInfo[],
): SkillInfo | undefined {
  return (
    skills.find((s) => s.origin?.catalogId === entry.id) ??
    skills.find((s) => s.provenance === "curated" && s.name === entry.name)
  );
}

export function fallbackCatalogEntries(skills: SkillInfo[]): SkillCatalogEntry[] {
  const seen = new Set<string>();
  const rows: SkillCatalogEntry[] = [];
  for (const skill of skills) {
    if (skill.provenance !== "curated") continue;
    const id = skill.origin?.catalogId || skill.name;
    if (seen.has(id)) continue;
    seen.add(id);
    const sourceUrl = skill.origin?.sourceUrl || "";
    rows.push({
      id,
      name: skill.origin?.sourceLabel || skill.name,
      description: skill.description,
      publisher: "",
      sourceUrl,
      homepage: sourceUrl,
      installed: true,
    });
  }
  return rows;
}

function fileCount(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

function groupPlugins(
  plugins: SkillPluginExtra[],
): Array<[string, SkillPluginExtra[]]> {
  const groups = new Map<string, SkillPluginExtra[]>();
  for (const extra of plugins) {
    const list = groups.get(extra.provider) ?? [];
    list.push(extra);
    groups.set(extra.provider, list);
  }
  return [...groups.entries()];
}

export function CoverageMeter({ skill }: { skill: SkillInfo }) {
  const title = coverageTitle(skill);
  return (
    <span
      className={styles.coverage}
      title={title}
      aria-label={title}
      data-coverage
    >
      {coverageLabel(skill)}
    </span>
  );
}

export function CuratedSkillsSection({
  catalog,
  loading,
  error,
  skills,
  busy,
  onInstall,
}: {
  catalog: SkillCatalogEntry[];
  loading: boolean;
  error: string | null;
  skills: SkillInfo[];
  busy: boolean;
  onInstall: (id: string) => void;
}) {
  const rows =
    catalog.length > 0
      ? catalog
      : loading
        ? []
        : fallbackCatalogEntries(skills);
  return (
    <section
      className={styles.subSection}
      aria-label="Curated skills"
      data-skill-section="curated"
    >
      <div className={styles.sectionHead}>
        <div className={styles.sectionLabel}>
          Curated skills
          <span className={styles.sectionCount}>{rows.length}</span>
        </div>
      </div>
      {error && (
        <p className={styles.formError} role="alert">
          {catalog.length === 0 ? "Catalog unavailable" : error}
        </p>
      )}
      {loading && rows.length === 0 ? (
        <p className={styles.empty}>Loading…</p>
      ) : rows.length === 0 && !error ? (
        <p className={styles.empty}>No curated skills</p>
      ) : rows.length === 0 ? null : (
        <ul className={styles.list}>
          {rows.map((entry) => {
            const matched = matchCatalogSkill(entry, skills);
            const installed =
              entry.installed || matched?.provenance === "curated";
            return (
              <li
                key={entry.id}
                className={styles.row}
                data-catalog={entry.id}
              >
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>{entry.name}</span>
                  {entry.publisher && (
                    <span className={styles.rowDetail}>{entry.publisher}</span>
                  )}
                  {entry.description && (
                    <span className={styles.rowDetail}>{entry.description}</span>
                  )}
                  {(entry.sourceUrl ||
                    (entry.homepage && entry.homepage !== entry.sourceUrl)) && (
                    <span className={styles.linkRow}>
                      {entry.sourceUrl && (
                        <a
                          className={styles.sourceLink}
                          href={entry.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Source for ${entry.name}`}
                        >
                          Source
                        </a>
                      )}
                      {entry.homepage && entry.homepage !== entry.sourceUrl && (
                        <a
                          className={styles.sourceLink}
                          href={entry.homepage}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Homepage for ${entry.name}`}
                        >
                          Homepage
                        </a>
                      )}
                    </span>
                  )}
                </div>
                <div className={styles.rowSide}>
                  {installed ? (
                    <>
                      <span className={`${styles.badge} ${styles.badgeBuiltin}`}>
                        Installed
                      </span>
                      {matched && <CoverageMeter skill={matched} />}
                      {matched && (
                        <span className={styles.tokens} data-tokens>
                          {formatSkillTokens(matched.bytes)}
                        </span>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      disabled={busy}
                      aria-label={`Install ${entry.name}`}
                      onClick={() => onInstall(entry.id)}
                    >
                      Install
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function AddedSkillsSection({
  skills,
  loading,
  error,
  busy,
  hasDrift,
  confirmRemove,
  onSync,
  onAskRemove,
  onConfirmRemove,
  onCancelRemove,
}: {
  skills: SkillInfo[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  hasDrift: boolean;
  confirmRemove: string | null;
  onSync: () => void;
  onAskRemove: (key: string) => void;
  onConfirmRemove: (skill: SkillInfo) => void;
  onCancelRemove: () => void;
}) {
  return (
    <section
      className={styles.subSection}
      aria-label="Added skills"
      data-skill-section="added"
    >
      <div className={styles.sectionHead}>
        <div className={styles.sectionLabel}>
          Added skills
          <span className={styles.sectionCount}>{skills.length}</span>
        </div>
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={busy || !hasDrift}
          aria-label="Sync missing skills"
          title={
            hasDrift
              ? "Copy missing skills into every provider"
              : "Nothing to sync"
          }
          onClick={() => onSync()}
        >
          Sync
        </button>
      </div>
      {error && (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      )}
      {loading && skills.length === 0 ? (
        <p className={styles.empty}>Loading…</p>
      ) : skills.length === 0 && !error ? (
        <p className={styles.empty}>Use Add skill to import or write one.</p>
      ) : (
        <ul className={styles.list}>
          {skills.map((skill) => {
            const key = `${skill.source}:${skill.name}`;
            const drifted = skill.missingFrom.length > 0;
            const hintId = `skill-remove-${key}`;
            return (
              <li key={key} className={styles.row} data-skill={key}>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>{skill.name}</span>
                  {skill.description && (
                    <span className={styles.rowDetail}>{skill.description}</span>
                  )}
                </div>
                <div className={styles.rowSide}>
                  <CoverageMeter skill={skill} />
                  <span className={styles.tokens} data-tokens>
                    {formatSkillTokens(skill.bytes)}
                  </span>
                  {drifted && (
                    <span className={styles.drift} data-drift>
                      Drift
                    </span>
                  )}
                  {confirmRemove === key ? (
                    <>
                      <span id={hintId} className={styles.confirmHint}>
                        Removes from all providers
                      </span>
                      <button
                        type="button"
                        className={styles.dangerBtn}
                        disabled={busy}
                        aria-describedby={hintId}
                        onClick={() => onConfirmRemove(skill)}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        className={styles.ghostBtn}
                        disabled={busy}
                        onClick={() => onCancelRemove()}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      disabled={busy}
                      aria-label={`Remove ${skill.name}`}
                      onClick={() => onAskRemove(key)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ProjectSkillsSection({ skills }: { skills: SkillInfo[] }) {
  if (skills.length === 0) return null;
  return (
    <section
      className={styles.subSection}
      aria-label="Project skills"
      data-skill-section="project"
    >
      <div className={styles.sectionHead}>
        <div className={styles.sectionLabel}>
          Project skills
          <span className={styles.sectionCount}>{skills.length}</span>
        </div>
      </div>
      <ul className={styles.list}>
        {skills.map((skill) => {
          const key = `${skill.source}:${skill.name}`;
          return (
            <li key={key} className={styles.row} data-skill={key}>
              <div className={styles.rowMain}>
                <span className={styles.rowName}>{skill.name}</span>
                {skill.description && (
                  <span className={styles.rowDetail}>{skill.description}</span>
                )}
              </div>
              <div className={styles.rowSide}>
                <span className={`${styles.badge} ${styles.badgeProject}`}>
                  Project
                </span>
                <span className={styles.tokens} data-tokens>
                  {formatSkillTokens(skill.bytes)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function AddSkillSection({
  busy,
  githubUrl,
  skillName,
  skillDescription,
  skillBody,
  formError,
  importError,
  onGithubUrl,
  onImportFile,
  onPreviewGithub,
  onSkillName,
  onSkillDescription,
  onSkillBody,
  onAddSkill,
}: {
  busy: boolean;
  githubUrl: string;
  skillName: string;
  skillDescription: string;
  skillBody: string;
  formError: string | null;
  importError: string | null;
  onGithubUrl: (value: string) => void;
  onImportFile: () => void;
  onPreviewGithub: () => void;
  onSkillName: (value: string) => void;
  onSkillDescription: (value: string) => void;
  onSkillBody: (value: string) => void;
  onAddSkill: () => void;
}) {
  return (
    <section
      className={styles.subSection}
      aria-label="Add skill"
      data-skill-section="add"
    >
      <div className={styles.form}>
        <div className={styles.formLabel}>Add skill</div>
        <div className={styles.addActions}>
          <button
            type="button"
            className={styles.ghostBtn}
            disabled={busy}
            onClick={() => onImportFile()}
          >
            Import file
          </button>
        </div>
        <div className={styles.formRow}>
          <input
            type="text"
            className={styles.input}
            placeholder="https://github.com/owner/repo"
            value={githubUrl}
            onChange={(e) => onGithubUrl(e.target.value)}
            aria-label="GitHub URL"
          />
          <button
            type="button"
            className={styles.ghostBtn}
            disabled={busy}
            onClick={() => onPreviewGithub()}
          >
            Preview
          </button>
        </div>
        {importError && (
          <p className={styles.formError} role="alert">
            {importError}
          </p>
        )}
        <details className={styles.disclosure}>
          <summary>Write manually</summary>
          <form
            className={styles.manualForm}
            onSubmit={(e) => {
              e.preventDefault();
              onAddSkill();
            }}
          >
            <input
              type="text"
              className={styles.input}
              placeholder="Name"
              value={skillName}
              onChange={(e) => onSkillName(e.target.value)}
              aria-label="Skill name"
            />
            <input
              type="text"
              className={styles.input}
              placeholder="One-line description"
              value={skillDescription}
              onChange={(e) => onSkillDescription(e.target.value)}
              aria-label="Skill description"
            />
            <textarea
              className={styles.textarea}
              placeholder="Skill instructions (Markdown)"
              value={skillBody}
              onChange={(e) => onSkillBody(e.target.value)}
              rows={4}
              aria-label="Skill body"
            />
            {formError && (
              <p className={styles.formError} role="alert">
                {formError}
              </p>
            )}
            <button
              type="submit"
              className={styles.primaryBtn}
              disabled={busy}
            >
              {busy ? "Saving…" : "Add skill"}
            </button>
          </form>
        </details>
      </div>
    </section>
  );
}

export function SkillImportPreviewPanel({
  preview,
  selected,
  replace,
  trusted,
  busy,
  error,
  onToggle,
  onReplace,
  onTrust,
  onInstall,
  onCancel,
}: {
  preview: SkillImportPreview;
  selected: ReadonlySet<string>;
  replace: boolean;
  trusted: boolean;
  busy: boolean;
  error: string | null;
  onToggle: (name: string) => void;
  onReplace: (value: boolean) => void;
  onTrust: (value: boolean) => void;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const selectedSkills = preview.skills.filter((s) => selected.has(s.name));
  const hasSelectedCollision = selectedSkills.some((s) => s.collision);
  const selectedWarnings = selectedSkills.flatMap((s) => s.warnings);
  const hasPlugins = preview.plugins.length > 0;
  const needsAck = selectedWarnings.length > 0 || hasPlugins;
  const canInstall =
    selectedSkills.length > 0 &&
    (!hasSelectedCollision || replace) &&
    (!needsAck || trusted);

  return (
    <section
      className={styles.preview}
      aria-label="Skill import preview"
      data-import-preview
    >
      <div className={styles.formLabel}>Skill import preview</div>
      <p className={styles.previewSource}>
        <span className={styles.rowName}>{preview.source.label}</span>
        <span className={styles.kind}>{preview.source.kind}</span>
      </p>
      <ul className={styles.checkList}>
        {preview.skills.map((skill) => (
          <li key={skill.name} className={styles.checkRow}>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={selected.has(skill.name)}
                disabled={busy}
                aria-label={`Select ${skill.name}`}
                onChange={() => onToggle(skill.name)}
              />
              <span className={styles.rowMain}>
                <span className={styles.rowName}>{skill.name}</span>
                {skill.description && (
                  <span className={styles.rowDetail}>{skill.description}</span>
                )}
                <span className={styles.rowDetail}>
                  {fileCount(skill.files.length)}
                  {typeof skill.bytes === "number"
                    ? ` · ${skill.bytes} bytes`
                    : ""}
                </span>
              </span>
            </label>
            {skill.collision && (
              <span className={styles.drift}>Collision</span>
            )}
          </li>
        ))}
      </ul>
      {hasSelectedCollision && (
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={replace}
            disabled={busy}
            aria-label="Replace existing skills"
            onChange={(e) => onReplace(e.target.checked)}
          />
          Replace existing skills
        </label>
      )}
      {selectedWarnings.length > 0 && (
        <ul className={styles.warnList}>
          {selectedSkills.flatMap((skill) =>
            skill.warnings.map((warning, index) => {
              const key = `${skill.name}:${index}:${warning}`;
              return (
                <li key={key} data-warn-key={key} className={styles.pathWrap}>
                  {warning}
                </li>
              );
            }),
          )}
        </ul>
      )}
      {hasPlugins && (
        <div className={styles.pluginBlock}>
          <p className={styles.pluginNote}>
            Recognized provider extras can be activated after explicit trust.
            Unsupported extras remain inactive.
          </p>
          {groupPlugins(preview.plugins).map(([provider, extras]) => (
            <div key={provider} className={styles.pluginGroup}>
              <div className={styles.pluginProvider}>{provider}</div>
              {extras.map((extra) => (
                <div key={`${extra.provider}:${extra.label}`}>
                  <div className={styles.rowDetail}>
                    {extra.label} · {extra.activation.status}
                  </div>
                  {extra.executableFiles.length > 0 && (
                    <ul className={styles.warnList}>
                      {extra.executableFiles.map((file, index) => (
                        <li
                          key={`${extra.provider}:${extra.label}:${index}:${file}`}
                          className={styles.pathWrap}
                        >
                          {file}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {needsAck && (
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={trusted}
            disabled={busy}
            aria-label="I trust this package and understand it may include executable instructions or hooks."
            onChange={(e) => onTrust(e.target.checked)}
          />
          I trust this package and understand it may include executable
          instructions or hooks.
        </label>
      )}
      {error && (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      )}
      <div className={styles.addActions}>
        <button
          type="button"
          className={styles.primaryBtn}
          disabled={busy || !canInstall}
          onClick={() => onInstall()}
        >
          Install selected
        </button>
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={busy}
          onClick={() => onCancel()}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

function mcpTransportLabel(server: McpServerDefinition | McpPreviewServer): string {
  if (server.transport === "stdio") return "Local";
  if (server.transport === "sse") return "SSE";
  return "HTTP";
}

function mcpDetail(server: McpServerDefinition): string {
  return server.transport === "stdio" ? server.command : server.url;
}

function mcpEnvNames(server: McpServerDefinition): string[] {
  return server.transport === "stdio" ? server.envNames : server.headerNames;
}

export function CuratedMcpsSection({
  catalog,
  busy,
  onInstall,
}: {
  catalog: McpCatalogEntry[];
  busy: boolean;
  onInstall: (id: string) => void;
}) {
  return (
    <section
      className={styles.subSection}
      aria-label="Curated MCP servers"
      data-mcp-section="curated"
    >
      <div className={styles.sectionHead}>
        <div className={styles.sectionLabel}>
          Curated MCP servers
          <span className={styles.sectionCount}>{catalog.length}</span>
        </div>
      </div>
      {catalog.length === 0 ? (
        <p className={styles.empty}>No curated MCP servers</p>
      ) : (
        <ul className={styles.list}>
          {catalog.map((entry) => (
            <li key={entry.id} className={styles.row} data-mcp-catalog={entry.id}>
              <div className={styles.rowMain}>
                <span className={styles.rowName}>{entry.name}</span>
                {entry.description && (
                  <span className={styles.rowDetail}>{entry.description}</span>
                )}
              </div>
              <div className={styles.rowSide}>
                {entry.installed ? (
                  <span className={`${styles.badge} ${styles.badgeBuiltin}`}>
                    Installed
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    disabled={busy}
                    aria-label={`Install ${entry.name}`}
                    onClick={() => onInstall(entry.id)}
                  >
                    Install
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AddedMcpsSection({
  servers,
  busy,
  onToggle,
  onRemove,
  onTrust,
}: {
  servers: McpServerDefinition[];
  busy: boolean;
  onToggle: (name: string, enabled: boolean) => void;
  onRemove: (name: string) => void;
  onTrust: (server: McpServerDefinition) => void;
}) {
  return (
    <section
      className={styles.subSection}
      aria-label="Added MCP servers"
      data-mcp-section="added"
    >
      <div className={styles.sectionHead}>
        <div className={styles.sectionLabel}>
          Added MCP servers
          <span className={styles.sectionCount}>{servers.length}</span>
        </div>
      </div>
      {servers.length === 0 ? (
        <p className={styles.empty}>No added MCP servers</p>
      ) : (
        <ul className={styles.list}>
          {servers.map((s) => {
            const names = mcpEnvNames(s);
            const untrusted = s.transport === "stdio" && !s.trusted;
            return (
              <li key={s.name} className={styles.row} data-mcp={s.name}>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>{s.name}</span>
                  <span className={styles.rowDetail} title={mcpDetail(s)}>
                    {mcpDetail(s)}
                  </span>
                  {names.length > 0 && (
                    <span className={styles.chipRow}>
                      {names.map((n) => (
                        <span key={n} className={styles.chip}>
                          {n}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <div className={styles.rowSide}>
                  <span className={`${styles.badge} ${styles.badgeBuiltin}`}>
                    {mcpTransportLabel(s)}
                  </span>
                  {untrusted ? (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      disabled={busy}
                      aria-label={`Trust ${s.name}`}
                      onClick={() => onTrust(s)}
                    >
                      Trust
                    </button>
                  ) : (
                    <label
                      className={styles.toggle}
                      title={s.enabled ? "Disable server" : "Enable server"}
                    >
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={busy}
                        aria-label={`Enable ${s.name}`}
                        onChange={(e) => onToggle(s.name, e.target.checked)}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    disabled={busy}
                    onClick={() => onRemove(s.name)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function McpImportPreviewPanel({
  preview,
  selected,
  replace,
  trusted,
  busy,
  error,
  onToggle,
  onReplace,
  onTrust,
  onInstall,
  onCancel,
}: {
  preview: McpImportPreview;
  selected: Set<string>;
  replace: boolean;
  trusted: boolean;
  busy: boolean;
  error: string | null;
  onToggle: (name: string) => void;
  onReplace: (value: boolean) => void;
  onTrust: (value: boolean) => void;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const selectedServers = preview.servers.filter((s) => selected.has(s.name));
  const hasCollision = selectedServers.some((s) => s.collision);
  const needsTrust = selectedServers.some((s) => s.requiresTrust);
  const canInstall =
    selectedServers.length > 0 &&
    (!hasCollision || replace) &&
    (!needsTrust || trusted);
  const unsupported = selectedServers.flatMap((s) =>
    s.providers.filter((p) => !p.supported).map((p) => `${s.name}: ${p.note || p.id}`),
  );

  return (
    <section
      className={styles.preview}
      aria-label="MCP import preview"
      data-mcp-preview
    >
      <div className={styles.formLabel}>MCP import preview</div>
      <p className={styles.previewSource}>
        <span className={styles.rowName}>{preview.source.label}</span>
        <span className={styles.kind}>{preview.source.kind}</span>
      </p>
      <ul className={styles.checkList}>
        {preview.servers.map((server) => (
          <li key={server.name} className={styles.checkRow}>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={selected.has(server.name)}
                disabled={busy}
                aria-label={`Select ${server.name}`}
                onChange={() => onToggle(server.name)}
              />
              <span className={styles.rowMain}>
                <span className={styles.rowName}>{server.name}</span>
                <span className={styles.rowDetail}>
                  {mcpTransportLabel(server)}
                  {server.transport === "stdio"
                    ? ` · ${server.command}`
                    : ` · ${server.url}`}
                </span>
                {(server.envNames.length > 0 || server.headerNames.length > 0) && (
                  <span className={styles.chipRow}>
                    {[...server.envNames, ...server.headerNames].map((n) => (
                      <span key={n} className={styles.chip}>
                        {n}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </label>
            {server.collision && <span className={styles.drift}>Collision</span>}
            {server.requiresTrust && (
              <span className={styles.drift}>Needs trust</span>
            )}
          </li>
        ))}
      </ul>
      {preview.warnings.map((w) => (
        <p key={w} className={styles.rowDetail}>
          {w}
        </p>
      ))}
      {unsupported.map((w) => (
        <p key={w} className={styles.rowDetail}>
          {w}
        </p>
      ))}
      {hasCollision && (
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={replace}
            disabled={busy}
            aria-label="Replace existing MCP servers"
            onChange={(e) => onReplace(e.target.checked)}
          />
          Replace existing servers
        </label>
      )}
      {needsTrust && (
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={trusted}
            disabled={busy}
            aria-label="Trust local MCP commands"
            onChange={(e) => onTrust(e.target.checked)}
          />
          Trust local commands. Do not enable servers you did not review.
        </label>
      )}
      {error && (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      )}
      <div className={styles.addActions}>
        <button
          type="button"
          className={styles.primaryBtn}
          disabled={busy || !canInstall}
          onClick={() => onInstall()}
        >
          {busy ? "Installing…" : "Install selected"}
        </button>
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={busy}
          onClick={() => onCancel()}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

export function SkillInstallResultPanel({
  result,
}: {
  result: SkillInstallResult;
}) {
  const followUps = result.plugins.filter(
    (plugin) => plugin.status !== "skipped",
  );
  if (followUps.length === 0) return null;
  return (
    <section
      className={styles.preview}
      aria-label="Plugin activation result"
      aria-live="polite"
      data-install-result
    >
      <div className={styles.formLabel}>Plugin activation</div>
      {followUps.map((plugin) => (
        <div key={`${plugin.provider}:${plugin.label}:${plugin.status}`}>
          <div className={styles.rowDetail}>
            {plugin.label} · {plugin.status}
            {plugin.error ? ` · ${plugin.error}` : ""}
          </div>
          {(plugin.instructions || []).map((line) => (
            <pre key={line} className={styles.instructionCode}>
              <code>{line}</code>
            </pre>
          ))}
        </div>
      ))}
    </section>
  );
}
