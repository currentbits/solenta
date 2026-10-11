"use strict";

/**
 * Shared automations section of solenta.json (#1590). Parse, hash, present,
 * merge file definitions with local overlays, and write project-scoped rows.
 * Ticker/poller/trustFile changes land in a later task.
 *
 * The hash is independent of commandsHash / repoConfigTrust so approving
 * a setup command does not approve an agent prompt.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { normalizeTrigger, parseTriggerInput } = require("./automation-triggers.js");
const { normalizeRoute } = require("./routing.js");
const { isKnownProviderId } = require("./services-notes.js");
const { readRepoJson, invalidateRepoConfigCache } = require("./repoConfig.js");

const REPO_CONFIG_FILE = "solenta.json";

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

/**
 * Local project: on-disk path, not a remote host.
 * @param {any} project
 */
function isLocalProject(project) {
  return Boolean(project && project.path && !project.remoteHost);
}

/**
 * Merge private store rows with file definitions + local overlays.
 * Definition fields always come from the file. Does not save.
 *
 * @param {import("./store").Store} store
 * @param {number} nowMs
 * @returns {object[]}
 */
function mergeAutomations(store, nowMs) {
  const { nextFire } = require("./automations.js");
  const privates = (store.getAutomations() || []).filter(
    (a) => a && a.scope !== "project",
  );
  const overlayById = new Map();
  for (const a of store.getAutomations() || []) {
    if (a && a.id) overlayById.set(a.id, a);
  }
  const shared = [];
  for (const project of store.getProjects() || []) {
    if (!isLocalProject(project)) continue;
    const section = readAutomations(project.path);
    if (section.error || !section.automations.length) continue;
    for (const row of section.automations) {
      const id = sharedId(project.id, row.id);
      const overlay = overlayById.get(id);
      const runtime = overlay
        ? {
            enabled: overlay.enabled,
            memory: overlay.memory,
            triggerCursor: overlay.triggerCursor,
            lastRunAt: overlay.lastRunAt,
            lastError: overlay.lastError,
            consecutiveFailures: overlay.consecutiveFailures,
            pendingRunThreadId: overlay.pendingRunThreadId,
            nextRunAt: overlay.nextRunAt,
          }
        : {
            enabled: false,
            memory: "",
            triggerCursor: null,
            lastRunAt: null,
            lastError: null,
            consecutiveFailures: 0,
            pendingRunThreadId: null,
            nextRunAt: nextFire(row.preset, row.hour, nowMs),
          };
      shared.push({
        ...runtime,
        id,
        projectId: project.id,
        name: row.name,
        prompt: row.prompt,
        provider: row.provider,
        model: row.model,
        preset: row.preset,
        hour: row.hour,
        trigger: row.trigger,
        tier: row.tier,
        scope: "project",
      });
    }
  }
  return [...privates, ...shared];
}

/**
 * Auto-fire gate: enabled, and trusted when the row is project-scoped.
 * Private enabled rows return true.
 *
 * @param {import("./store").Store} store
 * @param {object} auto
 * @returns {boolean}
 */
function canAutoFire(store, auto) {
  if (!auto || !auto.enabled) return false;
  if (auto.scope !== "project") return true;
  const project = store.getProject(auto.projectId);
  return Boolean(presentAutomationsFile(project)?.trusted);
}

/**
 * Drop store overlays whose slug is no longer in any local file.
 * A parse-error file keeps that project's existing overlays (invalid
 * JSON is not treated as an empty list). Mutates the store list; does
 * not save.
 *
 * @param {import("./store").Store} store
 * @returns {boolean} true if the list changed
 */
function gcOrphanOverlays(store) {
  const list = store.getAutomations() || [];
  const valid = new Set();
  for (const project of store.getProjects() || []) {
    if (!isLocalProject(project)) continue;
    const section = readAutomations(project.path);
    if (section.error) {
      for (const a of list) {
        if (a && a.scope === "project" && a.projectId === project.id) {
          valid.add(a.id);
        }
      }
      continue;
    }
    for (const row of section.automations) {
      valid.add(sharedId(project.id, row.id));
    }
  }
  const next = list.filter((a) => !a || a.scope !== "project" || valid.has(a.id));
  if (next.length === list.length) return false;
  store.setAutomations(next);
  return true;
}

/**
 * Replace `automations` in `<projectPath>/solenta.json`. Missing file →
 * `{}`. Existing invalid JSON → throw. Empty `rows` writes `automations: []`
 * (does not delete the key). Unknown sibling keys are preserved.
 *
 * @param {string} projectPath
 * @param {object[]} rows
 * @returns {{ automations: object[], hash: string | null, error?: string }}
 */
function writeAutomations(projectPath, rows) {
  const file = path.join(projectPath, REPO_CONFIG_FILE);
  let doc = {};
  const raw = readRepoJson(projectPath);
  if (raw) {
    if (raw.error) throw new Error(raw.error);
    if (raw.json && typeof raw.json === "object" && !Array.isArray(raw.json)) {
      doc = { ...raw.json };
    }
  }
  doc.automations = (rows || []).map((row) => canonical(row));
  const parsed = parseAutomations(doc);
  if (parsed.error) throw new Error(parsed.error);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  invalidateRepoConfigCache(projectPath);
  return parsed;
}

/**
 * Ensure a store overlay exists for a merged project-scoped row.
 * Does not save.
 *
 * @param {import("./store").Store} store
 * @param {object} auto
 * @returns {object}
 */
function ensureOverlay(store, auto) {
  if (!auto || !auto.id) {
    throw new Error("Automation id is required");
  }
  const existing = store.getAutomation(auto.id);
  if (existing) return existing;
  const { nextFire } = require("./automations.js");
  const overlay = {
    id: auto.id,
    projectId: auto.projectId,
    scope: "project",
    name: auto.name,
    prompt: auto.prompt,
    provider: auto.provider,
    model: auto.model,
    preset: auto.preset,
    hour: auto.hour,
    trigger: auto.trigger || null,
    tier: auto.tier || null,
    enabled: auto.enabled,
    memory: auto.memory || "",
    triggerCursor: auto.triggerCursor ?? null,
    lastRunAt: auto.lastRunAt ?? null,
    lastError: auto.lastError ?? null,
    consecutiveFailures: auto.consecutiveFailures || 0,
    pendingRunThreadId: auto.pendingRunThreadId ?? null,
    nextRunAt:
      typeof auto.nextRunAt === "number" && Number.isFinite(auto.nextRunAt)
        ? auto.nextRunAt
        : nextFire(auto.preset, auto.hour, Date.now()),
  };
  const list = (store.getAutomations() || []).slice();
  list.push(overlay);
  store.setAutomations(list);
  return store.getAutomation(auto.id);
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
  writeAutomations,
  presentAutomationsFile,
  mergeAutomations,
  gcOrphanOverlays,
  canAutoFire,
  ensureOverlay,
};
