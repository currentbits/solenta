"use strict";

/**
 * Instruction-file Fusion (#1856).
 *
 * Reads every agent-instruction file configDoctor discovers (AGENTS.md,
 * CLAUDE.md, GEMINI.md, .cursorrules, .cursor/rules/*, …), pulls out
 * comparable facts (package manager; install/test/build/lint/format
 * commands; near-duplicate lines that disagree) and reports where the files
 * conflict, with file:line on every side. A sync writes one shared block,
 * between start/end markers, into each file the user ticks. Text outside the
 * markers is never touched.
 *
 * Deterministic on purpose: no LLM. Each start marker carries a hash of the
 * text outside every block plus that block's own body, so "synced" is
 * computed from disk alone and survives clones and worktrees.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const configDoctor = require("./configDoctor.js");

const START = "solenta:fusion:start";
const END = "solenta:fusion:end";
const MARKER_SHA_RE = /solenta:fusion:start sha:([0-9a-f]+)/;

const FACT_KEYS = Object.freeze([
  ["packageManager", "Package manager"],
  ["install", "Install"],
  ["test", "Test"],
  ["build", "Build"],
  ["lint", "Lint"],
  ["format", "Format"],
]);
const FACT_LABEL = Object.fromEntries(FACT_KEYS);

const TOOL_RE =
  /^(?:npm|npx|pnpm|yarn|bun|bunx|make|cargo|go|pytest|uv|python3?|node|deno|ruff|eslint|prettier|vitest|jest|tsc)\b/;
const PM_RE = /^(npm|npx|pnpm|yarn|bunx|bun)\b/;
const INSTALL_RE =
  /^(?:npm (?:i|install|ci)|pnpm (?:i|install)|yarn(?: install)?|bun (?:i|install)|uv sync|pip install -r \S+)(?: --?[\w-]+(?:=\S+)?)*$/;
const CATEGORY_RES = [
  ["test", /\btest\b|\b(?:vitest|jest|pytest|mocha)\b/],
  ["build", /\bbuild\b/],
  ["lint", /\blint\b|\beslint\b|\bruff check\b|\bclippy\b/],
  ["format", /\bformat\b|\bfmt\b|\bprettier\b/],
];

const KINDS = Object.freeze({
  agents: "Codex, Grok, OpenCode and others",
  claude: "Claude Code",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  windsurf: "Windsurf",
});

/** @param {string} rel posix path */
function fileKind(rel) {
  const base = path.posix.basename(rel);
  if (base === "AGENTS.md") return "agents";
  if (base === "CLAUDE.md" || base === ".claude.md") return "claude";
  if (base === "GEMINI.md") return "gemini";
  if (base === ".cursorrules" || rel.startsWith(".cursor/")) return "cursor";
  if (base === "copilot-instructions.md" || base === "COPILOT.md") return "copilot";
  if (base === ".windsurfrules") return "windsurf";
  return "agents";
}

/**
 * Root-level instruction files only: packages/* files describe one package,
 * so comparing their commands with the root's would invent conflicts.
 * Symlinked duplicates (CLAUDE.md -> AGENTS.md) and links that leave the
 * project are dropped so a sync never writes one file twice or outside root.
 *
 * @param {string} root
 */
function discoverFusionFiles(root) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const file of configDoctor.discoverAgentConfigFiles(root)) {
    if (file.path.startsWith("packages/")) continue;
    let real;
    let mtimeMs = 0;
    try {
      real = fs.realpathSync(file.absPath);
      mtimeMs = fs.statSync(file.absPath).mtimeMs;
    } catch {
      continue;
    }
    if (seen.has(real) || !real.startsWith(rootReal + path.sep)) continue;
    seen.add(real);
    out.push({ ...file, mtimeMs });
  }
  return out;
}

/** @param {string} content */
function findBlock(content) {
  const s = content.indexOf(START);
  if (s === -1) return null;
  const e = content.indexOf(END, s);
  if (e === -1) return null;
  const from = content.lastIndexOf("\n", s) + 1;
  const nl = content.indexOf("\n", e);
  return { from, to: nl === -1 ? content.length : nl + 1 };
}

/** Lines between the markers, without the marker lines. */
function blockInner(content) {
  const at = findBlock(content);
  if (!at) return null;
  const startEnd = content.indexOf("\n", at.from);
  const endLine = content.lastIndexOf("\n", content.indexOf(END, at.from)) + 1;
  return content.slice(startEnd + 1, Math.max(startEnd + 1, endLine - 1));
}

