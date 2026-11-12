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
const xcodeMcp = require("./xcodeMcp.js");
const pairing = require("./pairing.js");
const oauth = require("./mcpOauth.js");
const oauthClient = require("./mcpOauthClient.js");
const { listServerTools } = require("./mcpTools.js");
const { MCP_TOOL_NAME_RE } = require("./mcp.js");

function requireDesktopPairing(ctx) {
  if (ctx.transport !== "desktop") {
    throw new Error("MCP public access and OAuth consent require the desktop app.");
  }
}

function inputName(input) {
  return input && typeof input.name === "string" ? input.name.trim() : "";
}

function remoteServer(ctx, name) {
  const row = services.getSettings(ctx.store).mcpServers.find((s) => s.name === name);
  if (!row) throw new Error(`Unknown MCP server: ${name}`);
  if (row.transport === "stdio") throw new Error("Only remote MCP servers sign in");
  return row;
}

/**
 * Rewrite one stored row (secrets included, so replace, not merge) and
 * re-sync every provider so a new token reaches the next run.
 * @param {(row: object) => object} patch
 */
function saveServerRow(ctx, name, patch) {
  const current = services.getSettings(ctx.store).mcpServers;
  if (!current.some((s) => s.name === name)) throw new Error(`Unknown MCP server: ${name}`);
  const next = services.setSettings(
    ctx.store,
    { mcpServers: current.map((s) => (s.name === name ? patch(s) : s)) },
    { replaceMcpServers: true },
  );
  try {
    syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
  } catch {
    // ignore
  }
  return redactMcpServer(next.mcpServers.find((s) => s.name === name));
}

function defaultOpenExternal(url) {
  const { shell } = require("electron");
  return shell.openExternal(url);
}

/**
 * Refresh every OAuth token close to expiry (#1720). main.js runs this on a
 * timer; mcp:listTools runs it first. A token the server rejects outright
 * loses its refresh token (shows "Sign-in expired"); a network blip keeps
 * it for the next pass.
 */
async function refreshMcpTokens(ctx, opts = {}) {
  const now = opts.now || Date.now;
  const due = services
    .getSettings(ctx.store)
    .mcpServers.filter((s) => s.oauth && oauthClient.needsRefresh(s.oauth, now()));
  for (const s of due) {
    try {
      const record = await oauthClient.refresh(s.oauth, {
        serverUrl: s.url,
        fetchFn: opts.fetchFn,
        now,
      });
      saveServerRow(ctx, s.name, (row) => (row.url === s.url ? { ...row, oauth: record } : row));
    } catch (err) {
      if (ctx.log) ctx.log(`mcp: token refresh for ${s.name} failed: ${err && err.message}`);
      if (err && (err.errorCode || /connect again/.test(String(err.message)))) {
        saveServerRow(ctx, s.name, (row) => {
          if (!row.oauth) return row;
          const { refreshToken: _drop, ...rest } = row.oauth;
          return { ...row, oauth: rest };
        });
      }
    }
  }
}

function emptyFunnel() {
  return { installed: false, loggedIn: false, host: null, serving: false, url: null };
}

async function listWithPublic(ctx) {
  const listed = pairing.listPairings(ctx.userDataPath, {
    getOrchStatus: ctx.getOrchStatus,
  });
  const funnelFn = ctx.getMcpFunnel && ctx.getMcpFunnel();
  const port = listed.server.port;
  const funnel = funnelFn && typeof funnelFn.status === "function"
    ? await funnelFn.status(port)
    : emptyFunnel();
  listed.server.publicEnabled = pairing.getPublicEnabled(ctx.userDataPath);
  listed.server.publicUrl = funnel.serving && funnel.url ? `${String(funnel.url).replace(/\/$/, "")}/mcp` : null;
  listed.server.funnel = funnel;
  return listed;
}

