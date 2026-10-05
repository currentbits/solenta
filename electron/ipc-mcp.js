"use strict";

const services = require("./services.js");
const { syncUserMcpServers } = require("./memory-sup.js");
const {
  redactMcpServer,
  redactMcpServers,
  upsertMcpServer,
  sanitizeMcpInput,
} = require("./mcp.js");
const mcpCatalog = require("./mcpCatalog.js");
const mcpImports = require("./mcpImports.js");
const pairing = require("./pairing.js");

/** IPC_HANDLERS rows for mcp:*, pairing:*; ipc.js spreads them in. */
module.exports = {
  "mcp:list": async (ctx) => {
    const settings = services.getSettings(ctx.store);
    return redactMcpServers(settings.mcpServers);
  },
  // No await/yield between get/upsert/set: this async handler runs
  // synchronously until return, so concurrent IPC cannot interleave the
  // in-memory store write. store.save() only debounces disk I/O.
  "mcp:save": async (ctx, input) => {
    const clean = sanitizeMcpInput(input);
    const current = services.getSettings(ctx.store).mcpServers;
    const nextList = upsertMcpServer(current, clean);
    const next = services.setSettings(
      ctx.store,
      { mcpServers: nextList },
      { replaceMcpServers: true },
    );
    try {
      syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
    } catch {
      // ignore
    }
    const saved = next.mcpServers.find((s) => s.name === clean.name);
    return redactMcpServer(saved);
  },
  "mcp:remove": async (ctx, input) => {
    const name =
      input && typeof input.name === "string" ? input.name.trim() : "";
    const current = services.getSettings(ctx.store).mcpServers;
    const nextList = current.filter((s) => s.name !== name);
    const next = services.setSettings(ctx.store, { mcpServers: nextList });
    try {
      syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
    } catch {
      // ignore
    }
  },
  "mcp:setEnabled": async (ctx, input) => {
    const name =
      input && typeof input.name === "string" ? input.name.trim() : "";
    const enabled = Boolean(input && input.enabled);
    const current = services.getSettings(ctx.store).mcpServers;
    const existing = current.find((s) => s.name === name);
    if (!existing) throw new Error(`Unknown MCP server: ${name}`);
    if (
      existing.transport === "stdio" &&
      enabled &&
      existing.trusted !== true
    ) {
      throw new Error("Local MCP server must be trusted to enable");
    }
    const nextList = current.map((s) =>
      s.name === name ? { ...s, enabled } : s,
    );
    const next = services.setSettings(ctx.store, { mcpServers: nextList });
    try {
      syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
    } catch {
      // ignore
    }
    const saved = next.mcpServers.find((s) => s.name === name);
    return redactMcpServer(saved);
  },
  "mcp:catalog": async (ctx) => {
    const settings = services.getSettings(ctx.store);
    return mcpCatalog.listCatalog({ servers: settings.mcpServers });
  },
  "mcp:pickImport": async (ctx) => {
    const current = services.getSettings(ctx.store).mcpServers;
    return mcpImports.pickImport({
      userDataPath: ctx.userDataPath,
      dialog: ctx.dialog,
      current,
    });
  },
  "mcp:previewImport": async (ctx, input) => {
    const request = input && typeof input === "object" ? input : {};
    let source = {};
    if (request.kind === "json") {
      source = { kind: "json", text: request.text };
    } else if (request.kind === "catalog") {
      source = { kind: "catalog", id: request.id };
    } else if (request.kind === "github") {
      source = { kind: "github", url: request.url };
    }
    const current = services.getSettings(ctx.store).mcpServers;
    return mcpImports.previewImport({
      userDataPath: ctx.userDataPath,
      input: source,
      current,
    });
  },
  "mcp:installImport": async (ctx, input) => {
    const request = input && typeof input === "object" ? input : {};
    const current = services.getSettings(ctx.store).mcpServers;
    const result = await mcpImports.installImport({
      userDataPath: ctx.userDataPath,
      current,
      request: {
        previewId: request.previewId,
        selected: request.selected,
        replace: request.replace,
        trustLocal: request.trustLocal === true,
        trustLocalCommands: request.trustLocalCommands === true,
        secrets: request.secrets,
      },
      save: (nextList) => {
        const next = services.setSettings(
          ctx.store,
          { mcpServers: nextList },
          { replaceMcpServers: true },
        );
        try {
          syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
        } catch {
          // ignore
        }
        return next.mcpServers;
      },
    });
    return { installed: result.installed };
  },
  "mcp:discardImport": async (ctx, input) => {
    return mcpImports.discardImport({
      userDataPath: ctx.userDataPath,
      previewId: input && input.previewId,
    });
  },
  "pairing:list": async (ctx) => {
    return pairing.listPairings(ctx.userDataPath, {
      getOrchStatus: ctx.getOrchStatus,
    });
  },
  "pairing:create": async (ctx, input) => {
    return pairing.createPairing(ctx.userDataPath, input || {}, {
      getOrchStatus: ctx.getOrchStatus,
    });
  },
  "pairing:revoke": async (ctx, input) => {
    const id = input && typeof input.id === "string" ? input.id : "";
    return pairing.revokePairing(ctx.userDataPath, id);
  },
  "pairing:approve": async (ctx, input) => {
    const threadId =
      input && typeof input.threadId === "string" ? input.threadId : "";
    return pairing.approveExternalRun(
      {
        store: ctx.store,
        runner: ctx.runner,
        broadcast: ctx.broadcast,
      },
      threadId,
    );
  },
  "pairing:reject": async (ctx, input) => {
    const threadId =
      input && typeof input.threadId === "string" ? input.threadId : "";
    return pairing.rejectExternalRun(
      {
        store: ctx.store,
        broadcast: ctx.broadcast,
      },
      threadId,
    );
  },
};
