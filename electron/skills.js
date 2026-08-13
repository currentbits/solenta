"use strict";

/**
 * Agent skills on disk: SKILL.md files under the two user skill dirs
 * (~/.claude/skills, ~/.agents/skills) plus the selected project's
 * .claude/skills. Listing is read-only for all three; writes and deletes are
 * confined to the two USER dirs (never the project dir, never arbitrary
 * paths) so a renderer bug cannot delete project content.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SKILL_NAME_RE = /^[a-z0-9-]+$/;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function homeDir(env = process.env) {
  return (env && env.HOME) || os.homedir();
}

/**
 * Absolute base dir for a writable skill target.
 * @param {"claude" | "agents"} target
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function skillBaseDir(target, env = process.env) {
  if (target === "claude") return path.join(homeDir(env), ".claude", "skills");
  if (target === "agents") return path.join(homeDir(env), ".agents", "skills");
  throw new Error('Skill target must be "claude" or "agents"');
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
 * @param {string} baseDir
 * @param {"claude" | "agents" | "project"} source
 * @returns {Array<{ name: string, description: string, source: string }>}
 */
function scanSkillDir(baseDir, source) {
  /** @type {Array<{ name: string, description: string, source: string }>} */
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
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillMarkdown(content);
    out.push({ name: d.name, description: parsed.description, source });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * List skills from ~/.claude/skills, ~/.agents/skills, and (when projectPath)
 * <project>/.claude/skills. Never throws on unreadable dirs.
 *
 * @param {string | null | undefined} projectPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ name: string, description: string, source: string }>}
 */
function listSkills(projectPath, env = process.env) {
  const home = homeDir(env);
  const out = scanSkillDir(path.join(home, ".claude", "skills"), "claude");
  out.push(...scanSkillDir(path.join(home, ".agents", "skills"), "agents"));
  const project = typeof projectPath === "string" ? projectPath.trim() : "";
  if (project) {
    out.push(
      ...scanSkillDir(path.join(project, ".claude", "skills"), "project"),
    );
  }
  return out;
}

/**
 * Resolve and confine a skill dir inside a writable base. Throws unless the
 * result is exactly <base>/<name> (name regex already excludes separators
 * and dots; this is belt and braces against symlink tricks on the base).
 * @param {"claude" | "agents"} target
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
 * Write <base>/<name>/SKILL.md with frontmatter.
 * @param {{ target: "claude" | "agents", name: unknown, description: unknown, body: unknown }} input
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ name: string }}
 */
function addSkill(input, env = process.env) {
  const target = input && input.target;
  const dir = resolveSkillDir(target, input && input.name, env);
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
  const name = path.basename(dir);
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
  return { name };
}

/**
 * Delete <base>/<name> (confined to the two user skill dirs).
 * @param {{ target: "claude" | "agents", name: unknown }} input
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ name: string }}
 */
function removeSkill(input, env = process.env) {
  const dir = resolveSkillDir(input && input.target, input && input.name, env);
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) {
    throw new Error(`Unknown skill: ${path.basename(dir)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { name: path.basename(dir) };
}

module.exports = {
  SKILL_NAME_RE,
  parseSkillMarkdown,
  listSkills,
  addSkill,
  removeSkill,
  skillBaseDir,
};
