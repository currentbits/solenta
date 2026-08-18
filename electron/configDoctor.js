"use strict";

/**
 * Agent-config doctor (#412).
 *
 * Lints CLAUDE.md / AGENTS.md (and siblings) against Anthropic's six-axis
 * 100-point rubric, then can regenerate those files from the project's
 * shared-memory conventions, strategies, and verified decisions.
 *
 * Deterministic on purpose: no LLM. Scoring is heuristic; generation is a
 * template over memory entries. Session-end auto-learning is #247, not here.
 */

const fs = require("node:fs");
const path = require("node:path");

const AXIS_MAX = Object.freeze({
  commands: 20,
  architecture: 20,
  patterns: 15,
  conciseness: 15,
  currency: 15,
  actionability: 15,
});

const GENERATED_MARKER = "<!-- generated-by: solenta-config-doctor -->";

const ROOT_FILE_NAMES = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  ".claude.md",
  "GEMINI.md",
  ".cursorrules",
  path.join(".github", "copilot-instructions.md"),
  ".windsurfrules",
  "COPILOT.md",
]);

const PACKAGE_FILE_NAMES = Object.freeze(["AGENTS.md", "CLAUDE.md"]);

const WRITEABLE_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);

const SOURCE_TYPES = new Set(["convention", "strategy", "knowledge"]);

const COMMAND_HEADING =
  /\b(commands?|workflows?|build|test|lint|deploy|quick start|scripts?|dev)\b/i;
const ARCH_HEADING =
  /\b(architecture|structure|director(?:y|ies)|layout|code map|key files?|modules?)\b/i;
