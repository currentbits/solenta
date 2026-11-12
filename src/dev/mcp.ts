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
  McpToolAction,
  McpToolInfo,
} from "../shared/ipc";
import {
  parseMcpConfigDocument,
  redactMcpServer,
  redactMcpServers,
  upsertMcpServer,
} from "../shared/mcpModel.ts";
import type { DevCtx } from "./context.ts";
import { DEV_MCP_CATALOG_DATA } from "./mcpCatalogData.ts";

/** Browser-twin row of the main-process catalog (electron/mcpCatalog.js). */
export interface DevMcpCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  publisher: string;
  homepage: string;
  sourceUrl: string;
  transport: "http" | "sse" | "stdio";
  auth: "oauth" | "key" | "none";
  risk: string;
  requiredSecrets: Array<{ id: string; label: string }>;
  definition: Record<string, unknown>;
}

export const DEV_MCP_CATALOG: readonly DevMcpCatalogEntry[] = DEV_MCP_CATALOG_DATA;

function summaryOf(def: Record<string, unknown>): string {
  return def.transport === "stdio"
    ? [def.command, ...((def.args as string[]) || [])].join(" ")
    : String(def.url);
}

/** Public catalog rows with `installed` derived from the curated servers. */
export function devMcpCatalogRows(
  servers: ReadonlyArray<{ name?: string; provenance?: string; catalogId?: string }>,
): McpCatalogEntry[] {
  const installed = new Map<string, string>();
  for (const s of servers) {
    if (s.provenance === "curated" && s.catalogId) installed.set(s.catalogId, s.name ?? "");
  }
  return DEV_MCP_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    publisher: entry.publisher,
    homepage: entry.homepage,
    sourceUrl: entry.sourceUrl,
    transport: entry.transport,
    auth: entry.auth,
    risk: entry.risk,
    summary: summaryOf(entry.definition),
    requiredSecrets: entry.requiredSecrets.map((r) => ({ ...r })),
    installed: installed.has(entry.id),
    ...(installed.get(entry.id) ? { installedName: installed.get(entry.id) } : {}),
  }));
}

/** Fixture tools so browser dev can show the per-tool rules UI. */
export function devMcpTools(name: string): McpToolInfo[] {
  return [
    { name: "search", description: `Search ${name}` },
    { name: "read_item", description: "Read one item by id" },
    { name: "create_item", description: "Create a new item" },
    { name: "delete_item", description: "Delete an item permanently" },
  ];
}

export function withToolRule<T extends { toolRules?: Record<string, McpToolAction> }>(
  s: T,
  tool: string,
  action: McpToolAction | null,
): T {
  const rules = { ...(s.toolRules || {}) };
  if (action === null) delete rules[tool];
  else rules[tool] = action;
  return { ...s, toolRules: rules };
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
      async resolveProposal() { throw new Error("MCP proposals require the owning desktop app"); },
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
      async xcodeStatus() {
        return null;
      },
      async pairXcode(): Promise<McpServerDefinition> {
        throw new Error("Xcode pairing needs the desktop app.");
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
      // Browser dev has no loopback or shell: pretend the sign-in succeeded.
      async oauthConnect(input: { name: string }): Promise<McpServerDefinition> {
        ctx.mcpServers = ctx.mcpServers.map((s) =>
          s.name === input.name && s.transport !== "stdio"
            ? { ...s, oauth: { accessToken: "dev", refreshToken: "dev", expiresAt: Date.now() + 3_600_000 } }
            : s,
        ) as McpServerInfo[];
        const saved = ctx.mcpServers.find((s) => s.name === input.name);
        if (!saved) throw new Error(`Unknown MCP server: ${input.name}`);
        return redactMcpServer(saved) as unknown as McpServerDefinition;
      },
      async listTools(input: { name: string }) {
        if (!ctx.mcpServers.some((s) => s.name === input.name)) {
          throw new Error(`Unknown MCP server: ${input.name}`);
        }
        return { tools: devMcpTools(input.name) };
      },
      async setToolRule(input: {
        name: string;
        tool: string;
        action: McpToolAction | null;
      }): Promise<McpServerDefinition> {
        ctx.mcpServers = ctx.mcpServers.map((s) =>
          s.name === input.name ? withToolRule(s, input.tool, input.action) : s,
        );
        const saved = ctx.mcpServers.find((s) => s.name === input.name);
        if (!saved) throw new Error(`Unknown MCP server: ${input.name}`);
        return redactMcpServer(saved) as unknown as McpServerDefinition;
      },
      async oauthCancel(): Promise<{ cancelled: boolean }> {
        return { cancelled: false };
      },
      async oauthDisconnect(input: { name: string }): Promise<McpServerDefinition> {
        ctx.mcpServers = ctx.mcpServers.map((s) => {
          if (s.name !== input.name) return s;
          const { oauth: _drop, ...rest } = s as McpServerInfo & { oauth?: unknown };
          return rest;
        }) as McpServerInfo[];
        const saved = ctx.mcpServers.find((s) => s.name === input.name);
        if (!saved) throw new Error(`Unknown MCP server: ${input.name}`);
        return redactMcpServer(saved) as unknown as McpServerDefinition;
      },
    },
  };
}
