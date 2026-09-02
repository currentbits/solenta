"use strict";

/**
 * Per-run GROK_HOME overlay (issue #706).
 *
 * Grok has no `--mcp-config`. `grok mcp add --scope user` writes the
 * user-global ~/.grok/config.toml, so a Solenta grok turn in project A
 * shares MCP URLs with every other project (and races boot-time
 * registration). Overlay: symlink auth/sessions/plugins, copy the rest of
 * config.toml with `[mcp_servers.*]` replaced by Solenta servers bound to
 * this project. Never follow those symlinks on reclaim.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  injectGrokGuardrailHook,
  grokGuardrailHookCommand,
} = require("./grok-guardrail-hook.js");
const { guardrailsEnabled } = require("./guardrails.js");

/**
 * Auth/session/plugin files a per-run home must share with the user's real
 * grok home so `--resume` and login still work. config.toml stays OUT — that
 * is the contamination (MCP URLs, last-write-wins project bind).
 * @type {string[]}
 */
const GROK_HOME_LINKS = [
  "auth.json",
  "agent_id",
  "sessions",
  "installed-plugins",
  "marketplace-cache",
  "plugins",
  "hooks",
  "bin",
  "bundled",
  "models_cache.json",
  "completions",
];

function tomlEscape(value) {
  const s = String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (c === "\\") out += "\\\\";
    else if (c === '"') out += '\\"';
    else if (c === "\b") out += "\\b";
    else if (c === "\t") out += "\\t";
    else if (c === "\n") out += "\\n";
    else if (c === "\f") out += "\\f";
    else if (c === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += c;
    }
  }
  return out;
}

function tomlBareKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : `"${tomlEscape(key)}"`;
}

function linkOrSkip(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return;
  try {
    fs.symlinkSync(src, dst);
  } catch {
    // Windows without symlink privilege: isolation still holds; resume/auth
    // just will not share with the user's real home.
  }
}

/**
 * Drop tables that must not leak from the user's grok home into a Solenta
 * overlay: `[mcp_servers.*]`, `[compat.claude]`, `[compat.cursor]`, and
 * `disabled_mcp_servers` assignments.
 * @param {string} text
 * @returns {string}
 */
