"use strict";

/**
 * Named provider instances (#453 / #1512 I1): extra configurations of an
 * installed CLI, e.g. "Claude (work)" with its own config dir and env.
 *
 * A thread stores the base id in `provider` (every capability check keys on
 * it) and the instance id in `providerInstance`. Places that hold a provider
 * as one string (picker rows, agent profiles, defaults, the failover chain)
 * use a ref: `claude` or `claude:<instanceId>`.
 *
 * The overlay env is built per spawn and never written to process.env, so
 * one instance's config dir or keys cannot reach another provider's child.
 *
 * `generic` (#458) has no base row: each instance IS a user-defined CLI
 * (argv + env), run best-effort through runner-provider-generic.js with the
 * prompt appended last and raw stdout as the transcript.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * The env var each CLI reads its config dir from. Checked against claude
 * 2.1.283 and codex 0.159.2: pointed at an empty dir both report signed out.
 */
const CONFIG_DIR_ENV = Object.freeze({
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
});

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_MAX = 40;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Extra launch arguments (#1780): flags Solenta itself controls, so a user
 * value cannot change the protocol a normal run depends on. Checked as
 * exact tokens and as the `flag=value` form; everything else is free.
 * claude: print/stream shape and resume identity. codex: the interactive
 * app-server subcommand itself (runner-provider-codex.js hand-builds that
 * argv; extraArgs only ever joins the end of it).
 */
const EXTRA_ARGS_DENYLIST = Object.freeze({
  claude: ["-p", "--print", "--output-format", "--input-format", "--resume", "--session-id"],
  codex: ["app-server", "--listen", "exec", "resume"],
});

/**
 * Providers whose base row can carry its own env (#1714): an instance whose
 * id equals the provider id, e.g. `{ id: "claude", provider: "claude" }`.
 * It is never a picker row; its env (an API key, a base URL) rides every
 * local run of the base provider. Only providers whose runner applies it.
 */
const BASE_ENV_PROVIDERS = Object.freeze(["claude", "codex", "cursor", "grok"]);

/**
 * Env var an OpenAI-compatible provider's key is stored under (#1714). The
 * opencode config references it as `{env:...}`, so the key stays in the
 * sealed instance env and never lands in the config JSON.
 */
const OPENAI_COMPAT_KEY_ENV = "SOLENTA_OPENAI_COMPAT_API_KEY";

/** @param {{ id: string, provider: string }} inst */
function isBaseOverlay(inst) {
  return inst.id === inst.provider;
}

/** @param {unknown} v */
function isHttpUrl(v) {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @typedef {object} ProviderInstance
 * @property {string} id
 * @property {string} name
 * @property {string} provider
 * @property {string | null} configDir
 * @property {boolean} [isolatedHome] - claude/codex only (#1808): an
 *   exclusive home under Solenta's userData instead of configDir, with no
 *   sharing back to the real CLI home
 * @property {Record<string, string>} env
 * @property {string[]} [extraArgs] - appended to a normal run's argv
 *   (#1780), filtered against EXTRA_ARGS_DENYLIST at parse time
 * @property {string[]} [command] - generic only: argv, binary first
 * @property {string[]} [fullAccessArgs] - generic only: appended in
 *   bypassPermissions; empty means the CLI handles permissions itself
 * @property {string | null} [cwd] - generic only: working folder; relative
 *   resolves inside the thread's worktree, null is the worktree itself
 * @property {"stdout" | "pty" | "acp"} [transcript] - generic only: plain
 *   pipes, a pseudo-terminal for CLIs that need a TTY, or an Agent Client
 *   Protocol agent over stdio (#272)
 * @property {OpenAiCompat} [openaiCompatible] - opencode only (#1714): a
 *   custom OpenAI-compatible endpoint run through opencode's config
 */

/**
 * @typedef {object} OpenAiCompat
 * @property {string} baseUrl
 * @property {string | null} modelsUrl
 * @property {string[]} models
 * @property {string | null} defaultModel
 * @property {Record<string, string>} headers
 */

/**
 * Named instances: claude/codex config dirs, custom CLIs, and opencode
 * OpenAI-compatible endpoints (#1714).
 * @param {string} id
 */
function supportsInstances(id) {
  return (
    id === "generic" ||
    id === "opencode" ||
    Object.prototype.hasOwnProperty.call(CONFIG_DIR_ENV, id)
  );
}

/**
 * @param {unknown} raw
 * @param {(msg: string) => null} fail
 * @returns {OpenAiCompat | null}
 */
function parseOpenAiCompat(raw, fail) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("An OpenAI-compatible provider needs a base URL");
  }
  const rec = /** @type {Record<string, unknown>} */ (raw);
  const baseUrl = typeof rec.baseUrl === "string" ? rec.baseUrl.trim() : "";
  if (!isHttpUrl(baseUrl)) return fail("Base URL must be an http(s) URL");
  const modelsUrlRaw = typeof rec.modelsUrl === "string" ? rec.modelsUrl.trim() : "";
  if (modelsUrlRaw && !isHttpUrl(modelsUrlRaw)) {
    return fail("Models URL must be an http(s) URL");
  }
  const models = argvList(rec.models);
  if (!models) return fail("Models must be a list of ids");
  const ids = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
  if (ids.some((m) => m.length > 100)) return fail("Model ids must be at most 100 characters");
  if (ids.length === 0 && !modelsUrlRaw) {
    return fail("Add at least one model or a models URL");
  }
  const defaultModel =
    typeof rec.defaultModel === "string" && ids.includes(rec.defaultModel.trim())
      ? rec.defaultModel.trim()
      : (ids[0] ?? null);
  /** @type {Record<string, string>} */
  const headers = {};
  if (rec.headers != null) {
    if (typeof rec.headers !== "object" || Array.isArray(rec.headers)) {
      return fail("Headers must be an object");
    }
    for (const [k, v] of Object.entries(rec.headers)) {
      if (!HEADER_RE.test(k) || typeof v !== "string") {
        return fail(`Invalid header: ${k}`);
      }
      headers[k] = v;
    }
  }
  return { baseUrl, modelsUrl: modelsUrlRaw || null, models: ids, defaultModel, headers };
}

/**
 * A custom CLI may not borrow a first-class adapter's id or name (#458): a
 * "Claude Code" row that is really raw stdout would pass for the real one.
 * @param {string} name
 */
function isReservedProviderName(name) {
  const key = name.trim().toLowerCase();
  return require("./providers.js").PROVIDERS.some(
    (p) => p.id === key || p.name.toLowerCase() === key,
  );
}

/**
 * @param {unknown} raw
 * @returns {string[] | null} null when not an array of strings
 */
function argvList(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || !raw.every((a) => typeof a === "string")) return null;
  return raw.slice();
}

/**
 * @param {unknown} ref
 * @returns {{ provider: string, instance: string | null }}
 */
function parseProviderRef(ref) {
  const s = typeof ref === "string" ? ref.trim() : "";
  const i = s.indexOf(":");
  if (i < 0) return { provider: s, instance: null };
  return { provider: s.slice(0, i), instance: s.slice(i + 1) || null };
}

/**
 * @param {string} provider
 * @param {string | null | undefined} instance
 */
function providerRef(provider, instance) {
  return instance ? `${provider}:${instance}` : provider;
}

/** @param {{ provider?: string, providerInstance?: string | null } | null | undefined} thread */
function threadProviderRef(thread) {
  if (!thread) return "";
  return providerRef(String(thread.provider || ""), thread.providerInstance || null);
}

/**
 * Parse one instance. Lenient returns null; strict throws.
 * @param {unknown} item
 * @param {boolean} strict
 * @returns {ProviderInstance | null}
 */
function parseInstance(item, strict) {
  const fail = (msg) => {
    if (strict) throw new Error(msg);
    return null;
  };
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return fail("providerInstances entry must be a plain object");
  }
  const rec = /** @type {Record<string, unknown>} */ (item);
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!ID_RE.test(id)) {
    return fail("providerInstances entry id must be lowercase letters, digits or dashes");
  }
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) return fail("Instance name cannot be empty");
  if (name.length > NAME_MAX) return fail(`Instance name must be at most ${NAME_MAX} characters`);
  const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
  const overlay = id === provider;
  if (overlay ? !BASE_ENV_PROVIDERS.includes(provider) : !supportsInstances(provider)) {
    return fail(`Instances are not supported for provider "${provider}"`);
  }
  if ((provider === "generic" || provider === "opencode") && isReservedProviderName(name)) {
    return fail(`"${name}" is reserved for a built-in provider`);
  }
  let configDir = null;
  // Separate CLI home (#1808): a computed, exclusive home under Solenta's
  // userData. Mutually exclusive with a user-typed configDir - isolatedHome
  // wins, and configDir is dropped on save so toggling it off reverts to
  // the shared/default home rather than a stale folder.
  let isolatedHome = false;
  if (!overlay && CONFIG_DIR_ENV[/** @type {"claude"} */ (provider)]) {
    isolatedHome = rec.isolatedHome === true;
    if (!isolatedHome && rec.configDir != null && rec.configDir !== "") {
      if (typeof rec.configDir !== "string") return fail("Config folder must be a path");
      const dir = rec.configDir.trim();
      if (dir && !path.isAbsolute(dir) && !dir.startsWith("~/")) {
        return fail("Config folder must be an absolute path");
      }
      configDir = dir || null;
    }
  }
  /** @type {Record<string, string>} */
  const env = {};
  if (rec.env != null) {
    if (typeof rec.env !== "object" || Array.isArray(rec.env)) {
      return fail("Instance env must be an object");
    }
    for (const [k, v] of Object.entries(rec.env)) {
      if (!ENV_KEY_RE.test(k)) {
        if (strict) throw new Error(`Invalid env var name: ${k}`);
        continue;
      }
      if (typeof v !== "string") {
        if (strict) throw new Error(`Env var ${k} must be a string`);
        continue;
      }
      // The config dir has its own field; letting env override it would
      // make the displayed folder lie about where the account lives.
      if (k === CONFIG_DIR_ENV[provider]) {
        if (strict) throw new Error(`Set ${k} with the config folder field`);
        continue;
      }
      env[k] = v;
    }
  }
  // Extra launch arguments (#1780): same argv-list shape as command /
  // fullAccessArgs, filtered against the provider's denylist. Lenient
  // (load from disk) drops only the bad tokens; strict (settings:set)
  // rejects the whole save so the UI can show why.
  const extraArgsRaw = argvList(rec.extraArgs);
  if (!extraArgsRaw) return fail("Extra launch arguments must be a list of strings");
  const denylist = EXTRA_ARGS_DENYLIST[provider] || [];
  const extraArgs = [];
  for (const a of extraArgsRaw) {
    const banned = denylist.includes(a) || denylist.some((b) => a.startsWith(`${b}=`));
    if (banned) {
      if (strict) {
        throw new Error(`"${a}" is controlled by Solenta and cannot be set as an extra launch argument`);
      }
      continue;
    }
    extraArgs.push(a);
  }
  if (provider === "opencode") {
    const openaiCompatible = parseOpenAiCompat(rec.openaiCompatible, fail);
    if (!openaiCompatible) return null;
    return { id, name, provider, configDir: null, env, extraArgs, openaiCompatible };
  }
  if (provider !== "generic") {
    return {
      id,
      name,
      provider,
      configDir,
      env,
      extraArgs,
      ...(isolatedHome ? { isolatedHome: true } : {}),
    };
  }
  const command = argvList(rec.command);
  if (!command || command.length === 0 || !command[0].trim()) {
    return fail("Custom CLI command cannot be empty");
  }
  const fullAccessArgs = argvList(rec.fullAccessArgs);
  if (!fullAccessArgs) return fail("Full access flags must be a list of strings");
  let cwd = null;
  if (rec.cwd != null && rec.cwd !== "") {
    if (typeof rec.cwd !== "string" || rec.cwd.includes("\0")) {
      return fail("Working folder must be a path");
    }
    cwd = rec.cwd.trim() || null;
  }
  const transcript = rec.transcript == null ? "stdout" : rec.transcript;
  if (transcript !== "stdout" && transcript !== "pty" && transcript !== "acp") {
    return fail('Transcript must be "stdout", "pty" or "acp"');
  }
  return {
    id,
    name,
    provider,
    configDir: null,
    env,
    extraArgs,
    command,
    fullAccessArgs,
    cwd,
    transcript,
  };
}