const PATTERN_HEADING =
  /\b(gotchas?|caveats?|warnings?|quirks?|pitfalls?|never|do not|don't|non-obvious)\b/i;

const COMMAND_LINE =
  /^\s*(?:\$\s*)?(?:npm|npx|pnpm|yarn|bun|cargo|make|go|pytest|python3?|node|git|uv)\b/;
const PATH_REF =
  /\b((?:src|electron|lib|app|packages|test|tests|core|memory-server|scripts|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/g;
const TICK_PATH = /`([^`\n]{1,200})`/g;
const PATTERN_HIT =
  /\b(never|do not|don't|gotcha|caveat|warning|pitfall|instead of|must not)\b/gi;
const FILLER =
  /this document|it is important|best practices|as an ai|comprehensive guide|please note|in order to/gi;
const VAGUE = /\b(should|consider|generally|typically|maybe|perhaps)\b/gi;
const HEADING_LINE = /^(#{1,3})\s+(.+)$/gm;

const ENTRY_BODY_CAP = 800;
const GENERATE_CAPS = Object.freeze({
  convention: 20,
  strategy: 10,
  knowledge: 15,
});

/**
 * @param {number} score
 * @returns {"A" | "B" | "C" | "D" | "F"}
 */
function gradeFor(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n < 30) return "F";
  if (n < 50) return "D";
  if (n < 70) return "C";
  if (n < 90) return "B";
  return "A";
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string}
 */
function posixRel(root, abs) {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join("/");
}

/**
 * @param {string} root
 * @returns {string[] | null}
 */
function loadPackageScripts(root) {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (!pkg || typeof pkg !== "object" || !pkg.scripts) return [];
    return Object.keys(pkg.scripts).filter((k) => typeof k === "string");
  } catch {
    return null;
  }
}

/**
 * Root + one-level packages/* agent-instruction files. Skips node_modules.
 *
 * @param {string} root
 * @returns {Array<{ path: string, absPath: string, bytes: number, content: string }>}
 */
function discoverAgentConfigFiles(root) {
  const out = [];
  if (!root || typeof root !== "string") return out;
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return out;
  }
  if (!stat.isDirectory()) return out;

  const seen = new Set();
  const push = (abs) => {
    const key = posixRel(root, abs);
    if (seen.has(key)) return;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return;
      const content = fs.readFileSync(abs, "utf8");
      seen.add(key);
      out.push({
        path: key,
        absPath: abs,
        bytes: st.size,
        content,
      });
    } catch {
      // unreadable: skip
    }
  };

  for (const name of ROOT_FILE_NAMES) {
    push(path.join(root, name));
  }

  const packagesDir = path.join(root, "packages");
  let ents = [];
  try {
    ents = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    ents = [];
  }
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    for (const name of PACKAGE_FILE_NAMES) {
      push(path.join(packagesDir, ent.name, name));
    }
  }
  return out;
}

/**
 * @param {string} content
 * @returns {string[]}
 */
function headingsOf(content) {
  const found = [];
  HEADING_LINE.lastIndex = 0;
  let m;
  while ((m = HEADING_LINE.exec(content))) {
    found.push(String(m[2] || "").trim());
  }
  return found;
}

/**
 * @param {string} content
 * @returns {string[]}
 */
function fencesOf(content) {
  const blocks = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(content))) {
    blocks.push(String(m[1] || ""));
  }
  return blocks;
}

/**
 * @param {string} content
 * @returns {string[]}
 */
function commandLinesOf(content) {
  const lines = [];
  for (const line of String(content || "").split(/\r?\n/)) {
    if (COMMAND_LINE.test(line)) lines.push(line.trim());
  }
  return lines;
}

/**
 * @param {string} content
 * @returns {string[]}
 */
function extractPathRefs(content) {
  const refs = new Set();
  PATH_REF.lastIndex = 0;
  let m;
  while ((m = PATH_REF.exec(content))) {
    refs.add(m[1]);
  }
  TICK_PATH.lastIndex = 0;
  while ((m = TICK_PATH.exec(content))) {
    const inner = String(m[1] || "").trim();
    if (!inner || inner.includes("://")) continue;
    if (!/[\\/]/.test(inner)) continue;
    if (/\s/.test(inner)) continue;
    refs.add(inner.replace(/\\/g, "/"));
  }
  return [...refs];
}

/**
 * @param {string} content
 * @param {{ root?: string | null, packageScripts?: string[] | null }} [ctx]
 */
function scoreCommands(content) {
  const headings = headingsOf(content);
  const hasHeading = headings.some((h) => COMMAND_HEADING.test(h));
  const fences = fencesOf(content).filter((b) =>
    commandLinesOf(b).length > 0 || COMMAND_LINE.test(b),
  );
  const lines = commandLinesOf(content);
  let score = 0;
  let notes = "No commands documented";
  if (hasHeading && fences.length >= 2) {
    score = 20;
    notes = "Commands and workflow are documented";
  } else if (hasHeading && fences.length >= 1) {
    score = 15;
    notes = "Commands present; workflow is thin";
  } else if (fences.length >= 1 || lines.length >= 3) {
    score = 10;
    notes = "Basic commands only, no workflow heading";
  } else if (/\b(build|test|lint|deploy|npm|pnpm)\b/i.test(content)) {
    score = 5;
    notes = "Mentions commands without listing them";
  }
  return { id: "commands", score, max: AXIS_MAX.commands, notes };
}

/**
 * @param {string} content
 */
function scoreArchitecture(content) {
  const headings = headingsOf(content);
  const hasHeading = headings.some((h) => ARCH_HEADING.test(h));
  const paths = extractPathRefs(content);
  let score = 0;
  let notes = "No architecture info";
  if (hasHeading && paths.length >= 3) {
    score = 20;
    notes = "Codebase map is clear";
  } else if (hasHeading || paths.length >= 5) {
    score = 15;
    notes = "Structure overview with minor gaps";
  } else if (paths.length >= 2) {
    score = 10;
    notes = "Path references only, no architecture heading";
  } else if (paths.length >= 1) {
    score = 5;
    notes = "Vague or incomplete structure";
  }
  return { id: "architecture", score, max: AXIS_MAX.architecture, notes };
}

/**
 * @param {string} content
 */
function scorePatterns(content) {
  const headings = headingsOf(content);
  const hasHeading = headings.some((h) => PATTERN_HEADING.test(h));
  const hits = content.match(PATTERN_HIT) || [];
  let score = 0;
  let notes = "No patterns or gotchas";
  if (hasHeading && hits.length >= 2) {
    score = 15;
    notes = "Gotchas and quirks are captured";
  } else if (hasHeading || hits.length >= 3) {
    score = 10;
    notes = "Some patterns documented";
  } else if (hits.length >= 1) {
    score = 5;
    notes = "Minimal pattern documentation";
  }
  return { id: "patterns", score, max: AXIS_MAX.patterns, notes };
}

/**
 * @param {string} content
 */
function scoreConciseness(content) {
  const words = String(content || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const fillers = content.match(FILLER) || [];
  let score;
  let notes;
  if (words >= 120 && words <= 2500) {
    score = 15;
    notes = "Dense, valuable content";
  } else if ((words >= 60 && words <= 119) || (words >= 2501 && words <= 5000)) {
    score = 10;
    notes =
      words < 120
        ? "Short; some useful signal is missing"
        : "Mostly concise, some padding";
  } else if ((words >= 30 && words <= 59) || (words >= 5001 && words <= 9000)) {
    score = 5;
    notes = words < 60 ? "Sparse" : "Verbose in places";
  } else {
    score = 0;
    notes = words < 30 ? "Empty or nearly empty" : "Mostly filler";
  }
  if (fillers.length) {
    score = Math.max(0, score - 3 * fillers.length);
    notes = "Filler phrases pad the file";
  }
  return { id: "conciseness", score, max: AXIS_MAX.conciseness, notes };
}

/**
 * @param {string} content
 * @param {{ root?: string | null, packageScripts?: string[] | null }} [ctx]
 */
function scoreCurrency(content, ctx) {
  if (!String(content || "").trim()) {
    return {
      id: "currency",
      score: 0,
      max: AXIS_MAX.currency,
      notes: "Empty file",
    };
  }
  const refs = extractPathRefs(content);
  const root = ctx && ctx.root;
  const scripts = (ctx && ctx.packageScripts) || [];
  const mentionedScripts = scripts.filter((s) => content.includes(s));

  if (!refs.length) {
    const score = mentionedScripts.length ? 10 : 5;
    return {
      id: "currency",
      score,
      max: AXIS_MAX.currency,
      notes: mentionedScripts.length
        ? "Scripts match package.json; no file references to check"
        : "No file references to verify",
    };
  }

  if (!root) {
    return {
      id: "currency",
      score: 10,
      max: AXIS_MAX.currency,
      notes: "File references present; tree not checked",
    };
  }

  let ok = 0;
  for (const ref of refs) {
    const abs = path.isAbsolute(ref) ? ref : path.join(root, ref);
    try {
      if (fs.existsSync(abs)) ok += 1;
    } catch {
      // ignore
    }
  }
  const ratio = ok / refs.length;
  let score;
  let notes;
  if (ok === refs.length) {
    score = 15;
    notes = "Referenced files exist";
  } else if (ratio >= 0.7) {
    score = 10;
    notes = "Mostly current; a few missing paths";
  } else if (ratio >= 0.3) {
    score = 5;
    notes = "Several outdated references";
  } else {
    score = 0;
    notes = "Referenced files are missing";
  }
  if (scripts.length && mentionedScripts.length === 0 && /npm run|pnpm /i.test(content)) {
    score = Math.max(0, score - 5);
    notes = "Documented scripts do not match package.json";
  }
  return { id: "currency", score, max: AXIS_MAX.currency, notes };
}

/**
 * @param {string} content
 */
function scoreActionability(content) {
  const fences = fencesOf(content).filter((b) => commandLinesOf(b).length > 0);
  const numbered = (content.match(/^\s*\d+\.\s+\S/gm) || []).length;
  const vague = (content.match(VAGUE) || []).length;
  const lines = commandLinesOf(content);
  let score = 0;
  let notes = "Vague or theoretical";
  if (fences.length >= 2) {
    score = 15;
    notes = "Instructions are copy-pasteable";
  } else if (fences.length >= 1 || numbered >= 3) {
    score = 10;
    notes = "Mostly actionable";
  } else if (numbered >= 1 || lines.length >= 1) {
    score = 5;
    notes = "Some vague instructions";
  }
  if (vague >= 5 && fences.length === 0) {
    score = Math.min(score, 5);
    notes = "Hedged language without executable commands";
  }
  return { id: "actionability", score, max: AXIS_MAX.actionability, notes };
}

/**
 * @param {string} title
 * @returns {string[]}
 */
function titleTokens(title) {
  return String(title || "")
    .toLowerCase()
    .match(/[a-z0-9]{4,}/g) || [];
}

/**
 * @param {string} haystack
 * @param {{ id: string, type: string, title: string }} entry
 * @returns {boolean}
 */
function entryCoveredBy(haystack, entry) {
  const tokens = titleTokens(entry.title);
  if (tokens.length === 0) {
    const needle = String(entry.title || "")
      .trim()
      .toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  }
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  const need = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.5);
  return hits >= need;
}

/**
 * @param {string} content
 * @param {Array<{ id: string, type: string, title: string }>} entries
 */
function memoryCoverage(content, entries) {
  const source = (entries || []).filter(
    (e) => e && SOURCE_TYPES.has(e.type),
  );
  const hay = String(content || "").toLowerCase();
  const covered = [];
  const missing = [];
  for (const entry of source) {
    if (entryCoveredBy(hay, entry)) covered.push(entry);
    else missing.push({ id: entry.id, type: entry.type, title: entry.title });
  }
  return {
    considered: source.length,
    covered: covered.length,
    missing,
  };
}

/**
 * @param {string} content
 * @param {{ root?: string | null, packageScripts?: string[] | null, memoryEntries?: object[] }} [ctx]
 */
function scoreAgentConfig(content, ctx) {
  const axes = [
    scoreCommands(content),
    scoreArchitecture(content),
    scorePatterns(content),
    scoreConciseness(content),
    scoreCurrency(content, ctx),
    scoreActionability(content),
  ];
  const score = axes.reduce((sum, a) => sum + a.score, 0);
  const issues = [];
  const recommendations = [];

  const text = String(content || "");
  if (!text.trim()) {
    issues.push({ severity: "error", message: "File is empty" });
    recommendations.push("Generate from shared memory or add commands, architecture, and gotchas");
  }
  const cmd = axes.find((a) => a.id === "commands");
  if (cmd && cmd.score <= 5) {
    issues.push({
      severity: "warn",
      message: "Build/test/dev commands are missing or not copy-pasteable",
    });
    recommendations.push("Add a Commands section with the real build, test, and lint invocations");
  }
  const arch = axes.find((a) => a.id === "architecture");
  if (arch && arch.score <= 5) {
    issues.push({
      severity: "warn",
      message: "No codebase map — agents will wander",
    });
    recommendations.push("Name the entry points and the directories that own them");
  }
  const pat = axes.find((a) => a.id === "patterns");
  if (pat && pat.score === 0) {
    issues.push({
      severity: "info",
      message: "No gotchas or non-obvious patterns",
    });
    recommendations.push("Promote verified memory decisions into a Gotchas section");
  }
  const cur = axes.find((a) => a.id === "currency");
  if (cur && cur.score === 0) {
    issues.push({
      severity: "error",
      message: "Referenced files do not exist on disk",
    });
    recommendations.push("Drop stale paths or regenerate from current memory");
  }

  const memory = memoryCoverage(text, (ctx && ctx.memoryEntries) || []);
  if (memory.considered > 0 && memory.missing.length > 0) {
    issues.push({
      severity: memory.covered === 0 ? "warn" : "info",
      message: `${memory.missing.length} memory ${
        memory.missing.length === 1 ? "entry is" : "entries are"
      } missing from this file`,
    });
    recommendations.push("Regenerate from shared memory to close the gap");
  }

  return {
    score,
    grade: gradeFor(score),
    axes,
    issues,
    recommendations,
    memory,
  };
}

/**
 * @param {Array<{ path: string, bytes: number, content: string }>} files
 * @param {{ root?: string | null, packageScripts?: string[] | null, memoryEntries?: object[] }} [ctx]
 */
function lintAgentConfigFiles(files, ctx) {
  const reports = [];
  for (const file of files || []) {
    const scored = scoreAgentConfig(file.content, ctx);
    reports.push({
      path: file.path,
      bytes: file.bytes,
      score: scored.score,
      grade: scored.grade,
      axes: scored.axes,
      issues: scored.issues,
      recommendations: scored.recommendations,
    });
  }

  const score =
    reports.length === 0
      ? 0
      : Math.round(
          reports.reduce((sum, r) => sum + r.score, 0) / reports.length,
        );

  const combined = memoryCoverage(
    (files || []).map((f) => f.content).join("\n"),
    (ctx && ctx.memoryEntries) || [],
  );

  if (reports.length === 0) {
    return {
      files: [],
      score: 0,
      grade: "F",
      memory: combined,
      issues: [
        {
          severity: "error",
          message: "No AGENTS.md / CLAUDE.md (or sibling) in this repo",
        },
      ],
      recommendations: [
        "Generate AGENTS.md from shared memory so every agent reads the same conventions",
      ],
    };
  }

  return {
    files: reports,
    score,
    grade: gradeFor(score),
    memory: combined,
    issues: reports.flatMap((r) =>
      r.issues.map((i) => ({ ...i, message: `${r.path}: ${i.message}` })),
    ),
    recommendations: [...new Set(reports.flatMap((r) => r.recommendations))],
  };
}

/**
 * Conventions always; strategies always; knowledge only when it looks like a
 * decision/gotcha (importance >= 3 or it has citations).
 *
 * @param {Array<{ type?: string, importance?: number, citations?: unknown[] }>} entries
 */
function selectSourceEntries(entries) {
  const picked = [];
  for (const entry of entries || []) {
    if (!entry || !SOURCE_TYPES.has(entry.type)) continue;
    if (entry.type === "knowledge") {
      const importance = Number(entry.importance);
      const cited = Array.isArray(entry.citations) && entry.citations.length > 0;
      if (!(importance >= 3 || cited)) continue;
    }
    picked.push(entry);
  }
  picked.sort((a, b) => {
    const rank = { convention: 0, strategy: 1, knowledge: 2 };
    const d = (rank[a.type] ?? 9) - (rank[b.type] ?? 9);
    if (d !== 0) return d;
    return (Number(b.importance) || 0) - (Number(a.importance) || 0);
  });
  const counts = { convention: 0, strategy: 0, knowledge: 0 };
  const out = [];
  for (const entry of picked) {
    if (counts[entry.type] >= GENERATE_CAPS[entry.type]) continue;
    counts[entry.type] += 1;
    out.push(entry);
  }
  return out;
}

/**
 * @param {string} text
 * @param {number} max
 */
function clipBody(text, max) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}\n…`;
}

