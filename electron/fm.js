"use strict";

const { execFile } = require("node:child_process");
const { isBinAvailable } = require("./providers.js");

/**
 * macOS 27's `fm` CLI: on-device / Private Cloud Compute inference from the
 * shell — no API key, no account, no bill (issue #340). We shell out to it for
 * housekeeping prompts (commit subjects, titles, summaries) that a cloud agent
 * should not be charged for.
 *
 * Deliberately NOT a providers.js entry: fm has no tool loop and no resumable
 * session, so listing it there would surface it in the model picker as an agent
 * it is not. It borrows providers' isBinAvailable so PATH/which resolution
 * matches every other CLI we spawn.
 *
 * Every export degrades to "not available" off-Mac, pre-macOS-27, on timeout
 * and on a non-zero exit. Callers get null and fall back to whatever they did
 * before; nothing in the app may depend on fm being there.
 */

const TIMEOUT_MS = 20000;
const MAX_OUTPUT = 64 * 1024;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function fmBin(env = process.env) {
  return env.CODER_FM_BIN || "fm";
}

/**
 * argv for a one-shot prompt. Prompt is LAST, matching the convention every
 * provider in providers.js follows, so no flag can swallow it.
 *
 * ponytail: the flag-free positional form is a best guess — macOS 27 is not out
 * yet and this could not be run against the real binary. CODER_FM_ARGS (space
 * separated) prepends flags so a wrong guess is an env var, not a release.
 * Fold the real flags in here once `fm --help` can actually be read.
 *
 * @param {string} prompt
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function buildFmArgs(prompt, env = process.env) {
  const extra = String(env.CODER_FM_ARGS || "")
    .split(" ")
    .filter(Boolean);
  return [...extra, String(prompt)];
}

/**
 * Is a usable fm on this machine? Non-darwin is false unless CODER_FM_BIN
 * points somewhere (tests inject a fake there).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function fmAvailable(env = process.env) {
  if (env.CODER_FM_DISABLE === "1") return false;
  if (process.platform !== "darwin" && !env.CODER_FM_BIN) return false;
  return isBinAvailable(fmBin(env), undefined, env);
}

/**
 * Run one housekeeping prompt through fm.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string | null>} trimmed stdout, or null when fm is
 *   unavailable, timed out, failed, or said nothing. Never throws, never rejects.
 */
function fmRun(prompt, opts = {}) {
  const env = opts.env || process.env;
  const text = String(prompt || "").trim();
  if (!text) return Promise.resolve(null);
  if (!fmAvailable(env)) return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      execFile(
        fmBin(env),
        buildFmArgs(text, env),
        {
          timeout: opts.timeoutMs || TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT,
          encoding: "utf8",
          env,
        },
        (err, stdout) => {
          if (err) return resolve(null);
          const out = String(stdout || "").trim();
          resolve(out || null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

module.exports = {
  TIMEOUT_MS,
  MAX_OUTPUT,
  fmBin,
  buildFmArgs,
  fmAvailable,
  fmRun,
};