function stripGrokConfigForOverlay(text) {
  const skipHeader =
    /^\[(\[)?(mcp_servers\b|compat\.claude\b|compat\.cursor\b)/i;
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("[")) {
      skipping = skipHeader.test(t);
    }
    if (skipping) continue;
    if (/^disabled_mcp_servers\b/.test(t)) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * @param {Record<string, object>} mcpServers
 * @returns {string}
 */
function grokMcpToml(mcpServers) {
  const parts = [];
  for (const [name, entry] of Object.entries(mcpServers || {})) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "stdio" && typeof entry.cwd === "string" && entry.cwd) {
      continue;
    }
    const table = `mcp_servers.${name}`;
    parts.push(`[${table}]`);
    if (entry.type === "stdio") {
      parts.push(`command = "${tomlEscape(entry.command || "")}"`);
      const argv = Array.isArray(entry.args) ? entry.args : [];
      if (argv.length) {
        parts.push(
          `args = [${argv.map((a) => `"${tomlEscape(a)}"`).join(", ")}]`,
        );
      }
      const env =
        entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)
          ? entry.env
          : {};
      const envKeys = Object.keys(env);
      if (envKeys.length) {
        parts.push(`[${table}.env]`);
        for (const k of envKeys) {
          if (typeof env[k] !== "string") continue;
          parts.push(`${tomlBareKey(k)} = "\${${k}}"`);
        }
      }
    } else {
      parts.push(
        `transport = "${entry.type === "sse" ? "sse" : "http"}"`,
      );
      parts.push(`url = "${tomlEscape(entry.url || "")}"`);
      const headers =
        entry.headers &&
        typeof entry.headers === "object" &&
        !Array.isArray(entry.headers)
          ? entry.headers
          : {};
      const headerKeys = Object.keys(headers);
      if (headerKeys.length) {
        parts.push(`[${table}.headers]`);
        for (const k of headerKeys) {
          if (typeof headers[k] !== "string") continue;
          parts.push(`${tomlBareKey(k)} = "${tomlEscape(headers[k])}"`);
        }
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}

function writeSecretFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600, encoding: "utf8" });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dest
 * @param {string} opts.sourceHome
 * @param {Record<string, object>} [opts.mcpServers]
 * @param {false | { command?: string, timeout?: number }} [opts.guardrailHook]
 *   PreToolUse classifyTool hook (#812). false skips it (tests / kill switch).
 *   The gate is overlay config.toml — never GROK_HOME_LINKS "hooks".
 * @returns {string} dest
 */
function materializeGrokHome(opts) {
  const dest = String(opts.dest || "");
  const sourceHome = String(opts.sourceHome || "");
  if (!dest) throw new Error("materializeGrokHome: dest required");
  fs.mkdirSync(dest, { recursive: true });

  if (sourceHome && fs.existsSync(sourceHome)) {
    for (const name of GROK_HOME_LINKS) {
      linkOrSkip(path.join(sourceHome, name), path.join(dest, name));
    }
  }

  let base = "";
  const cfgSrc = sourceHome ? path.join(sourceHome, "config.toml") : "";
  if (cfgSrc && fs.existsSync(cfgSrc)) {
    try {
      base = stripGrokConfigForOverlay(fs.readFileSync(cfgSrc, "utf8"));
    } catch {
      base = "";
    }
  }

  const mcp = grokMcpToml(opts.mcpServers || {});
  const compat = [
    "[compat.claude]",
    "mcps = false",
    "",
    "[compat.cursor]",
    "mcps = false",
    "",
  ].join("\n");
  const chunks = [];
  if (base.trim()) chunks.push(base.replace(/\s+$/, ""));
  chunks.push(compat.trimEnd());
  if (mcp.trim()) chunks.push(mcp.replace(/\s+$/, ""));
  let toml = chunks.join("\n\n") + "\n";

  // #812: PreToolUse hook so classifyTool runs before grok `-p`
  // --always-approve executes a tool. Overlay config.toml only — never
  // write the gate through the GROK_HOME_LINKS "hooks" symlink (user
  // ~/.grok/hooks). Skip when the caller opts out or the process-wide
  // kill switch is off. Live 1.0.13 loads this table as
  // source.type=configToml (#826).
  if (opts.guardrailHook !== false && guardrailsEnabled()) {
    try {
      const spec =
        opts.guardrailHook && typeof opts.guardrailHook === "object"
          ? opts.guardrailHook
          : {};
      const hookDest = path.join(dest, "grok-guardrail-hook.js");
      const policyDest = path.join(dest, "guardrails.js");
      fs.copyFileSync(
        path.join(__dirname, "grok-guardrail-hook.js"),
        hookDest,
      );
      fs.copyFileSync(path.join(__dirname, "guardrails.js"), policyDest);
      const command =
        spec.command || grokGuardrailHookCommand({ hookPath: hookDest });
      const timeout = spec.timeout || 15;
      toml = injectGrokGuardrailHook(toml, command, timeout);
    } catch {
      // A hook write failure must not block the turn; stream notice remains.
    }
  }

  writeSecretFile(path.join(dest, "config.toml"), toml);
  return dest;
}

/**
 * True when the overlay must stay on disk: a grok child may still be
 * reading it. Matches worktree GC's live-thread skip.
 * @param {object | null | undefined} store
 * @param {string} threadId
 */
function isLiveGrokThread(store, threadId) {
  if (!store || typeof store.getThread !== "function") return false;
  const thread = store.getThread(threadId);
  if (!thread) return false;
  return thread.status === "working" || thread.status === "quota-wait";
}

/**
 * Remove `target` without following symlinks. Unlink a symlink (even one
 * pointing at a directory) instead of descending into the target — the
 * overlay's auth/sessions links go into ~/.grok.
 * @param {string} target
 */
function rmWithoutFollowing(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  for (const ent of entries) {
    const child = path.join(target, ent.name);
    if (ent.isSymbolicLink() || !ent.isDirectory()) {
      try {
        fs.unlinkSync(child);
      } catch {
        // best-effort
      }
    } else {
      rmWithoutFollowing(child);
    }
  }
  fs.rmdirSync(target);
}

/**
 * Reclaim stale GROK_HOME overlays (#706).
 *
 * One dir per thread that has ever run grok, under
 * `<userDataPath>/grok-homes/<threadId>/`. Called from scheduleRetention
 * so boot / archive / merge / the 6h sweeper pick them up — not a new
 * timer. Skips a thread that is currently working or in quota-wait.
 *
 * @param {object} opts
 * @param {string} [opts.userDataPath]
 * @param {{ getThread?: (id: string) => { status?: string } | null }} [opts.store]
 * @returns {{ removed: string[], skipped: string[] }}
 */
function reclaimGrokHomes(opts) {
  const userDataPath = String((opts && opts.userDataPath) || "");
  if (!userDataPath) return { removed: [], skipped: [] };
  const store = opts && opts.store;
  if (!store || typeof store.getThread !== "function") {
    return { removed: [], skipped: [] };
  }
  const base = path.join(userDataPath, "grok-homes");
  let baseStat;
  try {
    baseStat = fs.lstatSync(base);
  } catch (err) {
    if (err && err.code === "ENOENT") return { removed: [], skipped: [] };
    throw err;
  }
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    return { removed: [], skipped: [] };
  }

  const removed = [];
  const skipped = [];
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return { removed, skipped };
  }
  for (const name of names) {
    if (!name || name !== path.basename(name)) continue;
    const dest = path.join(base, name);
    if (isLiveGrokThread(store, name)) {
      skipped.push(dest);
      continue;
    }
    try {
      rmWithoutFollowing(dest);
      removed.push(dest);
    } catch {
      // housekeeping; a busy overlay is retried on the next pass
    }
  }
  return { removed, skipped };
}

module.exports = {
  materializeGrokHome,
  reclaimGrokHomes,
  stripGrokConfigForOverlay,
  grokMcpToml,
  GROK_HOME_LINKS,
};