/**
 * @param {{ name?: string, entries?: object[] }} input
 * @returns {string}
 */
function renderGeneratedMarkdown(input) {
  const name = String((input && input.name) || "Project").trim() || "Project";
  const selected = selectSourceEntries((input && input.entries) || []);
  const byType = { convention: [], strategy: [], knowledge: [] };
  for (const entry of selected) {
    byType[entry.type].push(entry);
  }

  const lines = [
    `# ${name}`,
    "",
    "Standing instructions generated from Solenta shared memory — conventions, strategies, and verified decisions. Prefer these over restating the tree.",
    "",
    GENERATED_MARKER,
    "",
  ];

  const section = (heading, rows) => {
    if (rows.length === 0) return;
    lines.push(`## ${heading}`, "");
    for (const row of rows) {
      const title = String(row.title || "").trim() || "(untitled)";
      const body = clipBody(row.body || row.excerpt || "", ENTRY_BODY_CAP);
      lines.push(`### ${title}`, "");
      if (body) {
        lines.push(body, "");
      }
    }
  };

  section("Conventions", byType.convention);
  section("Strategies", byType.strategy);
  section("Decisions and gotchas", byType.knowledge);

  if (selected.length === 0) {
    lines.push(
      "## Empty memory",
      "",
      "No conventions, strategies, or verified decisions are stored for this project yet. Add them in the Memory tab, then regenerate.",
      "",
    );
  }

  return lines.join("\n");
}

