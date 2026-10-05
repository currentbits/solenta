import { useCallback } from "react";
import type {
  CoderApi,
  HarnessInstallRequest,
  HarnessSourceId,
  McpInstallRequest,
  McpPreviewImportInput,
  McpServerSaveInput,
  SkillInstallRequest,
  SkillPreviewImportInput,
  SkillWrite,
} from "../shared/ipc";

/** Agent config, MCP servers, skills, harness import and CLI catalog (IPC pass-throughs). */
export function useCoderAgentTools(api: CoderApi) {
  const lintAgentConfig = useCallback(
    async (input: { projectId: string }) => {
      return api.projects.lintAgentConfig(input);
    },
    [api],
  );

  const previewAgentConfig = useCallback(
    async (input: { projectId: string; targets?: string[] }) => {
      return api.projects.previewAgentConfig(input);
    },
    [api],
  );

  const writeAgentConfig = useCallback(
    async (input: { projectId: string; targets?: string[] }) => {
      return api.projects.writeAgentConfig(input);
    },
    [api],
  );

  const listMcpServers = useCallback(async () => {
    return api.mcp.list();
  }, [api]);

  const saveMcpServer = useCallback(
    async (input: McpServerSaveInput) => {
      return api.mcp.save(input);
    },
    [api],
  );

  const removeMcpServer = useCallback(
    async (input: { name: string }) => {
      return api.mcp.remove(input);
    },
    [api],
  );

  const setMcpEnabled = useCallback(
    async (input: { name: string; enabled: boolean }) => {
      return api.mcp.setEnabled(input);
    },
    [api],
  );

  const listMcpCatalog = useCallback(async () => {
    return api.mcp.catalog();
  }, [api]);

  const pickMcpImport = useCallback(async () => {
    return api.mcp.pickImport();
  }, [api]);

  const previewMcpImport = useCallback(
    async (input: McpPreviewImportInput) => {
      return api.mcp.previewImport(input);
    },
    [api],
  );

  const installMcpImport = useCallback(
    async (input: McpInstallRequest) => {
      return api.mcp.installImport(input);
    },
    [api],
  );

  const discardMcpImport = useCallback(
    async (input: { previewId: string }) => {
      return api.mcp.discardImport(input);
    },
    [api],
  );

  const listSkills = useCallback(
    async (input?: { projectPath?: string }) => {
      return api.skills.list(input);
    },
    [api],
  );

  const addSkill = useCallback(
    async (input: SkillWrite) => {
      return api.skills.add(input);
    },
    [api],
  );

  const removeSkill = useCallback(
    async (input: { name: string }) => {
      return api.skills.remove(input);
    },
    [api],
  );

  const syncSkills = useCallback(async () => {
    return api.skills.sync();
  }, [api]);

  const listSkillCatalog = useCallback(async () => {
    return api.skills.catalog();
  }, [api]);

  const pickSkillImport = useCallback(async () => {
    return api.skills.pickImport();
  }, [api]);

  const previewSkillImport = useCallback(
    async (input: SkillPreviewImportInput) => {
      return api.skills.previewImport(input);
    },
    [api],
  );

  const installSkillImport = useCallback(
    async (input: SkillInstallRequest) => {
      return api.skills.installImport(input);
    },
    [api],
  );

  const discardSkillImport = useCallback(
    async (input: { previewId: string }) => {
      return api.skills.discardImport(input);
    },
    [api],
  );

  const detectHarnessSources = useCallback(async () => {
    return api.harness.detectSources();
  }, [api]);

  const previewHarnessImport = useCallback(
    async (input: { source: HarnessSourceId; projectPath?: string }) => {
      return api.harness.previewImport(input);
    },
    [api],
  );

  const installHarnessImport = useCallback(
    async (input: HarnessInstallRequest) => {
      return api.harness.installImport(input);
    },
    [api],
  );

  const discardHarnessImport = useCallback(
    async (input: { previewId: string }) => {
      return api.harness.discardImport(input);
    },
    [api],
  );

  const listCliCommands = useCallback(
    async (input?: { projectPath?: string; provider?: string }) => {
      return api.skills.commands(input);
    },
    [api],
  );

  const listCliSessions = useCallback(
    async (input?: {
      provider?: "codex" | "grok" | "claude" | "cursor" | "opencode" | "kimi" | "muse";
    }) => {
      return api.threads.listCliSessions(input);
    },
    [api],
  );

  return {
    lintAgentConfig,
    previewAgentConfig,
    writeAgentConfig,
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
    detectHarnessSources,
    previewHarnessImport,
    installHarnessImport,
    discardHarnessImport,
    listCliCommands,
    listCliSessions,
  };
}
