"use strict";

/**
 * Source-control detection for a project checkout (issue #521).
 *
 * Solenta shells out to git for worktrees, diffs, checkpoints, and merge.
 * A colocated Jujutsu repo (`jj git init --colocate`) has both `.jj` and
 * `.git`, so git plumbing usually works — until a jj command detaches HEAD
 * (merge) or rewrites the working-copy commit (checkpoints). Non-colocated
 * jj has no Git work tree; `git init` next to `.jj` would be a footgun.
 *
 * Derived at list time, like iconUrl. Never persisted.
 */

const fs = require("node:fs");
const path = require("node:path");

const JJ_COLOCATED_DETAIL =
  "Jujutsu colocated repo. Worktrees and diffs use git; merge fails once jj detaches HEAD, and checkpoints keyed on commit SHAs break if jj rewrites commits.";

const JJ_NON_COLOCATED_DETAIL =
  "Jujutsu repo is not colocated. Solenta needs a Git work tree — run `jj git colocation enable` or `jj git init --colocate`.";

const JJ_NON_COLOCATED_ADD_ERROR =
  "This directory is a Jujutsu repository without a colocated Git work tree. Solenta shells out to git; run `jj git colocation enable` (or `jj git init --colocate`) and add the project again.";

const JJ_DETACHED_HEAD_ERROR =
  "Project checkout is detached HEAD (Jujutsu colocated repos detach git HEAD on every jj command). Check out a git branch before merging.";

/**
 * True when p exists as a directory or a symlink (dangling links throw
 * into the caller). Matches the skill-dir rule: dirent.isDirectory() is
 * false for a symlink, so lstat + isDirectory || isSymbolicLink.
 * @param {string} p
 */
function isDirOrLink(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True when p exists as any file type (.git is a directory in the main
 * checkout and a gitfile in a linked worktree).
 * @param {string} p
 */
function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe a local checkout. Remotes are the caller's problem — pass null/omit.
 * Returns null when the path is missing or looks like neither git nor jj.
 *
 * @param {string | null | undefined} projectPath
 * @returns {import('../src/shared/ipc').ProjectScmInfo | null}
 */
function detectScm(projectPath) {
  if (!projectPath || typeof projectPath !== "string") return null;
  const root = projectPath;
  const hasJj = isDirOrLink(path.join(root, ".jj"));
  const hasGit = exists(path.join(root, ".git"));
  if (hasJj && hasGit) {
    return {
      kind: "jj",
      colocated: true,
      support: "unsupported",
      detail: JJ_COLOCATED_DETAIL,
    };
  }
  if (hasJj) {
    return {
      kind: "jj",
      colocated: false,
      support: "unsupported",
      detail: JJ_NON_COLOCATED_DETAIL,
    };
  }
  if (hasGit) {
    return { kind: "git", support: "supported" };
  }
  return null;
}

/**
 * Attach scm onto a presented project. Only jj is copied onto the object
 * (git is the assumed default — no badge). Never mutates the store row.
 *
 * @param {object} project
 * @returns {object}
 */
function attachScm(project) {
  if (!project || typeof project !== "object") return project;
  if (project.remoteHost) {
    if (!project.scm) return project;
    const next = { ...project };
    delete next.scm;
    return next;
  }
  const scm = detectScm(project.path);
  const want = scm && scm.kind === "jj" ? scm : null;
  if (!want) {
    if (!project.scm) return project;
    const next = { ...project };
    delete next.scm;
    return next;
  }
  return { ...project, scm: want };
}

module.exports = {
  detectScm,
  attachScm,
  JJ_COLOCATED_DETAIL,
  JJ_NON_COLOCATED_DETAIL,
  JJ_NON_COLOCATED_ADD_ERROR,
  JJ_DETACHED_HEAD_ERROR,
};
