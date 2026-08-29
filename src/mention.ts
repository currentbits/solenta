/**
 * Composer @-mention detection. Pure so the token rules are testable.
 *
 * A mention is an `@` that starts a token (start of text or after whitespace)
 * with a non-empty, whitespace-free query running up to the caret. This keeps
 * "a@b" (email-shaped) and "@@" from ever opening the popup.
 */
export interface MentionQuery {
  /** Index of the "@" in the text. */
  start: number;
  /** Text between "@" and the caret. */
  query: string;
}

const MAX_QUERY = 100;

export function getMentionQuery(
  text: string,
  caret: number,
): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  // Empty query is allowed: typing a bare "@" opens the popup unfiltered.
  if (/\s/.test(query)) return null;
  if (query.length > MAX_QUERY) return null;
  return { start: at, query };
}

/**
 * Replace the active mention token with `@path ` and report the new caret
 * (just past the trailing space).
 */
export function applyMention(
  text: string,
  caret: number,
  start: number,
  path: string,
): { text: string; caret: number } {
  const inserted = `@${path} `;
  return {
    text: text.slice(0, start) + inserted + text.slice(caret),
    caret: start + inserted.length,
  };
}

/**
 * Repo-relative folder token for an @-mention. Trailing slash marks a
 * directory. Paths outside the project stay absolute.
 */
export function repoRelativeDir(projectPath: string, picked: string): string {
  const root = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const dir = picked.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!dir) return "./";
  if (dir === root) return "./";
  if (root && dir.startsWith(`${root}/`)) {
    return `${dir.slice(root.length + 1)}/`;
  }
  return `${dir}/`;
}
