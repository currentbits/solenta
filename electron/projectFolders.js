"use strict";

/**
 * Multi-folder projects (#514). project.path stays the primary folder: it
 * owns chats, git, worktrees, AGENTS.md / skills / memory. project.folders
 * lists SECONDARY folders, in order, that agents may read and search.
 * Writes there are denied until the user grants that folder on a thread's
 * permission card (thread.folderWriteGrants).
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_FOLDERS = 8;

/**
 * Validate a folders patch for projects.update. Throws on bad input;
 * returns the cleaned, de-duplicated list (empty = clear).
 * @param {unknown} input
 * @param {{ path: string, remoteHost?: string }} project
 * @returns {string[]}
 */
function normalizeFolders(input, project) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error("folders must be a list of paths");
  const primary = path.resolve(project.path);
  /** @type {string[]} */
  const out = [];
  for (const raw of input) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s) continue;
    if (project.remoteHost) {
      throw new Error("Extra folders are only supported on local projects");
    }
    if (!path.isAbsolute(s)) throw new Error(`Folder must be an absolute path: ${s}`);
    const p = path.resolve(s);
    if (p === primary) continue;
    let stat = null;
    try {
      stat = fs.statSync(p);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) throw new Error(`Folder not found: ${s}`);
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_FOLDERS) {
    throw new Error(`At most ${MAX_FOLDERS} extra folders per project`);
  }
  return out;
}

/**
 * Secondary folders an agent run gets. Remote / WSL projects have none:
 * the paths would name the wrong machine.
 * @param {{ folders?: unknown, remoteHost?: string } | null | undefined} project
 * @returns {string[]}
 */
function secondaryFolders(project) {
  if (!project || project.remoteHost || !Array.isArray(project.folders)) return [];
  return project.folders.filter((f) => typeof f === "string" && path.isAbsolute(f));
}

/**
 * @param {{ folderWriteGrants?: unknown } | null | undefined} thread
 * @returns {string[]}
 */
function writeGrants(thread) {
  const g = thread && thread.folderWriteGrants;
  return Array.isArray(g) ? g.filter((f) => typeof f === "string") : [];
}

/**
 * The secondary folder holding `target`, or null. Relative targets resolve
 * against `cwd` (the primary checkout).
 * @param {string} target
 * @param {string[]} folders
 * @param {string | null} [cwd]
 */
function folderFor(target, folders, cwd) {
  if (!target) return null;
  const abs = path.resolve(cwd || process.cwd(), target);
  for (const f of folders) {
    const rel = path.relative(f, abs);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return f;
  }
  return null;
}

/**
 * Prompt note so every provider knows the extra folders exist and what it
 * may do there. Empty for single-folder projects.
 * @param {object | null | undefined} project
 * @param {object | null | undefined} thread
 */
function foldersNoteFor(project, thread) {
  const folders = secondaryFolders(project);
  if (!folders.length) return "";
  const granted = writeGrants(thread);
  const rows = folders.map((f) =>
    `- ${f}${granted.includes(f) ? " (writes granted)" : " (read and search only)"}`,
  );
  return (
    "\n\n[Project folders] Besides your working directory (the primary folder, " +
    "which owns git, worktrees and project config), this project includes:\n" +
    rows.join("\n") +
    "\nRead and search them with absolute paths. Do not write to a read-only " +
    "folder: the write is denied unless the user grants that folder on the " +
    "permission card. Never run git commands that change those folders."
  );
}

module.exports = {
  MAX_FOLDERS,
  normalizeFolders,
  secondaryFolders,
  writeGrants,
  folderFor,
  foldersNoteFor,
};
