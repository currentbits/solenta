"use strict";

// Claude Agent SDK's initialize response exposes supportedModels before any
// user input. Never send a user frame, slash command, or generation prompt.
// Protocol: anthropics/claude-agent-sdk-python, _internal/query.py initialize.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("cross-spawn");
const { parseProviderRef, findInstance, defaultAccountFor, instanceEnv, threadExtraArgv } = require("./providerInstances.js");

const TTL_MS = 60_000;
const FAILURE_TTL_MS = 10_000;
const TIMEOUT_MS = 10_000;
const cache = new Map();
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function stamp(file) {
  try { const s = fs.statSync(file); return [s.size, s.mtimeMs]; } catch { return null; }
}

function scope(settings, ref, opts = {}) {
  const parsed = parseProviderRef(ref);
  if (parsed.provider !== "claude") return null;
  const id = parsed.instance || (opts.useDefault !== false ? defaultAccountFor(settings, "claude") : null);
  const inst = findInstance(settings, "claude", id || "claude");
  if (id && !inst) throw new Error("This Claude account was removed. Pick another account.");
  const home = opts.home || opts.env?.HOME || os.homedir();
  const env = { ...(opts.env || process.env), ...(inst ? instanceEnv(inst, home, opts.userDataPath) : {}) };
  const providers = require("./providers.js");
  // The normal runner resolves its binary from the process env before the
  // account overlay, so discovery must use exactly that executable too.
  const binary = providers.resolveBin(providers.getProvider("claude"), opts.env || process.env);
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || home, ".claude");
  const extraArgs = threadExtraArgv(settings, { provider: "claude", providerInstance: id });
  // Only configuration options may enter the discovery invocation. Positional
  // extra args could become a paid prompt; MCP/plugins/tools are irrelevant.
  const args = [];
  let inline = {};
  for (let i = 0; i < extraArgs.length; i++) {
    const [flag, ...rest] = extraArgs[i].split("=");
    if (flag !== "--settings" && flag !== "--setting-sources") continue;
    const value = rest.length ? rest.join("=") : extraArgs[++i];
    if (typeof value !== "string") throw new Error(`Missing ${flag} value`);
    if (flag === "--setting-sources") args.push(`${flag}=${value}`);
    else {
      if (!value.trim().startsWith("{") && !path.isAbsolute(value)) throw new Error("Use an absolute --settings path to discover Claude models. Showing the catalog.");
      const text = value.trim().startsWith("{") ? value : fs.readFileSync(value, "utf8");
      inline = { ...inline, ...JSON.parse(text) };
    }
  }
  args.push("--settings", JSON.stringify({ ...inline, disableAllHooks: true }));
  const identity = Object.entries(env).filter(([key]) => /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$|HOME$|PATH$)/.test(key)).sort(([a], [b]) => a.localeCompare(b));
  const key = createHash("sha256").update(JSON.stringify([
    binary, stamp(binary), home, configDir, id, identity, args,
    stamp(path.join(configDir, "settings.json")), stamp(path.join(configDir, ".credentials.json")),
    require("./providerAuth.js").account(id ? `claude:${id}` : "claude"),
  ])).digest("hex");
  return { key, binary, env, cwd: home, args };
}

function parseModels(rows, base) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Claude did not report a models list. Showing the catalog.");
  const models = new Map();
  const aliases = new Map();
  // Prefer a concrete row over its alias when both carry metadata.
  for (const row of rows.slice().sort((a, b) => Number(Boolean(a?.resolvedModel && a.value !== a.resolvedModel)) - Number(Boolean(b?.resolvedModel && b.value !== b.resolvedModel)))) {
    if (!row || typeof row.value !== "string" || !row.value.trim()) continue;
    const id = typeof row.resolvedModel === "string" && row.resolvedModel.trim() ? row.resolvedModel.trim() : row.value.trim();
    if (id.length > 100 || /[\r\n]/.test(id)) continue;
    aliases.set(row.value, id);
    if (models.has(id)) continue;
    const known = base.modelInfo.find((m) => m.id === id);
    const efforts = row.supportsEffort === false ? [] : Array.isArray(row.supportedEffortLevels)
      ? [...new Set(row.supportedEffortLevels.filter((v) => EFFORTS.has(v)))] : known?.efforts || [];
    models.set(id, {
      ...known, id, label: typeof row.displayName === "string" && row.displayName || known?.label || id,
      description: typeof row.description === "string" && row.description || known?.description || "", vendor: known?.vendor || (id.startsWith("claude-") ? "Anthropic" : ""),
      efforts, ...(typeof row.supportsFastMode === "boolean" ? { fast: row.supportsFastMode } : {}),
    });
  }
  if (!models.size) throw new Error("Claude did not report usable models. Showing the catalog.");
  return { models: [...models.keys()], modelInfo: [...models.values()], aliases: Object.fromEntries(aliases) };
}