/**
 * From disk: drop junk, dedupe ids. Never throws.
 * @param {unknown} raw
 * @returns {ProviderInstance[]}
 */
function normalizeProviderInstances(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  /** @type {ProviderInstance[]} */
  const out = [];
  for (const item of raw) {
    const inst = parseInstance(item, false);
    if (!inst || seen.has(inst.id)) continue;
    seen.add(inst.id);
    out.push(inst);
  }
  return out;
}

/**
 * settings:set. Throws on the first problem.
 * @param {unknown} raw
 * @returns {ProviderInstance[]}
 */
function validateProviderInstances(raw) {
  if (!Array.isArray(raw)) throw new Error("providerInstances must be an array");
  const seen = new Set();
  return raw.map((item) => {
    const inst = /** @type {ProviderInstance} */ (parseInstance(item, true));
    if (seen.has(inst.id)) throw new Error(`Duplicate instance id: ${inst.id}`);
    seen.add(inst.id);
    return inst;
  });
}

/**
 * @param {{ providerInstances?: unknown } | null | undefined} settings
 * @param {string} provider
 * @param {string | null | undefined} id
 * @returns {ProviderInstance | null}
 */
function findInstance(settings, provider, id) {
  if (!id) return null;
  const list = Array.isArray(settings && settings.providerInstances)
    ? settings.providerInstances
    : [];
  return list.find((i) => i && i.id === id && i.provider === provider) || null;
}

