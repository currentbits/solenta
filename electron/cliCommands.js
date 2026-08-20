"use strict";

/**
 * CLI slash commands the TUI would run (#606): skills (SKILL.md) and custom
 * command markdown. Solenta's headless `-p` / stream-json path has no TUI
 * command router, so we discover the same files and expand `/name args`
 * into the body the CLI would inject.
 *
 * Listing is for the composer palette. Expansion is for the runner: the
 * transcript keeps the raw `/name`, the CLI sees the expanded prompt.
 *
 * Orchestration verbs (`/handoff` `/advisor` `/committee`) stay in
 * orchcommands.js — they never expand as skills even if a SKILL.md exists.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { parseSkillMarkdown, SKILL_DIRS } = require("./skills.js");

/** Runner intercepts these; a same-named skill must not steal the send. */
const ORCH_TOKENS = new Set(["handoff", "advisor", "committee"]);

const HINT_MAX = 80;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function homeDir(env = process.env) {
  return (env && env.HOME) || os.homedir();
}

/**
 * @param {string} text
 * @returns {string}
 */
function commandHint(text) {
  const one = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!one) return "Skill";
  if (one.length <= HINT_MAX) return one;
  return `${one.slice(0, HINT_MAX - 1)}…`;
}

/**
 * @param {string} content
 * @returns {boolean}
 */
