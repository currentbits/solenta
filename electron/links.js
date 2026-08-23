"use strict";

/**
 * Where a URL is allowed to open. The app window must never navigate to the
 * open web: a PR link is target=_blank, and without a policy Electron answers
 * it with a bare chrome-less window pointed at github.com.
 *
 * Pure so the policy is testable; main.js only wires it to webContents.
 */

/** @param {string} url */
function isWebUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

/**
 * Policy for window.open / target=_blank.
 * @param {string} url
 * @returns {{ external: boolean }} external: hand to the OS browser.
 *   The window itself is never allowed to open; callers always deny.
 */
function windowOpenAction(url) {
  return { external: isWebUrl(url) };
}

/**
 * Policy for in-place navigation.
 * @param {string} url the navigation target
 * @param {{ currentUrl?: string, isDev?: boolean, devServerUrl?: string }} ctx
 * @returns {{ allow: boolean, external: boolean }}
 */
function navigateAction(url, ctx = {}) {
  const target = String(url || "");
  // Reloading the page we are already on is not a navigation away.
  if (ctx.currentUrl && target === ctx.currentUrl) {
    return { allow: true, external: false };
  }
  // The dev server is the app in dev mode, so HMR navigation must survive.
  // Compare ORIGINS, not string prefixes: "http://localhost:5173".startsWith
  // also admits localhost:5173.evil.com, localhost:5173@evil.com and :51730.
  if (ctx.isDev && ctx.devServerUrl) {
    try {
      if (new URL(target).origin === new URL(ctx.devServerUrl).origin) {
        return { allow: true, external: false };
      }
    } catch {
      // unparseable target: fall through to deny
    }
  }
  return { allow: false, external: isWebUrl(target) };
}

/**
 * Loopback hosts the embedded Browser pane may load. The app window still
 * never navigates here (navigateAction above); this is the guest webview
 * allow-list (issue #155).
 * @param {string} hostname
 */
function isLoopbackHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    host === "::ffff:127.0.0.1" ||
    host.endsWith(".localhost")
  );
}

/**
 * Prepend http:// when the user typed a host:port with no scheme.
 * @param {string} raw
 */
function coercePreviewUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  // Require :// so "localhost:5173" is a host:port, not a scheme.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
  return `http://${s}`;
}

/**
 * Rewrite 0.0.0.0 / :: (bind-all banners) to 127.0.0.1 so Chromium will load
 * them. Returns null when the URL does not parse.
 * @param {string} url
 * @returns {string | null}
 */
function canonicalizePreviewUrl(url) {
  try {
    const u = new URL(coercePreviewUrl(url));
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "0.0.0.0" || host === "::") {
      u.hostname = "127.0.0.1";
    }
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Policy for the embedded preview guest (not the app window).
 * about:blank is the empty document; anything else must be http(s) loopback.
 * Other http(s) targets go to the OS browser; non-web schemes are dropped.
 * @param {string} url
 * @returns {{ allow: boolean, external: boolean, url?: string }}
 */
function previewNavigateAction(url) {
  const target = String(url || "");
  if (target === "" || target === "about:blank") {
    return { allow: true, external: false, url: "about:blank" };
  }
  let parsed;
  try {
    parsed = new URL(coercePreviewUrl(target));
  } catch {
    return { allow: false, external: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allow: false, external: false };
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { allow: false, external: true };
  }
  const canon = canonicalizePreviewUrl(parsed.toString());
  return { allow: true, external: false, url: canon || parsed.toString() };
}

module.exports = {
  isWebUrl,
  windowOpenAction,
  navigateAction,
  isLoopbackHost,
  coercePreviewUrl,
  canonicalizePreviewUrl,
  previewNavigateAction,
};
