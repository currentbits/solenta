"use strict";

/**
 * Agent skills on disk: SKILL.md files under every provider's user skills
 * dir, plus the selected project's .claude/skills. Listing merges user
 * copies into one row per name (project copies stay separate, read-only).
 * Writes, deletes, and sync only ever touch the user dirs.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SKILL_NAME_RE = /^[a-z0-9-]+$/;

/** @typedef {"claude" | "agents" | "codex" | "grok" | "opencode" | "kimi"} SkillTarget */

/**
 * Fan-out order and merge/source priority. Keep this list in lockstep with
 * SkillTarget in src/shared/ipc.ts.
 * @type {readonly SkillTarget[]}
 */
const SKILL_TARGETS = Object.freeze([
  "claude",
  "agents",
  "codex",
  "grok",
  "opencode",
  "kimi",
]);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function homeDir(env = process.env) {
  return (env && env.HOME) || os.homedir();
}

/**
 * Target → absolute skills dir. Every caller passes `env` so tests can
 * point HOME at a temp dir; we never read process.env.HOME at require time.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<SkillTarget, string>}
 */
function SKILL_DIRS(env = process.env) {
  const home = homeDir(env);
  return {
    claude: path.join(home, ".claude", "skills"),
    agents: path.join(home, ".agents", "skills"),
    codex: path.join(home, ".codex", "skills"),
    grok: path.join(home, ".grok", "skills"),
    opencode: path.join(home, ".config", "opencode", "skills"),
    kimi: path.join(home, ".kimi", "skills"),
  };
}

/**
 * Absolute base dir for a writable skill target.
 * @param {SkillTarget} target
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function skillBaseDir(target, env = process.env) {
  const dirs = SKILL_DIRS(env);
  if (!Object.prototype.hasOwnProperty.call(dirs, target)) {
    throw new Error(
      `Skill target must be one of ${SKILL_TARGETS.join(", ")}`,
    );
  }
  return dirs[target];
}

/**
 * A target is active only when its CLI is actually set up: the skills dir
 * itself exists, or the parent config dir exists. We never create skill
 * dirs for an uninstalled CLI.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {SkillTarget[]}
 */
function activeSkillTargets(env = process.env) {
  const dirs = SKILL_DIRS(env);
  /** @type {SkillTarget[]} */
  const out = [];
  for (const target of SKILL_TARGETS) {
    const skillsDir = dirs[target];
    if (fs.existsSync(skillsDir) || fs.existsSync(path.dirname(skillsDir))) {
      out.push(target);
    }
  }
  return out;
}

/**
 * Pure SKILL.md parser. Name comes from frontmatter when present (the lister
 * overrides it with the directory name); description comes from the
 * frontmatter `description:` line, then a top-level `description:` line, then
 * the first non-heading content line, else "".
 *
 * @param {unknown} content
 * @returns {{ name: string | null, description: string }}
 */
function parseSkillMarkdown(content) {
  const text = String(content == null ? "" : content);
  /** @type {string | null} */
  let name = null;
  let description = "";

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2].trim().replace(/^["']|["']$/g, "");
      if (key === "name" && name == null) name = value || null;
      if (key === "description" && !description) description = value;
    }
    return { name, description };
  }

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const kv = t.match(/^description:\s*(.*)$/i);
    if (kv) {
      description = kv[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    if (t.startsWith("#")) continue;
    description = t;
    break;
  }
  return { name, description };
}

/**
 * List skills under one base dir: every subdirectory containing a SKILL.md.
 * Context cost is SKILL.md size only (references/ and examples/ are
 * on-demand and never enter context).
 * @param {string} baseDir
 * @returns {Array<{ name: string, description: string, bytes: number }>}
 */
function scanSkillDir(baseDir) {
  /** @type {Array<{ name: string, description: string, bytes: number }>} */
  const out = [];
  let dirents;
  try {
    dirents = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const file = path.join(baseDir, d.name, "SKILL.md");
    let content;
    let bytes;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      bytes = stat.size;
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillMarkdown(content);
    out.push({ name: d.name, description: parsed.description, bytes });
  }
  return out;
}

/**
 * List skills as one row per user-skill name (merged across targets) plus
 * separate read-only rows from <project>/.claude/skills. Never throws on
 * unreadable dirs. User rows first (by name), then project rows (by name).
 *
 * @param {string | null | undefined} projectPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{
 *   name: string,
 *   description: string,
 *   source: string,
 *   installedIn: SkillTarget[],
 *   missingFrom: SkillTarget[],
 *   bytes: number,
 * }>}
 */
