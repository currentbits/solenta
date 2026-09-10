"use strict";

/**
 * Extra Codex `-c` flags for `workspace-write` so `git add`/`git commit`
 * work (#847, #1160) and a Planboard session can reach GitHub (#848)
 * without opening the whole network.
 *
 * Codex workspace-write allows writes in cwd, then carves `.git` and the
 * resolved `gitdir:` target out as read-only. A standalone checkout's
 * `.git` is inside cwd, so `git add` fails with EPERM on index.lock
 * unless that gitdir is listed as its own writable root. A Solenta
 * managed worktree's `.git` file points at `<main>/.git/worktrees/<id>`,
 * so the same flag must cover that gitdir plus the shared object/ref/
 * reflog stores. Listing those paths as writable_roots overrides the
 * carve-out on macOS without granting sibling worktrees.
 *
 * `sandbox_workspace_write.network_access` only opens the seatbelt gate.
 * `features.network_proxy` then allowlists api.github.com, github.com, and
 * uploads.github.com. Plan / danger-full-access emit nothing here.
 *
 * Fail closed: GitHub flags are omitted unless gh can authenticate inside
 * that same sandbox (macOS keychain is reachable once network_access is
 * on; without it `gh` reports "token in default is invalid"). Worktree
 * gitdir roots do not depend on gh.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitTry } = require("./worktrees.js");
const { codexSandboxFor } = require("./providers.js");

const PLANBOARD_GITHUB_HOSTS = [
  "api.github.com",
  "github.com",
  "uploads.github.com",
];

/** @type {boolean | undefined} */
let authOkOverride;
/** @type {boolean | undefined} */
let authOkCache;

/**
 * @param {string} p
 */
function realpathOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * @param {string} parent
 * @param {string} child
 */
