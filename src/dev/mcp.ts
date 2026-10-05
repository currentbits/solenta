/** MCP servers and the curated catalog for the browser-dev fixture (Skills tab). */
import type {
  CoderApi,
  McpCatalogEntry,
  McpImportPreview,
  McpInstallRequest,
  McpInstallResult,
  McpPreviewImportInput,
  McpServerDefinition,
  McpServerInfo,
  McpServerSaveInput,
} from "../shared/ipc";
import {
  parseMcpConfigDocument,
  redactMcpServer,
  redactMcpServers,
  upsertMcpServer,
} from "../shared/mcpModel.ts";
import type { DevCtx } from "./context.ts";

/**
 * Browser-twin mirror of the main-process curated catalog
 * (electron/mcpCatalog.js). Keep ids/definitions in sync with it.
 */
export interface DevMcpCatalogEntry {
  id: string;
  name: string;
  description: string;
  publisher: string;
  homepage: string;
  sourceUrl: string;
  transport: "http" | "sse" | "stdio";
  risk: string;
  definition: Record<string, unknown>;
}

export const DEV_MCP_CATALOG: readonly DevMcpCatalogEntry[] = [
  {
    id: "context7",
    name: "Context7",
    description:
      "Up-to-date library documentation and code examples for LLMs over a remote MCP endpoint.",
    publisher: "Upstash",
    homepage: "https://context7.com",
    sourceUrl: "https://context7.com",
    transport: "http",
    risk: "Remote HTTP endpoint. Review the vendor before sending repository context.",
    definition: {
      name: "context7",
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      enabled: true,
    },
  },
  {
    id: "linear",
    name: "Linear",
    description:
      "Linear issue tracking and project management over a remote MCP endpoint.",
    publisher: "Linear",
    homepage: "https://linear.app",
    sourceUrl: "https://linear.app",
    transport: "http",
    risk: "Remote HTTP with OAuth. No static secret is stored; complete Linear's OAuth flow.",
    definition: {
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      enabled: true,
    },
  },
  {
    id: "playwright",
    name: "Playwright",
    description:
      "Browser automation via the Playwright MCP server. Runs a local npx command.",
    publisher: "Microsoft",
    homepage: "https://playwright.dev",
    sourceUrl: "https://playwright.dev",
    transport: "stdio",
    risk: "Local stdio via npx. Explicit trust is required before the command can run.",
    definition: {
      name: "playwright",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      enabled: false,
      trusted: false,
    },
  },
];

/** Public catalog rows with `installed` derived from the curated servers. */
export function devMcpCatalogRows(
  servers: ReadonlyArray<{ provenance?: string; catalogId?: string }>,
): McpCatalogEntry[] {
  const installedIds = new Set(
    servers
      .filter((s) => s.provenance === "curated" && s.catalogId)
      .map((s) => s.catalogId as string),
  );
  return DEV_MCP_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    publisher: entry.publisher,
    sourceUrl: entry.sourceUrl,
    homepage: entry.homepage,
    transport: entry.transport,
    risk: entry.risk,
    requiredSecrets: [],
    installed: installedIds.has(entry.id),
  }));
}

export function redactDevMcp(s: McpServerInfo): McpServerDefinition {
  if (s.transport === "stdio") {
    const env = s.env ?? {};
    return {
      name: s.name,
      transport: "stdio",
      command: s.command,
      args: [...s.args],
      envNames: Object.keys(env),
      hasSecrets: Object.keys(env).length > 0,
      ...(s.cwd ? { cwd: s.cwd } : {}),
      enabled: s.enabled,
      trusted: s.trusted,
      ...(s.provenance ? { provenance: s.provenance } : {}),
      ...(s.catalogId ? { catalogId: s.catalogId } : {}),
    };
  }
  const headers = s.headers ?? {};
  return {
    name: s.name,
    transport: s.transport === "sse" ? "sse" : "http",
    url: s.url,
    headerNames: Object.keys(headers),
    hasToken: Boolean(s.token),
    enabled: s.enabled,
    ...(s.provenance ? { provenance: s.provenance } : {}),
    ...(s.catalogId ? { catalogId: s.catalogId } : {}),
  };
}