/** Text outside the block; trailing whitespace dropped so appending a block is neutral. */
function outsideText(content) {
  const at = findBlock(content);
  return (at ? content.slice(0, at.from) + content.slice(at.to) : content).trimEnd();
}

/** @param {string} text */
function commandCandidates(text, inFence) {
  const out = [];
  if (inFence) {
    out.push(text.trim().replace(/^\$\s+/, ""));
  } else {
    const re = /`([^`\n]+)`/g;
    let m;
    while ((m = re.exec(text))) out.push(m[1].trim().replace(/^\$\s+/, ""));
    const bare = text.trim().replace(/^(?:[-*]|\d+\.)\s+/, "").replace(/^\$\s+/, "");
    if (!out.length && TOOL_RE.test(bare)) out.push(bare);
  }
  return out
    .map((c) => c.replace(/\s+/g, " "))
    .filter((c) => TOOL_RE.test(c));
}

/** @param {string} cmd */
function commandCategory(cmd) {
  if (INSTALL_RE.test(cmd)) return "install";
  for (const [key, re] of CATEGORY_RES) if (re.test(cmd)) return key;
  return null;
}

/** @param {string} line */
function lineTokens(line) {
  return String(line).toLowerCase().match(/[a-z0-9]+/g) || [];
}

/**
 * Facts and prose lines from one file, skipping the fusion block so a
 * previous sync never counts as one more voice.
 *
 * @param {{ path: string, content: string }} file
 */
function extractFileFacts(file) {
  const content = String(file.content || "");
  const block = findBlock(content);
  const facts = {};
  const pms = [];
  const prose = [];
  let inFence = false;
  let offset = 0;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const at = offset;
    offset += raw.length + 1;
    if (block && at >= block.from && at < block.to) continue;
    const line = raw.replace(/\r$/, "");
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const lineNo = i + 1;
    const cmds = commandCandidates(line, inFence);
    for (const cmd of cmds) {
      const pm = PM_RE.exec(cmd);
      if (pm) pms.push({ value: pm[1], line: lineNo });
      const key = commandCategory(cmd);
      if (key && !facts[key]) facts[key] = { value: cmd, line: lineNo };
    }
    if (inFence || cmds.length || /^\s*#/.test(line) || line.includes("`")) continue;
    const text = line.trim().replace(/^(?:[-*]|\d+\.)\s+/, "");
    const tokens = lineTokens(text);
    if (tokens.length >= 3) prose.push({ text, tokens, line: lineNo });
  }
  // npx runs in pnpm/yarn repos too; it only names the manager when nothing else does.
  const pm = pms.find((p) => p.value !== "npx") || pms[0];
  if (pm) {
    const value = pm.value === "npx" ? "npm" : pm.value === "bunx" ? "bun" : pm.value;
    facts.packageManager = { value, line: pm.line };
  }
  return { facts, prose };
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  let both = 0;
  for (const t of sa) if (sb.has(t)) both += 1;
  return both / (sa.size + sb.size - both);
}

const normLine = (text) => lineTokens(text).join(" ");

/**
 * Near-duplicate prose lines across files that say different things
 * ("Use 2-space indentation" vs "Use 4-space indentation").
 * ponytail: O(n²) over prose lines; instruction files are small.
 */
function lineConflicts(perFile) {
  const rows = [];
  for (const { path: rel, prose } of perFile) {
    for (const p of prose) rows.push({ ...p, path: rel, norm: normLine(p.text) });
  }
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (rows[i].path === rows[j].path) continue;
      if (rows[i].norm === rows[j].norm || jaccard(rows[i].tokens, rows[j].tokens) >= 0.6) {
        parent[find(j)] = find(i);
      }
    }
  }
  const groups = new Map();
  rows.forEach((row, i) => {
    const g = find(i);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(row);
  });
  const out = [];
  for (const group of groups.values()) {
    if (new Set(group.map((r) => r.path)).size < 2) continue;
    const options = new Map();
    for (const row of group) {
      if (!options.has(row.norm)) options.set(row.norm, { value: row.text, sources: [] });
      options.get(row.norm).sources.push({ path: row.path, line: row.line });
    }
    if (options.size < 2) continue;
    const values = [...options.values()];
    const id = `line:${crypto
      .createHash("sha1")
      .update(values.map((v) => v.value).sort().join("\n"))
      .digest("hex")
      .slice(0, 10)}`;
    out.push({ id, key: "line", label: "Similar lines", options: values });
  }
  return out;
}