function isUserInvocable(content) {
  const fm = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return true;
  for (const line of fm[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    if (kv[1].toLowerCase() === "user-invocable") {
      const value = kv[2].trim().replace(/^["']|["']$/g, "");
      return !/^(false|no|0)$/i.test(value);
    }
  }
  return true;
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripFrontmatter(text) {
  const raw = String(text ?? "");
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? raw.slice(m[0].length) : raw).trim();
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Every subdirectory (or symlink) containing SKILL.md. Same rule as
 * skills.scanSkillDir: a symlink farm is a real install.
 *
 * @param {string} baseDir
 * @returns {Array<{ name: string, description: string, file: string, content: string, userInvocable: boolean }>}
 */
function scanSkillDir(baseDir) {
  /** @type {Array<{ name: string, description: string, file: string, content: string, userInvocable: boolean }>} */
  const out = [];
  let dirents;
  try {
    dirents = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    const file = path.join(baseDir, d.name, "SKILL.md");
    const content = readFile(file);
    if (content == null) continue;
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const parsed = parseSkillMarkdown(content);
    out.push({
      name: d.name,
      description: parsed.description,
      file,
      content,
      userInvocable: isUserInvocable(content),
    });
  }
  return out;
}

/**
 * Recurse for `*.md` command files. `git/pr.md` → name `git:pr`.
 *
 * @param {string} baseDir
 * @param {string} [rel]
 * @returns {Array<{ name: string, description: string, file: string, content: string }>}
 */
function scanCommandDir(baseDir, rel = "") {
  /** @type {Array<{ name: string, description: string, file: string, content: string }>} */
  const out = [];
  let dirents;
  try {
    dirents = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    const nextRel = rel ? `${rel}/${d.name}` : d.name;
    const full = path.join(baseDir, d.name);
    if (d.isDirectory() || d.isSymbolicLink()) {
      try {
        if (fs.statSync(full).isDirectory()) {
          out.push(...scanCommandDir(full, nextRel));
        }
      } catch {
        /* dangling link */
      }
      continue;
    }
    if (!d.isFile() || !d.name.endsWith(".md")) continue;
    if (/^readme\.md$/i.test(d.name)) continue;
    const content = readFile(full);
    if (content == null) continue;
    const parsed = parseSkillMarkdown(content);
    const slug = nextRel.replace(/\.md$/i, "").replace(/\//g, ":");
    out.push({
      name: slug,
      description: parsed.description,
      file: full,
      content,
    });
  }
  return out;
}

/**
 * @param {string} pluginRoot
 * @returns {{ name: string, skillDirs: string[], commandDirs: string[] }}
 */
function readPluginManifest(pluginRoot) {
  const candidates = [
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    path.join(pluginRoot, "plugin.json"),
  ];
  /** @type {Record<string, unknown>} */
  let json = {};
  for (const file of candidates) {
    const raw = readFile(file);
    if (!raw) continue;
    try {
      json = JSON.parse(raw);
      break;
    } catch {
      json = {};
    }
  }
  const name =
    typeof json.name === "string" && /^[a-z0-9-]+$/i.test(json.name.trim())
      ? json.name.trim().toLowerCase()
      : path.basename(pluginRoot).toLowerCase();

  const skillDirs = [];
  if (Array.isArray(json.skills)) {
    for (const entry of json.skills) {
      if (typeof entry === "string" && entry.trim()) {
        skillDirs.push(path.resolve(pluginRoot, entry.trim()));
      }
    }
  } else {
    skillDirs.push(path.join(pluginRoot, "skills"));
    skillDirs.push(path.join(pluginRoot, ".claude", "skills"));
  }

  const commandDirs = [];
  if (Array.isArray(json.commands)) {
    for (const entry of json.commands) {
      if (typeof entry === "string" && entry.trim()) {
        commandDirs.push(path.resolve(pluginRoot, entry.trim()));
      }
    }
  } else {
    commandDirs.push(path.join(pluginRoot, "commands"));
    commandDirs.push(path.join(pluginRoot, ".claude", "commands"));
  }

  return { name, skillDirs, commandDirs };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function pluginInstallPaths(env = process.env) {
  const file = path.join(
    homeDir(env),
    ".claude",
    "plugins",
    "installed_plugins.json",
  );
  const raw = readFile(file);
  if (!raw) return [];
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const plugins = json && json.plugins && typeof json.plugins === "object"
    ? json.plugins
    : {};
  /** @type {string[]} */
  const out = [];
  for (const entries of Object.values(plugins)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const p =
        entry && typeof entry.installPath === "string"
          ? entry.installPath
          : "";
      if (p) out.push(p);
    }
  }
  return out;
}

/**
 * @typedef {object} InvocableCommand
 * @property {string} name - `/commit` or `/si:review`
 * @property {string} hint
 * @property {"skill" | "command"} kind
 * @property {string} file - absolute path to SKILL.md or the command markdown
 */

/**
 * Insert `row` under `name` unless that slash is already taken.
 * @param {Map<string, InvocableCommand>} byName
 * @param {string} slashName
 * @param {InvocableCommand} row
 */
function addOnce(byName, slashName, row) {
  if (byName.has(slashName)) return;
  byName.set(slashName, { ...row, name: slashName });
}

/**
 * @param {object} [opts]
 * @param {string | null} [opts.projectPath]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {InvocableCommand[]}
 */
function listInvocableCommands(opts = {}) {
  const env = opts.env || process.env;
  const home = homeDir(env);
  const project =
    typeof opts.projectPath === "string" ? opts.projectPath.trim() : "";
  /** @type {Map<string, InvocableCommand>} */
  const byName = new Map();

  const addSkill = (slashName, skill) => {
    if (!skill.userInvocable) return;
    if (ORCH_TOKENS.has(slashName.slice(1))) return;
    addOnce(byName, slashName, {
      name: slashName,
      hint: commandHint(skill.description),
      kind: "skill",
      file: skill.file,
    });
  };
  const addCommand = (slashName, cmd) => {
    if (ORCH_TOKENS.has(slashName.slice(1))) return;
    addOnce(byName, slashName, {
      name: slashName,
      hint: commandHint(cmd.description || slashName.slice(1)),
      kind: "command",
      file: cmd.file,
    });
  };

  // Project first so a repo skill wins the bare `/name`.
  if (project) {
    for (const rel of [
      path.join(".claude", "skills"),
      path.join(".grok", "skills"),
    ]) {
      for (const skill of scanSkillDir(path.join(project, rel))) {
        addSkill(`/${skill.name}`, skill);
      }
    }
    for (const rel of [
      path.join(".claude", "commands"),
      path.join(".grok", "commands"),
    ]) {
      for (const cmd of scanCommandDir(path.join(project, rel))) {
        addCommand(`/${cmd.name}`, cmd);
      }
    }
  }

  const dirs = SKILL_DIRS(env);
  for (const base of Object.values(dirs)) {
    for (const skill of scanSkillDir(base)) {
      addSkill(`/${skill.name}`, skill);
    }
  }

  for (const skill of scanSkillDir(
    path.join(home, ".grok", "bundled", "skills"),
  )) {
    addSkill(`/${skill.name}`, skill);
  }

  for (const rel of [
    path.join(".claude", "commands"),
    path.join(".grok", "commands"),
  ]) {
    for (const cmd of scanCommandDir(path.join(home, rel))) {
      addCommand(`/${cmd.name}`, cmd);
    }
  }

  for (const pluginRoot of pluginInstallPaths(env)) {
    const manifest = readPluginManifest(pluginRoot);
    const prefix = manifest.name;
    for (const dir of manifest.skillDirs) {
      for (const skill of scanSkillDir(dir)) {
        addSkill(`/${skill.name}`, skill);
        if (prefix) addSkill(`/${prefix}:${skill.name}`, skill);
      }
    }
    for (const dir of manifest.commandDirs) {
      for (const cmd of scanCommandDir(dir)) {
        addCommand(`/${cmd.name}`, cmd);
        if (prefix) addCommand(`/${prefix}:${cmd.name}`, cmd);
      }
    }
  }

  return [...byName.values()];
}

/**
 * First `/token` of a composer prompt, or null.
 * @param {string} prompt
 * @returns {{ token: string, rest: string } | null}
 */
function leadingSlash(prompt) {
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) return null;
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  return { token: m[1], rest: (m[2] || "").trim() };
}

/**
 * Expand a leading `/name [args]` into the skill/command body the TUI
 * would inject. Returns null when the token is unknown or reserved.
 *
 * @param {string} prompt
 * @param {{ projectPath?: string | null, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ name: string, kind: "skill" | "command", prompt: string } | null}
 */
function expandInvocableCommand(prompt, opts = {}) {
  const lead = leadingSlash(prompt);
  if (!lead) return null;
  if (ORCH_TOKENS.has(lead.token)) return null;

  const rows = listInvocableCommands(opts);
  const slash = `/${lead.token}`;
  const hit = rows.find((r) => r.name === slash);
  if (!hit) return null;

  const raw = readFile(hit.file);
  if (raw == null) return null;
  const body = stripFrontmatter(raw);
  const args = lead.rest;

  if (hit.kind === "command") {
    let text = body;
    if (text.includes("$ARGUMENTS")) {
      text = text.replace(/\$ARGUMENTS/g, args);
    } else if (args) {
      text = `${text}\n\n${args}`;
    }
    return { name: hit.name, kind: "command", prompt: text };
  }

  const header = `# Skill: ${lead.token}\n\n${body}`;
  const user = args || "(no additional arguments)";
  return {
    name: hit.name,
    kind: "skill",
    prompt: `${header}\n\n## User\n\n${user}`,
  };
}

/**
 * Palette rows for the renderer: no filesystem paths.
 * @param {object} [opts]
 * @param {string | null} [opts.projectPath]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {Array<{ name: string, hint: string, kind: "insert" }>}
 */
function listPaletteCommands(opts = {}) {
  return listInvocableCommands(opts).map((row) => ({
    name: row.name,
    hint: row.hint,
    kind: "insert",
  }));
}

module.exports = {
  ORCH_TOKENS,
  listInvocableCommands,
  expandInvocableCommand,
  listPaletteCommands,
  commandHint,
};
