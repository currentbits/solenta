"use strict";

const { randomUUID, createHash } = require("node:crypto");
const { validateMcpServers, upsertMcpServer, sanitizeImportSecrets, RESERVED_MCP_NAMES, MCP_SERVER_NAME_RE } = require("./mcp.js");

const MAX_PROPOSALS = 10;
const MAX_BYTES = 16_384;
const TTL_MS = 24 * 60 * 60 * 1000;
const CONFIG_KEYS = new Set(["name", "transport", "url", "command", "args", "cwd", "envNames", "headerNames"]);

function publicProposal({ base, ...proposal }) {
  const reviewToken = createHash("sha256").update(JSON.stringify({ id: proposal.id, config: proposal.config, base })).digest("hex");
  return { ...proposal, reviewToken };
}

function ownership(store, thread) {
  const project = store.getProject(thread.projectId);
  if (!project || project.remoteHost) throw new Error("MCP proposals require a project on this computer");
  return { projectId: thread.projectId, path: project.path };
}

function fingerprint(store, thread, name) {
  return createHash("sha256").update(JSON.stringify({
    owner: ownership(store, thread), server: (store.getSettings().mcpServers || []).find((s) => s.name === name) || null,
  })).digest("hex");
}

function credentialNames(raw, label) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 32 || raw.some((n) => typeof n !== "string" || !n || n.length > 128)) {
    throw new Error(`Invalid MCP ${label} names`);
  }
  if (new Set(raw.map((n) => label === "header" ? n.toLowerCase() : n)).size !== raw.length) throw new Error(`Duplicate MCP ${label} names`);
  return [...raw];
}

function definition(config, secrets = {}) {
  const env = Object.fromEntries((config.envNames || []).map((name) => [name, secrets[`env:${name}`] || ""]));
  const headers = Object.fromEntries((config.headerNames || []).map((name) => [name, secrets[`header:${name}`] || ""]));
  return validateMcpServers([config.transport === "stdio" ? {
    name: config.name, transport: "stdio", command: config.command, args: config.args ?? [],
    cwd: config.cwd, env, enabled: false, trusted: false,
  } : {
    name: config.name, transport: config.transport, url: config.url, headers, enabled: false,
  }])[0];
}

function cleanConfig(raw, action) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MCP configuration is required");
  if (Object.keys(raw).some((key) => !CONFIG_KEYS.has(key))) throw new Error("Use credential names only; secret values are entered in the desktop review");
  if (typeof raw.name !== "string" || !MCP_SERVER_NAME_RE.test(raw.name) || raw.name.length > 64 || RESERVED_MCP_NAMES.has(raw.name)) {
    throw new Error("Invalid or reserved MCP server name");
  }
  if (action === "remove") return { name: raw.name };
  const config = { ...raw, envNames: credentialNames(raw.envNames, "environment"), headerNames: credentialNames(raw.headerNames, "header") };
  if (config.transport === "stdio" && (config.headerNames.length || config.url)) throw new Error("Local MCP proposals use environment names, not HTTP fields");
  if (config.transport !== "stdio" && (config.envNames.length || config.command || config.args || config.cwd)) throw new Error("HTTP MCP proposals cannot contain local command fields");
  // Nonempty placeholders let the existing validator check every credential key.
  const placeholders = Object.fromEntries([
    ...config.envNames.map((n) => [`env:${n}`, "placeholder"]),
    ...config.headerNames.map((n) => [`header:${n}`, "placeholder"]),
  ]);
  const validated = definition(config, placeholders);
  config.transport = validated.transport;
  if (validated.transport === "stdio") {
    config.command = validated.command;
    config.args = validated.args;
  }
  if (validated.url) {
    const url = new URL(validated.url);
    if (url.search || url.hash) throw new Error("MCP proposal URLs cannot contain a query or fragment; supply authentication in headers during review");
    config.url = validated.url;
  }
  if (Buffer.byteLength(JSON.stringify(config)) > MAX_BYTES) throw new Error("MCP proposal exceeds 16 KiB");
  return JSON.parse(JSON.stringify(config));
}

