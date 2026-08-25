"use strict";

/**
 * Main-process curated MCP catalog. Renderer looks up by id only; commands
 * and URLs never come from the client.
 */

/** @typedef {{ name: string, transport: "http" | "sse" | "stdio", url?: string, command?: string, args?: string[], enabled?: boolean, trusted?: boolean }} McpCatalogDefinition */

/**
 * @type {readonly {
 *   id: string,
 *   name: string,
 *   description: string,
 *   publisher: string,
 *   homepage: string,
 *   transport: "http" | "sse" | "stdio",
 *   risk: string,
 *   requiredSecrets: readonly string[],
 *   definition: McpCatalogDefinition,
 * }[]}
 */
const CATALOG = Object.freeze([
  Object.freeze({
    id: "context7",
    name: "Context7",
    description:
      "Up-to-date library documentation and code examples for LLMs over a remote MCP endpoint.",
    publisher: "Upstash",
    homepage: "https://context7.com",
    transport: "http",
    risk: "Remote HTTP endpoint. Review the vendor before sending repository context.",
    requiredSecrets: Object.freeze([]),
    definition: Object.freeze({
      name: "context7",
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      enabled: true,
    }),
  }),
  Object.freeze({
    id: "linear",
    name: "Linear",
    description: "Linear issue tracking and project management over a remote MCP endpoint.",
    publisher: "Linear",
    homepage: "https://linear.app",
    transport: "http",
    risk: "Remote HTTP with OAuth. No static secret is stored; complete Linear's OAuth flow.",
    requiredSecrets: Object.freeze([]),
    definition: Object.freeze({
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      enabled: true,
    }),
  }),
  Object.freeze({
    id: "playwright",
    name: "Playwright",
    description: "Browser automation via the Playwright MCP server. Runs a local npx command.",
    publisher: "Microsoft",
    homepage: "https://playwright.dev",
    transport: "stdio",
    risk: "Local stdio via npx. Explicit trust is required before the command can run.",
    requiredSecrets: Object.freeze([]),
    definition: Object.freeze({
      name: "playwright",
      transport: "stdio",
      command: "npx",
      args: Object.freeze(["-y", "@playwright/mcp@latest"]),
      enabled: false,
      trusted: false,
    }),
  }),
]);

/**
 * @param {unknown} id
 * @returns {(typeof CATALOG)[number] | null}
 */
function getCatalogEntry(id) {
  const key = typeof id === "string" ? id.trim() : "";
  if (!key) return null;
  return CATALOG.find((entry) => entry.id === key) || null;
}

/**
 * @param {{ servers?: Array<{ provenance?: string, catalogId?: string }> }} [opts]
 */
function listCatalog(opts = {}) {
  const installedIds = new Set();
  for (const row of opts.servers || []) {
    if (
      row &&
      row.provenance === "curated" &&
      typeof row.catalogId === "string" &&
      row.catalogId
    ) {
      installedIds.add(row.catalogId);
    }
  }
  return CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    publisher: entry.publisher,
    homepage: entry.homepage,
    transport: entry.transport,
    risk: entry.risk,
    requiredSecrets: [...entry.requiredSecrets],
    installed: installedIds.has(entry.id),
  }));
}

module.exports = {
  CATALOG,
  getCatalogEntry,
  listCatalog,
};
