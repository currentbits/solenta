"use strict";

/**
 * Shared plugin.json reader for the live / palette and Skills-tab import.
 * Never executes plugin files. JSON reads cap at 512KB. Command/skill
 * dirs that escape the plugin root are ignored.
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_JSON_BYTES = 512 * 1024;
const PLUGIN_NAME_RE = /^[a-z0-9-]+$/i;

const PLUGIN_JSON_RELS = [
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "plugin.json",
];

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readCappedJson(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink()) return null;
  if (st.size > MAX_JSON_BYTES) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string[]} into
 * @param {string} pluginRoot
 * @param {unknown} entry
 */
function addDir(into, pluginRoot, entry) {
  if (typeof entry !== "string" || !entry.trim()) return;
  const resolved = path.resolve(pluginRoot, entry.trim());
  if (!isInside(pluginRoot, resolved)) return;
  into.push(resolved);
}

/**
 * @param {string} pluginRoot
 * @param {{ requireName?: boolean }} [opts]
 *   requireName true (Skills-tab import): missing/invalid name → null.
 *   requireName false (live / palette): fall back to basename(pluginRoot).
 * @returns {{ name: string, commandDirs: string[], skillDirs: string[] } | null}
 */
function readPluginManifest(pluginRoot, opts = {}) {
  const requireName = Boolean(opts.requireName);
  /** @type {Record<string, unknown>} */
  let json = {};
  for (const rel of PLUGIN_JSON_RELS) {
    const raw = readCappedJson(path.join(pluginRoot, rel));
    if (raw == null) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      json = parsed;
      break;
    } catch {
      continue;
    }
  }

  const rawName = typeof json.name === "string" ? json.name.trim() : "";
  const validName = PLUGIN_NAME_RE.test(rawName) ? rawName.toLowerCase() : "";
  if (requireName && !validName) return null;
  const name = validName || path.basename(pluginRoot).toLowerCase();

  /** @type {string[]} */
  const commandDirs = [];
  /** @type {string[]} */
  const skillDirs = [];
  if (Array.isArray(json.commands)) {
    for (const entry of json.commands) addDir(commandDirs, pluginRoot, entry);
  } else {
    addDir(commandDirs, pluginRoot, "commands");
    addDir(commandDirs, pluginRoot, ".claude/commands");
  }
  if (Array.isArray(json.skills)) {
    for (const entry of json.skills) addDir(skillDirs, pluginRoot, entry);
  } else {
    addDir(skillDirs, pluginRoot, "skills");
    addDir(skillDirs, pluginRoot, ".claude/skills");
  }
  return { name, commandDirs, skillDirs };
}

module.exports = {
  MAX_JSON_BYTES,
  PLUGIN_JSON_RELS,
  readPluginManifest,
};