function listSkills(projectPath, env = process.env) {
  const dirs = SKILL_DIRS(env);
  const active = new Set(activeSkillTargets(env));

  /**
   * @type {Map<string, {
   *   name: string,
   *   description: string,
   *   source: SkillTarget,
   *   installedIn: SkillTarget[],
   *   missingFrom: SkillTarget[],
   *   bytes: number,
   * }>}
   */
  const byName = new Map();
  for (const target of SKILL_TARGETS) {
    for (const skill of scanSkillDir(dirs[target])) {
      const existing = byName.get(skill.name);
      if (!existing) {
        byName.set(skill.name, {
          name: skill.name,
          description: skill.description,
          source: target,
          installedIn: [target],
          missingFrom: [],
          bytes: skill.bytes,
        });
      } else {
        existing.installedIn.push(target);
      }
    }
  }

  const userRows = [];
  for (const row of byName.values()) {
    // A dir a marketplace installed under a name we cannot write (uppercase,
    // dots) is listed but never reported as drift — sync would refuse it, so
    // claiming it is missing somewhere would be a promise we cannot keep.
    row.missingFrom = !SKILL_NAME_RE.test(row.name)
      ? []
      : SKILL_TARGETS.filter(
          (t) => active.has(t) && !row.installedIn.includes(t),
        );
    userRows.push(row);
  }
  userRows.sort((a, b) => a.name.localeCompare(b.name));

  const projectRows = [];
  const project = typeof projectPath === "string" ? projectPath.trim() : "";
  if (project) {
    for (const skill of scanSkillDir(
      path.join(project, ".claude", "skills"),
    )) {
      projectRows.push({
        name: skill.name,
        description: skill.description,
        source: "project",
        installedIn: [],
        missingFrom: [],
        bytes: skill.bytes,
      });
    }
    projectRows.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...userRows, ...projectRows];
}

/**
 * Resolve and confine a skill dir inside a writable base. Throws unless the
 * result is exactly <base>/<name> (name regex already excludes separators
 * and dots; this is belt and braces against symlink tricks on the base).
 * @param {SkillTarget} target
 * @param {unknown} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveSkillDir(target, name, env = process.env) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!SKILL_NAME_RE.test(n)) {
    throw new Error(
      `Skill name must be lowercase letters, digits, dashes (got "${n}")`,
    );
  }
  const base = skillBaseDir(target, env);
  const dir = path.join(base, n);
  if (path.relative(base, dir) !== n) {
    throw new Error("Skill path escapes the skills directory");
  }
  return dir;
}

/**
 * Write <dir>/<name>/SKILL.md into every active target.
 * @param {{ name: unknown, description: unknown, body: unknown }} input
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ name: string, installedIn: SkillTarget[] }}
 */
function addSkill(input, env = process.env) {
  // Validate name + confinement against a known target before any write.
  const name = path.basename(
    resolveSkillDir("claude", input && input.name, env),
  );
  const description =
    input && typeof input.description === "string"
      ? input.description.trim().replace(/\s+/g, " ")
      : "";
  if (!description) {
    throw new Error("Skill description is required");
  }
  const body =
    input && typeof input.body === "string" ? input.body.trim() : "";
  if (!body) {
    throw new Error("Skill body is required");
  }
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  /** @type {SkillTarget[]} */
  const installedIn = [];
  for (const target of activeSkillTargets(env)) {
    const dir = resolveSkillDir(target, name, env);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
    installedIn.push(target);
  }
  return { name, installedIn };
}

/**
 * Delete <dir>/<name> from every target holding it.
 * @param {{ name: unknown }} input
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ name: string }}
 */
function removeSkill(input, env = process.env) {
  const name = path.basename(
    resolveSkillDir("claude", input && input.name, env),
  );
  let found = false;
  for (const target of SKILL_TARGETS) {
    const dir = resolveSkillDir(target, name, env);
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    found = true;
  }
  if (!found) {
    throw new Error(`Unknown skill: ${name}`);
  }
  return { name };
}

/**
 * Copy every skill present in at least one target into each active target
 * that is missing it. Source is the first target holding it in SKILL_DIRS
 * order. Whole-directory copy so references/ and examples/ come along.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ copied: number, skills: string[] }}
 */
function syncSkills(env = process.env) {
  const dirs = SKILL_DIRS(env);
  const active = activeSkillTargets(env);

  /** @type {Map<string, { source: SkillTarget, installedIn: Set<SkillTarget> }>} */
  const byName = new Map();
  for (const target of SKILL_TARGETS) {
    for (const skill of scanSkillDir(dirs[target])) {
      // Skip what we could never write back (resolveSkillDir would throw and
      // take the whole sync with it); listSkills reports these as drift-free.
      if (!SKILL_NAME_RE.test(skill.name)) continue;
      const existing = byName.get(skill.name);
      if (!existing) {
        byName.set(skill.name, {
          source: target,
          installedIn: new Set([target]),
        });
      } else {
        existing.installedIn.add(target);
      }
    }
  }

  let copied = 0;
  /** @type {string[]} */
  const needed = [];
  for (const name of [...byName.keys()].sort()) {
    const info = byName.get(name);
    const srcDir = path.join(dirs[info.source], name);
    let didCopy = false;
    for (const target of active) {
      if (info.installedIn.has(target)) continue;
      const destDir = resolveSkillDir(target, name, env);
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.cpSync(srcDir, destDir, { recursive: true });
      copied += 1;
      didCopy = true;
    }
    if (didCopy) needed.push(name);
  }
  return { copied, skills: needed };
}

module.exports = {
  SKILL_NAME_RE,
  SKILL_DIRS,
  SKILL_TARGETS,
  parseSkillMarkdown,
  listSkills,
  addSkill,
  removeSkill,
  syncSkills,
  activeSkillTargets,
  skillBaseDir,
};