function runInitialize(target, opts = {}) {
  return new Promise((resolve, reject) => {
    const requestId = "solenta-models";
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--tools", "", "--disable-slash-commands", ...target.args];
    const env = { ...target.env };
    // SDK children must not inherit the enclosing Claude session marker.
    delete env.CLAUDECODE;
    const child = (opts.spawn || spawn)(target.binary, args, { cwd: target.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let done = false;
    let buffer = "";
    let bytes = 0;
    const timer = setTimeout(() => finish(new Error("Claude model discovery timed out. Showing the catalog.")), opts.timeoutMs ?? TIMEOUT_MS);
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill();
      const killTimer = setTimeout(() => { if (child.exitCode == null) child.kill("SIGKILL"); }, 1000);
      killTimer.unref();
      if (error) reject(error); else resolve(value);
    }
    child.on("error", () => finish(new Error("Could not start Claude model discovery. Showing the catalog.")));
    child.on("close", () => finish(new Error("Claude model discovery ended without a models list. Showing the catalog.")));
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {}); // Never surface credential-bearing CLI diagnostics.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return finish(new Error("Claude model discovery response was too large."));
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== "control_response" || event.response?.request_id !== requestId) continue;
        if (event.response.subtype !== "success") return finish(new Error("This Claude CLI could not list models. Showing the catalog."));
        return finish(null, event.response.response?.models);
      }
    });
    // Leave stdin open until the response, with no user frame at any point.
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } }) + "\n");
  });
}

async function refresh(settings, ref, opts = {}) {
  const target = scope(settings, ref, opts);
  if (!target) return Promise.resolve(null);
  // Tests opt in with an injected runner; normal suites never start real CLIs.
  if (process.env.NODE_TEST_CONTEXT && !opts.runInitialize) return Promise.resolve(null);
  const hit = cache.get(target.key);
  const now = opts.now?.() ?? Date.now();
  if (hit?.pending) return hit.pending;
  if (!opts.force && hit && now - hit.at < (hit.error ? FAILURE_TTL_MS : TTL_MS)) return hit.error ? Promise.reject(hit.error) : Promise.resolve(hit.value);
  const providers = require("./providers.js");
  if (!providers.isBinAvailable(target.binary, opts.which, target.env)) return Promise.resolve(null);
  const pending = Promise.resolve().then(() => (opts.runInitialize || runInitialize)(target, opts))
    .then((rows) => {
      const value = parseModels(rows, providers.getProvider("claude"));
      cache.set(target.key, { at: opts.now?.() ?? Date.now(), value });
      return value;
    })
    .catch((error) => {
      cache.set(target.key, { at: opts.now?.() ?? Date.now(), value: hit?.value || null, error });
      throw error;
    });
  cache.set(target.key, { at: now, value: hit?.value || null, pending });
  return pending;
}

function cachedProvider(base, settings, ref, opts = {}) {
  let target;
  try { target = scope(settings, ref, opts); } catch { return base; }
  const value = target && cache.get(target.key)?.value;
  if (!value) return base;
  return { ...base, models: value.models.slice(), modelInfo: value.modelInfo.map((m) => ({ ...m })), modelAliases: value.aliases };
}

function started(settings, ref, opts = {}) {
  let target;
  try { target = scope(settings, ref, opts); } catch { return false; }
  return Boolean(target && cache.has(target.key));
}

function fallbackNote(settings, ref, opts = {}) {
  let target;
  try { target = scope(settings, ref, opts); } catch { return "Claude model discovery is unavailable. Showing the catalog."; }
  const hit = target && cache.get(target.key);
  return !hit?.error ? null : hit.value
    ? "Could not refresh Claude models. Showing the last list for this account."
    : "Claude model discovery is unavailable. Showing the catalog.";
}

function forThread(base, store, thread, opts = {}) {
  if (base?.id !== "claude") return base;
  if (projectFallback(store, thread, opts)) return base;
  const settings = typeof store.getSettings === "function" ? store.getSettings() : null;
  return cachedProvider(base, settings, thread.providerInstance ? `claude:${thread.providerInstance}` : "claude", {
    userDataPath: store.filePath ? path.dirname(store.filePath) : undefined, ...opts, useDefault: false,
  });
}

/** No discovery side effects for project env: the normal launch owns direnv. */
function projectFallback(store, thread, opts = {}) {
  const project = store.getProject?.(thread?.projectId);
  if (!project) return false;
  if (project.remoteHost || require("./wsl.js").wslTarget(project, opts.platform)) return true;
  const relevant = (env) => Object.keys(env || {}).some((key) => /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_)/.test(key));
  if (relevant(project.env)) return true;
  const effective = require("./repoConfig.js").effectiveCommands(project);
  if (relevant(effective.env)) return true;
  const cwd = thread.worktreePath || project.path;
  if (!cwd) return false;
  for (const root of new Set([cwd, project.path].filter(Boolean))) {
    for (const name of ["settings.json", "settings.local.json"]) {
      const file = path.join(root, ".claude", name);
      if (!fs.existsSync(file)) continue;
      try {
        const config = JSON.parse(fs.readFileSync(file, "utf8"));
        if (relevant(config.env) || config.model || config.availableModels) return true;
      } catch { return true; }
    }
  }
  if (relevant(require("./direnvEnv.js").direnvEnv(cwd))) return true;
  // An unevaluated .envrc may change the gateway/login. Read existence only;
  // do not execute project code just to open a model picker.
  let dir = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(dir, ".envrc"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

module.exports = { refresh, cachedProvider, forThread, projectFallback, started, fallbackNote, parseModels, runInitialize, reset: () => cache.clear(), TTL_MS };