/**
 * @param {Array<{ path: string, content: string }>} files
 * @returns {{ agreed: object[], conflicts: object[] }}
 */
function analyzeFiles(files) {
  const perFile = files.map((f) => ({ path: f.path, ...extractFileFacts(f) }));
  const agreed = [];
  const conflicts = [];
  for (const [key, label] of FACT_KEYS) {
    const options = new Map();
    for (const f of perFile) {
      const fact = f.facts[key];
      if (!fact) continue;
      if (!options.has(fact.value)) options.set(fact.value, { value: fact.value, sources: [] });
      options.get(fact.value).sources.push({ path: f.path, line: fact.line });
    }
    if (options.size === 1) agreed.push({ key, label, ...[...options.values()][0] });
    if (options.size > 1) conflicts.push({ id: key, key, label, options: [...options.values()] });
  }
  conflicts.push(...lineConflicts(perFile));
  return { agreed, conflicts };
}

/** Default pick: what the last sync chose, else the most-cited option. */
function defaultPick(conflict, previousBlock) {
  if (previousBlock) {
    const hit = conflict.options.find((o) =>
      conflict.key === "packageManager"
        ? previousBlock.includes(`Package manager: ${o.value}\n`)
        : conflict.key === "line"
          ? previousBlock.includes(`- ${o.value}\n`)
          : previousBlock.includes(`\`${o.value}\``),
    );
    if (hit) return hit.value;
  }
  let best = conflict.options[0];
  for (const o of conflict.options) if (o.sources.length > best.sources.length) best = o;
  return best.value;
}

/** Block body lines, before markers are added. */
function blockBody(agreed, conflicts) {
  const chosen = new Map(agreed.map((f) => [f.key, f.value]));
  const lines = [];
  for (const c of conflicts) {
    if (c.key === "line") lines.push(c.pick);
    else chosen.set(c.key, c.pick);
  }
  const facts = [];
  for (const [key, label] of FACT_KEYS) {
    if (!chosen.has(key)) continue;
    const v = chosen.get(key);
    facts.push(key === "packageManager" ? `- ${label}: ${v}` : `- ${label}: \`${v}\``);
  }
  if (!facts.length && !lines.length) return null;
  return [
    "## Shared instructions",
    "",
    "Solenta Fusion keeps this block the same in every agent's instruction file. Change it from Solenta, not here.",
    "",
    ...facts,
    ...lines.map((l) => `- ${l}`),
  ].join("\n");
}

// ponytail: HTML comments for every file; .cursorrules and .windsurfrules have
// no comment syntax of their own and are read as markdown anyway.
function renderBlock(body, sha) {
  return `<!-- ${START} sha:${sha} -->\n${body}\n<!-- ${END} -->\n`;
}

/** Replace the block in place, or append it after the existing text. */
function applyBlock(content, block) {
  const at = findBlock(content);
  if (at) return content.slice(0, at.from) + block + content.slice(at.to);
  const sep = !content || content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + block;
}

/**
 * Hash of every instruction file's text outside its block, plus one block
 * body. Independent of which files carry a block, so ticking fewer files
 * never changes the others' markers.
 */
function blockSha(files, body) {
  const h = crypto.createHash("sha1");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    h.update(`${f.path}\0${outsideText(String(f.content))}\0`);
  }
  return h.update(body).digest("hex").slice(0, 12);
}

/**
 * Synced when at least one file carries a block and every block's hash
 * matches the files as they are now.
 */
function fusionStatus(files) {
  let blocks = 0;
  let synced = true;
  let syncedAt = 0;
  for (const f of files) {
    const m = MARKER_SHA_RE.exec(f.content);
    if (!m) continue;
    blocks += 1;
    if (m[1] !== blockSha(files, blockInner(f.content))) synced = false;
    syncedAt = Math.max(syncedAt, f.mtimeMs || 0);
  }
  synced = synced && blocks > 0;
  return { synced, syncedAt: synced ? syncedAt : null };
}

