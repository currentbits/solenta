"use strict";

/**
 * solenta:// deep links (#186): solenta://thread/<id> and
 * solenta://project/<id>. The renderer builds the same strings for its
 * Copy link actions.
 */

const DEEP_LINK_SCHEME = "solenta";

/**
 * @param {unknown} url
 * @returns {{ kind: "thread" | "project", id: string } | null}
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
  // Windows hands the URL back with a trailing slash.
  const id = u.pathname.replace(/^\/|\/$/g, "");
  if (kind !== "thread" && kind !== "project") return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return { kind, id };
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

module.exports = { DEEP_LINK_SCHEME, parseDeepLink, deepLinkFromArgv };
