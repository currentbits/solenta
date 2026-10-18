"use strict";

/**
 * macOS Seatbelt wrapper (#803). Compiles a profile's governance matrix
 * (#262) into an SBPL profile and runs the local agent CLI under
 * `sandbox-exec`, so CLIs that never raise a permission prompt (Kimi, Grok
 * --always-approve, Cursor --force, Claude in acceptEdits/bypass) are still
 * confined by the kernel.
 *
 *   writes  deny everywhere except the worktree, its git common dir, tmp,
 *           /dev, the CLI's own config homes, and write rules whose action
 *           is allow/ask. Write rules with deny/block are carved back out
 *           (SBPL: the last matching rule wins).
 *   network only when the matrix has network rules: outbound IP is denied
 *           except loopback and unix sockets; HTTP(S)_PROXY points at a
 *           per-thread host-filtering proxy (seatbeltProxy.js), because
 *           Seatbelt cannot match hostnames.
 *
 * Reads are not confined (the #409 secret-path rules stay at the tool layer).
 * Every deny rule carries `(with message "solenta:<threadId>")` so the
 * unified-log watcher (seatbeltWatch.js) can attribute kernel denials.
 *
 * Fail closed: a path that cannot be canonicalized, or a glob that cannot be
 * expressed safely, throws, and the run refuses to start rather than spawning
 * unconfined. ssh remotes and WSL are never wrapped.
 */

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { normalizePath } = require("./governance.js");
const { wslTarget } = require("./wsl.js");

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** CLI state that must stay writable (relative to $HOME). */
const HOME_WRITABLE = [
  ".claude",
  ".codex",
  ".grok",
  ".kimi",
  ".cursor",
  ".config",
  ".local/share",
  ".local/state",
  ".cache",
  ".npm",
  ".bun",
  "Library/Caches",
  "Library/Logs",
];

/** ~/.claude.json and its lock/backup siblings live next to ~/.claude. */
const HOME_FILE_PREFIXES = [".claude.json"];