function toLines(text) {
  const lines = String(text).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** One-hunk unified diff: a sync only ever changes one contiguous region. */
function unifiedDiff(rel, before, after) {
  if (before === after) return "";
  const a = toLines(before);
  const b = toLines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf += 1;
  }
  const start = Math.max(0, pre - 3);
  const aEnd = a.length - suf;
  const bEnd = b.length - suf;
  const aTo = Math.min(a.length, aEnd + 3);
  const bTo = Math.min(b.length, bEnd + 3);
  const out = [
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -${start + 1},${aTo - start} +${start + 1},${bTo - start} @@`,
  ];
  for (let i = start; i < pre; i += 1) out.push(` ${a[i]}`);
  for (let i = pre; i < aEnd; i += 1) out.push(`-${a[i]}`);
  for (let i = pre; i < bEnd; i += 1) out.push(`+${b[i]}`);
  for (let i = aEnd; i < aTo; i += 1) out.push(` ${a[i]}`);
  return out.join("\n");
}

/**
 * Pure planner over in-memory files.
 *
 * @param {Array<{ path: string, content: string, mtimeMs?: number }>} files
 * @param {{ picks?: Record<string, string>, importInClaude?: boolean, paths?: string[] }} [opts]
 *   `paths` limits which files get the block (default: all); the rest keep
 *   their current text and still count toward the hash.
 */
function planFusion(files, opts = {}) {
  const { agreed, conflicts } = analyzeFiles(files);
  const withBlock = files.find((f) => findBlock(f.content));
  const previous = withBlock && findBlock(withBlock.content);
  const previousBlock = previous ? withBlock.content.slice(previous.from, previous.to) : "";
  const picks = opts.picks || {};
  for (const c of conflicts) {
    c.pick = c.options.some((o) => o.value === picks[c.id])
      ? picks[c.id]
      : defaultPick(c, previousBlock);
  }
  const body = blockBody(agreed, conflicts);
  const targets = new Set(opts.paths || files.map((f) => f.path));
  const agentsSynced = files.some((f) => f.path === "AGENTS.md" && targets.has(f.path));
  const bodyFor = (rel) =>
    opts.importInClaude && agentsSynced && rel === "CLAUDE.md" ? "@AGENTS.md" : body;

  const after = files.map((f) =>
    body && targets.has(f.path)
      ? applyBlock(f.content, renderBlock(bodyFor(f.path), blockSha(files, bodyFor(f.path))))
      : f.content,
  );
  return {
    files: files.map((f) => ({
      path: f.path,
      kind: fileKind(f.path),
      kindLabel: KINDS[fileKind(f.path)],
      hasBlock: Boolean(findBlock(f.content)),
    })),
    agreed,
    conflicts,
    diffs: files.map((f, i) => ({
      path: f.path,
      diff: unifiedDiff(f.path, f.content, after[i]),
      changed: after[i] !== f.content,
    })),
    after: Object.fromEntries(files.map((f, i) => [f.path, after[i]])),
    status: fusionStatus(files),
  };
}

/**
 * @param {string} root
 * @param {{ picks?: Record<string, string>, importInClaude?: boolean }} [opts]
 */
function previewFusion(root, opts) {
  const { after, ...plan } = planFusion(discoverFusionFiles(root), opts);
  return plan;
}

/**
 * Write the block into the ticked files. Re-plans from disk so the write is
 * based on what is there now; unchanged files are not rewritten.
 *
 * @param {string} root
 * @param {{ picks?: Record<string, string>, importInClaude?: boolean, paths: string[] }} opts
 */
function syncFusion(root, opts) {
  const files = discoverFusionFiles(root);
  const allowed = new Set(files.map((f) => f.path));
  const paths = (opts.paths || []).filter((p) => allowed.has(p));
  const plan = planFusion(files, { ...opts, paths });
  const writes = files
    .filter((f) => paths.includes(f.path) && plan.after[f.path] !== f.content)
    .map((f) => ({ path: f.path, content: plan.after[f.path] }));
  const written = configDoctor.writeAgentConfigFiles(root, writes, allowed);
  return { written, status: fusionStatus(discoverFusionFiles(root)) };
}

module.exports = {
  START,
  END,
  fileKind,
  discoverFusionFiles,
  extractFileFacts,
  analyzeFiles,
  applyBlock,
  blockSha,
  fusionStatus,
  unifiedDiff,
  planFusion,
  previewFusion,
  syncFusion,
};
