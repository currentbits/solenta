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

module.exports = { isWebUrl, windowOpenAction, navigateAction };