/**
 * Computed home for an isolated-home instance (#1808): exclusive, under
 * Solenta's own userData, never shared with the real CLI home.
 * @param {string} userDataPath
 * @param {ProviderInstance} inst
 * @returns {string}
 */
function isolatedHomeDir(userDataPath, inst) {
  return path.join(String(userDataPath || ""), "provider-homes", inst.id, inst.provider);
}

/**
 * Env overlay for one spawn of this instance. `~/` expands against `home`.
 * An isolatedHome instance (#1808) ignores configDir and computes its own
 * exclusive folder under `userDataPath` instead; without a userDataPath
 * (callers that have none to give) it falls through with no dir var set,
 * same as a fresh instance with no folder.
 * @param {ProviderInstance} inst
 * @param {string} [home]
 * @param {string} [userDataPath]
 * @returns {Record<string, string>}
 */
function instanceEnv(inst, home = require("node:os").homedir(), userDataPath) {
  /** @type {Record<string, string>} */
  const out = { ...inst.env };
  const dirVar = CONFIG_DIR_ENV[inst.provider];
  if (dirVar && inst.isolatedHome && userDataPath) {
    const dir = isolatedHomeDir(userDataPath, inst);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // The CLI reports the bad path itself.
    }
    out[dirVar] = dir;
    return out;
  }
  if (inst.configDir) {
    const dir = inst.configDir.startsWith("~/")
      ? path.join(home, inst.configDir.slice(2))
      : inst.configDir;
    // Codex refuses a CODEX_HOME that does not exist yet (0.159.2), and a
    // fresh instance's first use is usually Sign in.
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // The CLI reports the bad path itself.
    }
    out[CONFIG_DIR_ENV[inst.provider]] = dir;
  }
  return out;
}