function isInside(parent, child) {
  const rel = path.relative(realpathOrResolve(parent), realpathOrResolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * @param {string} p
 * @returns {string | null}
 */
function existingDir(p) {
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Extra writable roots so Codex's `.git` / `gitdir:` carve-out does not
 * block `git add`/`git commit`.
 *
 * Always grants this checkout's gitdir, even when it lives inside cwd:
 * workspace-write does not cover `.git` there. For a linked worktree,
 * also grants the shared object/ref/reflog stores under the common dir.
 * Does not grant the whole common dir (sibling worktrees live there).
 *
 * @param {string | null | undefined} cwd
 * @returns {string[]}
 */
function codexWorkspaceWritableRoots(cwd) {
  const dir = String(cwd || "");
  if (!dir) return [];
  const gitDir = gitTry(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  const common = gitTry(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!gitDir.ok || !common.ok) return [];
  const gitDirPath = realpathOrResolve(
    path.resolve(dir, String(gitDir.stdout || "")),
  );
  const commonPath = realpathOrResolve(
    path.resolve(dir, String(common.stdout || "")),
  );
  /** @type {string[]} */
  const roots = [];
  /**
   * @param {string} p
   */
  const addDir = (p) => {
    const d = existingDir(p);
    if (d && !roots.includes(d)) roots.push(d);
  };
  addDir(gitDirPath);
  // Linked worktree: objects/refs/logs live in the common dir, not in
  // this gitdir. Standalone: gitdir === common, so those subs are already
  // covered and must not be listed separately.
  if (!isInside(gitDirPath, commonPath)) {
    for (const sub of ["objects", "refs", "logs"]) {
      addDir(path.join(commonPath, sub));
    }
  }
  return roots;
}

/**
 * @param {unknown} value
 */
function tomlQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Inline TOML table for `features.network_proxy.domains`.
 * @returns {string}
 */
function planboardGithubProxyDomainsToml() {
  return `{ ${PLANBOARD_GITHUB_HOSTS.map((h) => `${tomlQuote(h)} = "allow"`).join(", ")} }`;
}

/**
 * `-c` pairs used both on `codex exec` and on the `codex sandbox` probe.
 * @returns {string[]}
 */
function planboardGithubProxyConfigArgs() {
  return [
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    "features.network_proxy.enabled=true",
    "-c",
    `features.network_proxy.domains=${planboardGithubProxyDomainsToml()}`,
  ];
}

/**
 * @param {string} output
 * @returns {boolean}
 */
function ghAuthOutputOk(output) {
  const text = String(output || "");
  return (
    /Logged in to github\.com/i.test(text) &&
    !/token in default is invalid/i.test(text)
  );
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{ encoding?: string, timeout?: number, env?: NodeJS.ProcessEnv }} opts
 */
function defaultExecFileSync(bin, args, opts) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: (opts && opts.timeout) || 20000,
    env: (opts && opts.env) || process.env,
  });
  const output = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (r.error) {
    const err = r.error;
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    throw err;
  }
  return output;
}

/**
 * Run `gh auth status` inside Codex workspace-write with the GitHub-only
 * proxy. Exit 0 is not enough: a blocked keychain/network still prints
 * "token in default is invalid" and exits 0.
 *
 * @param {{
 *   bin?: string,
 *   execFileSync?: (bin: string, args: string[], opts: object) => string,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {{ ok: boolean, output: string }}
 */
function probeGhAuthInCodexSandbox(opts) {
  const run = (opts && opts.execFileSync) || defaultExecFileSync;
  const env = (opts && opts.env) || process.env;
  const bin = (opts && opts.bin) || env.CODER_CODEX_BIN || "codex";
  const args = [
    "sandbox",
    "-c",
    "sandbox_mode=workspace-write",
    ...planboardGithubProxyConfigArgs(),
    "--",
    "gh",
    "auth",
    "status",
  ];
  try {
    const output = String(
      run(bin, args, { encoding: "utf8", timeout: 20000, env }) ?? "",
    );
    return { ok: ghAuthOutputOk(output), output };
  } catch (err) {
    const output = String(
      (err && (err.stderr || err.stdout || err.message)) || "",
    );
    return { ok: false, output };
  }
}

/**
 * @param {boolean} value
 */
function setCodexGhAuthOkForTests(value) {
  authOkOverride = Boolean(value);
}

function resetCodexGhAuthOkForTests() {
  authOkOverride = undefined;
  authOkCache = undefined;
}

/**
 * Cached live probe, overridable in tests. Missing/failed probe is false.
 * @returns {boolean}
 */
function codexGhAuthOk() {
  if (typeof authOkOverride === "boolean") return authOkOverride;
  if (typeof authOkCache === "boolean") return authOkCache;
  authOkCache = probeGhAuthInCodexSandbox().ok;
  return authOkCache;
}

/**
 * `-c` pairs to splice onto a Codex exec argv, or [].
 *
 * @param {{
 *   cwd?: string | null,
 *   permissionMode?: string | null,
 *   allowNetwork?: boolean,
 * }} [opts]
 * @returns {string[]}
 */
function codexWorkspaceWriteArgs(opts) {
  if (codexSandboxFor(opts && opts.permissionMode) !== "workspace-write") {
    return [];
  }
  /** @type {string[]} */
  const args = [];
  const roots = codexWorkspaceWritableRoots(opts && opts.cwd);
  if (roots.length) {
    args.push(
      "-c",
      `sandbox_workspace_write.writable_roots=[${roots.map(tomlQuote).join(", ")}]`,
    );
  }
  if (opts && opts.allowNetwork && codexGhAuthOk()) {
    args.push(...planboardGithubProxyConfigArgs());
  }
  return args;
}

module.exports = {
  PLANBOARD_GITHUB_HOSTS,
  planboardGithubProxyDomainsToml,
  planboardGithubProxyConfigArgs,
  probeGhAuthInCodexSandbox,
  setCodexGhAuthOkForTests,
  resetCodexGhAuthOkForTests,
  codexGhAuthOk,
  codexWorkspaceWritableRoots,
  codexWorkspaceWriteArgs,
};
