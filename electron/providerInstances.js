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

/**
 * @typedef {object} ProviderInstance
 * @property {string} id
 * @property {string} name
 * @property {string} provider
 * @property {string | null} configDir
 * @property {Record<string, string>} env
 */

/** @param {string} id */
function supportsInstances(id) {
  return Object.prototype.hasOwnProperty.call(CONFIG_DIR_ENV, id);
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
  if (!supportsInstances(provider)) {
    return fail(`Instances are not supported for provider "${provider}"`);
  }
  let configDir = null;
  if (rec.configDir != null && rec.configDir !== "") {
    if (typeof rec.configDir !== "string") return fail("Config folder must be a path");
    const dir = rec.configDir.trim();
    if (dir && !path.isAbsolute(dir) && !dir.startsWith("~/")) {
      return fail("Config folder must be an absolute path");
    }
    configDir = dir || null;
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
  return { id, name, provider, configDir, env };
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
 * Env overlay for one spawn of this instance. `~/` expands against `home`.
 * @param {ProviderInstance} inst
 * @param {string} [home]
 * @returns {Record<string, string>}
 */
function instanceEnv(inst, home = require("node:os").homedir()) {
  /** @type {Record<string, string>} */
  const out = { ...inst.env };
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
 * @param {{ providerInstances?: unknown } | null | undefined} settings
 * @param {{ provider?: string, providerInstance?: string | null }} thread
 * @returns {Record<string, string> | undefined}
 */
function threadInstanceEnv(settings, thread) {
  const id = thread && thread.providerInstance;
  if (!id) return undefined;
  const inst = findInstance(settings, String(thread.provider || ""), id);
  if (!inst) {
    throw new Error(
      `This thread's provider instance was removed. Pick a provider in the model picker to continue.`,
    );
  }
  return instanceEnv(inst);
}

/**
 * Display name: "Claude (work)".
 * @param {string} baseName
 * @param {ProviderInstance} inst
 */
function instanceDisplayName(baseName, inst) {
  return `${baseName} (${inst.name})`;
}

module.exports = {
  CONFIG_DIR_ENV,
  supportsInstances,
  parseProviderRef,
  providerRef,
  threadProviderRef,
  normalizeProviderInstances,
  validateProviderInstances,
  findInstance,
  instanceEnv,
  threadInstanceEnv,
  instanceDisplayName,
};