function createProposal(store, input) {
  const thread = store.getThread(input.threadId);
  if (!thread || Number.isFinite(thread.trashedAt) || thread.projectId !== input.projectId) throw new Error("MCP proposal thread/project does not match");
  if (input.action !== "add" && input.action !== "remove") throw new Error("MCP proposal action must be add or remove");
  const config = cleanConfig(input.config, input.action);
  const current = store.getSettings().mcpServers || [];
  const exists = current.some((server) => server.name === config.name);
  if (input.action === "add" && exists) throw new Error("MCP server already exists; edit it in connector settings");
  if (input.action === "remove" && !exists) throw new Error("MCP server does not exist");
  const base = fingerprint(store, thread, config.name);
  const rows = thread.mcpProposals || [];
  const duplicate = rows.find((p) => p.status === "pending" && p.base === base &&
    p.action === input.action && JSON.stringify(p.config) === JSON.stringify(config) && Date.now() - p.at < TTL_MS);
  if (duplicate) return publicProposal(duplicate);
  if (rows.filter((p) => p.status === "pending" && Date.now() - p.at < TTL_MS).length >= MAX_PROPOSALS) throw new Error("Review or dismiss pending MCP proposals first");
  const proposal = { id: randomUUID(), action: input.action, config, status: "pending", at: Date.now(), base };
  // Resolved/expired history may be dropped; never evict an active proposal.
  const active = rows.filter((p) => p.status === "pending" && Date.now() - p.at < TTL_MS);
  const history = rows.filter((p) => !active.includes(p));
  const keep = MAX_PROPOSALS - active.length - 1;
  const next = [...(keep ? history.slice(-keep) : []), ...active, proposal];
  store.updateThread(thread.id, { mcpProposals: next.slice(-MAX_PROPOSALS) });
  store.save();
  return publicProposal(proposal);
}

// All checks and the settings/proposal writes are synchronous: two approvals
// cannot interleave between the fingerprint check and the registry update.
function resolveProposal(ctx, input) {
  if (ctx.transport !== "desktop") throw new Error("Review MCP proposals in the desktop app on the owning computer");
  const thread = ctx.store.getThread(input?.threadId);
  const proposal = thread && !Number.isFinite(thread.trashedAt) ? thread.mcpProposals?.find((p) => p.id === input?.proposalId) : null;
  if (!proposal || proposal.status !== "pending") throw new Error("MCP proposal is missing or already resolved");
  if (input.resolution !== "approved" && input.resolution !== "dismissed") throw new Error("Invalid MCP proposal resolution");
  const update = (status) => {
    const next = { ...proposal, status };
    ctx.store.updateThread(thread.id, { mcpProposals: thread.mcpProposals.map((p) => p.id === proposal.id ? next : p) });
    ctx.store.save();
    return publicProposal(next);
  };
  if (input.resolution === "dismissed") return update("dismissed");
  if (input.reviewToken !== publicProposal(proposal).reviewToken) throw new Error("MCP proposal changed after review; review it again");
  let currentBase;
  try { currentBase = fingerprint(ctx.store, thread, proposal.config.name); } catch { /* owner changed */ }
  if (currentBase !== proposal.base || Date.now() - proposal.at > TTL_MS || proposal.at > Date.now()) {
    update("stale");
    throw new Error("MCP configuration, owning project or proposal age changed; request a fresh proposal");
  }
  const current = ctx.store.getSettings().mcpServers || [];
  let next;
  if (proposal.action === "remove") {
    next = current.filter((server) => server.name !== proposal.config.name);
  } else {
    const config = cleanConfig(proposal.config, "add");
    if (config.transport === "stdio" && input.trustLocal !== true) throw new Error("Review and trust the local MCP command before approving");
    const secrets = sanitizeImportSecrets(input.secrets);
    for (const key of [...config.envNames.map((n) => `env:${n}`), ...config.headerNames.map((n) => `header:${n}`)]) {
      if (!secrets[key]) throw new Error("Fill every credential field in the desktop review");
    }
    const server = definition(config, secrets);
    next = upsertMcpServer(current, { ...server, enabled: true, ...(server.transport === "stdio" ? { trusted: true } : {}) });
  }
  ctx.store.setSettings({ mcpServers: next }, { replaceMcpServers: true });
  return update("approved");
}

module.exports = { createProposal, resolveProposal, publicProposal, TTL_MS };
