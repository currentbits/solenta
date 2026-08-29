"use strict";

/**
 * Deterministic repo wiki (issue #268). Derived from the shared code index
 * plus lockfile-free manifests. Describes the code, not agent learnings.
 *
 * ponytail: no LLM, no extra on-disk format. The index already has the
 * files; this groups them and reads package.json. Add AI-annotated
 * architecture notes if a generated paragraph ever beats the hottest-files
 * list for onboarding.
 */

const fs = require("node:fs");
const path = require("node:path");

const WIKI_NOTE_MAX = 1200;
const MAX_MODULES = 16;
const MAX_HOT_FILES = 4;
const MAX_DEPS = 24;
const SKIP_TOP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".next",
  "out",
]);

/**
 * @typedef {object} WikiHotFile
 * @property {string} path
 * @property {string[]} symbols
 * @property {number} rank
 *
 * @typedef {object} WikiModule
 * @property {string} name
 * @property {number} fileCount
 * @property {number} symbolCount
 * @property {WikiHotFile[]} hot
 *
 * @typedef {object} CodeWiki
 * @property {number} updatedAt
 * @property {number} fileCount
 * @property {number} symbolCount
 * @property {string} headSha
 * @property {string} defaultBranch
 * @property {WikiModule[]} modules
 * @property {string[]} dependencies
 */

/**
 * @param {import('./codeindex.js').CodeIndex | null | undefined} index
 * @param {{ dependencies?: string[], headSha?: string, defaultBranch?: string }} [extras]
 * @returns {CodeWiki}
 */
function wikiFromIndex(index, extras) {
  extras = extras || {};
  const files = Array.isArray(index && index.files) ? index.files : [];
  let symbolCount = Number(index && index.symbolCount) || 0;
  if (!symbolCount) {
    for (const file of files) {
      symbolCount += Array.isArray(file && file.symbols) ? file.symbols.length : 0;
    }
  }
  return {
    updatedAt: Number(index && index.updatedAt) || 0,
    fileCount: Number(index && index.fileCount) || files.length,
    symbolCount,
    headSha: String(extras.headSha || (index && index.headSha) || ""),
    defaultBranch: String(extras.defaultBranch || ""),
    modules: modulesFromFiles(files),
    dependencies: Array.isArray(extras.dependencies)
      ? extras.dependencies.slice(0, MAX_DEPS)
      : [],
  };
}

/**
 * @param {unknown[]} files
 * @returns {WikiModule[]}
 */
function modulesFromFiles(files) {
  /** @type {Map<string, WikiModule>} */
  const by = new Map();
  for (const file of files) {
    if (!file || !file.path) continue;
    const name = moduleName(String(file.path));
    if (!name) continue;
    let row = by.get(name);
    if (!row) {
      row = { name, fileCount: 0, symbolCount: 0, hot: [] };
      by.set(name, row);
    }
    const symbols = Array.isArray(file.symbols) ? file.symbols : [];
    row.fileCount += 1;
    row.symbolCount += symbols.length;
    row.hot.push({
      path: String(file.path),
      symbols: symbols.slice(0, 8),
      rank: Number(file.rank) || 0,
    });
  }
  const list = [...by.values()];
  for (const row of list) {
    row.hot.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
    row.hot = row.hot.slice(0, MAX_HOT_FILES);
  }
  list.sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
  return list.slice(0, MAX_MODULES);
}

/**
 * @param {string} rel
 * @returns {string}
 */
function moduleName(rel) {
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return "";
  if (SKIP_TOP.has(parts[0])) return "";
  if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
  if (parts.length === 1) return "(root)";
  return parts[0];
}

/**
 * Key runtime/dev dependencies from common manifests. Missing files are
 * skipped; a parse error on one file does not hide the others.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
function parseDependencies(repoRoot) {
  const seen = new Set();
  const deps = [];
  const add = (name) => {
    const n = String(name || "").trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    deps.push(n);
  };

  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const obj = pkg && pkg[key];
      if (!obj || typeof obj !== "object") continue;
      for (const name of Object.keys(obj)) add(name);
    }
  } catch {
    /* no package.json */
  }

  try {
    const text = fs.readFileSync(path.join(repoRoot, "go.mod"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("//") || t === "require (" || t === ")") continue;
      const m = /^(?:require\s+)?(\S+)\s+v\d/.exec(t);
      if (m && m[1] !== "module") add(m[1]);
    }
  } catch {
    /* no go.mod */
  }

  try {
    const text = fs.readFileSync(path.join(repoRoot, "requirements.txt"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("-")) continue;
      add(t.split(/[<>=!~\[]/, 1)[0]);
    }
  } catch {
    /* no requirements.txt */
  }

  return deps.slice(0, MAX_DEPS);
}

