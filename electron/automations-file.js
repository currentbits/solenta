"use strict";

/**
 * Shared automations section of solenta.json (#1590). Parse, hash, and
 * present only — writes, merge, and fire gates land in later tasks.
 *
 * The hash is independent of commandsHash / repoConfigTrust so approving
 * a setup command does not approve an agent prompt.
 */

const { createHash } = require("node:crypto");
const { normalizeTrigger, parseTriggerInput } = require("./automation-triggers.js");
const { normalizeRoute } = require("./routing.js");
const { isKnownProviderId } = require("./services-notes.js");
const { readRepoJson } = require("./repoConfig.js");

const SLUG_RE = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_SHARED_AUTOMATIONS = 16;
const PROMPT_MAX = 4000;
const PRESETS = new Set(["hourly", "daily", "weekly"]);

/**
 * Overlay / merge id for a shared automation row.
 * @param {string} projectId
 * @param {string} slug
 */
function sharedId(projectId, slug) {
  return `shared:${projectId}:${slug}`;
}

/**
 * Derive a unique slug from a display name. Invalid leftovers become `auto`.
 * @param {string} name
 * @param {string[]} taken
 */
function slugFromName(name, taken) {
  const used = new Set(taken || []);
  let base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!SLUG_RE.test(base)) base = "auto";
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Canonical nine fields in key order, for a stable sha256.
 * @param {{
 *   id: string,
 *   name: string,
 *   prompt: string,
 *   provider: string,
 *   model: string | null,
 *   preset: string,
 *   hour: number | null,
 *   trigger: object | null,
 *   tier: string | null,
 * }} row
 */
function canonical(row) {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    provider: row.provider,
    model: row.model,
    preset: row.preset,
    hour: row.hour,
    trigger: row.trigger,
    tier: row.tier,
  };
}

/**
 * sha256 of the canonical automations array. Independent of commandsHash.
 * @param {Array<object>} rows
 */
function automationsHash(rows) {
  return createHash("sha256")
    .update(JSON.stringify((rows || []).map(canonical)))
    .digest("hex");
}

/**
 * @param {unknown} hour
 * @param {"hourly" | "daily" | "weekly"} preset
 * @returns {{ hour: number | null } | { error: string }}
 */
function parseHour(preset, hour) {
  if (preset === "hourly") return { hour: null };
  if (hour == null || hour === "") {
    return { error: "solenta.json: hour is required for daily and weekly automations" };
  }
  const n = Number(hour);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    return { error: "solenta.json: hour must be an integer from 0 to 23" };
  }
  return { hour: n };
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @param {Set<string>} seen
 * @returns {{ row: object } | { error: string }}
 */
function parseRow(raw, index, seen) {
  const at = `automations[${index}]`;
  const r = raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};

  const id = typeof r.id === "string" ? r.id : "";
  if (!SLUG_RE.test(id)) {
    return { error: `solenta.json: ${at}.id must be a slug matching ${SLUG_RE}` };
  }
  if (seen.has(id)) {
    return { error: `solenta.json: duplicate automation id "${id}"` };
  }
  seen.add(id);

  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) {
    return { error: `solenta.json: ${at}.name is required` };
  }

  const prompt = r.prompt != null ? String(r.prompt) : "";
  if (!prompt.trim()) {
    return { error: `solenta.json: ${at}.prompt is required` };
  }
  if (prompt.length > PROMPT_MAX) {
    return { error: `solenta.json: ${at}.prompt must be at most ${PROMPT_MAX} characters` };
  }

  const provider = typeof r.provider === "string" ? r.provider : "";
  if (!provider || !isKnownProviderId(provider)) {
    return { error: `solenta.json: ${at}.provider is unknown` };
  }

  let model = null;
  if (r.model != null && r.model !== "") {
    if (typeof r.model !== "string") {
      return { error: `solenta.json: ${at}.model must be a string or null` };
    }
    const trimmed = r.model.trim();
    if (!trimmed) {
      return { error: `solenta.json: ${at}.model must be a string or null` };
    }
    model = trimmed;
  }

  const preset = typeof r.preset === "string" ? r.preset : "";
  if (!PRESETS.has(preset)) {
    return {
      error: `solenta.json: ${at}.preset must be hourly, daily, or weekly`,
    };
  }

  const hourParsed = parseHour(preset, r.hour);
  if ("error" in hourParsed) return hourParsed;

  let trigger = null;
  if (r.trigger != null) {
    try {
      trigger = parseTriggerInput(r.trigger);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      return { error: `solenta.json: ${at}.trigger: ${msg}` };
    }
    trigger = normalizeTrigger(trigger);
  }

  let tier = null;
  if (r.tier != null && r.tier !== "") {
    tier = normalizeRoute(r.tier);
    if (!tier) {
      return {
        error: `solenta.json: ${at}.tier must be auto, fast, balanced, or strong`,
      };
    }
  }

  return {
    row: {
      id,
      name,
      prompt,
      provider,
      model,
      preset,
      hour: hourParsed.hour,
      trigger,
      tier,
    },
  };
}

/**
 * Validate `data.automations`. One bad row fails the section only (empty
 * list + error, no hash). Commands are not considered.
 *
 * @param {unknown} data
 * @returns {{ automations: object[], hash: string | null, error?: string }}
 */
function parseAutomations(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { automations: [], hash: null };
  }
  const d = /** @type {Record<string, unknown>} */ (data);
  if (d.automations === undefined) {
    return { automations: [], hash: null };
  }
  if (!Array.isArray(d.automations)) {
    return { error: "solenta.json: automations must be an array", automations: [] };
  }
  if (d.automations.length > MAX_SHARED_AUTOMATIONS) {
    return {
      error: `solenta.json: at most ${MAX_SHARED_AUTOMATIONS} automations`,
      automations: [],
    };
  }
  const seen = new Set();
  const rows = [];
  for (const [i, raw] of d.automations.entries()) {
    const parsed = parseRow(raw, i, seen);
    if ("error" in parsed) return { error: parsed.error, automations: [] };
    rows.push(parsed.row);
  }
  return { automations: rows, hash: automationsHash(rows) };
}

/**
 * Read `<root>/solenta.json` automations via the shared mtime cache.
 * Missing file → empty, no hash. Invalid JSON → error, no hash.
 *
 * @param {string | null | undefined} root
 */
function readAutomations(root) {
  const raw = readRepoJson(root);
  if (!raw) return { automations: [], hash: null };
  if (raw.error) return { error: raw.error, automations: [] };
  return parseAutomations(raw.json);
}

/**
 * ProjectInfo.automationsFile for the renderer. Never persisted.
 * Null when there is no local file section (remote, pathless, or no key).
 *
 * @param {any} project
 */
function presentAutomationsFile(project) {
  if (!project || project.remoteHost || !project.path) return null;
  const section = readAutomations(project.path);
  if (!section.hash && !section.error) return null;
  return {
    hash: section.hash,
    trusted: Boolean(section.hash && project.automationsTrust === section.hash),
    ...(section.error ? { error: section.error } : {}),
    count: section.automations.length,
  };
}

module.exports = {
  SLUG_RE,
  MAX_SHARED_AUTOMATIONS,
  PROMPT_MAX,
  sharedId,
  slugFromName,
  parseAutomations,
  automationsHash,
  readAutomations,
  presentAutomationsFile,
};
