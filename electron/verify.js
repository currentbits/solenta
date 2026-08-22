"use strict";

/**
 * Verification gate (issue #296): run a thread's verify command and turn a
 * failure into a structured bundle the fixer can act on.
 *
 * The engine only. Persistence lives in store/services, the gate that calls
 * it at a run terminal lives in runner.js. Issue #390 injects a shared
 * build-cache env here; affected-scope rewrites happen in prepareVerifyRun
 * before this spawn (post-merge keeps the original command).
 */

const { spawn } = require("node:child_process");
const { killTree } = require("./proc.js");
const { wrapCommand } = require("./ssh.js");
const { wslTarget } = require("./wsl.js");
const { mergeCacheEnv } = require("./verifyEfficiency.js");

/**
 * Shell that runs the user's verify command string.
 *
 * Windows has no /bin/sh. Git Bash (`bash` on PATH) is the POSIX shell the
 * doctor already probes for (#435). Verify commands are POSIX (`npm test`,
 * `>&2`, `exit 3`); cmd.exe or PowerShell would silently mis-parse them.
 * Missing bash is a real spawn error — no cmd.exe fallback.
 *
 * @param {NodeJS.Platform} platform
 */
function verifyShell(platform) {
  return platform === "win32" ? "bash" : "/bin/sh";
}

/** A command longer than this is a script, not a setting. */
const VERIFY_COMMAND_MAX = 500;
/** Tail kept from combined stdout+stderr. Enough for a failing suite's report. */
const VERIFY_LOG_MAX = 8000;
/** A verify command that runs longer than this is hung, not slow. */
const VERIFY_TIMEOUT_MS = 10 * 60_000;
/** SIGTERM → SIGKILL grace, same as devservers. */
const KILL_FALLBACK_MS = 3_000;
/**
 * Fix hand-backs per turn before the thread lands "failed". Two attempts
 * catch the "forgot to run the tests" case without burning a budget on an
 * agent that cannot fix it.
 */
const MAX_FIX_ATTEMPTS = 2;

/**
 * Normalize a user-supplied verify command. Empty / whitespace / non-string
 * disarms the gate (null); anything else is trimmed and capped.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeCommand(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, VERIFY_COMMAND_MAX);
}

/**
 * Last `max` chars of `text`, marked when anything was dropped. Tail not
 * head: a failing suite prints its summary last.
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function tailLog(text, max = VERIFY_LOG_MAX) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `…[${s.length - max} chars trimmed]…\n${s.slice(-max)}`;
}

/**
 * Run one verify command to completion.
 *
 * Never rejects: a spawn failure comes back as an ok:false result whose log
 * is the error, because "could not run the tests" is a verification failure
 * like any other, not a crash of the run lifecycle.
 *
 * @param {{
 *   command: string,
 *   cwd: string,
 *   timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 *   project?: { remoteHost?: string, remotePath?: string, path?: string } | null,
 *   platform?: NodeJS.Platform,
 *   spawn?: typeof spawn,
 * }} input
 * @returns {Promise<{ ok: boolean, exitCode: number | null, timedOut: boolean, log: string, durationMs: number }>}
 */
function runVerifyCommand(input) {
  const command = normalizeCommand(input && input.command);
  const startedAt = Date.now();
  if (!command) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      timedOut: false,
      log: "No verify command set.",
      durationMs: 0,
    });
  }
  const timeoutMs =
    input.timeoutMs == null ? VERIFY_TIMEOUT_MS : Number(input.timeoutMs);
  const platform = input.platform || process.platform;
  const spawnFn = input.spawn || spawn;
  const project = input.project || { path: input.cwd };
  const shell = verifyShell(platform);
  const argv = ["-c", command];
  // WSL-side only: the command belongs inside the distro. Do not wrap ssh
  // remotes here — that would change macOS remote-verify behaviour.
  const wsl = wslTarget(project, platform);
  const wrapped = wsl
    ? wrapCommand(project, shell, argv, platform)
    : { bin: shell, args: argv };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(wrapped.bin, wrapped.args, {
        cwd: wsl ? undefined : input.cwd,
        detached: true,
        env: mergeCacheEnv(input.cwd, input.env, {
          repoRoot: project && project.path,
        }),
        stdio: ["ignore", "pipe", "pipe"],
        // Hide the console window Git Bash would otherwise flash on win32.
        windowsHide: platform === "win32",
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        timedOut: false,
        log: `Could not start "${command}": ${err && err.message ? err.message : String(err)}`,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    let out = "";
    let timedOut = false;
    let settled = false;
    /** Cap in flight too — a chatty command can print gigabytes before exit. */
    const keep = (chunk) => {
      out += String(chunk);
      if (out.length > VERIFY_LOG_MAX * 4) out = out.slice(-VERIFY_LOG_MAX * 2);
    };
    if (child.stdout) child.stdout.on("data", keep);
    if (child.stderr) child.stderr.on("data", keep);

    let killTimer = null;
    const deadline = setTimeout(() => {
      timedOut = true;
      killTimer = killTree(child, KILL_FALLBACK_MS);
    }, timeoutMs);
    if (typeof deadline.unref === "function") deadline.unref();

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        log: tailLog(
          timedOut
            ? `${out}\n[verify] killed after ${Math.round(timeoutMs / 1000)}s`
            : out,
        ),
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", (err) => {
      out += `\n${err && err.message ? err.message : String(err)}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * The bundle a failed verification hands the fixer: what was run, how it
 * failed, the evidence, and the checkpoint it is pinned to. Deliberately a
 * prompt and not a JSON blob — it is delivered as a normal turn.
 *
 * @param {import("../src/shared/ipc").VerifyResult} result
 * @param {{ maxAttempts?: number }} [opts]
 * @returns {string}
 */
function buildFixPrompt(result, opts) {
  const maxAttempts =
    opts && opts.maxAttempts != null ? opts.maxAttempts : MAX_FIX_ATTEMPTS;
  const attempt = (result.attempt || 0) + 1;
  const why = result.timedOut
    ? `timed out after ${Math.round(result.durationMs / 1000)}s`
    : `exited ${result.exitCode}`;
  const lines = [
    "[verification failed] This turn is NOT done.",
    "",
    `Command: ${result.command}`,
    `Result: ${why}`,
  ];
  if (result.sha) lines.push(`Checkpoint: ${result.sha}`);
  lines.push(
    `Fix attempt ${attempt} of ${maxAttempts}.`,
    "",
    "Output:",
    "```",
    result.log || "(no output)",
    "```",
    "",
    "State a root-cause hypothesis in one line, fix the cause, then re-run",
    "the command yourself. Do not report success without its exit 0.",
  );
  return lines.join("\n");
}

module.exports = {
  VERIFY_COMMAND_MAX,
  VERIFY_LOG_MAX,
  VERIFY_TIMEOUT_MS,
  MAX_FIX_ATTEMPTS,
  normalizeCommand,
  tailLog,
  verifyShell,
  runVerifyCommand,
  buildFixPrompt,
};