export function createMcp(ctx: DevCtx): Pick<CoderApi, "mcp"> {
  let pendingMcpImport: {
    previewId: string;
    kind: "json" | "github" | "catalog" | "local";
    catalogId?: string;
    servers: ReturnType<typeof parseMcpConfigDocument>["servers"];
  } | null = null;

  function mcpPreviewFromParsed(
    kind: "json" | "github" | "catalog" | "local",
    label: string,
    parsed: ReturnType<typeof parseMcpConfigDocument>,
    catalogId?: string,
  ): McpImportPreview {
    const previewId = "m".repeat(32);
    pendingMcpImport = { previewId, kind, catalogId, servers: parsed.servers };
    const existing = new Set(ctx.mcpServers.map((s) => s.name));
    return {
      previewId,
      source: { kind, label },
      warnings: parsed.warnings,
      servers: parsed.servers.map((row) => ({
        name: row.stored.name,
        transport: row.stored.transport,
        command: row.stored.command,
        args: row.stored.args ? [...row.stored.args] : [],
        url: row.stored.url,
        cwd: row.stored.cwd,
        envNames: [...row.meta.envNames],
        headerNames: [...row.meta.headerNames],
        hasToken: row.meta.hasToken,
        requiresTrust: row.stored.transport === "stdio",
        collision: existing.has(row.stored.name),
        warnings: [...row.meta.warnings],
        providers: [
          { id: "claude", supported: true },
          { id: "kimi", supported: true },
          { id: "codex", supported: row.stored.transport !== "sse" },
          { id: "grok", supported: true },
        ],
      })),
    };
  }

  return {
    mcp: {
      async list(): Promise<McpServerDefinition[]> {
        return redactMcpServers(ctx.mcpServers) as unknown as McpServerDefinition[];
      },
      async save(input: McpServerSaveInput): Promise<McpServerDefinition> {
        ctx.mcpServers = upsertMcpServer(ctx.mcpServers, input) as McpServerInfo[];
        const saved = ctx.mcpServers.find((s) => s.name === input.name);
        if (!saved) throw new Error("MCP save failed");
        return redactDevMcp(saved);
      },
      async remove(input: { name: string }): Promise<void> {
        ctx.mcpServers = ctx.mcpServers.filter((s) => s.name !== input.name);
      },
      async setEnabled(input: {
        name: string;
        enabled: boolean;
      }): Promise<McpServerDefinition> {
        const existing = ctx.mcpServers.find((s) => s.name === input.name);
        if (!existing) throw new Error(`Unknown MCP server: ${input.name}`);
        if (
          existing.transport === "stdio" &&
          input.enabled &&
          existing.trusted !== true
        ) {
          throw new Error("Local MCP server must be trusted to enable");
        }
        ctx.mcpServers = ctx.mcpServers.map((s) =>
          s.name === input.name ? { ...s, enabled: input.enabled } : s,
        );
        const saved = ctx.mcpServers.find((s) => s.name === input.name);
        if (!saved) throw new Error(`Unknown MCP server: ${input.name}`);
        return redactDevMcp(saved);
      },
      async catalog(): Promise<McpCatalogEntry[]> {
        return devMcpCatalogRows(ctx.mcpServers);
      },
      async pickImport(): Promise<McpImportPreview | null> {
        return null;
      },
      async previewImport(input: McpPreviewImportInput): Promise<McpImportPreview> {
        if (input.kind === "json") {
          return mcpPreviewFromParsed("json", "JSON", parseMcpConfigDocument(input.text));
        }
        if (input.kind === "github") {
          return mcpPreviewFromParsed(
            "github",
            "github",
            parseMcpConfigDocument({
              mcpServers: { "gh-tools": { url: "https://gh.example.com/mcp" } },
            }),
          );
        }
        const entry = DEV_MCP_CATALOG.find((e) => e.id === input.id);
        if (!entry) throw new Error("Unknown catalog item");
        return mcpPreviewFromParsed(
          "catalog",
          entry.name,
          parseMcpConfigDocument([entry.definition]),
          entry.id,
        );
      },
      async installImport(input: McpInstallRequest): Promise<McpInstallResult> {
        if (!pendingMcpImport || pendingMcpImport.previewId !== input.previewId) {
          throw new Error("Import preview is invalid");
        }
        const selected = new Set(input.selected);
        const installed: McpServerDefinition[] = [];
        for (const row of pendingMcpImport.servers) {
          if (!selected.has(row.stored.name)) continue;
          const entry = { ...row.stored };
          if (pendingMcpImport.catalogId) {
            entry.provenance = "curated";
            entry.catalogId = pendingMcpImport.catalogId;
          } else {
            entry.provenance = "added";
          }
          if (entry.transport === "stdio") {
            const trusted =
              input.trustLocal === true || input.trustLocalCommands === true;
            if (!trusted) {
              throw new Error("Local MCP commands require explicit trust");
            }
            entry.trusted = true;
            entry.enabled = true;
          }
          ctx.mcpServers = upsertMcpServer(ctx.mcpServers, entry) as McpServerInfo[];
          installed.push(redactMcpServer(entry) as unknown as McpServerDefinition);
        }
        pendingMcpImport = null;
        return { installed };
      },
      async discardImport(input: { previewId: string }): Promise<void> {
        if (pendingMcpImport?.previewId === input.previewId) pendingMcpImport = null;
      },
    },
  };
}
