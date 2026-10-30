"use strict";

/**
 * solenta:// deep links (#186): solenta://thread/<id>, solenta://project/<id>
 * and solenta://new?prompt=...&project=... (#1766). The renderer builds the
 * same thread/project strings for its Copy link actions.
 */

const DEEP_LINK_SCHEME = "solenta";

// A link is not a run trigger: a prompt this long is almost certainly a
// mistake (or abuse), not a real request, so it is truncated rather than
// rejected outright.
const MAX_NEW_PROMPT_LENGTH = 20000;

/**
 * @param {unknown} url
 * @returns {
 *   | { kind: "thread" | "project", id: string }
 *   | { kind: "new", prompt: string, project: string | null }
 *   | null
 * }
 */
function parseDeepLink(url) {
  if (typeof url !== "string") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  const kind = u.hostname;
  if (kind === "new") {
    // URLSearchParams already percent- (and +-) decodes; no manual decode.
    const prompt = (u.searchParams.get("prompt") || "").slice(
      0,
      MAX_NEW_PROMPT_LENGTH,
    );
    if (!prompt) return null;
    return { kind: "new", prompt, project: u.searchParams.get("project") || null };
  }
  // Windows hands the URL back with a trailing slash.
  const id = u.pathname.replace(/^\/|\/$/g, "");
  if (kind !== "thread" && kind !== "project") return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return { kind, id };
}

/**
 * Resolve the `new` link's `project` param against known projects: by id,
 * then by filesystem path, then by display name. Null means "unresolved" —
 * the caller falls back to whatever project is currently selected, it is
 * not an error for a `new` link to name no project or an unknown one.
 * @param {unknown} ref
 * @param {readonly { id: string, path?: string, name?: string }[] | undefined} projects
 * @returns {string | null}
 */
function resolveProjectRef(ref, projects) {
  if (typeof ref !== "string" || !ref) return null;
  const list = Array.isArray(projects) ? projects : [];
  const byId = list.find((p) => p.id === ref);
  if (byId) return byId.id;
  const trimSlash = (s) => (typeof s === "string" ? s.replace(/\/+$/, "") : s);
  const refTrimmed = trimSlash(ref);
  const byPath = list.find((p) => p.path && trimSlash(p.path) === refTrimmed);
  if (byPath) return byPath.id;
  const byName = list.find((p) => p.name === ref);
  if (byName) return byName.id;
  return null;
}

/**
 * Windows/Linux pass the link as a command-line argument (cold launch and
 * second-instance alike).
 * @param {readonly unknown[]} argv
 */
function deepLinkFromArgv(argv) {
  for (const arg of argv) {
    const link = parseDeepLink(arg);
    if (link) return link;
  }
  return null;
}

module.exports = {
  DEEP_LINK_SCHEME,
  MAX_NEW_PROMPT_LENGTH,
  parseDeepLink,
  deepLinkFromArgv,
  resolveProjectRef,
};