/**
 * Compact standing note. Empty when there is nothing to orient on.
 *
 * @param {CodeWiki | null | undefined} wiki
 * @returns {string}
 */
function formatWikiNote(wiki) {
  if (!wiki || !Array.isArray(wiki.modules) || wiki.modules.length === 0) {
    return "";
  }
  const lines = [
    "\n\n[Code wiki] Regenerated map of this repo (not agent memory). " +
      "It describes the code: modules, key dependencies, architecture. " +
      "Shared by every thread. Do not memory_store it.",
  ];
  const sha = wiki.headSha ? String(wiki.headSha).slice(0, 7) : "";
  const branch = wiki.defaultBranch || "";
  if (branch || sha || wiki.fileCount) {
    const loc = [branch, sha && `@ ${sha}`].filter(Boolean).join(" ");
    const counts = `${wiki.fileCount} files, ${wiki.symbolCount} symbols`;
    lines.push(loc ? `${loc} · ${counts}` : counts);
  }
  lines.push("Modules:");
  for (const mod of wiki.modules) {
    const hot = (mod.hot || [])
      .map((h) => String(h.path || "").split("/").pop())
      .filter(Boolean);
    const line =
      `  ${mod.name}/ — ${mod.fileCount} file${mod.fileCount === 1 ? "" : "s"}` +
      (hot.length ? `. Hottest: ${hot.join(", ")}` : "");
    if ((lines.join("\n") + "\n" + line).length > WIKI_NOTE_MAX) break;
    lines.push(line);
  }
  if (wiki.dependencies && wiki.dependencies.length) {
    const depLine = `Dependencies: ${wiki.dependencies.slice(0, 16).join(", ")}`;
    if ((lines.join("\n") + "\n" + depLine).length <= WIKI_NOTE_MAX) {
      lines.push(depLine);
    }
  }
  return lines.join("\n");
}

/**
 * SHA of the repo default branch (origin/HEAD, else main/master).
 * Empty strings when git cannot name one.
 *
 * @param {string} repoRoot
 * @returns {Promise<{ branch: string, sha: string }>}
 */
async function defaultHead(repoRoot) {
  try {
    const { defaultBranchAsync, gitTryAsync } = require("./worktrees.js");
    let name = "";
    try {
      name = await defaultBranchAsync(repoRoot);
    } catch {
      name = "";
    }
    if (name) {
      const local = await gitTryAsync(repoRoot, ["rev-parse", `refs/heads/${name}`]);
      if (local.ok) {
        return { branch: name, sha: String(local.stdout || "").trim() };
      }
      const remote = await gitTryAsync(repoRoot, [
        "rev-parse",
        `refs/remotes/origin/${name}`,
      ]);
      if (remote.ok) {
        return { branch: name, sha: String(remote.stdout || "").trim() };
      }
    }
    const head = await gitTryAsync(repoRoot, ["rev-parse", "HEAD"]);
    const current = await gitTryAsync(repoRoot, ["branch", "--show-current"]);
    return {
      branch: name || (current.ok ? String(current.stdout || "").trim() : ""),
      sha: head.ok ? String(head.stdout || "").trim() : "",
    };
  } catch {
    return { branch: "", sha: "" };
  }
}

/**
 * Build the wiki for a checkout. Index may be null (empty modules).
 *
 * @param {import('./codeindex.js').CodeIndex | null | undefined} index
 * @param {string} repoRoot
 * @returns {Promise<CodeWiki>}
 */
async function buildWiki(index, repoRoot) {
  const head = repoRoot ? await defaultHead(repoRoot) : { branch: "", sha: "" };
  return wikiFromIndex(index, {
    dependencies: repoRoot ? parseDependencies(repoRoot) : [],
    headSha: head.sha || (index && index.headSha) || "",
    defaultBranch: head.branch,
  });
}

/**
 * Push the wiki into the memory server so memory_bootstrap carries it.
 * Fail-open: a down server must not fail a refresh.
 *
 * @param {{ userDataPath: string, repoRoot: string, index?: import('./codeindex.js').CodeIndex | null }} opts
 * @returns {Promise<void>}
 */
async function publishWiki(opts) {
  try {
    if (!opts || !opts.userDataPath || !opts.repoRoot) return;
    const wiki = await buildWiki(opts.index || null, opts.repoRoot);
    if (!wiki.modules.length && !wiki.dependencies.length) return;
    const { createMemoryProxy } = require("./memory-proxy.js");
    const proxy = createMemoryProxy({ userDataPath: opts.userDataPath });
    await proxy.putWiki({ project: opts.repoRoot, wiki });
  } catch {
    // refresh path: never throw
  }
}

module.exports = {
  WIKI_NOTE_MAX,
  MAX_MODULES,
  wikiFromIndex,
  parseDependencies,
  formatWikiNote,
  defaultHead,
  buildWiki,
  publishWiki,
};
