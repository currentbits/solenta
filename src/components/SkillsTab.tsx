import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  McpCatalogEntry,
  McpImportPreview,
  McpInstallRequest,
  McpInstallResult,
  McpPreviewImportInput,
  McpServerDefinition,
  McpServerSaveInput,
  SkillCatalogEntry,
  SkillImportPreview,
  SkillInstallRequest,
  SkillInstallResult,
  SkillInfo,
  SkillPreviewImportInput,
  SkillWrite,
} from "../shared/ipc";
import {
  AddSkillSection,
  AddedMcpsSection,
  AddedSkillsSection,
  CuratedMcpsSection,
  CuratedSkillsSection,
  McpImportPreviewPanel,
  ProjectSkillsSection,
  SkillImportPreviewPanel,
  SkillInstallResultPanel,
  formatSkillTokens,
} from "./SkillsSections";
import styles from "./SkillsTab.module.css";

export { formatSkillTokens };

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
  listMcpServers: () => Promise<McpServerDefinition[]>;
  saveMcpServer: (input: McpServerSaveInput) => Promise<McpServerDefinition>;
  removeMcpServer: (input: { name: string }) => Promise<void>;
  setMcpEnabled: (input: {
    name: string;
    enabled: boolean;
  }) => Promise<McpServerDefinition>;
  listMcpCatalog: () => Promise<McpCatalogEntry[]>;
  pickMcpImport: () => Promise<McpImportPreview | null>;
  previewMcpImport: (input: McpPreviewImportInput) => Promise<McpImportPreview>;
  installMcpImport: (input: McpInstallRequest) => Promise<McpInstallResult>;
  discardMcpImport: (input: { previewId: string }) => Promise<void>;
  listSkills: (input?: { projectPath?: string }) => Promise<SkillInfo[]>;
  addSkill: (
    input: SkillWrite,
  ) => Promise<{ name: string; installedIn: SkillInfo["installedIn"] }>;
  removeSkill: (input: { name: string }) => Promise<void>;
  syncSkills: () => Promise<{ copied: number; skills: string[] }>;
  listSkillCatalog: () => Promise<SkillCatalogEntry[]>;
  pickSkillImport: () => Promise<SkillImportPreview | null>;
  previewSkillImport: (
    input: SkillPreviewImportInput,
  ) => Promise<SkillImportPreview>;
  installSkillImport: (
    input: SkillInstallRequest,
  ) => Promise<SkillInstallResult>;
  discardSkillImport: (input: { previewId: string }) => Promise<void>;
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error && err.message ? err.message : String(err);
  // Electron wraps invoke rejections; strip the transport noise.
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

function copiedMessage(copied: number): string {
  return copied === 1 ? "Copied 1 skill" : `Copied ${copied} skills`;
}

function installedMessage(count: number): string {
  return count === 1 ? "Installed 1 skill" : `Installed ${count} skills`;
}

function installStatusMessage(result: SkillInstallResult): string {
  const parts = [installedMessage(result.installed.length)];
  const plugins = result.plugins || [];
  const activated = plugins.filter((p) => p.status === "activated");
  const manual = plugins.filter((p) => p.status === "manual");
  const failed = plugins.filter((p) => p.status === "failed");
  if (activated.length === 1) {
    parts.push(`activated ${activated[0].label}`);
  } else if (activated.length > 1) {
    parts.push(`activated ${activated.length} plugins`);
  }
  if (manual.length === 1) {
    parts.push(`${manual[0].label} needs a manual install`);
  } else if (manual.length > 1) {
    parts.push(`${manual.length} plugin actions need a manual install`);
  }
  if (failed.length) {
    const first = failed[0];
    parts.push(
      first.error
        ? `${first.label} failed: ${first.error}`
        : `${first.label} failed`,
    );
  }
  if (plugins.some((p) => p.instructions && p.instructions.length > 0)) {
    parts.push("Instructions follow");
  }
  return parts.join(". ");
}