function disabled() {
  const v = String(process.env.CODER_SEATBELT || "").toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

/**
 * True when this thread's run gets wrapped: macOS, a plain local project,
 * and a policy with at least one write or network rule (the parts Seatbelt
 * can enforce). Pure; used by the badge too.
 * @param {{ rules?: Array<{ kind: string }> } | null | undefined} policy
 * @param {{ remoteHost?: string, path?: string } | null | undefined} project
 * @param {NodeJS.Platform} [platform]
 */
function seatbeltApplies(policy, project, platform = process.platform) {
  if (platform !== "darwin" || disabled()) return false;
  if (!project || project.remoteHost || wslTarget(project, platform)) return false;
  const rules = (policy && policy.rules) || [];
  return rules.some((r) => r.kind === "write" || r.kind === "network");
}

/** @param {{ rules?: Array<{ kind: string }> } | null | undefined} policy */
function confinesNetwork(policy) {
  return ((policy && policy.rules) || []).some((r) => r.kind === "network");
}

/** SBPL string literal. Refuses what it cannot quote safely. */
function sbString(s) {
  if (/["\\\u0000-\u001f]/.test(s)) {
    throw new Error(`Seatbelt: cannot express path ${JSON.stringify(s)}`);
  }
  return `"${s}"`;
}

/** Case-insensitive ERE for one literal run (APFS is case-insensitive). */
function literalRe(s) {
  return s.replace(/[.^$|()[\]{}*+?\\]/g, "\\$&").replace(/[a-z]/gi, (c) => {
    const lo = c.toLowerCase();
    const up = c.toUpperCase();
    return lo === up ? c : `[${lo}${up}]`;
  });
}

/**
 * One matrix write glob → an SBPL regex over canonical absolute paths.
 * Relative globs are anchored at the worktree; an absolute glob's literal
 * directory prefix is realpath'd (throws → caller fails closed); a glob that
 * starts with `*` matches anywhere, same as the tool-layer matcher.
 * @param {string} glob
 * @param {string} worktree canonical
 */
function globToSbRegex(glob, worktree) {
  let g = String(glob).normalize("NFKC").trim();
  if (g === "~" || g.startsWith("~/")) g = path.join(os.homedir(), g.slice(1));
  let prefix = "";
  if (g.startsWith("*")) {
    prefix = "";
  } else if (path.isAbsolute(g)) {
    const wild = g.search(/[*?]/);
    const literal = wild < 0 ? g : g.slice(0, wild);
    const dir = literal.endsWith("/") ? literal : path.dirname(literal);
    const real = normalizePath(dir, worktree);
    prefix = real === "/" ? "/" : `${real}/`;
    g = g.slice(dir.length).replace(/^\/+/, "");
  } else {
    prefix = `${worktree}/`;
  }
  const body = g
    .split(/([*?])/)
    .map((part) => (part === "*" ? ".*" : part === "?" ? "." : literalRe(part)))
    .join("");
  const re = `^${literalRe(prefix)}${body}$`;
  if (/["\u0000-\u001f]/.test(re)) {
    throw new Error(`Seatbelt: cannot express write rule ${JSON.stringify(glob)}`);
  }
  return `(regex #"${re}")`;
}

/** Shared .git dir of a linked worktree (objects and refs land there). */
function gitCommonDir(worktree) {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return out ? normalizePath(out, worktree) : null;
  } catch {
    return null;
  }
}

/**
 * Compile the SBPL profile. Throws on any canonicalization failure.
 * @param {{
 *   threadId: string,
 *   policy: { rules: Array<{ kind: string, match: string, action: string }> },
 *   worktree: string,
 *   env?: Record<string, string> | null,
 *   home?: string,
 *   tmpdir?: string,
 *   commonDir?: string | null,
 * }} input
 * @returns {{ profile: string, network: boolean, hash: string }}
 */
function compileSeatbelt(input) {
  const { threadId, policy } = input;
  const home = normalizePath(input.home || os.homedir(), null);
  const worktree = normalizePath(input.worktree, null);
  const tmp = normalizePath(input.tmpdir || os.tmpdir(), null);
  const commonDir =
    input.commonDir !== undefined ? input.commonDir : gitCommonDir(worktree);
  const tag = sbString(`solenta:${threadId}`);

  const allowed = new Set([
    `(subpath ${sbString(worktree)})`,
    // $TMPDIR is /private/var/folders/xx/yyyy/T; its siblings C/ and X/ are
    // the per-user cache dirs tools reach through confstr.
    `(subpath ${sbString(/\/T$/.test(tmp) ? path.dirname(tmp) : tmp)})`,
    `(subpath "/private/tmp")`,
    `(subpath "/dev")`,
  ]);
  if (commonDir) allowed.add(`(subpath ${sbString(commonDir)})`);
  for (const rel of HOME_WRITABLE) {
    allowed.add(`(subpath ${sbString(`${home}/${rel}`)})`);
  }
  for (const f of HOME_FILE_PREFIXES) {
    allowed.add(`(regex #"^${literalRe(`${home}/${f}`)}")`);
  }
  // Per-thread CLI homes Solenta points the CLI at (GROK_HOME, CODEX_HOME,
  // KIMI_CODE_HOME, cursor's HOME, XDG_*): absolute env values are dirs it
  // must be able to write.
  for (const v of Object.values(input.env || {})) {
    if (typeof v === "string" && path.isAbsolute(v)) {
      allowed.add(`(subpath ${sbString(normalizePath(v, null))})`);
    }
  }
  const denied = [];
  if (commonDir) denied.push(`(subpath ${sbString(`${commonDir}/hooks`)})`);
  for (const r of policy.rules) {
    if (r.kind !== "write") continue;
    const re = globToSbRegex(r.match, worktree);
    if (r.action === "allow" || r.action === "ask") allowed.add(re);
    else denied.push(re);
  }

  const lines = [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (require-not (require-any ${[...allowed].join(" ")})) (with message ${tag}))`,
  ];
  if (denied.length) {
    lines.push(`(deny file-write* (require-any ${denied.join(" ")}) (with message ${tag}))`);
  }
  const network = confinesNetwork(policy);
  if (network) {
    lines.push(
      `(deny network-outbound (with message ${tag}))`,
      `(allow network-outbound (remote ip "localhost:*"))`,
      `(allow network-outbound (remote unix-socket))`,
    );
  }
  const profile = `${lines.join("\n")}\n`;
  return {
    profile,
    network,
    hash: crypto.createHash("sha256").update(profile).digest("hex"),
  };
}

/**
 * argv for the wrapped child. Proxy env rides /usr/bin/env inside the
 * sandbox so no provider's env plumbing has to change.
 * The thread rides the proxy URL's userinfo (seatbeltProxy.js identity).
 * @param {{ binary: string, args: string[], cwd: string }} spawn
 * @param {string} profile
 * @param {{ port: number, threadId: string } | null} proxy
 */
function wrapSpawn(spawn, profile, proxy) {
  const url = proxy
    ? `http://${encodeURIComponent(proxy.threadId)}:x@127.0.0.1:${proxy.port}`
    : null;
  const envArgs = url
    ? [
        "/usr/bin/env",
        ...["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].map(
          (k) => `${k}=${url}`,
        ),
        "NO_PROXY=localhost,127.0.0.1,::1",
        "no_proxy=localhost,127.0.0.1,::1",
      ]
    : [];
  return {
    binary: SANDBOX_EXEC,
    args: ["-p", profile, ...envArgs, spawn.binary, ...spawn.args],
    cwd: spawn.cwd,
  };
}

module.exports = {
  SANDBOX_EXEC,
  seatbeltApplies,
  compileSeatbelt,
  globToSbRegex,
  wrapSpawn,
};