/**
 * Overlay env for a thread's spawn, or undefined on the base provider.
 * Throws when the thread names an instance that no longer exists: running
 * on the default account instead would spend the wrong subscription.
 *
 * A thread on the base provider gets the base overlay's env (#1714), but
 * only when the caller says the run is local (`opts.local`): across ssh/WSL
 * env travels as `env KEY=value` on the command line, and keys must not.
 *
 * @param {{ providerInstances?: unknown } | null | undefined} settings
 * @param {{ provider?: string, providerInstance?: string | null }} thread
 * @param {{ local?: boolean, userDataPath?: string }} [opts]
 * @returns {Record<string, string> | undefined}
 */
function threadInstanceEnv(settings, thread, opts = {}) {
  const id = thread && thread.providerInstance;
  if (!id) {
    const provider = String((thread && thread.provider) || "");
    const base = opts.local === true ? findInstance(settings, provider, provider) : null;
    return base && Object.keys(base.env).length > 0 ? { ...base.env } : undefined;
  }
  const inst = findInstance(settings, String(thread.provider || ""), id);
  if (!inst) {
    throw new Error(
      `This thread's provider instance was removed. Pick a provider in the model picker to continue.`,
    );
  }
  return instanceEnv(inst, undefined, opts.userDataPath);
}