export function SkillsTab({
  projectPath,
  listMcpServers,
  saveMcpServer,
  removeMcpServer,
  setMcpEnabled,
  listMcpCatalog,
  pickMcpImport,
  previewMcpImport,
  installMcpImport,
  discardMcpImport,
  listSkills,
  addSkill,
  removeSkill,
  syncSkills,
  listSkillCatalog,
  pickSkillImport,
  previewSkillImport,
  installSkillImport,
  discardSkillImport,
}: SkillsTabProps) {
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpToken, setMcpToken] = useState("");
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpTrustLocal, setMcpTrustLocal] = useState(false);
  const [mcpJson, setMcpJson] = useState("");
  const [mcpGithub, setMcpGithub] = useState("");
  const [mcpPreview, setMcpPreview] = useState<McpImportPreview | null>(null);
  const [mcpSelected, setMcpSelected] = useState<Set<string>>(new Set());
  const [mcpReplace, setMcpReplace] = useState(false);
  const [mcpTrustImport, setMcpTrustImport] = useState(false);
  const [mcpImportError, setMcpImportError] = useState<string | null>(null);
  const mcpPreviewIdRef = useRef<string | null>(null);
  const mcpDiscardedRef = useRef(new Set<string>());
  const mcpDiscardFnRef = useRef(discardMcpImport);
  mcpDiscardFnRef.current = discardMcpImport;

  const [skillBusy, setSkillBusy] = useState(false);
  const [skillFormError, setSkillFormError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  /** Inline remove confirm: row key of the skill asking. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [installResult, setInstallResult] = useState<SkillInstallResult | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replace, setReplace] = useState(false);
  const [trusted, setTrusted] = useState(false);

  const mountedRef = useRef(true);
  const previewIdRef = useRef<string | null>(null);
  const importLockRef = useRef(false);
  const generationRef = useRef(0);
  const discardedRef = useRef(new Set<string>());
  const discardFnRef = useRef(discardSkillImport);
  discardFnRef.current = discardSkillImport;

  const discardOnce = (previewId: string | null | undefined) => {
    if (!previewId || discardedRef.current.has(previewId)) return;
    discardedRef.current.add(previewId);
    if (previewIdRef.current === previewId) previewIdRef.current = null;
    void discardFnRef.current({ previewId }).catch(() => {});
  };

  const discardMcpOnce = (previewId: string | null | undefined) => {
    if (!previewId || mcpDiscardedRef.current.has(previewId)) return;
    mcpDiscardedRef.current.add(previewId);
    if (mcpPreviewIdRef.current === previewId) mcpPreviewIdRef.current = null;
    void mcpDiscardFnRef.current({ previewId }).catch(() => {});
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      importLockRef.current = false;
      discardOnce(previewIdRef.current);
      discardMcpOnce(mcpPreviewIdRef.current);
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
      setSkillsError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSkillsLoading(false);
    }
  }, [listSkills, projectPath]);

  const reloadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const rows = await listSkillCatalog();
      if (!mountedRef.current) return;
      setCatalog(rows);
      setCatalogError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setCatalogError(errorMessage(err));
    } finally {
      if (mountedRef.current) setCatalogLoading(false);
    }
  }, [listSkillCatalog]);

  const reloadMcp = useCallback(async () => {
    try {
      const [list, catalog] = await Promise.all([
        listMcpServers(),
        listMcpCatalog(),
      ]);
      if (!mountedRef.current) return;
      setMcpServers(list);
      setMcpCatalog(catalog);
    } catch (err) {
      if (mountedRef.current) setMcpError(errorMessage(err));
    }
  }, [listMcpServers, listMcpCatalog]);

  const reloadAll = useCallback(async () => {
    await Promise.all([reloadSkills(), reloadCatalog(), reloadMcp()]);
  }, [reloadSkills, reloadCatalog, reloadMcp]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  const runMcp = async (fn: () => Promise<void>): Promise<boolean> => {
    setMcpBusy(true);
    setMcpError(null);
    try {
      await fn();
      if (mountedRef.current) await reloadMcp();
      return true;
    } catch (err) {
      if (mountedRef.current) setMcpError(errorMessage(err));
      return false;
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
    const input: McpServerSaveInput = { name, url, enabled: true };
    if (token) input.token = token;
    const ok = await runMcp(async () => {
      await saveMcpServer(input);
    });
    if (!mountedRef.current || !ok) return;
    setMcpName("");
    setMcpUrl("");
    setMcpToken("");
  };

  const handleToggleMcp = async (name: string, enabled: boolean) => {
    await runMcp(async () => {
      await setMcpEnabled({ name, enabled });
    });
  };

  const handleRemoveMcp = async (name: string) => {
    await runMcp(async () => {
      await removeMcpServer({ name });
    });
  };

  const handleAddLocalMcp = async () => {
    setMcpError(null);
    const name = mcpName.trim();
    const command = mcpCommand.trim();
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
    if (!command) {
      setMcpError("Command is required");
      return;
    }
    const args = mcpArgs
      .split(/\s+/)
      .map((a) => a.trim())
      .filter(Boolean);
    const trusted = mcpTrustLocal;
    const ok = await runMcp(async () => {
      await saveMcpServer({
        name,
        transport: "stdio",
        command,
        args,
        enabled: trusted,
        trusted,
      });
    });
    if (!mountedRef.current || !ok) return;
    setMcpName("");
    setMcpCommand("");
    setMcpArgs("");
    setMcpTrustLocal(false);
  };

  const handleTrustMcp = async (server: McpServerDefinition) => {
    if (server.transport !== "stdio") return;
    await runMcp(async () => {
      await saveMcpServer({
        name: server.name,
        transport: "stdio",
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        enabled: false,
        trusted: true,
      });
    });
  };

  const showMcpPreview = (next: McpImportPreview) => {
    discardMcpOnce(mcpPreviewIdRef.current);
    mcpPreviewIdRef.current = next.previewId;
    setMcpPreview(next);
    setMcpSelected(new Set(next.servers.map((s) => s.name)));
    setMcpReplace(false);
    setMcpTrustImport(false);
    setMcpImportError(null);
  };

  const handleMcpPreviewJson = async () => {
    setMcpImportError(null);
    setMcpBusy(true);
    try {
      const next = await previewMcpImport({ kind: "json", text: mcpJson });
      if (!mountedRef.current) {
        discardMcpOnce(next.previewId);
        return;
      }
      showMcpPreview(next);
    } catch (err) {
      if (mountedRef.current) setMcpImportError(errorMessage(err));
    } finally {
      if (mountedRef.current) setMcpBusy(false);
    }
  };

  const handleMcpPreviewGithub = async () => {
    setMcpImportError(null);
    setMcpBusy(true);
    try {
      const next = await previewMcpImport({ kind: "github", url: mcpGithub });
      if (!mountedRef.current) {
        discardMcpOnce(next.previewId);
        return;
      }
      showMcpPreview(next);
    } catch (err) {
      if (mountedRef.current) setMcpImportError(errorMessage(err));
    } finally {
      if (mountedRef.current) setMcpBusy(false);
    }
  };

  const handleMcpImportFile = async () => {
    setMcpImportError(null);
    setMcpBusy(true);
    try {
      const next = await pickMcpImport();
      if (!mountedRef.current) {
        if (next) discardMcpOnce(next.previewId);
        return;
      }
      if (!next) return;
      showMcpPreview(next);
    } catch (err) {
      if (mountedRef.current) setMcpImportError(errorMessage(err));
    } finally {
      if (mountedRef.current) setMcpBusy(false);
    }
  };

  const handleMcpCatalogInstall = async (id: string) => {
    setMcpImportError(null);
    setMcpBusy(true);
    try {
      const next = await previewMcpImport({ kind: "catalog", id });
      if (!mountedRef.current) {
        discardMcpOnce(next.previewId);
        return;
      }
      showMcpPreview(next);
    } catch (err) {
      if (mountedRef.current) setMcpImportError(errorMessage(err));
    } finally {
      if (mountedRef.current) setMcpBusy(false);
    }
  };

  const handleInstallMcpPreview = async () => {
    if (!mcpPreview) return;
    const previewId = mcpPreview.previewId;
    setMcpBusy(true);
    setMcpImportError(null);
    try {
      const result = await installMcpImport({
        previewId,
        selected: [...mcpSelected],
        replace: mcpReplace,
        trustLocal: mcpTrustImport,
        trustLocalCommands: mcpTrustImport,
      });
      mcpDiscardedRef.current.add(previewId);
      mcpPreviewIdRef.current = null;
      if (!mountedRef.current) return;
      setMcpPreview(null);
      const names = (result.installed || []).map((s) =>
        typeof s === "string" ? s : s.name,
      );
      setStatusMessage(
        names.length === 1
          ? `Installed ${names[0]}`
          : `Installed ${names.length} MCP servers`,
      );
      await reloadMcp();
    } catch (err) {
      if (mountedRef.current) setMcpImportError(errorMessage(err));
    } finally {
      if (mountedRef.current) setMcpBusy(false);
    }
  };

  const handleDiscardMcpPreview = async () => {
    const previewId = mcpPreview?.previewId ?? mcpPreviewIdRef.current;
    discardMcpOnce(previewId);
    setMcpPreview(null);
    setMcpImportError(null);
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
      setStatusMessage(null);
      await reloadSkills();
    } catch (err) {
      if (mountedRef.current) setSkillFormError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSkillBusy(false);
    }
  };

  const handleRemoveSkill = async (skill: SkillInfo) => {
    if (skill.provenance === "project" || skill.source === "project") return;
    setSkillBusy(true);
    try {
      await removeSkill({ name: skill.name });
      if (!mountedRef.current) return;
      setConfirmRemove(null);
      setStatusMessage(null);
      await reloadSkills();
    } catch (err) {
      if (mountedRef.current) setSkillsError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSkillBusy(false);
    }
  };

  const handleSync = async () => {
    setSkillsError(null);
    setStatusMessage(null);
    setSkillBusy(true);
    try {
      const result = await syncSkills();
      if (!mountedRef.current) return;
      await reloadSkills();
      if (!mountedRef.current) return;
      setStatusMessage(copiedMessage(result.copied));
    } catch (err) {
      if (mountedRef.current) setSkillsError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSkillBusy(false);
    }
  };

  const applyPreview = (next: SkillImportPreview) => {
    previewIdRef.current = next.previewId;
    setPreview(next);
    setSelected(new Set(next.skills.map((s) => s.name)));
    setReplace(false);
    setTrusted(false);
    setImportError(null);
    setInstallResult(null);
    setStatusMessage(null);
  };

  const runImport = async (fn: () => Promise<SkillImportPreview | null>) => {
    if (importLockRef.current) return;
    importLockRef.current = true;
    const gen = ++generationRef.current;
    const previousId = previewIdRef.current;
    if (mountedRef.current) {
      setSkillBusy(true);
      setImportError(null);
    }
    try {
      const next = await fn();
      if (!mountedRef.current || gen !== generationRef.current) {
        if (next) discardOnce(next.previewId);
        return;
      }
      if (next) {
        applyPreview(next);
        if (previousId && previousId !== next.previewId) {
          discardOnce(previousId);
        }
      }
    } catch (err) {
      if (mountedRef.current && gen === generationRef.current) {
        setImportError(errorMessage(err));
      }
    } finally {
      if (gen === generationRef.current) {
        importLockRef.current = false;
        if (mountedRef.current) setSkillBusy(false);
      }
    }
  };

  const handleImportFile = () => {
    void runImport(() => pickSkillImport());
  };

  const handlePreviewGithub = () => {
    void runImport(() =>
      previewSkillImport({ kind: "github", url: githubUrl.trim() }),
    );
  };

  const handleCatalogInstall = (id: string) => {
    void runImport(() => previewSkillImport({ kind: "catalog", id }));
  };

  const handleDiscardPreview = async () => {
    const id = previewIdRef.current ?? preview?.previewId ?? null;
    if (!id || importLockRef.current) return;
    discardOnce(id);
    if (!mountedRef.current) return;
    setPreview(null);
    setImportError(null);
  };

  const handleInstallPreview = async () => {
    if (!preview || importLockRef.current) return;
    const chosen = preview.skills.filter((s) => selected.has(s.name));
    if (chosen.length === 0) return;
    const needsAck =
      chosen.some((s) => s.warnings.length > 0) || preview.plugins.length > 0;
    const hasCollision = chosen.some((s) => s.collision);
    if (hasCollision && !replace) return;
    if (needsAck && !trusted) return;
    importLockRef.current = true;
    const gen = ++generationRef.current;
    const previewId = preview.previewId;
    previewIdRef.current = null;
    setSkillBusy(true);
    setImportError(null);
    try {
      const result = await installSkillImport({
        previewId,
        selected: chosen.map((s) => s.name),
        replace,
        trustPluginCode: needsAck ? trusted : false,
      });
      discardedRef.current.add(previewId);
      if (!mountedRef.current || gen !== generationRef.current) return;
      setPreview(null);
      setReplace(false);
      setTrusted(false);
      setInstallResult(result);
      await reloadAll();
      if (!mountedRef.current || gen !== generationRef.current) return;
      setStatusMessage(installStatusMessage(result));
    } catch (err) {
      if (!mountedRef.current || gen !== generationRef.current) {
        discardOnce(previewId);
        return;
      }
      previewIdRef.current = previewId;
      setImportError(errorMessage(err));
    } finally {
      if (gen === generationRef.current) {
        importLockRef.current = false;
        if (mountedRef.current) setSkillBusy(false);
      }
    }
  };

  const addedSkills = skills.filter((s) => s.provenance === "added");
  const projectSkills = skills.filter((s) => s.provenance === "project");
  const hasDrift = skills.some(
    (s) => s.provenance !== "project" && s.missingFrom.length > 0,
  );

  return (
    <div className={styles.root}>
      <div className={styles.scroll}>
        <McpServersSection
          mcpServers={mcpServers}
          mcpCatalog={mcpCatalog}
          mcpBusy={mcpBusy}
          mcpError={mcpError}
          mcpImportError={mcpPreview ? null : mcpImportError}
          mcpName={mcpName}
          mcpUrl={mcpUrl}
          mcpToken={mcpToken}
          mcpCommand={mcpCommand}
          mcpArgs={mcpArgs}
          mcpTrustLocal={mcpTrustLocal}
          mcpJson={mcpJson}
          mcpGithub={mcpGithub}
          onName={setMcpName}
          onUrl={setMcpUrl}
          onToken={setMcpToken}
          onCommand={setMcpCommand}
          onArgs={setMcpArgs}
          onTrustLocal={setMcpTrustLocal}
          onJson={setMcpJson}
          onGithub={setMcpGithub}
          onAdd={() => void handleAddMcp()}
          onAddLocal={() => void handleAddLocalMcp()}
          onToggle={(name, enabled) => void handleToggleMcp(name, enabled)}
          onRemove={(name) => void handleRemoveMcp(name)}
          onTrust={(server) => void handleTrustMcp(server)}
          onCatalogInstall={(id) => void handleMcpCatalogInstall(id)}
          onImportFile={() => void handleMcpImportFile()}
          onPreviewJson={() => void handleMcpPreviewJson()}
          onPreviewGithub={() => void handleMcpPreviewGithub()}
        />
        {mcpPreview && (
          <McpImportPreviewPanel
            preview={mcpPreview}
            selected={mcpSelected}
            replace={mcpReplace}
            trusted={mcpTrustImport}
            busy={mcpBusy}
            error={mcpImportError}
            onToggle={(name) => {
              setMcpSelected((prev) => {
                const next = new Set(prev);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                return next;
              });
            }}
            onReplace={setMcpReplace}
            onTrust={setMcpTrustImport}
            onInstall={() => void handleInstallMcpPreview()}
            onCancel={() => void handleDiscardMcpPreview()}
          />
        )}

        <section className={styles.section} aria-label="Skills">
          <p
            className={styles.syncNote}
            aria-live="polite"
            data-empty={statusMessage ? undefined : ""}
          >
            {statusMessage ?? ""}
          </p>
          <CuratedSkillsSection
            catalog={catalog}
            loading={catalogLoading}
            error={catalogError}
            skills={skills}
            busy={skillBusy}
            onInstall={handleCatalogInstall}
          />
          <AddedSkillsSection
            skills={addedSkills}
            loading={skillsLoading}
            error={skillsError}
            busy={skillBusy}
            hasDrift={hasDrift}
            confirmRemove={confirmRemove}
            onSync={() => void handleSync()}
            onAskRemove={setConfirmRemove}
            onConfirmRemove={(skill) => void handleRemoveSkill(skill)}
            onCancelRemove={() => setConfirmRemove(null)}
          />
          <ProjectSkillsSection skills={projectSkills} />
          <AddSkillSection
            busy={skillBusy}
            githubUrl={githubUrl}
            skillName={skillName}
            skillDescription={skillDescription}
            skillBody={skillBody}
            formError={skillFormError}
            importError={preview ? null : importError}
            onGithubUrl={setGithubUrl}
            onImportFile={handleImportFile}
            onPreviewGithub={handlePreviewGithub}
            onSkillName={setSkillName}
            onSkillDescription={setSkillDescription}
            onSkillBody={setSkillBody}
            onAddSkill={() => void handleAddSkill()}
          />
          {installResult && (
            <SkillInstallResultPanel result={installResult} />
          )}
          {preview && (
            <SkillImportPreviewPanel
              preview={preview}
              selected={selected}
              replace={replace}
              trusted={trusted}
              busy={skillBusy}
              error={importError}
              onToggle={(name) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(name)) next.delete(name);
                  else next.add(name);
                  return next;
                });
              }}
              onReplace={setReplace}
              onTrust={setTrusted}
              onInstall={() => void handleInstallPreview()}
              onCancel={() => void handleDiscardPreview()}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function McpServersSection({
  mcpServers,
  mcpCatalog,
  mcpBusy,
  mcpError,
  mcpImportError,
  mcpName,
  mcpUrl,
  mcpToken,
  mcpCommand,
  mcpArgs,
  mcpTrustLocal,
  mcpJson,
  mcpGithub,
  onName,
  onUrl,
  onToken,
  onCommand,
  onArgs,
  onTrustLocal,
  onJson,
  onGithub,
  onAdd,
  onAddLocal,
  onToggle,
  onRemove,
  onTrust,
  onCatalogInstall,
  onImportFile,
  onPreviewJson,
  onPreviewGithub,
}: {
  mcpServers: McpServerDefinition[];
  mcpCatalog: McpCatalogEntry[];
  mcpBusy: boolean;
  mcpError: string | null;
  mcpImportError: string | null;
  mcpName: string;
  mcpUrl: string;
  mcpToken: string;
  mcpCommand: string;
  mcpArgs: string;
  mcpTrustLocal: boolean;
  mcpJson: string;
  mcpGithub: string;
  onName: (value: string) => void;
  onUrl: (value: string) => void;
  onToken: (value: string) => void;
  onCommand: (value: string) => void;
  onArgs: (value: string) => void;
  onTrustLocal: (value: boolean) => void;
  onJson: (value: string) => void;
  onGithub: (value: string) => void;
  onAdd: () => void;
  onAddLocal: () => void;
  onToggle: (name: string, enabled: boolean) => void;
  onRemove: (name: string) => void;
  onTrust: (server: McpServerDefinition) => void;
  onCatalogInstall: (id: string) => void;
  onImportFile: () => void;
  onPreviewJson: () => void;
  onPreviewGithub: () => void;
}) {
  const added = mcpServers.filter((s) => s.provenance !== "curated");
  return (
    <section className={styles.section} aria-label="MCP servers">
      <div className={styles.sectionHead}>
        <div className={styles.sectionLabel}>
          Built-in MCP servers
          <span className={styles.sectionCount}>{BUILTIN_MCPS.length}</span>
        </div>
      </div>
      <ul className={styles.list}>
        {BUILTIN_MCPS.map((s) => (
          <li key={s.name} className={styles.row}>
            <div className={styles.rowMain}>
              <span className={styles.rowName}>{s.name}</span>
              <span className={styles.rowDetail}>{s.blurb}</span>
            </div>
            <div className={styles.rowSide}>
              <span className={`${styles.badge} ${styles.badgeBuiltin}`}>
                Built-in
              </span>
            </div>
          </li>
        ))}
      </ul>
      <CuratedMcpsSection
        catalog={mcpCatalog}
        busy={mcpBusy}
        onInstall={onCatalogInstall}
      />
      <AddedMcpsSection
        servers={added}
        busy={mcpBusy}
        onToggle={onToggle}
        onRemove={onRemove}
        onTrust={onTrust}
      />

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
      >
        <div className={styles.formLabel}>Add MCP server</div>
        <div className={styles.addActions}>
          <button
            type="button"
            className={styles.ghostBtn}
            disabled={mcpBusy}
            onClick={() => onImportFile()}
          >
            Import MCP file
          </button>
        </div>
        <div className={styles.formRow}>
          <input
            type="text"
            className={styles.input}
            placeholder="Name"
            value={mcpName}
            onChange={(e) => onName(e.target.value)}
            aria-label="MCP server name"
          />
          <input
            type="text"
            className={styles.input}
            placeholder="https://example.com/mcp"
            value={mcpUrl}
            onChange={(e) => onUrl(e.target.value)}
            aria-label="MCP server URL"
          />
        </div>
        <input
          type="text"
          className={styles.input}
          placeholder="Bearer token (optional)"
          value={mcpToken}
          onChange={(e) => onToken(e.target.value)}
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
        <details className={styles.disclosure}>
          <summary>Local command</summary>
          <div className={styles.manualForm}>
            <input
              type="text"
              className={styles.input}
              placeholder="/usr/bin/mcp-server"
              value={mcpCommand}
              onChange={(e) => onCommand(e.target.value)}
              aria-label="MCP command"
            />
            <input
              type="text"
              className={styles.input}
              placeholder="Arguments (optional)"
              value={mcpArgs}
              onChange={(e) => onArgs(e.target.value)}
              aria-label="MCP command arguments"
            />
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={mcpTrustLocal}
                disabled={mcpBusy}
                aria-label="Trust local MCP command"
                onChange={(e) => onTrustLocal(e.target.checked)}
              />
              Trust this local command
            </label>
            <button
              type="button"
              className={styles.ghostBtn}
              disabled={mcpBusy}
              onClick={() => onAddLocal()}
            >
              Add local server
            </button>
          </div>
        </details>
        <details className={styles.disclosure}>
          <summary>Import JSON or GitHub</summary>
          <div className={styles.manualForm}>
            <textarea
              className={styles.textarea}
              placeholder='{"mcpServers":{"name":{"url":"https://example.com/mcp"}}}'
              value={mcpJson}
              onChange={(e) => onJson(e.target.value)}
              aria-label="MCP JSON"
            />
            <button
              type="button"
              className={styles.ghostBtn}
              disabled={mcpBusy}
              onClick={() => onPreviewJson()}
            >
              Check JSON
            </button>
            <div className={styles.formRow}>
              <input
                type="text"
                className={styles.input}
                placeholder="https://github.com/owner/repo"
                value={mcpGithub}
                onChange={(e) => onGithub(e.target.value)}
                aria-label="MCP GitHub URL"
              />
              <button
                type="button"
                className={styles.ghostBtn}
                disabled={mcpBusy}
                onClick={() => onPreviewGithub()}
              >
                Load GitHub
              </button>
            </div>
            {mcpImportError && (
              <p className={styles.formError} role="alert">
                {mcpImportError}
              </p>
            )}
          </div>
        </details>
      </form>
    </section>
  );
}
