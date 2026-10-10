"use strict";

/**
 * Repo-versioned workflow definitions (#164). A repo can commit its workflow
 * as markdown so it is diffable, reviewable and travels with branches/forks:
 *
 *   # Plan and Verify
 *
 *   ## seed
 *   provider: claude
 *   model: claude-opus-5-5
 *   agents: 1
 *
 *   Produce a concise plan plus key questions.
 *
 * `# ` is the template name, each `## ` heading is a phase. A phase opens with
 * `key: value` lines (provider, model, agents); the rest of the section is the
 * instruction. Prose between the title and the first phase is ignored, so the
 * file can document itself. An instruction cannot contain its own `## ` line.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Checked in order; the first that exists wins. */
const REPO_WORKFLOW_FILES = ["WORKFLOW.md", path.join(".solenta", "workflow.md")];

const PHASE_KEYS = new Set(["provider", "model", "agents"]);

/**
 * @param {string} text
 * @returns {{ name: string, phases: object[] }} unvalidated template shape
 */
function parseRepoWorkflow(text) {
  const parts = String(text).replace(/\r\n?/g, "\n").split(/^##[ \t]+/m);
  const title = /^#[ \t]+(.+)$/m.exec(parts[0]);
  const phases = parts.slice(1).map((section) => {
    const lines = section.split("\n");
    const phase = {
      name: lines.shift().trim(),
      agentCount: 1,
      instruction: "",
      provider: "",
      model: null,
    };
    while (lines.length && !lines[0].trim()) lines.shift();
    let m;
    while (lines.length && (m = /^(\w+):[ \t]*(.*)$/.exec(lines[0].trim()))) {
      const key = m[1].toLowerCase();
      if (!PHASE_KEYS.has(key)) {
        throw new Error(`Phase "${phase.name}": unknown key "${m[1]}"`);
      }
      const value = m[2].trim();
      if (key === "agents") phase.agentCount = Number(value);
      else if (key === "model") phase.model = value || null;
      else phase.provider = value;
      lines.shift();
    }
    phase.instruction = lines.join("\n").trim();
    return phase;
  });
  return { name: title ? title[1].trim() : "", phases };
}

/**
 * @param {{ name: string, phases: object[] }} template
 * @returns {string}
 */
function serializeRepoWorkflow(template) {
  const sections = template.phases.map((p) =>
    [
      `## ${p.name}`,
      `provider: ${p.provider}`,
      ...(p.model ? [`model: ${p.model}`] : []),
      `agents: ${p.agentCount}`,
      "",
      String(p.instruction).trim(),
    ].join("\n"),
  );
  return [`# ${template.name}`, ...sections].join("\n\n") + "\n";
}

/**
 * Relative path of the repo workflow file in `dir`, or null.
 * @param {string} dir
 */
function findRepoWorkflow(dir) {
  return (
    REPO_WORKFLOW_FILES.find((rel) => fs.existsSync(path.join(dir, rel))) ??
    null
  );
}

/**
 * Load and validate the repo workflow in `dir`. Returns null when the repo has
 * none; throws (prefixed with the file name) when it exists but is invalid, so
 * a broken file never silently falls back to a store template.
 *
 * @param {string} dir
 */
function loadRepoWorkflow(dir) {
  const rel = findRepoWorkflow(dir);
  if (!rel) return null;
  try {
    const template = parseRepoWorkflow(
      fs.readFileSync(path.join(dir, rel), "utf8"),
    );
    require("./services-settings.js").validateWorkflowTemplate(template);
    return { id: `repo:${rel}`, builtin: false, source: rel, ...template };
  } catch (err) {
    throw new Error(`${rel}: ${err instanceof Error ? err.message : err}`);
  }
}

module.exports = {
  REPO_WORKFLOW_FILES,
  parseRepoWorkflow,
  serializeRepoWorkflow,
  findRepoWorkflow,
  loadRepoWorkflow,
};