/**
 * Extra launch arguments for a thread's normal run (#1780): the named
 * instance's, or the base provider's overlay row when none is picked.
 * Already denylist-filtered at save time, so this never throws. Argv-only
 * (not a secret), so unlike threadInstanceEnv it applies across ssh/WSL too.
 *
 * @param {{ providerInstances?: unknown } | null | undefined} settings
 * @param {{ provider?: string, providerInstance?: string | null }} thread
 * @returns {string[]}
 */
function threadExtraArgv(settings, thread) {
  const provider = String((thread && thread.provider) || "");
  const id = (thread && thread.providerInstance) || provider;
  const inst = findInstance(settings, provider, id);
  return inst && Array.isArray(inst.extraArgs) ? inst.extraArgs.slice() : [];
}

/**
 * Display name: "Claude (work)".
 * @param {string} baseName
 * @param {ProviderInstance} inst
 */
function instanceDisplayName(baseName, inst) {
  return inst.provider === "generic" || inst.openaiCompatible
    ? inst.name
    : `${baseName} (${inst.name})`;
}

/**
 * The `provider` block of OPENCODE_CONFIG_CONTENT for an OpenAI-compatible
 * instance (#1714). Shape from opencode.ai/docs/providers "Custom provider":
 * npm @ai-sdk/openai-compatible, options.baseURL/apiKey/headers, models by id.
 * The key is `{env:...}`, substituted by opencode from the run's env.
 * `extraModels` (custom ids, the thread's pick) join the configured list so
 * any id the picker offers resolves.
 *
 * @param {ProviderInstance} inst
 * @param {string[]} [extraModels]
 * @returns {Record<string, object>}
 */
function opencodeProviderConfig(inst, extraModels = []) {
  const oc = inst.openaiCompatible;
  if (!oc) return {};
  /** @type {Record<string, object>} */
  const models = {};
  for (const id of [...oc.models, ...extraModels]) {
    if (id && !models[id]) models[id] = { name: id };
  }
  /** @type {Record<string, unknown>} */
  const options = { baseURL: oc.baseUrl };
  if (inst.env[OPENAI_COMPAT_KEY_ENV]) options.apiKey = `{env:${OPENAI_COMPAT_KEY_ENV}}`;
  if (Object.keys(oc.headers).length > 0) options.headers = { ...oc.headers };
  return {
    [inst.id]: { npm: "@ai-sdk/openai-compatible", name: inst.name, options, models },
  };
}

/**
 * Per-provider model favourites and custom ids (#1714), keyed by provider
 * ref. Plain settings: ids are not secrets. Lenient drops junk; strict throws.
 *
 * @param {unknown} raw
 * @param {boolean} strict
 * @returns {Record<string, { favorites: string[], custom: string[] }>}
 */
function parseProviderModels(raw, strict) {
  /** @type {Record<string, { favorites: string[], custom: string[] }>} */
  const out = {};
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    if (strict) throw new Error("providerModels must be an object");
    return out;
  }
  /** @param {unknown} list @param {string} what */
  const ids = (list, what) => {
    if (list == null) return [];
    if (!Array.isArray(list) || !list.every((m) => typeof m === "string" && m.trim() && m.length <= 100)) {
      if (strict) throw new Error(`${what} must be a list of model ids`);
      return [];
    }
    return [...new Set(list.map((m) => m.trim()))].slice(0, 200);
  };
  for (const [ref, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      if (strict) throw new Error(`providerModels.${ref} must be an object`);
      continue;
    }
    const rec = /** @type {Record<string, unknown>} */ (v);
    const favorites = ids(rec.favorites, "favorites");
    const custom = ids(rec.custom, "custom");
    if (favorites.length || custom.length) out[ref] = { favorites, custom };
  }
  return out;
}

module.exports = {
  CONFIG_DIR_ENV,
  BASE_ENV_PROVIDERS,
  OPENAI_COMPAT_KEY_ENV,
  EXTRA_ARGS_DENYLIST,
  isBaseOverlay,
  opencodeProviderConfig,
  parseProviderModels,
  supportsInstances,
  parseProviderRef,
  providerRef,
  threadProviderRef,
  normalizeProviderInstances,
  validateProviderInstances,
  findInstance,
  instanceEnv,
  isolatedHomeDir,
  threadInstanceEnv,
  threadExtraArgv,
  instanceDisplayName,
};