/**
 * @param {string} root
 * @param {string} rel
 */
function assertWriteableRel(root, rel) {
  const normalized = String(rel || "").trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("..")) {
    throw new Error("Invalid agent-config path");
  }
  const base = path.posix.basename(normalized);
  if (!WRITEABLE_BASENAMES.has(base)) {
    throw new Error(`Refusing to write ${normalized}`);
  }
  const abs = path.resolve(root, normalized.split("/").join(path.sep));
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error("Refusing to write outside the project");
  }
  return { rel: normalized, abs };
}

/**
 * Default write set: always AGENTS.md. Also CLAUDE.md when it already
 * exists, or when the repo has no agent-instruction file yet.
 *
 * @param {Array<{ path: string }>} existing
 * @returns {string[]}
 */
function defaultWriteTargets(existing) {
  const have = new Set((existing || []).map((f) => f.path));
  const targets = ["AGENTS.md"];
  if (have.has("CLAUDE.md") || existing.length === 0) {
    targets.push("CLAUDE.md");
  }
  return targets;
}

/**
 * @param {string} root
 * @param {Array<{ path: string, content: string }>} files
 * @returns {string[]}
 */
function writeAgentConfigFiles(root, files) {
  if (!root) throw new Error("Project path is required");
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    throw new Error("Config doctor needs a local checkout");
  }
  if (!st.isDirectory()) throw new Error("Config doctor needs a local checkout");

  const written = [];
  for (const file of files || []) {
    const { rel, abs } = assertWriteableRel(root, file.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(file.content ?? ""), "utf8");
    written.push(rel);
  }
  return written;
}

/**
 * @param {{
 *   root: string,
 *   name?: string,
 *   memoryEntries?: object[],
 *   targets?: string[],
 * }} input
 */
function previewGeneratedFiles(input) {
  const root = input && input.root;
  const existing = discoverAgentConfigFiles(root);
  const targets =
    input && Array.isArray(input.targets) && input.targets.length > 0
      ? input.targets
      : defaultWriteTargets(existing);
  const content = renderGeneratedMarkdown({
    name: input && input.name,
    entries: (input && input.memoryEntries) || [],
  });
  const have = new Set(existing.map((f) => f.path));
  return targets.map((rel) => {
    const { rel: safe } = assertWriteableRel(root || ".", rel);
    return {
      path: safe,
      content,
      exists: have.has(safe),
    };
  });
}

module.exports = {
  AXIS_MAX,
  GENERATED_MARKER,
  gradeFor,
  discoverAgentConfigFiles,
  loadPackageScripts,
  extractPathRefs,
  scoreAgentConfig,
  lintAgentConfigFiles,
  memoryCoverage,
  selectSourceEntries,
  renderGeneratedMarkdown,
  defaultWriteTargets,
  previewGeneratedFiles,
  writeAgentConfigFiles,
  assertWriteableRel,
};
