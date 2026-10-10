"use strict";

/**
 * CLI custom agents a thread can run as (#172): `claude --agent <name>` and
 * `opencode run --agent <name>`. Discovery mirrors where each CLI looks:
 *
 * - claude: .claude/agents/*.md (project) and ~/.claude/agents/*.md (user).
 *   Name is the frontmatter `name:`, falling back to the file stem.
 * - opencode: built-in primaries build/plan, plus .opencode/agent(s)/*.md
 *   and ~/.config/opencode/agent(s)/*.md. Name is the file stem.
 *   `mode: subagent` files are skipped: run --agent cannot use them.
 *
 * Agents defined inline in opencode.json are not listed (ponytail: add a
 * JSON read when someone asks).
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { parseSkillMarkdown } = require("./skills.js");

/** Also the argv guard: names reach ssh/WSL shells via wrapCommand. */
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const OPENCODE_BUILTINS = [
  { name: "build", description: "Default agent with all tools enabled" },
  { name: "plan", description: "Read-only analysis and planning" },
];

/**
 * @param {string} content
 * @returns {string | null}
 */
function frontmatterMode(content) {
  const fm = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^mode:\s*["']?([A-Za-z]+)/m);
  return m ? m[1].toLowerCase() : null;
}

/**
 * @param {string} dir
 * @param {"project" | "user"} source
 * @param {boolean} nameFromFrontmatter
 * @returns {Array<{ name: string, description: string, source: string, mode: string | null }>}
 */
function scanAgentDir(dir, source, nameFromFrontmatter) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    let content;
    try {
      // readFileSync follows symlinks; dangling links throw into the catch.
      content = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillMarkdown(content);
    const name =
      (nameFromFrontmatter && parsed.name) || file.slice(0, -".md".length);
    if (!AGENT_NAME_RE.test(name)) continue;
    out.push({
      name,
      description: parsed.description || "",
      source,
      mode: frontmatterMode(content),
    });
  }
  return out;
}

/**
 * @param {{ provider?: string | null, projectPath?: string | null, env?: NodeJS.ProcessEnv }} opts
 * @returns {Array<{ name: string, description: string, source: "builtin" | "project" | "user" }>}
 */
function listAgents(opts = {}) {
  const env = opts.env || process.env;
  const home = env.HOME || os.homedir();
  const project = opts.projectPath || null;
  /** @type {Array<{ name: string, description: string, source: string, mode?: string | null }>} */
  let rows = [];
  if (opts.provider === "claude") {
    if (project) rows.push(...scanAgentDir(path.join(project, ".claude", "agents"), "project", true));
    rows.push(...scanAgentDir(path.join(home, ".claude", "agents"), "user", true));
  } else if (opts.provider === "opencode") {
    const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
    rows.push(...OPENCODE_BUILTINS.map((a) => ({ ...a, source: "builtin" })));
    for (const sub of ["agent", "agents"]) {
      if (project) rows.push(...scanAgentDir(path.join(project, ".opencode", sub), "project", false));
    }
    for (const sub of ["agent", "agents"]) {
      rows.push(...scanAgentDir(path.join(xdg, "opencode", sub), "user", false));
    }
    rows = rows.filter((r) => r.mode !== "subagent");
  }
  // Project shadows user (and a project build.md shadows the built-in):
  // keep the first hit per name, but let a later file override builtins.
  /** @type {Map<string, { name: string, description: string, source: any }>} */
  const byName = new Map();
  for (const r of rows) {
    const prev = byName.get(r.name);
    if (prev && prev.source !== "builtin") continue;
    byName.set(r.name, { name: r.name, description: r.description, source: r.source });
  }
  return [...byName.values()];
}

module.exports = { AGENT_NAME_RE, listAgents };
