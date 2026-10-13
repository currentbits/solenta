"use strict";

/**
 * Multi-repo tasks (#263): one task, one thread per repo, linked PRs.
 *
 * A group is every thread sharing `taskGroupId` (the id of the thread the
 * user first extended from). Each member stays bound to its own project and
 * only ever writes there — the #109 ruling "a run must never write to a
 * second repo" holds; the group is bookkeeping plus what the agent is told.
 */

const { normalizePrLinks } = require("./prLinks.js");

/**
 * The other live members of `thread`'s group, each with its project.
 * @param {import('./store').Store} store
 * @param {any} thread
 */
function taskGroupSiblings(store, thread) {
  const gid = thread && thread.taskGroupId;
  if (!gid) return [];
  return store
    .getThreads()
    .filter(
      (t) =>
        t &&
        t.id !== thread.id &&
        t.taskGroupId === gid &&
        !Number.isFinite(t.trashedAt),
    )
    .map((t) => ({ thread: t, project: store.getProject(t.projectId) || null }));
}

function repoLabel(project) {
  if (!project) return "deleted project";
  return project.slug && project.slug !== project.name
    ? `${project.name} (${project.slug})`
    : project.name || project.slug || "project";
}

function prRefs(thread, project) {
  return normalizePrLinks(thread).map(
    (l) => l.url || `${l.repo || (project && project.slug) || ""}#${l.number}`,
  );
}

/**
 * Standing prompt note (CLI-only, never stored): which sibling threads own
 * the other repos, and their PRs. Paths are left out on purpose — the agent
 * has no business in a sibling's checkout. Ungated: it matters whether or
 * not coder-threads is registered.
 * @param {import('./store').Store} store
 * @param {any} thread
 * @returns {string}
 */
function taskGroupNoteFor(store, thread) {
  const siblings = taskGroupSiblings(store, thread);
  if (siblings.length === 0) return "";
  const rows = siblings.map(({ thread: t, project }) => {
    const prs = prRefs(t, project);
    return (
      `- ${repoLabel(project)}: "${t.title}" — ${t.status}, ` +
      (prs.length ? `PR ${prs.join(", ")}` : "no PR yet")
    );
  });
  return (
    "\n\n[Multi-repo task] This thread is one part of a task that spans " +
    "several repos. Sibling threads own the other parts, one per repo:\n" +
    rows.join("\n") +
    "\nChange only this repo. Never edit, build in, or run state-changing " +
    "git commands in a sibling's checkout; if this repo needs something from " +
    "another, say so in your reply. When you open this repo's pull request, " +
    "list the sibling PRs above in its description so they land together."
  );
}

/**
 * `body` plus a "Part of a multi-repo change" footer naming each sibling's
 * PR (full URLs, so GitHub cross-links both ways). Refs already in the body
 * are not repeated; no siblings → body unchanged.
 * @param {import('./store').Store} store
 * @param {any} thread
 * @param {string} body
 * @returns {string}
 */
function withTaskGroupFooter(store, thread, body) {
  const text = String(body || "");
  const rows = [];
  for (const { thread: t, project } of taskGroupSiblings(store, thread)) {
    const prs = prRefs(t, project).filter((ref) => !text.includes(ref));
    if (prs.length) rows.push(...prs.map((ref) => `- ${repoLabel(project)}: ${ref}`));
    else if (normalizePrLinks(t).length === 0) {
      rows.push(`- ${repoLabel(project)}: PR not opened yet`);
    }
  }
  if (rows.length === 0) return text;
  return `${text}${text ? "\n\n" : ""}---\nPart of a multi-repo change:\n${rows.join("\n")}`;
}

module.exports = { taskGroupSiblings, taskGroupNoteFor, withTaskGroupFooter };