/** IPC_HANDLERS rows for mcp:*, pairing:*; ipc.js spreads them in. */
const handlers = {
  "mcp:resolveProposal": async (ctx, input) => {
    try {
      const result = require("./mcpProposals.js").resolveProposal(ctx, input);
      if (result.status === "approved") {
        syncUserMcpServers(ctx.store.getSettings().mcpServers, { userDataPath: ctx.userDataPath });
      }
      return result;
    } finally {
      try { if (input?.threadId) ctx.runner?.refreshDetail?.(input.threadId); } catch { /* next detail read recovers */ }
    }
  },
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
  // #1720: MCP authorization flow for a remote server. Resolves once the
  // browser comes back (or Cancel / 5 min timeout rejects it).
  "mcp:oauthConnect": async (ctx, input) => {
    requireDesktopPairing(ctx);
    const name = inputName(input);
    const row = remoteServer(ctx, name);
    const record = await oauthClient.connect({
      name,
      serverUrl: row.url,
      transport: row.transport,
      openExternal: ctx.openExternal || defaultOpenExternal,
      fetchFn: ctx.fetchFn,
    });
    return saveServerRow(ctx, name, (s) => {
      if (s.url !== row.url) throw new Error("The server URL changed during sign-in");
      return { ...s, oauth: record };
    });
  },
  "mcp:oauthCancel": async (_ctx, input) => {
    return { cancelled: oauthClient.cancel(inputName(input)) };
  },
  "mcp:oauthDisconnect": async (ctx, input) => {
    const name = inputName(input);
    remoteServer(ctx, name);
    return saveServerRow(ctx, name, (s) => {
      const { oauth: _drop, ...rest } = s;
      return rest;
    });
  },
  // #1720: connect, initialize, tools/list, close (10 s limit).
  "mcp:listTools": async (ctx, input) => {
    const name = inputName(input);
    await refreshMcpTokens(ctx);
    const row = services.getSettings(ctx.store).mcpServers.find((s) => s.name === name);
    if (!row) throw new Error(`Unknown MCP server: ${name}`);
    return { tools: await (ctx.listServerTools || listServerTools)(row) };
  },
  // #1720: per-tool allow / ask / deny; null clears back to the default.
  "mcp:setToolRule": async (ctx, input) => {
    const name = inputName(input);
    const tool = input && typeof input.tool === "string" ? input.tool : "";
    const action = input ? input.action : undefined;
    if (!MCP_TOOL_NAME_RE.test(tool)) throw new Error("Invalid MCP tool name");
    if (action !== null && !["allow", "ask", "deny"].includes(action)) {
      throw new Error("Tool rule must be allow, ask, deny or null");
    }
    return saveServerRow(ctx, name, (s) => {
      const rules = { ...(s.toolRules || {}) };
      if (action === null) delete rules[tool];
      else rules[tool] = action;
      return { ...s, toolRules: rules };
    });
  },
  "mcp:xcodeStatus": async (ctx, input) => {
    const projectPath = input && typeof input.projectPath === "string" ? input.projectPath : "";
    return xcodeMcp.xcodeMcpStatus(projectPath, services.getSettings(ctx.store).mcpServers);
  },
  "mcp:pairXcode": async (ctx, input) => {
    const projectPath = input && typeof input.projectPath === "string" ? input.projectPath : "";
    const current = services.getSettings(ctx.store).mcpServers;
    const clean = xcodeMcp.xcodePairInput(projectPath, current);
    const next = services.setSettings(
      ctx.store,
      { mcpServers: upsertMcpServer(current, clean) },
      { replaceMcpServers: true },
    );
    try {
      syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
    } catch {
      // ignore
    }
    return redactMcpServer(next.mcpServers.find((s) => s.name === clean.name));
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
    return listWithPublic(ctx);
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
  "pairing:setPublic": async (ctx, input) => {
    requireDesktopPairing(ctx);
    const on = Boolean(input && input.on);
    const listed = pairing.listPairings(ctx.userDataPath, {
      getOrchStatus: ctx.getOrchStatus,
    });
    const funnelFn = ctx.getMcpFunnel && ctx.getMcpFunnel();
    if (!funnelFn) throw new Error("MCP public access is not available.");
    if (on && !(listed.server && listed.server.running && listed.server.port)) {
      throw new Error("Solenta is not serving MCP right now. Keep the app open.");
    }
    pairing.setPublicEnabled(ctx.userDataPath, on);
    try {
      await funnelFn.set({ on, port: listed.server.port });
    } catch (err) {
      pairing.setPublicEnabled(ctx.userDataPath, false);
      throw err;
    }
    return listWithPublic(ctx);
  },
  "pairing:listConsents": async (ctx) => {
    requireDesktopPairing(ctx);
    return oauth.listConsents();
  },
  "pairing:approveConsent": async (ctx, input) => {
    requireDesktopPairing(ctx);
    const id = input && typeof input.id === "string" ? input.id : "";
    return oauth.approveConsent(ctx.userDataPath, id, input || {}, {
      getOrchStatus: ctx.getOrchStatus,
    });
  },
  "pairing:denyConsent": async (ctx, input) => {
    requireDesktopPairing(ctx);
    const id = input && typeof input.id === "string" ? input.id : "";
    return oauth.denyConsent(id);
  },
};

module.exports = handlers;
// Not a channel: ipc.js spreads the enumerable keys into IPC_HANDLERS.
Object.defineProperty(module.exports, "refreshMcpTokens", { value: refreshMcpTokens });
